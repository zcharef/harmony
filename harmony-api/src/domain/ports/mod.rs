//! Repository traits (ports) for hexagonal architecture.
//!
//! These traits define the contracts that infrastructure adapters must implement.

mod channel_repository;
mod message_repository;
mod profile_repository;
mod server_repository;

pub use channel_repository::ChannelRepository;
pub use message_repository::MessageRepository;
pub use profile_repository::ProfileRepository;
pub use server_repository::ServerRepository;
