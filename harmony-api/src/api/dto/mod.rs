//! Data Transfer Objects (request/response types).

pub mod channels;
pub mod invites;
pub mod members;
pub mod messages;
pub mod pagination;
pub mod profiles;
pub mod servers;

pub use channels::{ChannelListResponse, ChannelResponse};
pub use invites::{CreateInviteRequest, InvitePreviewResponse, InviteResponse, JoinServerRequest};
pub use members::{MemberListResponse, MemberResponse};
pub use messages::{
    EditMessageRequest, MessageListQuery, MessageListResponse, MessageResponse, SendMessageRequest,
};
pub use pagination::PaginatedResponse;
pub use profiles::ProfileResponse;
pub use servers::{CreateServerRequest, ServerListResponse, ServerResponse};
