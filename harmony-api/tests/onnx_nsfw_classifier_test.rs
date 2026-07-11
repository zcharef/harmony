#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! End-to-end inference against the REAL bundled ONNX NSFW model (Phase 2).
//!
//! Gated on `NSFW_TEST_MODEL_PATH` (and optional `NSFW_TEST_NSFW_IMAGE` /
//! `NSFW_TEST_CLEAN_IMAGE` fixtures) so it runs ONLY where the model + fixtures
//! are provisioned. This PUBLIC repo ships no model artifact and no explicit
//! imagery, so the test self-skips in CI and locally by default — a synthetic,
//! benign solid image is used as the clean proxy when no fixture is supplied.
//!
//! Run it with a converted model on disk by setting `NSFW_TEST_MODEL_PATH` to
//! the `nsfw.onnx` path before `cargo test`.
//!
//! WHY it lives in `tests/` and not `src/`: it reads env vars to locate the
//! model/fixtures, and `std::env::var` is banned outside `config.rs` in `src/`
//! (enforced by `rust_patterns_test`).

use harmony_api::domain::ports::{ImageClassifier, NsfwLabel};
use harmony_api::infra::OnnxNsfwClassifier;

/// Score at/above which the classifier labels bytes adult-NSFW (mirrors the
/// classifier's internal threshold; spec §d Phase 2: `<0.5` → clean).
const NSFW_LABEL_THRESHOLD: f32 = 0.5;

/// Encode a solid-color RGB PNG — a benign proxy fixture when none is provided.
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

fn model_path() -> Option<String> {
    std::env::var("NSFW_TEST_MODEL_PATH").ok()
}

/// A known-clean image (synthetic proxy by default) scores `<0.5` → `Clean`.
#[tokio::test]
async fn clean_image_scores_below_threshold() {
    let Some(path) = model_path() else {
        return; // model not provisioned — skip, not a failure
    };
    let classifier = OnnxNsfwClassifier::load(&path).expect("load real model");
    let bytes = match std::env::var("NSFW_TEST_CLEAN_IMAGE") {
        Ok(fixture) => std::fs::read(fixture).expect("read clean fixture"),
        Err(_) => solid_png(400, 400, [210, 205, 200]),
    };
    let verdict = classifier
        .classify_nsfw(&bytes, "image/png")
        .await
        .expect("classify clean");
    assert!(
        verdict.score < NSFW_LABEL_THRESHOLD,
        "a benign clean image must score <0.5, got {}",
        verdict.score
    );
    assert_eq!(verdict.label, NsfwLabel::Clean);
}

/// A known-explicit fixture scores `>=0.85` → `Nsfw`. Runs only when BOTH the
/// model AND an explicit fixture are provisioned (never committed to this repo).
#[tokio::test]
async fn explicit_fixture_scores_at_or_above_high_threshold() {
    let (Some(path), Ok(fixture)) = (model_path(), std::env::var("NSFW_TEST_NSFW_IMAGE")) else {
        return; // model or explicit fixture not provisioned — skip
    };
    let classifier = OnnxNsfwClassifier::load(&path).expect("load real model");
    let bytes = std::fs::read(fixture).expect("read explicit fixture");
    let verdict = classifier
        .classify_nsfw(&bytes, "image/jpeg")
        .await
        .expect("classify explicit");
    assert!(
        verdict.score >= 0.85,
        "a known-explicit image must score >=0.85, got {}",
        verdict.score
    );
    assert_eq!(verdict.label, NsfwLabel::Nsfw);
}

/// Corrupt/undecodable bytes fail-closed: the classifier errors (the scan then
/// dead-letters and the attachment stays `pending`, never revealed).
#[tokio::test]
async fn undecodable_bytes_error_fail_closed() {
    let Some(path) = model_path() else {
        return;
    };
    let classifier = OnnxNsfwClassifier::load(&path).expect("load real model");
    let result = classifier
        .classify_nsfw(b"definitely not an image", "image/png")
        .await;
    assert!(
        result.is_err(),
        "undecodable bytes must error, not classify"
    );
}
