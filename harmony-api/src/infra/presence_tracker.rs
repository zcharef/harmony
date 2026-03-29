//! In-memory presence tracker backed by `DashMap`.
//!
//! Tracks which users are online, their status, and which servers they
//! belong to. Used by SSE connection lifecycle and the `POST /v1/presence`
//! endpoint. When Harmony scales past one instance, presence will need a
//! shared store (Redis) — same migration path as the event bus (ADR-SSE-002).

use std::time::{Duration, Instant};

use dashmap::DashMap;

use crate::domain::models::{ServerId, UserId, UserStatus};

/// A single user's presence state.
#[derive(Debug, Clone)]
pub struct PresenceEntry {
    /// Current status (Online, Idle, `DoNotDisturb`).
    pub status: UserStatus,
    /// Servers this user belongs to (for broadcasting presence to co-members).
    pub server_ids: Vec<ServerId>,
    /// Monotonic timestamp of last heartbeat (for stale-entry sweeps).
    pub last_heartbeat: Instant,
}

/// In-memory presence tracker using lock-free `DashMap`.
#[derive(Debug)]
pub struct PresenceTracker {
    entries: DashMap<UserId, PresenceEntry>,
}

impl PresenceTracker {
    /// Create a new empty presence tracker.
    #[must_use]
    pub fn new() -> Self {
        Self {
            entries: DashMap::new(),
        }
    }

    /// Mark a user as online with their server memberships.
    ///
    /// Inserts or replaces the entry. Heartbeat is set to now.
    pub fn set_online(&self, user_id: UserId, server_ids: Vec<ServerId>) {
        self.entries.insert(
            user_id,
            PresenceEntry {
                status: UserStatus::Online,
                server_ids,
                last_heartbeat: Instant::now(),
            },
        );
    }

    /// Update a user's status (e.g. Idle, `DoNotDisturb`) without changing `server_ids`.
    ///
    /// No-op if the user has no presence entry (not connected).
    pub fn set_status(&self, user_id: &UserId, status: UserStatus) {
        if let Some(mut entry) = self.entries.get_mut(user_id) {
            entry.status = status;
            entry.last_heartbeat = Instant::now();
        }
    }

    /// Remove a user's presence entry (they went offline).
    pub fn set_offline(&self, user_id: &UserId) {
        self.entries.remove(user_id);
    }

    /// Get a user's current status, or `None` if they have no presence entry.
    #[must_use]
    pub fn get_status(&self, user_id: &UserId) -> Option<UserStatus> {
        self.entries.get(user_id).map(|e| e.status.clone())
    }

    /// Return all online users for a given server with their current status.
    ///
    /// Iterates the full map — acceptable at small-to-medium scale. If this
    /// becomes a bottleneck, add a reverse index `ServerId -> Vec<UserId>`.
    #[must_use]
    pub fn get_server_presence(&self, server_id: &ServerId) -> Vec<(UserId, UserStatus)> {
        self.entries
            .iter()
            .filter(|entry| entry.value().server_ids.contains(server_id))
            .map(|entry| (entry.key().clone(), entry.value().status.clone()))
            .collect()
    }

    /// Remove entries whose heartbeat is older than `max_age`.
    ///
    /// Returns the `UserId`s that were removed (caller emits offline events).
    #[must_use]
    pub fn sweep_stale(&self, max_age: Duration) -> Vec<UserId> {
        let cutoff = Instant::now() - max_age;
        let mut removed = Vec::new();

        // WHY: retain() is the DashMap-idiomatic way to remove multiple entries
        // in a single pass without holding a ref across iterations.
        self.entries.retain(|user_id, entry| {
            if entry.last_heartbeat < cutoff {
                removed.push(user_id.clone());
                false
            } else {
                true
            }
        });

        removed
    }

    /// Refresh a user's heartbeat timestamp to now.
    ///
    /// No-op if the user has no presence entry.
    pub fn touch(&self, user_id: &UserId) {
        if let Some(mut entry) = self.entries.get_mut(user_id) {
            entry.last_heartbeat = Instant::now();
        }
    }
}

impl Default for PresenceTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::domain::models::UserStatus;
    use uuid::Uuid;

    fn user(n: u128) -> UserId {
        UserId(Uuid::from_u128(n))
    }

    fn server(n: u128) -> ServerId {
        ServerId(Uuid::from_u128(n))
    }

    #[test]
    fn set_online_and_get_status() {
        let tracker = PresenceTracker::new();
        let uid = user(1);

        assert!(tracker.get_status(&uid).is_none());

        tracker.set_online(uid.clone(), vec![server(10)]);

        assert_eq!(tracker.get_status(&uid).unwrap(), UserStatus::Online);
    }

    #[test]
    fn set_status_updates_without_changing_servers() {
        let tracker = PresenceTracker::new();
        let uid = user(2);
        let sid = server(20);

        tracker.set_online(uid.clone(), vec![sid.clone()]);
        tracker.set_status(&uid, UserStatus::DoNotDisturb);

        assert_eq!(tracker.get_status(&uid).unwrap(), UserStatus::DoNotDisturb);

        // server_ids unchanged
        let presence = tracker.get_server_presence(&sid);
        assert_eq!(presence.len(), 1);
        assert_eq!(presence[0].1, UserStatus::DoNotDisturb);
    }

    #[test]
    fn set_offline_removes_entry() {
        let tracker = PresenceTracker::new();
        let uid = user(3);

        tracker.set_online(uid.clone(), vec![server(30)]);
        tracker.set_offline(&uid);

        assert!(tracker.get_status(&uid).is_none());
    }

    #[test]
    fn get_server_presence_filters_by_server() {
        let tracker = PresenceTracker::new();
        let s1 = server(100);
        let s2 = server(200);

        tracker.set_online(user(1), vec![s1.clone(), s2.clone()]);
        tracker.set_online(user(2), vec![s1.clone()]);
        tracker.set_online(user(3), vec![s2.clone()]);

        let s1_presence = tracker.get_server_presence(&s1);
        assert_eq!(s1_presence.len(), 2); // user 1 and 2

        let s2_presence = tracker.get_server_presence(&s2);
        assert_eq!(s2_presence.len(), 2); // user 1 and 3

        let empty = tracker.get_server_presence(&server(999));
        assert!(empty.is_empty());
    }

    #[test]
    fn sweep_stale_removes_old_entries() {
        let tracker = PresenceTracker::new();
        let uid = user(4);

        tracker.set_online(uid.clone(), vec![server(40)]);

        // Manually backdating the heartbeat is not possible through the public API,
        // so we verify that a zero-duration sweep removes everything (heartbeat is
        // always in the past relative to the sweep's Instant::now()).
        // A non-zero max_age keeps fresh entries alive.

        // Fresh entry should survive a generous max_age
        let removed = tracker.sweep_stale(Duration::from_secs(60));
        assert!(removed.is_empty());
        assert!(tracker.get_status(&uid).is_some());

        // Zero max_age sweeps everything (entry was created in the past)
        let removed = tracker.sweep_stale(Duration::ZERO);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0], uid);
        assert!(tracker.get_status(&uid).is_none());
    }

    #[test]
    fn touch_refreshes_heartbeat() {
        let tracker = PresenceTracker::new();
        let uid = user(5);

        tracker.set_online(uid.clone(), vec![server(50)]);

        // Touch should keep the entry alive through a sweep
        tracker.touch(&uid);
        let removed = tracker.sweep_stale(Duration::from_secs(60));
        assert!(removed.is_empty());
        assert!(tracker.get_status(&uid).is_some());
    }

    #[test]
    fn set_status_noop_when_not_present() {
        let tracker = PresenceTracker::new();
        let uid = user(6);

        // Should not panic or insert an entry
        tracker.set_status(&uid, UserStatus::Idle);
        assert!(tracker.get_status(&uid).is_none());
    }
}
