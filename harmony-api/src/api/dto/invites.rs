//! Invite DTOs (request/response types).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::models::{Invite, InviteCode, Profile, Server, ServerId, UserId};

/// Request body for creating a new invite.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInviteRequest {
    /// Maximum number of times this invite can be used. `None` means unlimited.
    #[serde(default)]
    pub max_uses: Option<i32>,
    /// Invite expires after this many hours. `None` means it never expires.
    #[serde(default)]
    pub expires_in_hours: Option<i32>,
}

/// Request body for joining a server via invite code.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinServerRequest {
    /// The invite code to use.
    pub invite_code: String,
}

/// Invite response returned to API consumers.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteResponse {
    pub code: InviteCode,
    pub server_id: ServerId,
    pub creator_id: UserId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i32>,
    pub use_count: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl From<Invite> for InviteResponse {
    fn from(inv: Invite) -> Self {
        Self {
            code: inv.code,
            server_id: inv.server_id,
            creator_id: inv.creator_id,
            max_uses: inv.max_uses,
            use_count: inv.use_count,
            expires_at: inv.expires_at,
            created_at: inv.created_at,
        }
    }
}

/// Public invite preview (no auth required).
///
/// Contains just enough information for a user to decide whether to join.
/// REDACTION CONTRACT: this is an UNAUTHENTICATED surface — never add member
/// lists, channel names, or any field beyond the ones below. The exact key
/// set is pinned by `preview_serializes_exactly_the_allowed_fields`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreviewResponse {
    pub code: InviteCode,
    pub server_id: ServerId,
    pub server_name: String,
    /// Server icon URL, `null` when the server has no icon.
    pub server_icon_url: Option<String>,
    pub member_count: i64,
    /// Display name of the invite creator ("Maya invited you").
    /// Falls back to the username; `null` when the profile no longer exists.
    pub inviter_display_name: Option<String>,
    /// Avatar URL of the invite creator, `null` when absent.
    pub inviter_avatar_url: Option<String>,
}

impl InvitePreviewResponse {
    /// WHY: This DTO aggregates data from four sources (invite, server,
    /// member count, inviter profile), so a simple From<DomainModel> is not
    /// possible. A constructor keeps the assembly logic out of the handler
    /// (ADR-023).
    #[must_use]
    pub fn new(
        invite: &Invite,
        server: &Server,
        member_count: i64,
        inviter: Option<&Profile>,
    ) -> Self {
        Self {
            code: invite.code.clone(),
            server_id: invite.server_id.clone(),
            server_name: server.name.clone(),
            server_icon_url: server.icon_url.clone(),
            member_count,
            // WHY display_name ?? username: same fallback as voice participant
            // names (handlers/voice.rs) — a blank display name renders as the
            // username, never as an empty string.
            inviter_display_name: inviter
                .map(|p| p.display_name.clone().unwrap_or_else(|| p.username.clone())),
            inviter_avatar_url: inviter.and_then(|p| p.avatar_url.clone()),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::collections::BTreeSet;

    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::domain::models::{Profile, Server, UserId, UserStatus};

    fn sample_invite(server_id: ServerId, creator_id: UserId) -> Invite {
        Invite {
            code: InviteCode::new("abc123XY".to_string()),
            server_id,
            creator_id,
            max_uses: None,
            use_count: 0,
            expires_at: None,
            created_at: Utc::now(),
        }
    }

    fn sample_server(owner_id: UserId) -> Server {
        let mut server = Server::new("Test Server".to_string(), owner_id);
        server.icon_url = Some("https://cdn.example.com/icon.png".to_string());
        server
    }

    fn sample_profile(id: UserId) -> Profile {
        let now = Utc::now();
        Profile {
            id,
            username: "maya".to_string(),
            display_name: Some("Maya".to_string()),
            avatar_url: Some("https://cdn.example.com/maya.png".to_string()),
            status: UserStatus::Offline,
            custom_status: None,
            bio: None,
            banner_url: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// REDACTION: the unauth preview must serialize EXACTLY these keys —
    /// nothing else may ever leak through this endpoint (ticket requirement).
    #[test]
    fn preview_serializes_exactly_the_allowed_fields() {
        let owner = UserId::new(Uuid::new_v4());
        let server = sample_server(owner.clone());
        let invite = sample_invite(server.id.clone(), owner.clone());
        let profile = sample_profile(owner);

        let dto = InvitePreviewResponse::new(&invite, &server, 42, Some(&profile));
        let json = serde_json::to_value(&dto).unwrap();

        let keys: BTreeSet<String> = json.as_object().unwrap().keys().cloned().collect();
        let allowed: BTreeSet<String> = [
            "code",
            "serverId",
            "serverName",
            "serverIconUrl",
            "memberCount",
            "inviterDisplayName",
            "inviterAvatarUrl",
        ]
        .into_iter()
        .map(String::from)
        .collect();

        assert_eq!(keys, allowed, "preview response leaked or dropped a field");
        assert_eq!(json["serverName"], "Test Server");
        assert_eq!(json["memberCount"], 42);
        assert_eq!(json["inviterDisplayName"], "Maya");
    }

    #[test]
    fn preview_inviter_display_name_falls_back_to_username() {
        let owner = UserId::new(Uuid::new_v4());
        let server = sample_server(owner.clone());
        let invite = sample_invite(server.id.clone(), owner.clone());
        let mut profile = sample_profile(owner);
        profile.display_name = None;

        let dto = InvitePreviewResponse::new(&invite, &server, 1, Some(&profile));
        let json = serde_json::to_value(&dto).unwrap();

        assert_eq!(json["inviterDisplayName"], "maya");
    }

    #[test]
    fn preview_missing_inviter_profile_yields_nulls_not_error() {
        let owner = UserId::new(Uuid::new_v4());
        let mut server = sample_server(owner.clone());
        server.icon_url = None;
        let invite = sample_invite(server.id.clone(), owner);

        let dto = InvitePreviewResponse::new(&invite, &server, 7, None);
        let json = serde_json::to_value(&dto).unwrap();

        assert_eq!(json["inviterDisplayName"], serde_json::Value::Null);
        assert_eq!(json["inviterAvatarUrl"], serde_json::Value::Null);
        assert_eq!(json["serverIconUrl"], serde_json::Value::Null);
    }
}
