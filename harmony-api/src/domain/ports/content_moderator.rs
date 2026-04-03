//! Port: async content moderation.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::domain::errors::DomainError;

/// Result of async AI text moderation (B4).
#[derive(Debug)]
pub struct ModerationResult {
    /// Whether the content was flagged by the moderation service.
    pub flagged: bool,
    /// Human-readable reason (e.g. "hate", "violence"). Empty if not flagged.
    pub reason: String,
    /// Per-category confidence scores from the moderation API (0.0-1.0).
    /// WHY `HashMap<String, f64>`: Keys are provider-specific category names
    /// (e.g., `OpenAI`'s "violence/graphic"). If switching providers, both
    /// this mapping and the tier classification constants in
    /// `content_moderation.rs` must be updated together.
    pub category_scores: HashMap<String, f64>,
    /// Per-category boolean flags from the moderation API.
    pub category_flags: HashMap<String, bool>,
}

/// Async content moderation port.
///
/// Implementations call external AI APIs (e.g. `OpenAI` Moderation) to check text content.
/// Used in `tokio::spawn` background tasks after message delivery.
#[async_trait]
pub trait ContentModerator: Send + Sync + std::fmt::Debug {
    /// Check text content for policy violations.
    ///
    /// # Errors
    /// Returns `DomainError::ExternalService` on API failures.
    async fn check_text(&self, text: &str) -> Result<ModerationResult, DomainError>;
}
