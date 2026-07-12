//! Port: plan limit enforcement.
//!
//! WHY: Abstracts plan limit checking behind a trait so self-hosted deployments
//! can use `AlwaysAllowedChecker` while the hosted service uses `PgPlanLimitChecker`.

use async_trait::async_trait;

use crate::domain::errors::DomainError;
use crate::domain::models::{Plan, PlanLimits, ServerId, UserId};

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

    /// Return the plan limits for a server. Used by services that need
    /// per-plan validation values (message length, topic length, edit window).
    /// Self-hosted returns `SELF_HOSTED_LIMITS`. (§1/§3/§5)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::NotFound` if the server does not exist,
    /// or `DomainError::Internal` on infrastructure failure.
    async fn get_server_plan_limits(&self, server_id: &ServerId)
    -> Result<PlanLimits, DomainError>;

    /// Return the server's `SaaS` plan tier, when one applies.
    ///
    /// Default `None` fits self-hosted deployments (no tiers) and test fakes;
    /// only the hosted Postgres checker reads a real plan. Callers use it to
    /// attach upgrade context to plan-gate rejections.
    ///
    /// # Errors
    ///
    /// Returns `DomainError::NotFound` if the server does not exist,
    /// or `DomainError::Internal` on infrastructure failure.
    async fn get_server_plan(&self, _server_id: &ServerId) -> Result<Option<Plan>, DomainError> {
        Ok(None)
    }

    /// Check if the user can create another server. (§1, per-user)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the owned server count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_owned_server_limit(&self, user_id: &UserId) -> Result<(), DomainError>;

    /// Check if the user can join another server. (§1, per-user)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the joined server count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_joined_server_limit(&self, user_id: &UserId) -> Result<(), DomainError>;

    // ── TODO(plan-limits-v3): §3 — Categories (per server) ──────────────
    //
    // async fn check_category_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    // Call from ChannelService when category model is added.
    //   Free: 50, Supporter: 50, Creator: 100.

    // ── TODO(plan-limits-v3): §4 — Roles (per server) ───────────────────
    //
    // async fn check_role_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    // Call from RoleService::create_role AFTER validation, BEFORE repo.create().
    //   Free: 20, Supporter: 250, Creator: 500.

    // ── TODO(plan-limits-v3): §5 — Messages (remaining) ──────────────────
    //
    // DONE: Message char limit (via get_server_plan_limits in MessageService::create + edit_message)
    // DONE: Edit window (via get_server_plan_limits in MessageService::edit_message)
    //
    // Message history cap (per channel):
    //   Free: 1M messages, Supporter: 50M, Creator: 500M.
    //   Implement when history trimming is added.
    //
    // Embeds per message:
    //   Free: 1, Supporter: 5, Creator: 10.
    //   Implement when embed model is added.

    // ── TODO(plan-limits-v3): §6 — Files (remaining) ─────────────────────
    //
    // DONE: Attachments per message (check_attachment_count below).
    // DONE: Per-file size (check_attachment_size below).
    //
    // async fn check_storage_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;
    //
    // check_storage_limit: compare SUM(size) from message_attachments against plan total.
    //   Free: 1 GB, Supporter: 50 GB, Creator: 200 GB.
    //   DEFERRED (attachments ticket §3.5) — needs a SUM aggregate per send AND a
    //   cleanup/reconciliation story on delete. Bundle with orphan-object cleanup.

    /// Check if a message may carry `count` attachments on this server's plan. (§6)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when `count` exceeds the plan's
    /// `max_attachments_per_message`, or `DomainError::Internal` on infrastructure failure.
    async fn check_attachment_count(
        &self,
        server_id: &ServerId,
        count: u64,
    ) -> Result<(), DomainError>;

    /// Check if a single attachment of `size_bytes` fits this server's plan cap. (§6)
    ///
    /// The 100MB `attachments` bucket cap is the hard security boundary; this is
    /// the per-plan UX/billing gate on the client-reported size (ticket decision D5).
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when `size_bytes` exceeds the plan's
    /// `max_attachment_size_bytes`, or `DomainError::Internal` on infrastructure failure.
    async fn check_attachment_size(
        &self,
        server_id: &ServerId,
        size_bytes: u64,
    ) -> Result<(), DomainError>;

    /// Check if adding another voice participant would exceed the server's plan limit. (§7)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the concurrent voice session count
    /// equals or exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_voice_concurrent(&self, server_id: &ServerId) -> Result<(), DomainError>;

    /// Check if the server can create another active invite. (§8)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the active invite count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_invite_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;

    // ── TODO(plan-limits-v3): §8 — Invite options (per server) ────────
    //
    // Duration options:
    //   Free: 24h/7d only, Supporter: +30d/never, Creator: all.
    // Max uses options:
    //   Free: 10/25/50, Supporter: +100/unlimited, Creator: unlimited.
    // Vanity URL:
    //   Creator only.

    /// Check if the server can add another custom emoji. (§9)
    ///
    /// RED LINE: Free's cap is **0**, so every Free POST fails here — custom
    /// emoji is a paid feature and this must never be relaxed.
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the emoji count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_emoji_limit(&self, server_id: &ServerId) -> Result<(), DomainError>;

    /// Check if the user can open another DM conversation. (§10, per-user)
    ///
    /// # Errors
    ///
    /// Returns `DomainError::LimitExceeded` when the open DM count equals or
    /// exceeds the plan limit, or `DomainError::Internal` on infrastructure failure.
    async fn check_dm_limit(&self, user_id: &UserId) -> Result<(), DomainError>;

    // ── TODO(plan-limits-v3): §10 — Group DMs (per user) ──────────────
    //
    // Group DM max size:
    //   Free: 5, Supporter: 15, Creator: 25.
    //   Implement when group DMs are added.

    // ── TODO(plan-limits-v3): §11 — Profile (per user) ──────────────────
    //
    // Bio length: Make ProfileService bio validation plan-aware.
    //   Free: 200 chars, Supporter: 500 chars, Creator: 1,000 chars.
    //
    // Avatar size:
    //   Free: 2 MB, Supporter: 5 MB, Creator: 10 MB.
    //   Implement when avatar upload is added.
    // Animated avatar: Supporter/Creator only.
    // Banner: Creator only.
    //
    // Custom status length:
    //   Free: 50 chars, Supporter: 128 chars, Creator: 128 chars.

    // ── TODO(plan-limits-v3): §12 — Rate limits (remaining) ─────────────
    //
    // DONE: Message rate (via get_server_plan_limits in MessageService::create)
    // DONE: Upload rate (max_uploads_per_min via SpamGuard in MessageService::create)
    //
    // API rate limit:
    //   Free: 30 req/min, Supporter: 120/min, Creator: 300/min.
    //   Implement as global rate limit middleware.

    // ── TODO(plan-limits-v3): §13 — Admin (per server) ──────────────────
    //
    // Audit log retention:
    //   Free: none, Supporter: 7 days, Creator: 90 days.
    // Bulk delete:
    //   Free: 10, Supporter: 50, Creator: 100.
    // Auto-mod rules:
    //   Free: 0, Supporter: 5, Creator: 25.
    // Webhooks (inbound):
    //   Free: 0, Supporter: 5, Creator: 25.
    // Webhooks (outbound):
    //   Free: 0, Supporter: 3, Creator: 15.
    // All implement when respective services are created.

    // ── TODO(plan-limits-v3): §14 — Bots/API (per server, future) ───────
    //
    // Bots: Free: 0, Supporter: 3, Creator: 10.
    // API endpoints: Free: 0, Supporter: 3, Creator: 15.
    // Implement when BotService is created.
}
