//! Analytics DTOs (client-emitted funnel events).

use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::models::AnalyticsEventName;

/// Client-emittable analytics event names.
///
/// WHY a closed enum instead of a free string: the analytics log feeds
/// funnel dashboards — letting clients write arbitrary names would let a
/// hostile client forge server-owned funnel events (`server_created`, …)
/// or fragment the data with typos. Only paywall UI events, which the
/// server cannot observe itself, are accepted from clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClientAnalyticsEventName {
    PaywallViewed,
    PaywallCtaClicked,
    PaywallDismissed,
}

impl From<ClientAnalyticsEventName> for AnalyticsEventName {
    fn from(name: ClientAnalyticsEventName) -> Self {
        match name {
            ClientAnalyticsEventName::PaywallViewed => Self::PaywallViewed,
            ClientAnalyticsEventName::PaywallCtaClicked => Self::PaywallCtaClicked,
            ClientAnalyticsEventName::PaywallDismissed => Self::PaywallDismissed,
        }
    }
}

/// Request body for recording a client-side analytics event.
///
/// Properties are explicit typed fields (not a free JSON bag) so no PII can
/// ride along — the privacy contract of `analytics_events` (IDs and small
/// flags only) is enforced by the shape itself.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordAnalyticsEventRequest {
    pub name: ClientAnalyticsEventName,
    /// Stable resource key the paywall was shown for (e.g. `custom_emoji`).
    #[serde(default)]
    pub resource: Option<String>,
    /// Plan-gate code that triggered the paywall.
    #[serde(default)]
    pub code: Option<String>,
    /// The viewer's plan when the paywall fired.
    #[serde(default)]
    pub current_plan: Option<String>,
    /// The tier the paywall recommended.
    #[serde(default)]
    pub recommended_plan: Option<String>,
    /// The tier the CTA targets (for `paywall_cta_clicked`).
    #[serde(default)]
    pub target_plan: Option<String>,
}
