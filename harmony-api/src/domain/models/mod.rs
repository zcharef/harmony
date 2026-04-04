//! Domain models for the Harmony API.
//!
//! These are pure domain entities with no infrastructure dependencies.

mod ban;
mod channel;
mod crypto;
mod desktop_auth;
mod ids;
mod invite;
mod megolm_session;
mod member;
mod message;
mod message_with_author;
mod moderation;
mod plan;
mod profile;
mod reaction;
mod read_state;
pub mod role;
mod server;
pub mod server_event;
mod user_preferences;
mod voice_session;

pub use ban::ServerBan;
pub use channel::{Channel, ChannelType};
pub use crypto::{ClaimedKey, DeviceKey, OneTimeKey, PreKeyBundle};
pub use desktop_auth::DesktopAuthCode;
pub use ids::{
    CategoryId, ChannelId, DeviceId, DeviceKeyId, InviteCode, MegolmSessionId, MessageId,
    ModerationRetryId, OneTimeKeyId, RoleId, SYSTEM_MODERATOR_ID, ServerId, UserId, VoiceSessionId,
};
pub use invite::Invite;
pub use megolm_session::MegolmSession;
pub use member::ServerMember;
pub use message::{Message, MessageType, ParentMessagePreview};
pub use message_with_author::MessageWithAuthor;
pub use moderation::{ModerationRetry, ServerModerationSettings};
pub use plan::{Plan, PlanLimits, ResourceKind};
pub use profile::{Profile, UserStatus};
pub use reaction::ReactionSummary;
pub use read_state::ChannelReadState;
pub use role::Role;
pub use server::Server;
pub use server_event::ServerEvent;
pub use user_preferences::UserPreferences;
pub use voice_session::{NewVoiceSession, VoiceAction, VoiceSession, VoiceToken};
