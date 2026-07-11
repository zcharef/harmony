//! Domain models for the Harmony API.
//!
//! These are pure domain entities with no infrastructure dependencies.

mod analytics;
mod ban;
mod channel;
mod crypto;
mod desktop_auth;
pub mod friendship;
mod ids;
mod invite;
mod megolm_session;
mod member;
mod message;
mod message_embed;
mod message_report;
mod message_with_author;
mod migration;
mod moderation;
mod moderation_log;
mod plan;
mod profile;
mod reaction;
mod read_state;
pub mod role;
mod server;
mod server_emoji;
pub mod server_event;
mod user_preferences;
mod voice_session;

pub use analytics::{AnalyticsEvent, AnalyticsEventName};
pub use ban::ServerBan;
pub use channel::{Channel, ChannelModerationContext, ChannelType};
pub use crypto::{ClaimedKey, DeviceKey, OneTimeKey, PreKeyBundle};
pub use desktop_auth::DesktopAuthCode;
pub use friendship::{
    BlockOutcome, BlockedUserRow, FriendRequestRow, FriendRow, Friendship, FriendshipStatus,
    RequestDirection, RequestOutcome,
};
pub use ids::{
    AttachmentId, CategoryId, ChannelId, DeviceId, DeviceKeyId, EmbedId, EmojiId, InviteCode,
    MegolmSessionId, MessageId, ModerationLogId, ModerationRetryId, OneTimeKeyId, ReportId, RoleId,
    SYSTEM_MODERATOR_ID, ServerId, UserId, VoiceSessionId,
};
pub use invite::Invite;
pub use megolm_session::MegolmSession;
pub use member::ServerMember;
pub use message::{
    ALLOWED_ATTACHMENT_MIME, ATTACHMENT_PUBLIC_PATH_MARKER, Attachment, AttachmentModerationStatus,
    MentionedUser, Message, MessageType, NewAttachment, ParentMessagePreview,
};
pub use message_embed::{MessageEmbed, NewEmbed, UnfurledPage};
pub use message_report::{
    MessageReport, NewMessageReport, ReportReason, ReportStatus, ReportedMessageSnapshot,
};
pub use message_with_author::MessageWithAuthor;
pub use migration::{
    ALIVE_MIN_ACTIVE_DAYS, ALIVE_MIN_DISTINCT_SENDERS, ALIVE_MIN_MEMBERS_JOINED,
    ALIVE_MIN_MESSAGES, ALIVE_MIN_NON_OWNER_ACTIVE, MemberCohortPage, MemberFollowThrough,
    MigrationProgress, NotYetActiveMember, RecommendedAction, ServerAliveSnapshot,
};
pub use moderation::{
    AttachmentScanRetry, EmojiImageScanRetry, IdentityImageScanRetry, ModerationRetry,
    ServerModerationSettings,
};
pub use moderation_log::{ModerationAction, ModerationLogEntry, NewModerationLogEntry};
pub use plan::{Plan, PlanLimits, ResourceKind};
pub use profile::{IdentityImageKind, IdentityImageModerationStatus, Profile, UserStatus};
pub use reaction::{EmojiVariety, ReactionSummary, Reactor};
pub use read_state::ChannelReadState;
pub use role::Role;
pub use server::{DiscoveryCursor, DiscoveryServer, Server};
pub use server_emoji::{EmojiName, ServerEmoji};
pub use server_event::{ChannelAccessScope, ServerEvent};
pub use user_preferences::UserPreferences;
pub use voice_session::{
    NewVoiceSession, VoiceAction, VoiceParticipant, VoiceRefreshToken, VoiceSession, VoiceToken,
};
