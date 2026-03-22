//! Data Transfer Objects (request/response types).

pub mod bans;
pub mod channels;
pub mod dms;
pub mod invites;
pub mod members;
pub mod messages;
pub mod pagination;
pub mod profiles;
pub mod servers;

pub use bans::{BanListResponse, BanResponse, BanUserRequest};
pub use channels::{
    ChannelListResponse, ChannelResponse, CreateChannelRequest, UpdateChannelRequest,
};
pub use dms::{
    CreateDmRequest, DmLastMessageResponse, DmListItem, DmListQuery, DmListResponse,
    DmRecipientResponse, DmResponse,
};
pub use invites::{CreateInviteRequest, InvitePreviewResponse, InviteResponse, JoinServerRequest};
pub use members::{
    AssignRoleRequest, MemberListResponse, MemberResponse, TransferOwnershipRequest,
};
pub use messages::{
    EditMessageRequest, MessageListQuery, MessageListResponse, MessageResponse, SendMessageRequest,
};
pub use pagination::PaginatedResponse;
pub use profiles::ProfileResponse;
pub use servers::{CreateServerRequest, ServerListResponse, ServerResponse};
