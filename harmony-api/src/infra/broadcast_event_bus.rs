//! In-process event bus backed by `tokio::sync::broadcast`.
//!
//! Single-instance implementation of the `EventBus` port. When Harmony
//! scales past one Fly.io instance, swap this for a Redis Pub/Sub adapter
//! behind the same trait (ADR-SSE-002).

use tokio::sync::broadcast;

use crate::domain::models::ServerEvent;
use crate::domain::ports::EventBus;

/// Broadcast channel capacity.
///
/// WHY: 1024 provides ~10 seconds of headroom at 100 events/sec. If a slow
/// SSE consumer falls behind, `BroadcastStream` returns `Lagged` and the
/// handler logs + skips missed events. No data loss — clients invalidate
/// queries on reconnect (ADR-SSE-006).
const BROADCAST_CAPACITY: usize = 1024;

/// In-process event bus using `tokio::sync::broadcast`.
#[derive(Debug)]
pub struct BroadcastEventBus {
    sender: broadcast::Sender<ServerEvent>,
}

impl BroadcastEventBus {
    /// Create a new broadcast event bus with default capacity.
    #[must_use]
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self { sender }
    }

    /// Get a new receiver for the broadcast channel.
    ///
    /// Each SSE connection calls this once to get its own `Receiver`.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.sender.subscribe()
    }
}

impl Default for BroadcastEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus for BroadcastEventBus {
    fn publish(&self, event: ServerEvent) -> usize {
        // WHY: send() returns Err only when there are zero active receivers.
        // This is normal (no SSE clients connected) — not an error condition.
        self.sender.send(event).unwrap_or(0)
    }
}
