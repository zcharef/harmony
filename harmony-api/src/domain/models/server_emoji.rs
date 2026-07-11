//! Custom per-server emoji domain model.
//!
//! A [`ServerEmoji`] is an admin-uploaded image scoped to one server, addressed
//! in message content and reaction keys by the token `:name:`. The bytes live in
//! the `server-emojis` Storage bucket; the row stores the public URL only.

use chrono::{DateTime, Utc};

use crate::domain::errors::DomainError;

use super::IdentityImageModerationStatus;
use super::ids::{EmojiId, ServerId, UserId};

/// Minimum length of a custom emoji name.
const MIN_EMOJI_NAME_LEN: usize = 2;
/// Maximum length of a custom emoji name.
const MAX_EMOJI_NAME_LEN: usize = 32;

/// A validated custom-emoji name matching `^[a-z0-9_]{2,32}$`.
///
/// Constructed via [`EmojiName::parse`], which lowercases the input first
/// (Discord parity — names are case-insensitive and stored lowercase) and then
/// validates the character class and length. Parse, don't validate: once you
/// hold an `EmojiName` it is guaranteed well-formed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmojiName(String);

impl EmojiName {
    /// Parse and normalize a raw name into a validated [`EmojiName`].
    ///
    /// Lowercases first, then enforces `^[a-z0-9_]{2,32}$`.
    ///
    /// # Errors
    /// Returns `DomainError::ValidationError` when the normalized name is out of
    /// range or contains a character outside `[a-z0-9_]`.
    pub fn parse(raw: &str) -> Result<Self, DomainError> {
        let normalized = raw.trim().to_lowercase();

        let len = normalized.chars().count();
        if !(MIN_EMOJI_NAME_LEN..=MAX_EMOJI_NAME_LEN).contains(&len) {
            return Err(DomainError::ValidationError(format!(
                "Emoji name must be between {MIN_EMOJI_NAME_LEN} and {MAX_EMOJI_NAME_LEN} characters"
            )));
        }

        let valid = normalized
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if !valid {
            return Err(DomainError::ValidationError(
                "Emoji name may only contain lowercase letters, digits, and underscores"
                    .to_string(),
            ));
        }

        Ok(Self(normalized))
    }

    /// The normalized name, without the surrounding colons.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume into the owned `String`.
    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::fmt::Display for EmojiName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A custom server emoji row.
#[derive(Debug, Clone)]
pub struct ServerEmoji {
    pub id: EmojiId,
    pub server_id: ServerId,
    pub name: String,
    /// Public Storage URL of the emoji image. While `moderation_status` is
    /// `Pending` this is the candidate under scan — NOT shown to other members;
    /// it is revealed (via `emoji.created`) only when the async scan promotes it.
    pub url: String,
    pub is_animated: bool,
    pub created_by: UserId,
    /// Scan-before-reveal state: a newly-created emoji is `Pending` (invisible to
    /// other members) until the async image scan clears it to `Approved`; a
    /// flagged emoji is `Rejected` (its row is deleted, never revealed).
    pub moderation_status: IdentityImageModerationStatus,
    pub created_at: DateTime<Utc>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_valid_names() {
        assert_eq!(EmojiName::parse("fire").unwrap().as_str(), "fire");
        assert_eq!(EmojiName::parse("party_100").unwrap().as_str(), "party_100");
        assert_eq!(EmojiName::parse("ab").unwrap().as_str(), "ab");
        let at_max = "a".repeat(MAX_EMOJI_NAME_LEN);
        assert_eq!(EmojiName::parse(&at_max).unwrap().as_str(), at_max);
    }

    #[test]
    fn parse_lowercases() {
        assert_eq!(EmojiName::parse("Fire").unwrap().as_str(), "fire");
        assert_eq!(EmojiName::parse("PARTY").unwrap().as_str(), "party");
    }

    #[test]
    fn parse_rejects_too_short() {
        assert!(EmojiName::parse("x").is_err());
        assert!(EmojiName::parse("").is_err());
    }

    #[test]
    fn parse_rejects_too_long() {
        let over = "a".repeat(MAX_EMOJI_NAME_LEN + 1);
        assert!(EmojiName::parse(&over).is_err());
    }

    #[test]
    fn parse_rejects_bad_chars() {
        assert!(EmojiName::parse("bad-name").is_err()); // hyphen
        assert!(EmojiName::parse("bad name").is_err()); // space
        assert!(EmojiName::parse("bad.name").is_err()); // dot
        assert!(EmojiName::parse("\u{1f600}\u{1f600}").is_err()); // emoji/unicode
    }
}
