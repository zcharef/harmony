//! Domain services (business logic).
//!
//! Pure Rust, no infrastructure dependencies.

mod channel_access;
mod channel_service;
pub mod content_filter;
pub mod content_moderation;
pub mod dm_service;
mod invite_service;
mod key_service;
mod message_service;
mod moderation_service;
mod notification_settings_service;
mod profile_service;
mod reaction_service;
mod read_state_service;
mod server_service;
pub mod spam_guard;
mod user_preferences_service;
mod voice_service;

// WHY: `channel_access` is a private module, so its `pub(crate)` gate is not
// nameable from the API layer. Re-export the function (not the module) so
// handlers share the exact same access decision without widening the surface.
pub(crate) use channel_access::{ensure_channel_access, resolve_channel_access};
// WHY pub (not pub(crate)): the moderation-retry sweep in main.rs (the BIN
// crate, separate from this lib) resolves channel access to scope its
// MessageDeleted event — pub(crate) is invisible across the crate boundary.
pub use channel_access::resolve_channel_access_by_id;
pub use channel_service::ChannelService;
pub use content_filter::ContentFilter;
pub use content_moderation::{
    ModerationDecision, SCORE_THRESHOLD, TIER1_CATEGORIES, TIER2_CATEGORIES, evaluate_moderation,
};
pub use dm_service::DmService;
pub use invite_service::InviteService;
pub use key_service::KeyService;
pub use message_service::MessageService;
pub use moderation_service::ModerationService;
pub use notification_settings_service::NotificationSettingsService;
pub use profile_service::ProfileService;
pub use reaction_service::ReactionService;
pub use read_state_service::ReadStateService;
pub use server_service::ServerService;
pub use spam_guard::SpamGuard;
pub use user_preferences_service::UserPreferencesService;
pub use voice_service::VoiceService;
