use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::errors::DomainError;
use crate::domain::models::Plan;

/// RFC 9457 Content-Type for Problem Details responses.
const PROBLEM_JSON: &str = "application/problem+json";

/// Machine-readable code: the plan's limit for the resource is zero — the
/// feature is not part of the current plan at all.
pub const CODE_FEATURE_NOT_IN_PLAN: &str = "FEATURE_NOT_IN_PLAN";

/// Machine-readable code: the plan includes the resource but its nonzero
/// allowance is used up.
pub const CODE_PLAN_LIMIT_REACHED: &str = "PLAN_LIMIT_REACHED";

/// Structured plan-gate details (RFC 9457 extension member, like `upgrade_url`).
///
/// WHY: The client paywall needs machine-usable facts — parsing them out of
/// the human-readable `detail` string would break on every copy change.
/// Field names are `snake_case` to match the established `upgrade_url`
/// extension member on `ProblemDetails`.
#[derive(Debug, Serialize, ToSchema)]
pub struct PlanGate {
    /// Stable resource key (e.g. `custom_emoji`, `owned_servers`).
    pub resource: String,
    /// The plan the rejected caller is currently on.
    pub current_plan: Plan,
    /// The current plan's limit for the resource (0 = feature not included).
    pub limit: u64,
    /// Lowest tier that unlocks or raises the resource. Absent when no tier
    /// does (already at the top tier's ceiling).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_plan: Option<Plan>,
}

/// RFC 9457 Problem Details response.
///
/// All API errors are returned in this standardized format.
#[derive(Debug, Serialize, ToSchema)]
pub struct ProblemDetails {
    #[serde(rename = "type")]
    pub type_uri: String,
    pub title: String,
    pub status: u16,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// WHY: Drives upsell when a plan limit is exceeded. The frontend renders
    /// an "Upgrade" CTA using this URL. Only present on `LimitExceeded` errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_url: Option<String>,
    /// Machine-readable error code (`FEATURE_NOT_IN_PLAN` / `PLAN_LIMIT_REACHED`).
    /// Only present on plan-gate rejections.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Structured plan-gate details for the client paywall.
    /// Only present on plan-gate rejections with a known tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_gate: Option<PlanGate>,
}

#[allow(dead_code)] // with_instance will be used when specific error types need instance URIs
impl ProblemDetails {
    pub fn new(status: StatusCode, title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            type_uri: "about:blank".to_string(),
            title: title.into(),
            status: status.as_u16(),
            detail: detail.into(),
            instance: None,
            upgrade_url: None,
            code: None,
            plan_gate: None,
        }
    }

    pub fn with_instance(mut self, instance: impl Into<String>) -> Self {
        self.instance = Some(instance.into());
        self
    }
}

/// API Result type for handlers.
#[allow(dead_code)] // Will be used by auth handlers in Tranche 1
pub type ApiResult<T> = Result<T, ApiError>;

/// API error that converts to RFC 9457 Problem Details.
#[derive(Debug)]
#[allow(dead_code)] // Will be used by auth handlers in Tranche 1
pub struct ApiError {
    pub status: StatusCode,
    pub problem: ProblemDetails,
}

#[allow(dead_code)] // Will be used by auth handlers in Tranche 1
impl ApiError {
    pub fn bad_request(detail: impl Into<String>) -> Self {
        let status = StatusCode::BAD_REQUEST;
        Self {
            status,
            problem: ProblemDetails::new(status, "Bad Request", detail),
        }
    }

    pub fn unauthorized(detail: impl Into<String>) -> Self {
        let status = StatusCode::UNAUTHORIZED;
        Self {
            status,
            problem: ProblemDetails::new(status, "Unauthorized", detail),
        }
    }

    pub fn forbidden(detail: impl Into<String>) -> Self {
        let status = StatusCode::FORBIDDEN;
        Self {
            status,
            problem: ProblemDetails::new(status, "Forbidden", detail),
        }
    }

    pub fn not_found(detail: impl Into<String>) -> Self {
        let status = StatusCode::NOT_FOUND;
        Self {
            status,
            problem: ProblemDetails::new(status, "Not Found", detail),
        }
    }

    pub fn conflict(detail: impl Into<String>) -> Self {
        let status = StatusCode::CONFLICT;
        Self {
            status,
            problem: ProblemDetails::new(status, "Conflict", detail),
        }
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        let status = StatusCode::INTERNAL_SERVER_ERROR;
        Self {
            status,
            problem: ProblemDetails::new(status, "Internal Server Error", detail),
        }
    }

    pub fn too_many_requests(detail: impl Into<String>) -> Self {
        let status = StatusCode::TOO_MANY_REQUESTS;
        Self {
            status,
            problem: ProblemDetails::new(status, "Too Many Requests", detail),
        }
    }

    pub fn bad_gateway(detail: impl Into<String>) -> Self {
        let status = StatusCode::BAD_GATEWAY;
        Self {
            status,
            problem: ProblemDetails::new(status, "Bad Gateway", detail),
        }
    }

    pub fn service_unavailable(title: impl Into<String>, detail: impl Into<String>) -> Self {
        let status = StatusCode::SERVICE_UNAVAILABLE;
        Self {
            status,
            problem: ProblemDetails::new(status, title, detail),
        }
    }

    /// Converts a domain error to an API error.
    /// Useful in `map_err` closures where `From` trait can't be used directly.
    #[must_use]
    pub fn from_domain(err: DomainError) -> Self {
        Self::from(err)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // WHY: ProblemDetails is a simple struct with known-serializable fields.
        // serde_json::to_vec cannot fail here unless the Serialize impl is broken,
        // which would be caught by compile-time + contract tests.
        let body = serde_json::to_vec(&self.problem).unwrap_or_else(|_| {
            br#"{"type":"about:blank","title":"Internal Server Error","status":500,"detail":"Failed to serialize error response"}"#.to_vec()
        });
        let mut response = (self.status, body).into_response();
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(PROBLEM_JSON));

        // WHY: RFC 9110 Section 10.5.9 — 429 responses SHOULD include a
        // Retry-After header so clients know when to retry.
        if self.status == StatusCode::TOO_MANY_REQUESTS {
            let seconds = parse_retry_seconds(&self.problem.detail);
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }

        response
    }
}

impl From<DomainError> for ApiError {
    fn from(err: DomainError) -> Self {
        match err {
            DomainError::NotFound { resource_type, id } => {
                ApiError::not_found(format!("{} with id '{}' not found", resource_type, id))
            }
            DomainError::ValidationError(msg) => ApiError::bad_request(msg),
            DomainError::Forbidden(msg) => ApiError::forbidden(msg),
            DomainError::Conflict(msg) => ApiError::conflict(msg),
            DomainError::LimitExceeded {
                resource,
                plan,
                limit,
            } => {
                let status = StatusCode::FORBIDDEN;
                let mut problem = match plan {
                    Some(plan) => {
                        // WHY the split: a zero limit means the plan does not
                        // include the feature AT ALL — "limit reached" phrasing
                        // would be wrong (nothing was reached) and the client
                        // paywall pitches "unlock" instead of "raise".
                        let (code, title, detail) = if limit == 0 {
                            (
                                CODE_FEATURE_NOT_IN_PLAN,
                                "Feature Not In Plan",
                                format!(
                                    "{} are not included in the {plan} plan",
                                    resource.display_name()
                                ),
                            )
                        } else {
                            (
                                CODE_PLAN_LIMIT_REACHED,
                                "Plan Limit Exceeded",
                                format!(
                                    "Plan limit reached: {limit} {} on the {plan} plan",
                                    resource.display_name()
                                ),
                            )
                        };
                        let mut problem = ProblemDetails::new(status, title, detail);
                        problem.code = Some(code.to_string());
                        problem.plan_gate = Some(PlanGate {
                            resource: resource.key().to_string(),
                            current_plan: plan,
                            limit,
                            required_plan: Plan::lowest_tier_unlocking(resource, limit),
                        });
                        problem
                    }
                    // WHY no code/plan_gate: without a tier (self-hosted)
                    // there is nothing to upsell — generic limit message only.
                    None => ProblemDetails::new(
                        status,
                        "Plan Limit Exceeded",
                        format!("Plan limit reached: {limit} {}", resource.display_name()),
                    ),
                };
                // WHY: Hardcoded for now. When billing is added (Phase 4), this
                // will come from config. YAGNI — no config mechanism until needed.
                problem.upgrade_url = Some("https://harmony.app/pricing".to_string());
                ApiError { status, problem }
            }
            // WHY: Already logged at the infrastructure layer (db_err, etc.)
            DomainError::Internal(_) => ApiError::internal("An internal error occurred"),
            DomainError::ExternalService(msg) => ApiError::bad_gateway(msg),
            DomainError::RateLimited(msg) => ApiError::too_many_requests(msg),
        }
    }
}

/// Extract seconds from rate-limit messages like "wait 42 seconds".
/// Falls back to a sensible default when no number is present (e.g. flood
/// mutes, duplicate detection, DM rate limits).
fn parse_retry_seconds(detail: &str) -> u64 {
    // WHY: Only the slow-mode message embeds a precise "wait N seconds" value.
    // All other RateLimited variants lack a number, so we fall back to 5s —
    // long enough to deter spam, short enough not to frustrate legitimate users.
    const DEFAULT_RETRY_SECS: u64 = 5;

    detail
        .split_whitespace()
        .find_map(|token| token.parse::<u64>().ok())
        .unwrap_or(DEFAULT_RETRY_SECS)
}
