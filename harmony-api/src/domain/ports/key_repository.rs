//! Port: E2EE key persistence.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{DeviceId, DeviceKey, OneTimeKey, PreKeyBundle, UserId};

/// Intent-based repository for E2EE key distribution.
#[async_trait]
pub trait KeyRepository: Send + Sync + std::fmt::Debug {
    /// Register a device with its identity and signing keys.
    ///
    /// Upserts on (user_id, device_id) — re-registering a device replaces its keys.
    async fn register_device(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
        identity_key: &str,
        signing_key: &str,
        device_name: Option<&str>,
    ) -> Result<DeviceKey, DomainError>;

    /// List all registered devices for a user.
    async fn get_devices_for_user(
        &self,
        user_id: &UserId,
    ) -> Result<Vec<DeviceKey>, DomainError>;

    /// Remove a device and its associated one-time keys (CASCADE).
    async fn remove_device(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<(), DomainError>;

    /// Upload one-time keys (and/or fallback keys) for a device.
    ///
    /// Each tuple is `(key_id, public_key, is_fallback)`.
    async fn upload_one_time_keys(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
        keys: Vec<(String, String, bool)>,
    ) -> Result<(), DomainError>;

    /// Atomically claim and delete one non-fallback one-time key.
    ///
    /// Returns `None` if no non-fallback keys remain.
    async fn claim_one_time_key(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<Option<OneTimeKey>, DomainError>;

    /// Fetch the fallback key for a device (does not consume it).
    async fn get_fallback_key(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<Option<OneTimeKey>, DomainError>;

    /// Count remaining non-fallback one-time keys for a device.
    async fn count_one_time_keys(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<i64, DomainError>;

    /// Build a pre-key bundle for the first available device of a user.
    ///
    /// Atomically claims one OTK (or falls back to the fallback key).
    /// Returns `None` if the user has no registered devices.
    async fn get_pre_key_bundle(
        &self,
        user_id: &UserId,
    ) -> Result<Option<PreKeyBundle>, DomainError>;
}
