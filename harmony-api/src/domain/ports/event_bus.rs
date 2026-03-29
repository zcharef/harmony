//! Port: event bus for real-time event delivery.
//!
//! Abstracts the broadcast mechanism so the domain and handlers depend on
//! a trait, not on `tokio::sync::broadcast` directly. Swap to Redis Pub/Sub
//! when scaling past a single instance (ADR-SSE-002).

use crate::domain::models::ServerEvent;

/// Publish-side of the event bus.
///
/// Handlers call `publish` after successful mutations. The bus fans out
/// the event to all connected SSE subscribers.
pub trait EventBus: Send + Sync + std::fmt::Debug {
    /// Publish an event to all connected subscribers.
    ///
    /// Returns the number of active receivers that received the event.
    /// A return value of `0` means no SSE clients are currently connected
    /// (which is normal — events are fire-and-forget).
    fn publish(&self, event: ServerEvent) -> usize;
}
