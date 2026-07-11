//! Noop adult-NSFW classifier — the Phase 1 fallback.
//!
//! Always returns `Clean` (score `0.0`), so the whole scan pipeline (pending →
//! scan → approved → `MessageUpdated`) is exercised end to end with no external
//! dependency. Phase 2 swaps in an in-process `ONNX` `ViT` classifier; the pipeline
//! is unchanged. Also the fallback when the model path is unconfigured.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::ports::{ImageClassifier, NsfwLabel, NsfwVerdict};

/// Adult-NSFW classifier that never flags. Not a real detector.
#[derive(Debug, Clone, Default)]
pub struct NoopImageClassifier;

#[async_trait]
impl ImageClassifier for NoopImageClassifier {
    async fn classify_nsfw(&self, _bytes: &[u8], _mime: &str) -> Result<NsfwVerdict, DomainError> {
        Ok(NsfwVerdict {
            score: 0.0,
            label: NsfwLabel::Clean,
        })
    }
}
