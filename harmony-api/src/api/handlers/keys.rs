//! E2EE key distribution handlers.

use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};

use crate::api::dto::{
    DeviceListResponse, DeviceResponse, KeyCountResponse, PreKeyBundleResponse,
    RegisterDeviceRequest, UploadOneTimeKeysRequest,
};
use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::{ApiJson, ApiPath, AuthUser};
use crate::api::state::AppState;
use crate::domain::models::{DeviceId, UserId};

/// Register a device with its identity and signing keys.
///
/// Upserts on (`user_id`, `device_id`) -- re-registering replaces existing keys.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/keys/device",
    tag = "Keys",
    security(("bearer_auth" = [])),
    request_body = RegisterDeviceRequest,
    responses(
        (status = 201, description = "Device registered", body = DeviceResponse),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn register_device(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<RegisterDeviceRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let device_id = DeviceId::try_new(req.device_id).map_err(ApiError::bad_request)?;

    let device = state
        .key_service()
        .register_device(
            &user_id,
            &device_id,
            &req.identity_key,
            &req.signing_key,
            req.device_name.as_deref(),
        )
        .await?;

    Ok((StatusCode::CREATED, Json(DeviceResponse::from(device))))
}

/// Upload one-time keys (and/or fallback keys) for a device.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    post,
    path = "/v1/keys/one-time",
    tag = "Keys",
    security(("bearer_auth" = [])),
    request_body = UploadOneTimeKeysRequest,
    responses(
        (status = 204, description = "Keys uploaded"),
        (status = 400, description = "Validation error", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state, req))]
pub async fn upload_one_time_keys(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiJson(req): ApiJson<UploadOneTimeKeysRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let device_id = DeviceId::try_new(req.device_id).map_err(ApiError::bad_request)?;
    let keys: Vec<(String, String, bool)> = req
        .keys
        .into_iter()
        .map(|k| (k.key_id, k.public_key, k.is_fallback))
        .collect();

    state
        .key_service()
        .upload_one_time_keys(&user_id, &device_id, keys)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Fetch a pre-key bundle for a target user (Olm session establishment).
///
/// Atomically claims one one-time key (or falls back to the fallback key).
///
/// # Errors
/// Returns `ApiError` if the user has no registered devices or on repository error.
#[utoipa::path(
    get,
    path = "/v1/keys/bundle/{user_id}",
    tag = "Keys",
    security(("bearer_auth" = [])),
    params(("user_id" = UserId, Path, description = "Target user ID")),
    responses(
        (status = 200, description = "Pre-key bundle", body = PreKeyBundleResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "No keys found for user", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_pre_key_bundle(
    AuthUser(_caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(target_user_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    let bundle = state
        .key_service()
        .get_pre_key_bundle(&target_user_id)
        .await?;

    Ok((StatusCode::OK, Json(PreKeyBundleResponse::from(bundle))))
}

/// List all registered devices for a user.
///
/// # Errors
/// Returns `ApiError` on repository error.
#[utoipa::path(
    get,
    path = "/v1/keys/devices/{user_id}",
    tag = "Keys",
    security(("bearer_auth" = [])),
    params(("user_id" = UserId, Path, description = "Target user ID")),
    responses(
        (status = 200, description = "Device list", body = DeviceListResponse),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn list_devices(
    AuthUser(_caller_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(target_user_id): ApiPath<UserId>,
) -> Result<impl IntoResponse, ApiError> {
    let devices = state.key_service().get_devices(&target_user_id).await?;

    Ok((
        StatusCode::OK,
        Json(DeviceListResponse::from_devices(devices)),
    ))
}

/// Remove a device and its associated keys.
///
/// Only the device owner can remove their own devices.
///
/// # Errors
/// Returns `ApiError` if the device does not exist or on repository error.
#[utoipa::path(
    delete,
    path = "/v1/keys/device/{device_id}",
    tag = "Keys",
    security(("bearer_auth" = [])),
    params(("device_id" = String, Path, description = "Device ID to remove")),
    responses(
        (status = 204, description = "Device removed"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
        (status = 404, description = "Device not found", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn remove_device(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    ApiPath(device_id_str): ApiPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    let device_id = DeviceId::try_new(device_id_str).map_err(ApiError::bad_request)?;

    state
        .key_service()
        .remove_device(&user_id, &device_id)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Get the count of remaining non-fallback one-time keys for the caller's device.
///
/// Clients use this to decide when to upload more one-time keys.
///
/// # Errors
/// Returns `ApiError` on validation failure or repository error.
#[utoipa::path(
    get,
    path = "/v1/keys/count",
    tag = "Keys",
    security(("bearer_auth" = [])),
    params(
        ("device_id" = String, Query, description = "Device ID to check key count for"),
    ),
    responses(
        (status = 200, description = "Key count", body = KeyCountResponse),
        (status = 400, description = "Missing device_id", body = ProblemDetails),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state))]
pub async fn get_key_count(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<KeyCountQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let device_id = DeviceId::try_new(params.device_id).map_err(ApiError::bad_request)?;

    let count = state
        .key_service()
        .get_one_time_key_count(&user_id, &device_id)
        .await?;

    Ok((StatusCode::OK, Json(KeyCountResponse::new(count))))
}

/// Query parameters for the key count endpoint.
#[derive(Debug, serde::Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct KeyCountQuery {
    /// Device ID to check key count for.
    pub device_id: String,
}
