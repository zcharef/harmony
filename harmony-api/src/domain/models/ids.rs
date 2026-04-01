//! Strongly-typed IDs (newtypes) for domain entities.
//!
//! Using newtypes instead of raw `Uuid` prevents mixing up IDs
//! at compile time (e.g., passing a `UserId` where another ID is expected).

use serde::{Deserialize, Serialize};
use std::fmt;
use utoipa::ToSchema;
use uuid::Uuid;

/// Unique identifier for a user (Supabase auth.users UUID).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "550e8400-e29b-41d4-a716-446655440000")]
#[serde(transparent)]
pub struct UserId(pub Uuid);

impl UserId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for UserId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a server (guild).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "660e8400-e29b-41d4-a716-446655440001")]
#[serde(transparent)]
pub struct ServerId(pub Uuid);

impl ServerId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for ServerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for ServerId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a channel within a server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "770e8400-e29b-41d4-a716-446655440002")]
#[serde(transparent)]
pub struct ChannelId(pub Uuid);

impl ChannelId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for ChannelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for ChannelId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a message.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "880e8400-e29b-41d4-a716-446655440003")]
#[serde(transparent)]
pub struct MessageId(pub Uuid);

impl MessageId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for MessageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for MessageId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a role within a server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "990e8400-e29b-41d4-a716-446655440004")]
#[serde(transparent)]
pub struct RoleId(pub Uuid);

impl RoleId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for RoleId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for RoleId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a channel category.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "aa0e8400-e29b-41d4-a716-446655440005")]
#[serde(transparent)]
pub struct CategoryId(pub Uuid);

impl CategoryId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for CategoryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for CategoryId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a device key record.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "bb0e8400-e29b-41d4-a716-446655440006")]
#[serde(transparent)]
pub struct DeviceKeyId(pub Uuid);

impl DeviceKeyId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for DeviceKeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for DeviceKeyId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a one-time key record.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "cc0e8400-e29b-41d4-a716-446655440007")]
#[serde(transparent)]
pub struct OneTimeKeyId(pub Uuid);

impl OneTimeKeyId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for OneTimeKeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for OneTimeKeyId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Unique identifier for a Megolm session record.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "dd0e8400-e29b-41d4-a716-446655440008")]
#[serde(transparent)]
pub struct MegolmSessionId(pub Uuid);

impl MegolmSessionId {
    #[must_use]
    pub fn new(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

impl fmt::Display for MegolmSessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<Uuid> for MegolmSessionId {
    fn from(uuid: Uuid) -> Self {
        Self(uuid)
    }
}

/// Device identifier (client-generated string, not a UUID).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "ABCDEF123456")]
#[serde(transparent)]
pub struct DeviceId(pub String);

impl DeviceId {
    #[must_use]
    pub fn new(id: String) -> Self {
        Self(id)
    }

    /// Validated construction — returns error if device ID is empty, too long, or
    /// contains invalid characters.
    ///
    /// WHY: This is the `SSoT` for `DeviceId` validation. `new()` is kept for backward
    /// compatibility (deserialization, tests). Prefer `try_new()` at domain entry
    /// points for defense-in-depth.
    ///
    /// # Errors
    /// Returns a static error message if the ID is empty, exceeds 128 characters,
    /// or contains characters outside `[a-zA-Z0-9_-]`.
    pub fn try_new(id: String) -> Result<Self, &'static str> {
        if id.is_empty() {
            return Err("device_id cannot be empty");
        }
        if id.len() > 128 {
            return Err("device_id cannot exceed 128 characters");
        }
        // WHY: Restrict charset to prevent injection and encoding issues.
        if !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(
                "device_id may only contain alphanumeric characters, hyphens, and underscores",
            );
        }
        Ok(Self(id))
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<String> for DeviceId {
    fn from(id: String) -> Self {
        Self(id)
    }
}

/// Invite code for joining a server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[schema(example = "abc123XY")]
#[serde(transparent)]
pub struct InviteCode(pub String);

impl InviteCode {
    #[must_use]
    pub fn new(code: String) -> Self {
        Self(code)
    }
}

impl fmt::Display for InviteCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<String> for InviteCode {
    fn from(code: String) -> Self {
        Self(code)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── DeviceId::try_new ──────────────────────────────────────────

    #[test]
    fn device_id_valid() {
        let result = DeviceId::try_new("my-device_123".to_string());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().0, "my-device_123");
    }

    #[test]
    fn device_id_empty_rejected() {
        let result = DeviceId::try_new(String::new());
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "device_id cannot be empty");
    }

    #[test]
    fn device_id_too_long_rejected() {
        let long = "a".repeat(129);
        let result = DeviceId::try_new(long);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "device_id cannot exceed 128 characters"
        );
    }

    #[test]
    fn device_id_128_chars_accepted() {
        let exactly_128 = "a".repeat(128);
        let result = DeviceId::try_new(exactly_128.clone());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().0, exactly_128);
    }

    #[test]
    fn device_id_invalid_chars_rejected() {
        // Space and exclamation mark are not allowed.
        let result = DeviceId::try_new("my device!".to_string());
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "device_id may only contain alphanumeric characters, hyphens, and underscores"
        );
    }

    #[test]
    fn device_id_path_traversal_rejected() {
        let result = DeviceId::try_new("../../etc".to_string());
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "device_id may only contain alphanumeric characters, hyphens, and underscores"
        );
    }

    #[test]
    fn device_id_unicode_rejected() {
        let result = DeviceId::try_new("caf\u{00e9}".to_string());
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "device_id may only contain alphanumeric characters, hyphens, and underscores"
        );
    }

    #[test]
    fn device_id_special_chars_rejected() {
        let result = DeviceId::try_new("@#$%".to_string());
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "device_id may only contain alphanumeric characters, hyphens, and underscores"
        );
    }

    #[test]
    fn device_id_whitespace_padded_rejected() {
        let result = DeviceId::try_new(" valid-id ".to_string());
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err(),
            "device_id may only contain alphanumeric characters, hyphens, and underscores"
        );
    }
}
