//! Moderation settings DTOs (request/response types).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::ServerId;

/// Request body for updating server moderation settings (replace semantics).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateModerationSettingsRequest {
    /// Full desired state of Tier 2 category toggles.
    pub categories: HashMap<String, bool>,
}

/// Response for server moderation settings.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModerationSettingsResponse {
    pub server_id: ServerId,
    /// Current Tier 2 category toggles for this server.
    pub categories: HashMap<String, bool>,
    /// Informational: always-enforced Tier 1 categories (non-disableable).
    pub tier1_categories: Vec<String>,
    /// Available Tier 2 categories the admin can toggle.
    pub tier2_available: Vec<String>,
}

impl ModerationSettingsResponse {
    #[must_use]
    pub fn new(
        server_id: ServerId,
        categories: HashMap<String, bool>,
        tier1_categories: Vec<String>,
        tier2_available: Vec<String>,
    ) -> Self {
        Self {
            server_id,
            categories,
            tier1_categories,
            tier2_available,
        }
    }
}
