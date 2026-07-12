//! Analytics handlers (client-emitted funnel events).

use axum::{extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::analytics::RecordAnalyticsEventRequest;
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{AnalyticsEvent, AnalyticsEventName};

/// WHY: property values are plan names / resource keys / error codes — all
/// short identifiers. A tight cap keeps hostile clients from stuffing the
/// analytics log with junk payloads.
const MAX_PROPERTY_LEN: usize = 64;

/// Record a client-side analytics event (paywall funnel).
///
/// Fire-and-forget on the server side: the insert is spawned and the
/// endpoint always returns 204 on valid input — analytics must never
/// block or fail a client flow.
///
/// # Errors
/// Returns `ApiError` when a property exceeds the length cap or the event
/// name is not client-emittable (rejected by deserialization).
#[utoipa::path(
    post,
    path = "/v1/analytics/events",
    tag = "Analytics",
    security(("bearer_auth" = [])),
    request_body = RecordAnalyticsEventRequest,
    responses(
        (status = 204, description = "Event recorded"),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn record_event(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<RecordAnalyticsEventRequest>,
) -> Result<impl IntoResponse, ApiError> {
    for (field, value) in [
        ("resource", req.resource.as_ref()),
        ("code", req.code.as_ref()),
        ("currentPlan", req.current_plan.as_ref()),
        ("recommendedPlan", req.recommended_plan.as_ref()),
        ("targetPlan", req.target_plan.as_ref()),
    ] {
        if let Some(v) = value
            && v.len() > MAX_PROPERTY_LEN
        {
            return Err(ApiError::bad_request(format!(
                "{field} must be at most {MAX_PROPERTY_LEN} characters"
            )));
        }
    }

    let mut properties = serde_json::Map::new();
    if let Some(resource) = req.resource {
        properties.insert("resource".to_string(), resource.into());
    }
    if let Some(code) = req.code {
        properties.insert("code".to_string(), code.into());
    }
    if let Some(current_plan) = req.current_plan {
        properties.insert("current_plan".to_string(), current_plan.into());
    }
    if let Some(recommended_plan) = req.recommended_plan {
        properties.insert("recommended_plan".to_string(), recommended_plan.into());
    }
    if let Some(target_plan) = req.target_plan {
        properties.insert("target_plan".to_string(), target_plan.into());
    }

    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::from(req.name))
            .user(user_id)
            .properties(serde_json::Value::Object(properties)),
    );

    Ok(StatusCode::NO_CONTENT)
}
