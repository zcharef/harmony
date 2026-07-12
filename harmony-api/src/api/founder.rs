//! Shared platform-founder authorization gate.
//!
//! "Founder" = the owner of the official server, resolved once at startup into
//! [`AppState::founder_id`]. This is the single definition used by the badge
//! admin endpoints and the founder-only admin endpoints, so the founder check
//! lives in exactly one place.
//!
//! SECURITY: the gate keys ONLY off the resolved founder `UserId` (owner of the
//! official server). It never trusts a client-supplied value or a badge — a
//! user who merely holds the `official`/`founding` badge is NOT the founder.

use crate::api::errors::ApiError;
use crate::api::state::AppState;
use crate::domain::models::UserId;

/// Gate an action behind the platform founder.
///
/// Returns `403 Forbidden` when the caller is not the founder, or when no
/// founder is configured (self-hosted/dev instances have no official server,
/// so these platform-admin surfaces are closed).
///
/// # Errors
/// Returns `ApiError` 403 if `caller_id` is not the resolved founder.
// WHY allow: `ApiError` carries an RFC 9457 `ProblemDetails` payload (>200 bytes);
// the Ok variant is `()`. Same trade-off the moderation handlers accept.
#[allow(clippy::result_large_err)]
pub fn require_platform_founder(state: &AppState, caller_id: &UserId) -> Result<(), ApiError> {
    if state.is_platform_founder(caller_id) {
        Ok(())
    } else {
        // WHY a generic message (not "you are not the founder"): never confirm
        // to a prober that this instance HAS a founder or who it is.
        Err(ApiError::forbidden(
            "This action requires platform-owner privileges",
        ))
    }
}
