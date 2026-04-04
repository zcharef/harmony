//! Domain services (business logic).
//!
//! Pure Rust, no infrastructure dependencies.

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
