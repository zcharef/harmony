//! Port: plan limit enforcement.
//!
//! WHY: Abstracts plan limit checking behind a trait so self-hosted deployments
//! can use `AlwaysAllowedChecker` while the hosted service uses `PgPlanLimitChecker`.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::ServerId;

/// Checks whether a server has reached its plan limit for a given resource.
///
/// Implementations:
/// - `AlwaysAllowedChecker`: always returns `Ok(())` (self-hosted)
/// - `PgPlanLimitChecker`: reads `servers.plan` column and does COUNT queries (hosted)
#[async_trait]
pub trait PlanLimitChecker: Send + Sync + std::fmt::Debug {
    /// Check if the server can add another channel. (§3)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the channel count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_channel_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;

    /// Check if the server can add another member. (§2)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the member count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_member_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;

    // ── TODO(plan-limits-v2): §1 — Servers (per user) ───────────────────
    //
    // async fn check_owned_server_limit(&self, user_id: &UserId) -> Result<(), DomainError>;
    // async fn check_joined_server_limit(&self, user_id: &UserId) -> Result<(), DomainError>;
    //
    // Call check_owned_server_limit from ServerService::create_server BEFORE repo.create().
    //   Free: 3, Pro: 10, Community: 25.
    // Call check_joined_server_limit from InviteService::join_via_invite BEFORE join.
    //   Free: 10, Pro: 50, Community: 100.
    // NOTE: Per-user limits need profiles.plan or derived user plan.

    // ── TODO(plan-limits-v2): §3 — Categories (per server) ──────────────
    //
    // async fn check_category_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    // Call from ChannelService when category model is added.
    //   Free: 5, Pro: 20, Community: 50.

    // ── TODO(plan-limits-v2): §4 — Roles (per server) ───────────────────
    //
    // async fn check_role_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    // Call from RoleService::create_role AFTER validation, BEFORE repo.create().
    //   Free: 10, Pro: 50, Community: 250.

    // ── TODO(plan-limits-v2): §5 — Messages ─────────────────────────────
    //
    // Message char limit: Make MessageService::MAX_MESSAGE_LENGTH plan-aware.
    //   Free: 2,000 chars, Pro/Community: 4,000 chars.
    //   Requires PlanLimitChecker::get_server_plan() or inject plan into service.
    //
    // Edit window: Add time check in MessageService::edit_message.
    //   Free: 15 minutes, Pro/Community: unlimited.
    //
    // Message history cap (per channel):
    //   Free: 10,000 messages, Pro/Community: unlimited.
    //   Implement when history trimming is added.
    //
    // Embeds per message:
    //   Free: 1, Pro: 5, Community: 10.
    //   Implement when embed model is added.

    // ── TODO(plan-limits-v2): §6 — Files (per server) ───────────────────
    //
    // async fn check_storage_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    // async fn check_file_size(&self, server_id: &ServerId, file_bytes: u64) -> Result<(), DomainError>;
    //
    // check_storage_limit: compare SUM(file_size) from message_attachments against plan total.
    //   Free: 500 MB, Pro: 10 GB, Community: 50 GB.
    // check_file_size: compare individual file size against plan max_file_size_bytes.
    //   Free: 5 MB, Pro: 25 MB, Community: 50 MB.
    // Attachments per message:
    //   Free: 1, Pro: 5, Community: 10.
    // Allowed types:
    //   Free: images+PDF only, Pro/Community: all types.
    // Call from attachment upload handler BEFORE storing in Supabase Storage.

    // ── TODO(plan-limits-v2): §7 — Voice/Video (per server) ─────────────
    //
    // async fn check_voice_concurrent(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    //   Free: 5 concurrent, 3 voice channels, 64kbps, no video, 1h max.
    //   Pro: 25 concurrent, 20 channels, 128kbps, 720p, screen share, 8h.
    //   Community: 100 concurrent, 50 channels, 256kbps, 1080p, screen share, 24h.
    // Call from voice join handler when LiveKit integration lands (Phase 3).

    // ── TODO(plan-limits-v2): §8 — Invites (per server) ─────────────────
    //
    // async fn check_invite_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    // Call from InviteService::create_invite BEFORE repo.create().
    //   Free: 5 active, Pro: 25, Community: 100.
    //
    // Duration options:
    //   Free: 24h/7d only, Pro: +30d/never, Community: all.
    // Max uses options:
    //   Free: 10/25/50, Pro: +100/unlimited, Community: unlimited.
    // Vanity URL:
    //   Community only.

    // ── TODO(plan-limits-v2): §9 — Emoji (per server) ───────────────────
    //
    // async fn check_emoji_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    //   Free: 20 custom, 256KB, no animated, 10 reactions/msg.
    //   Pro: 100 custom, 512KB, animated, 20 reactions/msg.
    //   Community: 500 custom, 512KB, animated, 50 reactions/msg.
    // Implement when EmojiService is created.

    // ── TODO(plan-limits-v2): §10 — DMs (per user) ──────────────────────
    //
    // async fn check_dm_limit(&self, user_id: &UserId) -> Result<(), DomainError>;
    //
    // Call from DmService::create_or_get_dm BEFORE creating new DM.
    //   Free: 20 open, Pro: 100, Community: 500.
    // NOTE: Per-user limit, needs profiles.plan.
    //
    // Group DM max size:
    //   Free: 5, Pro: 10, Community: 25.
    //   Implement when group DMs are added.

    // ── TODO(plan-limits-v2): §11 — Profile (per user) ──────────────────
    //
    // Bio length: Make ProfileService bio validation plan-aware.
    //   Free: 200 chars, Pro/Community: 500 chars.
    //
    // Avatar size:
    //   Free: 2 MB, Pro: 5 MB, Community: 10 MB.
    //   Implement when avatar upload is added.
    // Animated avatar: Pro/Community only.
    // Banner: Community only.

    // ── TODO(plan-limits-v2): §12 — Rate limits (per user) ──────────────
    //
    // Message rate: Make MessageService::RATE_LIMIT_MAX plan-aware.
    //   Free: 5/5s, Pro: 10/5s, Community: 15/5s.
    //
    // Upload rate:
    //   Free: 3/min, Pro: 10/min, Community: 20/min.
    //   Implement when file upload is added.
    //
    // API rate limit:
    //   Free: 30 req/min, Pro: 120/min, Community: 300/min.
    //   Implement as global rate limit middleware.

    // ── TODO(plan-limits-v2): §13 — Admin (per server) ──────────────────
    //
    // Audit log retention:
    //   Free: none, Pro: 7 days, Community: 90 days.
    // Bulk delete:
    //   Free: 10, Pro: 50, Community: 100.
    // Auto-mod rules:
    //   Free: 0, Pro: 5, Community: 25.
    // Webhooks:
    //   Free: 0, Pro: 3, Community: 15.
    // All implement when respective services are created.

    // ── TODO(plan-limits-v2): §14 — Bots/API (per server, future) ───────
    //
    // Bots: Free: 0, Pro: 3, Community: 10.
    // API endpoints: Free: 0, Pro: 3, Community: 15.
    // Implement when BotService is created.
}
