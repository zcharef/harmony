//! `LiveKit` JWT token generator.
//!
//! Generates short-lived JWTs for voice channel participants using the
//! `livekit-api` crate's `AccessToken` builder. Tokens are scoped to a
//! single room with microphone-only publishing (no video, no screen share).

use std::time::Duration;

use livekit_api::access_token::{AccessToken, VideoGrants};
use secrecy::{ExposeSecret, SecretString};

use crate::domain::errors::DomainError;
use crate::domain::models::UserId;
use crate::domain::ports::{LiveKitTokenGenerator, VoiceGrants};

/// Default token TTL (2 hours). Balances usability against replay window.
/// Overridable via `LIVEKIT_TOKEN_TTL_SECS` env var.
const DEFAULT_MAX_TTL_SECS: u64 = 2 * 3600;

/// `LiveKit` token generator backed by the `livekit-api` crate.
///
/// Holds the `LiveKit` server URL and API credentials. Credentials are
/// stored as `SecretString` to prevent accidental logging.
pub struct LiveKitTokenService {
    url: String,
    api_key: SecretString,
    api_secret: SecretString,
    max_ttl_secs: u64,
}

// WHY: Manual Debug impl — SecretString already redacts, but we also
// redact api_key to avoid leaking even the key identifier in logs.
impl std::fmt::Debug for LiveKitTokenService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveKitTokenService")
            .field("url", &self.url)
            .field("api_key", &"[REDACTED]")
            .field("api_secret", &"[REDACTED]")
            .field("max_ttl_secs", &self.max_ttl_secs)
            .finish()
    }
}

impl LiveKitTokenService {
    #[must_use]
    pub fn new(
        url: String,
        api_key: SecretString,
        api_secret: SecretString,
        max_ttl_secs: u64,
    ) -> Self {
        Self {
            url,
            api_key,
            api_secret,
            max_ttl_secs,
        }
    }
}

impl LiveKitTokenGenerator for LiveKitTokenService {
    fn generate_token(
        &self,
        room_name: &str,
        user_id: &UserId,
        display_name: &str,
        grants: VoiceGrants,
    ) -> Result<String, DomainError> {
        let ttl_secs = grants.max_duration_secs.min(self.max_ttl_secs);

        let metadata = serde_json::json!({
            "bitrate_kbps": grants.bitrate_kbps,
            // TODO(e2ee): Add encryption key ID once E2EE is wired for voice channels.
        });

        let video_grants = VideoGrants {
            room_join: true,
            room: room_name.to_string(),
            can_publish: grants.can_publish,
            can_subscribe: grants.can_subscribe,
            // WHY: Restrict to microphone only — no video, no screen share.
            // This is a voice-only product; allowing other sources would bypass
            // the intended UX and inflate bandwidth costs.
            can_publish_sources: vec!["microphone".to_string()],
            ..VideoGrants::default()
        };

        let token = AccessToken::with_api_key(
            self.api_key.expose_secret(),
            self.api_secret.expose_secret(),
        )
        .with_identity(&user_id.to_string())
        .with_name(display_name)
        .with_metadata(&metadata.to_string())
        .with_grants(video_grants)
        .with_ttl(Duration::from_secs(ttl_secs))
        .to_jwt()
        .map_err(|e| {
            DomainError::ExternalService(format!("LiveKit token generation failed: {e}"))
        })?;

        Ok(token)
    }

    fn livekit_url(&self) -> &str {
        &self.url
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use livekit_api::access_token::{Claims, TokenVerifier};

    const TEST_KEY: &str = "test-api-key";
    const TEST_SECRET: &str = "test-api-secret-at-least-32-chars";

    /// WHY: Both `aws_lc_rs` and `rust_crypto` features are enabled (harmony-api
    /// uses `aws_lc_rs`, livekit-api uses `rust_crypto`). When both are active,
    /// `jsonwebtoken` v10 cannot auto-detect which provider to use and panics.
    /// We explicitly install one. `install_default` returns `Err` on subsequent
    /// calls (process-wide singleton) — harmless, hence `let _ =`.
    fn install_crypto_provider() {
        let _ = jsonwebtoken::crypto::aws_lc::DEFAULT_PROVIDER.install_default();
    }

    fn make_service() -> LiveKitTokenService {
        LiveKitTokenService::new(
            "wss://livekit.example.com".to_string(),
            SecretString::from(TEST_KEY.to_string()),
            SecretString::from(TEST_SECRET.to_string()),
            DEFAULT_MAX_TTL_SECS,
        )
    }

    fn make_grants() -> VoiceGrants {
        VoiceGrants {
            can_publish: true,
            can_subscribe: true,
            bitrate_kbps: 32,
            max_duration_secs: 3600,
        }
    }

    #[test]
    fn generates_valid_jwt() {
        install_crypto_provider();
        let service = make_service();
        let user_id = UserId::new(uuid::Uuid::new_v4());
        let token = service
            .generate_token("room-1", &user_id, "Alice", make_grants())
            .unwrap();

        let verifier = TokenVerifier::with_api_key(TEST_KEY, TEST_SECRET);
        let claims = verifier.verify(&token).unwrap();

        assert_eq!(claims.sub, user_id.to_string());
        assert_eq!(claims.name, "Alice");
        assert!(claims.video.room_join);
        assert_eq!(claims.video.room, "room-1");
        assert!(claims.video.can_publish);
        assert!(claims.video.can_subscribe);
        assert_eq!(claims.video.can_publish_sources, vec!["microphone"]);
    }

    #[test]
    fn metadata_contains_bitrate() {
        install_crypto_provider();
        let service = make_service();
        let user_id = UserId::new(uuid::Uuid::new_v4());
        let token = service
            .generate_token("room-1", &user_id, "Bob", make_grants())
            .unwrap();

        let claims = Claims::from_unverified(&token).unwrap();
        let meta: serde_json::Value = serde_json::from_str(&claims.metadata).unwrap();
        assert_eq!(meta["bitrate_kbps"], 32);
    }

    #[test]
    fn ttl_capped_at_default_max() {
        install_crypto_provider();
        let service = make_service();
        let user_id = UserId::new(uuid::Uuid::new_v4());
        let grants = VoiceGrants {
            max_duration_secs: 999_999,
            ..make_grants()
        };
        let token = service
            .generate_token("room-1", &user_id, "Eve", grants)
            .unwrap();

        let claims = Claims::from_unverified(&token).unwrap();
        // WHY: nbf is "now", exp is "now + ttl". The difference must be <= max_ttl_secs.
        let ttl = claims.exp - claims.nbf;
        // WHY: DEFAULT_MAX_TTL_SECS (7200) fits in usize on all targets
        #[allow(clippy::cast_possible_truncation)]
        let max_ttl: usize = DEFAULT_MAX_TTL_SECS as usize;
        assert!(
            ttl <= max_ttl,
            "TTL {ttl} exceeded cap {DEFAULT_MAX_TTL_SECS}"
        );
    }

    #[test]
    fn ttl_respects_custom_max() {
        install_crypto_provider();
        let custom_max: u64 = 1800; // 30 minutes
        let service = LiveKitTokenService::new(
            "wss://livekit.example.com".to_string(),
            SecretString::from(TEST_KEY.to_string()),
            SecretString::from(TEST_SECRET.to_string()),
            custom_max,
        );
        let user_id = UserId::new(uuid::Uuid::new_v4());
        let grants = VoiceGrants {
            max_duration_secs: 999_999,
            ..make_grants()
        };
        let token = service
            .generate_token("room-1", &user_id, "Eve", grants)
            .unwrap();

        let claims = Claims::from_unverified(&token).unwrap();
        let ttl = claims.exp - claims.nbf;
        #[allow(clippy::cast_possible_truncation)]
        let max_ttl: usize = custom_max as usize;
        assert!(ttl <= max_ttl, "TTL {ttl} exceeded custom cap {custom_max}");
    }

    #[test]
    fn livekit_url_returns_configured_url() {
        let service = make_service();
        assert_eq!(service.livekit_url(), "wss://livekit.example.com");
    }

    #[test]
    fn debug_redacts_api_secret() {
        let service = make_service();
        let debug = format!("{service:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(TEST_SECRET));
    }

    #[test]
    fn can_publish_false_propagates() {
        install_crypto_provider();
        let service = make_service();
        let user_id = UserId::new(uuid::Uuid::new_v4());
        let grants = VoiceGrants {
            can_publish: false,
            ..make_grants()
        };
        let token = service
            .generate_token("room-1", &user_id, "Muted", grants)
            .unwrap();

        let claims = Claims::from_unverified(&token).unwrap();
        assert!(!claims.video.can_publish);
    }
}
