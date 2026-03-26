//! E2EE key distribution domain service.

use std::sync::Arc;

use crate::domain::errors::DomainError;
use crate::domain::models::{ClaimedKey, DeviceId, DeviceKey, PreKeyBundle, UserId};
use crate::domain::ports::KeyRepository;

/// Maximum number of one-time keys per upload batch.
const MAX_KEYS_PER_UPLOAD: usize = 100;

/// Maximum key length in base64 characters (defense-in-depth).
const MAX_KEY_LENGTH: usize = 256;

/// Maximum device name length.
const MAX_DEVICE_NAME_LENGTH: usize = 128;

/// Service for E2EE key distribution business logic.
#[derive(Debug)]
pub struct KeyService {
    key_repo: Arc<dyn KeyRepository>,
}

impl KeyService {
    #[must_use]
    pub fn new(key_repo: Arc<dyn KeyRepository>) -> Self {
        Self { key_repo }
    }

    /// Register a device with its identity and signing keys.
    ///
    /// # Errors
    /// - `DomainError::ValidationError` if inputs exceed length limits.
    /// - Repository errors on failure.
    pub async fn register_device(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
        identity_key: &str,
        signing_key: &str,
        device_name: Option<&str>,
    ) -> Result<DeviceKey, DomainError> {
        validate_key("identity_key", identity_key)?;
        validate_key("signing_key", signing_key)?;
        validate_device_name(device_name)?;

        self.key_repo
            .register_device(user_id, device_id, identity_key, signing_key, device_name)
            .await
    }

    /// Upload one-time keys for a device.
    ///
    /// # Errors
    /// - `DomainError::ValidationError` if keys list is empty or exceeds batch limit.
    /// - Repository errors on failure.
    pub async fn upload_one_time_keys(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
        keys: Vec<(String, String, bool)>,
    ) -> Result<(), DomainError> {
        if keys.is_empty() {
            return Err(DomainError::ValidationError(
                "At least one key must be provided".to_string(),
            ));
        }

        if keys.len() > MAX_KEYS_PER_UPLOAD {
            return Err(DomainError::ValidationError(format!(
                "Cannot upload more than {} keys at once",
                MAX_KEYS_PER_UPLOAD
            )));
        }

        for (key_id, public_key, _) in &keys {
            if key_id.is_empty() || key_id.len() > MAX_KEY_LENGTH {
                return Err(DomainError::ValidationError(
                    "key_id must be non-empty and within length limits".to_string(),
                ));
            }
            validate_key("public_key", public_key)?;
        }

        // WHY: Verify the device belongs to the caller BEFORE hitting the repo.
        // Without this, a non-existent device_id causes a Postgres FK violation
        // that surfaces as an opaque DomainError::Internal (HTTP 500).
        let devices = self.key_repo.get_devices_for_user(user_id).await?;
        let device_exists = devices.iter().any(|d| d.device_id == *device_id);
        if !device_exists {
            return Err(DomainError::NotFound {
                resource_type: "DeviceKey",
                id: format!("user={}, device={}", user_id, device_id),
            });
        }

        self.key_repo
            .upload_one_time_keys(user_id, device_id, keys)
            .await
    }

    /// Build a pre-key bundle for a target user.
    ///
    /// Selects the first registered device, claims a one-time key (or falls
    /// back to the fallback key), and assembles the bundle. This orchestration
    /// belongs in the service layer, not the repository.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the user has no registered devices.
    /// - Repository errors on failure.
    pub async fn get_pre_key_bundle(
        &self,
        target_user_id: &UserId,
    ) -> Result<PreKeyBundle, DomainError> {
        // WHY: Fetch all devices and pick the first (by created_at).
        // In a multi-device scenario, clients should fetch bundles per-device.
        // For now, the first device is sufficient for the walking skeleton.
        let devices = self.key_repo.get_devices_for_user(target_user_id).await?;

        let device = devices
            .into_iter()
            .next()
            .ok_or_else(|| DomainError::NotFound {
                resource_type: "PreKeyBundle",
                id: target_user_id.to_string(),
            })?;

        // WHY: Try to claim a one-time key first; fall back to the fallback key
        // only when no OTKs remain. This preserves forward secrecy when possible.
        let claimed_otk = self
            .key_repo
            .claim_one_time_key(target_user_id, &device.device_id)
            .await?;

        let one_time_key = claimed_otk.as_ref().map(|k| ClaimedKey {
            key_id: k.key_id.clone(),
            public_key: k.public_key.clone(),
        });

        // WHY: Only fetch fallback if no OTK was available.
        let fallback_key = if claimed_otk.is_none() {
            self.key_repo
                .get_fallback_key(target_user_id, &device.device_id)
                .await?
                .map(|k| ClaimedKey {
                    key_id: k.key_id.clone(),
                    public_key: k.public_key.clone(),
                })
        } else {
            None
        };

        Ok(PreKeyBundle {
            user_id: device.user_id,
            device_id: device.device_id,
            identity_key: device.identity_key,
            signing_key: device.signing_key,
            one_time_key,
            fallback_key,
        })
    }

    /// List all registered devices for a user.
    ///
    /// # Errors
    /// Repository errors on failure.
    pub async fn get_devices(&self, user_id: &UserId) -> Result<Vec<DeviceKey>, DomainError> {
        self.key_repo.get_devices_for_user(user_id).await
    }

    /// Remove a device and its associated keys.
    ///
    /// # Errors
    /// - `DomainError::NotFound` if the device does not exist.
    /// - Repository errors on failure.
    pub async fn remove_device(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<(), DomainError> {
        self.key_repo.remove_device(user_id, device_id).await
    }

    /// Get the count of remaining non-fallback one-time keys for a device.
    ///
    /// # Errors
    /// Repository errors on failure.
    pub async fn get_one_time_key_count(
        &self,
        user_id: &UserId,
        device_id: &DeviceId,
    ) -> Result<i64, DomainError> {
        self.key_repo.count_one_time_keys(user_id, device_id).await
    }
}

/// Validate that a key value is non-empty and within length limits.
fn validate_key(field_name: &str, value: &str) -> Result<(), DomainError> {
    if value.is_empty() || value.len() > MAX_KEY_LENGTH {
        return Err(DomainError::ValidationError(format!(
            "{} must be non-empty and at most {} characters",
            field_name, MAX_KEY_LENGTH
        )));
    }
    Ok(())
}

/// Validate that a device name, when present, does not exceed the length limit
/// after trimming whitespace.
///
/// WHY: Extracted from `register_device` so that unit tests can verify the
/// pure validation logic without requiring a `KeyRepository`.
pub(crate) fn validate_device_name(name: Option<&str>) -> Result<(), DomainError> {
    if let Some(raw) = name {
        let trimmed = raw.trim();
        if trimmed.len() > MAX_DEVICE_NAME_LENGTH {
            return Err(DomainError::ValidationError(format!(
                "device_name must not exceed {} characters",
                MAX_DEVICE_NAME_LENGTH
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn max_keys_per_upload_constant() {
        assert_eq!(MAX_KEYS_PER_UPLOAD, 100);
    }

    #[test]
    fn max_device_name_length_constant() {
        assert_eq!(MAX_DEVICE_NAME_LENGTH, 128);
    }

    #[test]
    fn validate_key_rejects_empty() {
        let result = validate_key("test", "");
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert!(msg.contains("non-empty"), "got: {msg}");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn validate_key_accepts_valid() {
        let result = validate_key("test", "base64encodedkey==");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_key_rejects_too_long() {
        let long = "a".repeat(MAX_KEY_LENGTH + 1);
        let result = validate_key("test", &long);
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert!(msg.contains("at most 256 characters"), "got: {msg}");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn validate_key_accepts_at_max_length() {
        let exactly_max = "a".repeat(MAX_KEY_LENGTH);
        assert!(validate_key("test", &exactly_max).is_ok());
    }

    // ── device_name validation ─────────────────────────────────────

    #[test]
    fn device_name_valid() {
        assert!(validate_device_name(Some("My Laptop")).is_ok());
    }

    #[test]
    fn device_name_too_long_rejected() {
        let long = "a".repeat(129);
        let result = validate_device_name(Some(&long));
        assert!(result.is_err());
        match result.unwrap_err() {
            DomainError::ValidationError(msg) => {
                assert!(msg.contains("128"), "got: {msg}");
            }
            other => panic!("Expected ValidationError, got {:?}", other),
        }
    }

    #[test]
    fn device_name_128_chars_accepted() {
        let exactly_128 = "a".repeat(128);
        assert!(validate_device_name(Some(&exactly_128)).is_ok());
    }

    #[test]
    fn device_name_none_accepted() {
        assert!(validate_device_name(None).is_ok());
    }

    #[test]
    fn device_name_whitespace_only_accepted() {
        // WHY: The service trims then checks length. A whitespace-only name
        // trims to "" which is 0 chars — passes the length check.
        // Whether it *should* be rejected is a product decision; the current
        // code accepts it because there is no "non-empty after trim" rule.
        assert!(validate_device_name(Some("   ")).is_ok());
    }

    #[test]
    fn device_name_padded_accepted_when_core_within_limit() {
        // "  My Laptop  " trims to "My Laptop" (9 chars) — well within 128.
        assert!(validate_device_name(Some("  My Laptop  ")).is_ok());
    }
}
