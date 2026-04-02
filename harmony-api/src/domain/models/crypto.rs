//! E2EE crypto domain models.
//!
//! Device keys, one-time keys, and pre-key bundles for Olm session
//! establishment. These are pure domain structs with no infrastructure
//! dependencies.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::ids::{DeviceId, DeviceKeyId, OneTimeKeyId, UserId};

/// A registered device with its identity and signing keys.
///
/// One row per (user, device) pair. Required for Olm session establishment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceKey {
    pub id: DeviceKeyId,
    pub user_id: UserId,
    pub device_id: DeviceId,
    /// Curve25519 public key (base64-encoded).
    pub identity_key: String,
    /// Ed25519 public key (base64-encoded).
    pub signing_key: String,
    pub device_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_key_upload_at: DateTime<Utc>,
}

/// A one-time pre-key or fallback key for Olm session establishment.
///
/// One-time keys are consumed (deleted) when claimed. Fallback keys persist
/// until rotated.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OneTimeKey {
    pub id: OneTimeKeyId,
    pub user_id: UserId,
    pub device_id: DeviceId,
    pub key_id: String,
    /// Curve25519 public key (base64-encoded).
    pub public_key: String,
    pub is_fallback: bool,
    pub created_at: DateTime<Utc>,
}

/// A pre-key bundle returned to clients for Olm session establishment.
///
/// Contains the target device's identity keys plus one claimed key
/// (either a one-time key or the fallback key).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreKeyBundle {
    pub user_id: UserId,
    pub device_id: DeviceId,
    pub identity_key: String,
    pub signing_key: String,
    pub one_time_key: Option<ClaimedKey>,
    pub fallback_key: Option<ClaimedKey>,
}

/// A key that was claimed from the server during bundle fetching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimedKey {
    pub key_id: String,
    pub public_key: String,
}
