//! Domain services (business logic).
//!
//! Pure Rust, no infrastructure dependencies.

mod message_service;
mod profile_service;
mod server_service;

pub use message_service::MessageService;
pub use profile_service::ProfileService;
pub use server_service::ServerService;
