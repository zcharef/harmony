//! Member handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::members::MemberListResponse;
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::ServerId;

/// List all members of a server.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/servers/{id}/members",
    tag = "Members",
    security(("bearer_auth" = [])),
    params(("id" = ServerId, Path, description = "Server ID")),
    responses(
        (status = 200, description = "Member list", body = MemberListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Server not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_members(
    AuthUser(_user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(server_id): ApiPath<ServerId>,
) -> Result<impl IntoResponse, ApiError> {
    let members = state.member_repository().list_by_server(&server_id).await?;

    Ok((
        StatusCode::OK,
        Json(MemberListResponse::from_members(members)),
    ))
}
