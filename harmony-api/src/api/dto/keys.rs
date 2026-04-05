//! E2EE key distribution DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::domain::models::{ClaimedKey, DeviceId, DeviceKey, DeviceKeyId, PreKeyBundle, UserId};

/// Request body for registering a device with its identity keys.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterDeviceRequest {
    /// Client-generated device identifier.
    pub device_id: String,
    /// Curve25519 identity public key (base64-encoded).
    pub identity_key: String,
    /// Ed25519 signing public key (base64-encoded).
    pub signing_key: String,
    /// Optional human-readable device name (e.g., "My Laptop").
    pub device_name: Option<String>,
}

/// Request body for uploading one-time keys for a device.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadOneTimeKeysRequest {
    /// Device identifier these keys belong to.
    pub device_id: String,
    /// Batch of one-time keys to upload.
    pub keys: Vec<OneTimeKeyDto>,
}

/// A single one-time key in an upload batch.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OneTimeKeyDto {
    /// Unique key identifier (client-generated).
    pub key_id: String,
    /// Curve25519 public key (base64-encoded).
    pub public_key: String,
    /// Whether this is a fallback key (persists until rotated).
    pub is_fallback: bool,
}

/// Response for a registered device.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResponse {
    pub id: DeviceKeyId,
    pub user_id: UserId,
    pub device_id: DeviceId,
    pub identity_key: String,
    pub signing_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_key_upload_at: DateTime<Utc>,
}

impl From<DeviceKey> for DeviceResponse {
    fn from(dk: DeviceKey) -> Self {
        Self {
            id: dk.id,
            user_id: dk.user_id,
            device_id: dk.device_id,
            identity_key: dk.identity_key,
            signing_key: dk.signing_key,
            device_name: dk.device_name,
            created_at: dk.created_at,
            last_key_upload_at: dk.last_key_upload_at,
        }
    }
}

/// Envelope for a list of devices.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeviceListResponse {
    pub items: Vec<DeviceResponse>,
}

impl DeviceListResponse {
    #[must_use]
    pub fn from_devices(devices: Vec<DeviceKey>) -> Self {
        Self {
            items: devices.into_iter().map(DeviceResponse::from).collect(),
        }
    }
}

/// A claimed key in a pre-key bundle response.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedKeyResponse {
    pub key_id: String,
    pub public_key: String,
}

impl From<ClaimedKey> for ClaimedKeyResponse {
    fn from(ck: ClaimedKey) -> Self {
        Self {
            key_id: ck.key_id,
            public_key: ck.public_key,
        }
    }
}

/// Pre-key bundle response for Olm session establishment.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreKeyBundleResponse {
    pub user_id: UserId,
    pub device_id: DeviceId,
    pub identity_key: String,
    pub signing_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_time_key: Option<ClaimedKeyResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_key: Option<ClaimedKeyResponse>,
}

impl From<PreKeyBundle> for PreKeyBundleResponse {
    fn from(bundle: PreKeyBundle) -> Self {
        Self {
            user_id: bundle.user_id,
            device_id: bundle.device_id,
            identity_key: bundle.identity_key,
            signing_key: bundle.signing_key,
            one_time_key: bundle.one_time_key.map(ClaimedKeyResponse::from),
            fallback_key: bundle.fallback_key.map(ClaimedKeyResponse::from),
        }
    }
}

/// Response for one-time key count.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeyCountResponse {
    pub count: i64,
}

impl KeyCountResponse {
    #[must_use]
    pub fn new(count: i64) -> Self {
        Self { count }
    }
}

// WHY: Query parameter structs cannot use deny_unknown_fields because
// Axum's query deserializer passes all URL query params to the struct,
// and extra params (e.g., cache-busters) would cause 400 errors.
/// Query parameters for the key count endpoint.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
pub struct KeyCountQuery {
    /// Device ID to check key count for.
    pub device_id: DeviceId,
}
