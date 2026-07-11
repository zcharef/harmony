//! In-process `ONNX` adult-NSFW image classifier (Phase 2).
//!
//! Implements the [`ImageClassifier`] port with a bundled binary `ViT` model
//! (`Marqo/nsfw-image-detection-384`, Apache-2.0) run in-process via ONNX
//! Runtime (`ort`). The model is loaded **once** at startup and shared behind an
//! `Arc`; inference for each attachment runs on a blocking thread so it never
//! stalls the async runtime.
//!
//! **This detects LEGAL adult porn vs clean — it does NOT detect CSAM.** CSAM is
//! a separate hash-matching concern ([`CsamMatcher`](crate::domain::ports::CsamMatcher)).
//!
//! Preprocessing mirrors the model card
//! (`config.json`: `image_input_size=[3,384,384]`, `mean=std=0.5`, `id2label`
//! `0=NSFW`, `1=SFW`): decode → resize to 384×384 → normalize to `[-1, 1]` →
//! `NCHW` `f32` tensor. The two output logits are soft-maxed; the NSFW
//! probability (index 0) is the score. `<0.5` → `Clean`, otherwise `Nsfw`
//! (spec §d Phase 2); the raw score is persisted server-side and the decision
//! table maps the label to a status.

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use tokio::sync::Mutex;

use crate::domain::errors::DomainError;
use crate::domain::ports::{ImageClassifier, NsfwLabel, NsfwVerdict};

/// Model input spatial size (`Marqo/nsfw-image-detection-384` → 384×384).
const INPUT_SIZE: u32 = 384;
/// Pixels per channel plane (`384 * 384`), for `NCHW` buffer indexing.
const PLANE: usize = 384 * 384;
/// Per-channel normalization mean (model `preprocessing_config`, all channels).
const NORM_MEAN: f32 = 0.5;
/// Per-channel normalization std (model `preprocessing_config`, all channels).
const NORM_STD: f32 = 0.5;
/// Score at/above which raw bytes are labelled adult-NSFW (spec §d Phase 2:
/// `<0.5` → clean; `0.5-0.85` and `>=0.85` both treated as NSFW → single label
/// threshold at `0.5`). The raw score is still persisted for tuning/audit.
const NSFW_LABEL_THRESHOLD: f32 = 0.5;

/// Adult-NSFW classifier backed by an in-process `ONNX` `ViT` model.
///
/// The [`Session`] is wrapped in a [`tokio::sync::Mutex`] because ONNX Runtime's
/// `Session::run` takes `&mut self`; inference is serialized but always executed
/// inside `spawn_blocking` (the guard is never held across an `.await`), so the
/// async runtime is never blocked and there is no deadlock risk (ADR-022). The
/// post-send scan path is already concurrency-bounded by the moderation
/// semaphore, so serialized inference is acceptable for v1.
pub struct OnnxNsfwClassifier {
    session: Arc<Mutex<Session>>,
    input_name: String,
    output_name: String,
}

impl std::fmt::Debug for OnnxNsfwClassifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnnxNsfwClassifier")
            .field("input_name", &self.input_name)
            .field("output_name", &self.output_name)
            .finish_non_exhaustive()
    }
}

impl OnnxNsfwClassifier {
    /// Load and initialize the `ONNX` model from `model_path` (called once at
    /// startup). The input/output tensor names are read from the graph so the
    /// classifier does not hard-code names that vary by conversion.
    ///
    /// # Errors
    /// Returns [`DomainError::ExternalService`] if the model file is missing,
    /// invalid, or exposes no input/output — the caller falls back to the Noop
    /// classifier (images auto-approve) and alerts.
    pub fn load(model_path: &str) -> Result<Self, DomainError> {
        let session = Session::builder()
            .map_err(|e| onnx_err(&e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| onnx_err(&e))?
            // One intra-op thread: the scan path runs many inferences under the
            // moderation semaphore, so per-inference threads would oversubscribe
            // a small Fly machine. Latency is a background concern, not user-facing.
            .with_intra_threads(1)
            .map_err(|e| onnx_err(&e))?
            .commit_from_file(model_path)
            .map_err(|e| onnx_err(&e))?;

        let input_name = session
            .inputs
            .first()
            .map(|i| i.name.clone())
            .ok_or_else(|| {
                DomainError::ExternalService("ONNX model exposes no inputs".to_string())
            })?;
        let output_name = session
            .outputs
            .first()
            .map(|o| o.name.clone())
            .ok_or_else(|| {
                DomainError::ExternalService("ONNX model exposes no outputs".to_string())
            })?;

        tracing::info!(
            model_path,
            input_name,
            output_name,
            "loaded ONNX adult-NSFW classifier"
        );
        Ok(Self {
            session: Arc::new(Mutex::new(session)),
            input_name,
            output_name,
        })
    }
}

#[async_trait]
impl ImageClassifier for OnnxNsfwClassifier {
    async fn classify_nsfw(&self, bytes: &[u8], _mime: &str) -> Result<NsfwVerdict, DomainError> {
        let started = Instant::now();
        // Own the inputs so the closure is `'static` for `spawn_blocking`.
        let bytes = bytes.to_vec();
        let session = self.session.clone();
        let input_name = self.input_name.clone();
        let output_name = self.output_name.clone();

        // Preprocessing (decode/resize) and inference are both CPU-bound and
        // blocking — run them off the async runtime. `blocking_lock` is safe here
        // (dedicated blocking thread; the guard never crosses an `.await`).
        let score = tokio::task::spawn_blocking(move || -> Result<f32, DomainError> {
            let input = preprocess(&bytes)?;
            let tensor =
                Tensor::from_array(([1_usize, 3, 384, 384], input)).map_err(|e| onnx_err(&e))?;
            let mut session = session.blocking_lock();
            let outputs = session
                .run(ort::inputs![input_name.as_str() => tensor])
                .map_err(|e| onnx_err(&e))?;
            let (_, logits) = outputs[output_name.as_str()]
                .try_extract_tensor::<f32>()
                .map_err(|e| onnx_err(&e))?;
            nsfw_score(logits)
        })
        .await
        .map_err(|e| DomainError::ExternalService(format!("nsfw inference task failed: {e}")))??;

        let label = if score >= NSFW_LABEL_THRESHOLD {
            NsfwLabel::Nsfw
        } else {
            NsfwLabel::Clean
        };

        // Four Golden Signals: real classifier latency + verdict, per-scan.
        tracing::info!(
            classifier = "onnx_vit",
            nsfw_score = f64::from(score),
            label = ?label,
            latency_ms = started.elapsed().as_millis(),
            "adult-NSFW classification complete"
        );
        Ok(NsfwVerdict { score, label })
    }

    fn is_configured(&self) -> bool {
        true
    }
}

/// Map an `ort` error into the domain's external-service error.
fn onnx_err(e: &ort::Error) -> DomainError {
    DomainError::ExternalService(format!("onnx runtime error: {e}"))
}

/// Decode, resize to 384×384, and normalize image bytes into an `NCHW` `f32`
/// buffer (channels-first, values in `[-1, 1]`). Pure and side-effect-free.
///
/// # Errors
/// Returns [`DomainError::ExternalService`] when the bytes are not a decodable
/// image (unsupported/corrupt) — the scan dead-letters and stays `pending`.
fn preprocess(bytes: &[u8]) -> Result<Vec<f32>, DomainError> {
    let decoded = image::load_from_memory(bytes)
        .map_err(|e| DomainError::ExternalService(format!("image decode failed: {e}")))?;
    let rgb = decoded.to_rgb8();
    // Full-image resize (model `crop_pct = 1.0`, i.e. no crop). CatmullRom is a
    // cubic filter, the closest stable analogue to the card's `bicubic`.
    let resized = image::imageops::resize(
        &rgb,
        INPUT_SIZE,
        INPUT_SIZE,
        image::imageops::FilterType::CatmullRom,
    );

    // `as_raw` is row-major RGB (HWC), length `3 * PLANE`. Rearrange to CHW and
    // normalize. Only `usize` loop counters — no lossy casts.
    let raw = resized.as_raw();
    let mut data = vec![0.0_f32; 3 * PLANE];
    for i in 0..PLANE {
        let base = i * 3;
        for c in 0..3 {
            let v = f32::from(raw[base + c]) / 255.0;
            data[c * PLANE + i] = (v - NORM_MEAN) / NORM_STD;
        }
    }
    Ok(data)
}

/// Soft-max the two output logits `[NSFW, SFW]` and return the NSFW probability
/// (`id2label`: index 0 = NSFW). Numerically stable (subtracts the max).
///
/// # Errors
/// Returns [`DomainError::ExternalService`] if the model did not produce exactly
/// two logits (a wrong/corrupt model) — fail-closed, the attachment stays
/// `pending` rather than silently scoring off the wrong output shape.
fn nsfw_score(logits: &[f32]) -> Result<f32, DomainError> {
    let (&nsfw_logit, &sfw_logit) = match logits {
        [nsfw, sfw] => (nsfw, sfw),
        _ => {
            return Err(DomainError::ExternalService(format!(
                "expected exactly 2 output logits, got {}",
                logits.len()
            )));
        }
    };
    let max = nsfw_logit.max(sfw_logit);
    let e_nsfw = (nsfw_logit - max).exp();
    let e_sfw = (sfw_logit - max).exp();
    Ok(e_nsfw / (e_nsfw + e_sfw))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    /// Encode a solid-color RGB image to PNG bytes for preprocessing tests.
    fn solid_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb(rgb));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("encode png");
        bytes
    }

    #[test]
    fn preprocess_produces_nchw_buffer_of_expected_length() {
        let bytes = solid_png(120, 90, [128, 128, 128]);
        let data = preprocess(&bytes).expect("preprocess ok");
        assert_eq!(data.len(), 3 * PLANE, "must be one f32 per channel-pixel");
    }

    #[test]
    fn preprocess_normalizes_into_minus_one_to_one_range() {
        // Black (0) → -1, white (255) → +1 with mean=std=0.5.
        let black = preprocess(&solid_png(50, 50, [0, 0, 0])).expect("preprocess black");
        let white = preprocess(&solid_png(50, 50, [255, 255, 255])).expect("preprocess white");
        assert!((black[0] - (-1.0)).abs() < 1e-6, "black normalizes to -1");
        assert!((white[0] - 1.0).abs() < 1e-6, "white normalizes to +1");
        for v in &black {
            assert!((-1.0..=1.0).contains(v), "value {v} out of [-1,1]");
        }
    }

    #[test]
    fn preprocess_rejects_non_image_bytes() {
        let err = preprocess(b"not an image at all").unwrap_err();
        assert!(matches!(err, DomainError::ExternalService(_)));
    }

    #[test]
    fn nsfw_score_high_when_nsfw_logit_dominates() {
        // logits [nsfw, sfw] = [10, 0] → ~1.0 NSFW probability.
        let score = nsfw_score(&[10.0, 0.0]).expect("score");
        assert!(score > 0.99, "expected ~1.0, got {score}");
        assert!(score >= NSFW_LABEL_THRESHOLD);
    }

    #[test]
    fn nsfw_score_low_when_sfw_logit_dominates() {
        // logits [nsfw, sfw] = [0, 10] → ~0.0 NSFW probability → Clean.
        let score = nsfw_score(&[0.0, 10.0]).expect("score");
        assert!(score < 0.01, "expected ~0.0, got {score}");
        assert!(score < NSFW_LABEL_THRESHOLD);
    }

    #[test]
    fn nsfw_score_is_half_when_logits_equal() {
        let score = nsfw_score(&[2.5, 2.5]).expect("score");
        assert!(
            (score - 0.5).abs() < 1e-6,
            "equal logits → 0.5, got {score}"
        );
    }

    #[test]
    fn nsfw_score_errors_on_wrong_logit_count() {
        assert!(nsfw_score(&[]).is_err(), "empty must error");
        assert!(nsfw_score(&[1.0]).is_err(), "one logit must error");
        assert!(
            nsfw_score(&[1.0, 2.0, 3.0]).is_err(),
            "more than two logits must error (wrong model shape)"
        );
    }
}
