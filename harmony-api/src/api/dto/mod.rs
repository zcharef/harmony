//! Data Transfer Objects (request/response types).

pub mod bans;
pub mod channels;
pub mod desktop_auth;
pub mod dms;
pub mod invites;
pub mod keys;
pub mod members;
pub mod messages;
pub mod pagination;
pub mod profiles;
pub mod servers;

pub use bans::{BanListQuery, BanListResponse, BanResponse, BanUserRequest};
pub use channels::{
    ChannelListResponse, ChannelResponse, CreateChannelRequest, CreateMegolmSessionRequest,
    MegolmSessionResponse, UpdateChannelRequest,
};
pub use desktop_auth::{
    CreateDesktopAuthRequest, CreateDesktopAuthResponse, RedeemDesktopAuthRequest,
    RedeemDesktopAuthResponse,
};
pub use dms::{
    CreateDmRequest, DmLastMessageResponse, DmListItem, DmListQuery, DmListResponse,
    DmRecipientResponse, DmResponse,
};
pub use invites::{CreateInviteRequest, InvitePreviewResponse, InviteResponse, JoinServerRequest};
pub use keys::{
    ClaimedKeyResponse, DeviceListResponse, DeviceResponse, KeyCountResponse, OneTimeKeyDto,
    PreKeyBundleResponse, RegisterDeviceRequest, UploadOneTimeKeysRequest,
};
pub use members::{
    AssignRoleRequest, MemberListQuery, MemberListResponse, MemberResponse,
    TransferOwnershipRequest,
};
pub use messages::{
    EditMessageRequest, MessageListQuery, MessageListResponse, MessageResponse, SendMessageRequest,
};
pub use pagination::PaginatedResponse;
pub use profiles::{CheckUsernameQuery, CheckUsernameResponse, ProfileResponse};
pub use servers::{CreateServerRequest, ServerListResponse, ServerResponse, UpdateServerRequest};
