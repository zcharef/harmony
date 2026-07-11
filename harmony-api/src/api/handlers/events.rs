//! SSE event stream handler.
//!
//! `GET /v1/events` — single persistent connection per user that delivers
//! all real-time events (messages, members, channels, DMs, presence).
//!
//! Auth: Bearer JWT via the `require_auth` middleware (same as all endpoints).

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio::sync::watch;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::AuthUser;
use crate::api::state::AppState;
use crate::domain::models::{
    AnalyticsEvent, AnalyticsEventName, ChannelAccessScope, Role, ServerEvent, ServerId, UserId,
    UserStatus,
};

/// Ends the wrapped broadcast stream at the first `Lagged` error.
///
/// WHY: A lagged consumer has permanently MISSED events — the broadcast
/// channel already overwrote them and there is no replay buffer. Skipping
/// the error and continuing would leave the client silently out of sync
/// until some unrelated reconnect. Terminating the stream instead makes the
/// client auto-reconnect, and reconnect IS the resync mechanism: the client
/// invalidates all queries on reconnect (ADR-SSE-006).
fn take_until_lagged<T>(
    stream: impl tokio_stream::Stream<Item = Result<T, BroadcastStreamRecvError>>,
) -> impl tokio_stream::Stream<Item = T> {
    stream
        .take_while(|result| match result {
            Ok(_) => true,
            Err(BroadcastStreamRecvError::Lagged(count)) => {
                tracing::warn!(
                    missed_events = *count,
                    "SSE consumer lagged behind broadcast — terminating stream to force client resync"
                );
                false
            }
        })
        .filter_map(Result::ok)
}

/// Guard that decrements a user's connection count when the SSE stream is dropped.
///
/// WHY: Without this, offline detection relies on the background sweep (60s interval,
/// 90s `max_age` = up to 150s delay). The guard fires instantly on disconnect.
///
/// Uses `PgPresenceTracker::disconnect()` which decrements the connection counter.
/// The offline event is only published when the last connection drops (count → 0),
/// so closing one tab while another is still open does NOT mark the user offline.
struct PresenceGuard {
    user_id: UserId,
    state: AppState,
    /// Live view of the user's server memberships + roles (kept current by
    /// Stage 1), so the offline event carries accurate routing scope at drop
    /// time. Only the key set (server IDs) is used for the offline event.
    server_ids: watch::Receiver<HashMap<ServerId, Role>>,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        let went_offline = self.state.presence_tracker().disconnect(&self.user_id);
        if went_offline {
            let event = ServerEvent::PresenceChanged {
                sender_id: self.user_id.clone(),
                user_id: self.user_id.clone(),
                status: UserStatus::Offline,
                server_ids: self.server_ids.borrow().keys().cloned().collect(),
            };
            self.state.event_bus().publish(event);
            tracing::info!(user_id = %self.user_id.0, "last SSE connection dropped, user marked offline");
        } else {
            tracing::debug!(user_id = %self.user_id.0, "SSE connection dropped, other connections remain");
        }
    }
}

/// Decides whether a `PresenceChanged` for `subject` is visible to `receiver`.
///
/// Visible when the receiver IS the subject (own status must sync across
/// tabs/devices), or when they share at least one server (DMs are servers, so
/// DM partners are covered). An EMPTY `subject_servers` means the publisher
/// could not scope the event (older instance during a rolling deploy, or a
/// membership lookup failure) — fail OPEN to the previous broadcast behavior
/// rather than silently dropping presence updates.
fn presence_visible_to(
    subject: &UserId,
    subject_servers: &[ServerId],
    receiver: &UserId,
    receiver_servers: &HashMap<ServerId, Role>,
    receiver_friends: &HashSet<UserId>,
) -> bool {
    if receiver == subject {
        return true;
    }
    if subject_servers.is_empty() {
        return true;
    }
    // Friendship is symmetric: "is the subject my friend?" answered from the
    // receiver's own friend set is exactly "am I in the subject's friend list?"
    // (§4.3). No payload change — the friend set is receiver-local.
    receiver_friends.contains(subject)
        || subject_servers
            .iter()
            .any(|sid| receiver_servers.contains_key(sid))
}

/// Decides whether a `ProfileUpdated` for `subject` is visible to `receiver`.
///
/// Same shared-server/DM overlap rule as `presence_visible_to`, with ONE
/// deliberate difference (F8): an EMPTY `subject_servers` fails CLOSED to the
/// subject only. For profile updates, empty means either a membership-lookup
/// failure at publish time (the publisher warns and scopes to self) or a user
/// with zero memberships — in both cases nobody but the subject's own
/// tabs/devices should receive the semi-public profile snapshot. Presence keeps
/// its fail-open broadcast for rolling-deploy back-compat; `ProfileUpdated`
/// never shipped without `server_ids`, so no such compat path exists here.
fn profile_visible_to(
    subject: &UserId,
    subject_servers: &[ServerId],
    receiver: &UserId,
    receiver_servers: &HashMap<ServerId, Role>,
) -> bool {
    if receiver == subject {
        return true;
    }
    subject_servers
        .iter()
        .any(|sid| receiver_servers.contains_key(sid))
}

/// Decides whether a channel-scoped event is visible to a receiver, given the
/// channel's access scope and the receiver's role in that server.
///
/// Mirrors `presence_visible_to` — a small pure function so the private-channel
/// gate is unit-testable in isolation (see the falsification test).
///
/// Variant-agnostic: since F5 it also gates the channel-lifecycle events
/// (`ChannelCreated/Updated/Deleted`) and `VoiceStateUpdate` — any event whose
/// `channel_access()` returns `Some` goes through this gate.
///
/// - `access == None` ⇒ PUBLIC channel ⇒ visible to every server member.
/// - `Some(scope)` ⇒ PRIVATE channel ⇒ visible iff the receiver is Owner/Admin
///   (implicit access) OR their role is in `scope.authorized_roles`.
/// - `receiver_role == None` (not a member — should not reach here past the
///   server gate) ⇒ denied for private channels.
fn channel_visible_to(access: Option<&ChannelAccessScope>, receiver_role: Option<Role>) -> bool {
    let Some(scope) = access else {
        return true; // public channel — deliver by server membership
    };
    match receiver_role {
        Some(Role::Owner | Role::Admin) => true,
        Some(role) => scope.authorized_roles.contains(&role),
        None => false,
    }
}

/// Aborts the wrapped task when dropped.
///
/// WHY: The presence-touch heartbeat runs as a spawned task, NOT as a stream
/// merged into the SSE response. A merged `IntervalStream` never completes, and
/// `merge` only ends when BOTH sides end — it would keep the HTTP response open
/// after `take_until_lagged` terminates the event stream, defeating the forced
/// reconnect (the client's keep-alive watchdog stays happy on `:heartbeat`
/// comments alone). Tying the task to the stream's drop keeps its lifetime
/// identical to the old merged version.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// SSE event stream — delivers real-time events to the authenticated user.
///
/// The stream filters events based on:
/// 1. **Server scope**: only events for servers the user is a member of.
/// 2. **User scope**: user-targeted events (DMs, bans) only for this user.
/// 3. **Sender exclusion**: message events skip the sender (client has
///    optimistic UI).
///
/// **Dynamic `server_ids`**: The filter set is updated in-flight when the user
/// joins/leaves a server or a DM is created targeting them. This eliminates
/// the need for client-side reconnects on membership changes.
///
/// The stream pipeline has two stages:
/// - **Stage 1 (intercept)**: `.map()` — detects membership-change events
///   affecting this user and updates the `watch` channel.
/// - **Stage 2 (filter + serialize)**: `.filter_map()` — reads the latest
///   `server_ids` from the `watch` channel to filter and serialize events.
///
/// On reconnect, the client invalidates all queries (ADR-SSE-006) — no
/// event buffering or `Last-Event-ID` replay needed.
///
/// **Presence lifecycle**: On connect, the user is marked online in the
/// `PgPresenceTracker` and a `PresenceChanged` event is emitted. A heartbeat
/// stream calls `touch()` every 30s so the background sweep (in main.rs)
/// knows the connection is still alive.
///
/// # Errors
/// Returns `ApiError` if the user's server list cannot be fetched.
#[utoipa::path(
    get,
    path = "/v1/events",
    tag = "Events",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "SSE event stream (text/event-stream)", content_type = "text/event-stream"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state), fields(user_id = %user_id.0))]
pub async fn sse_events(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    // Fetch the user's server memberships (with roles) to build the filter set.
    // WHY list_all_memberships_with_roles (not list_for_user): list_for_user
    // excludes DMs (correct for the sidebar API), but the SSE stream must include
    // DM events. The role is needed by Stage 2 to gate private-channel events.
    let memberships: HashMap<ServerId, Role> = state
        .server_service()
        .list_all_memberships_with_roles(&user_id)
        .await?
        .into_iter()
        .collect();
    // Key set for the connect-time presence wiring (unchanged behavior).
    let server_ids: HashSet<ServerId> = memberships.keys().cloned().collect();

    // WHY: Load the receiver's friend set for RECEIVER-SIDE presence scoping
    // (§4.3). Same `?` semantics as the memberships query — a failed connect is
    // an ApiError the client retries, never a silently mis-scoped stream.
    let friend_ids: HashSet<UserId> = state
        .friendship_service()
        .list_friend_ids(&user_id)
        .await?
        .into_iter()
        .collect();

    // WHY: watch channel allows Stage 1 (intercept) to update server_ids
    // in-flight when the user joins/leaves a server or receives a DM. Stage 2
    // (filter) reads the latest value via borrow(). This eliminates the need
    // for client-side SSE reconnects on membership changes.
    let (watch_tx, watch_rx) = watch::channel(memberships);
    // Second receiver for the disconnect guard: the offline event must carry
    // the CURRENT membership set, not the connect-time snapshot.
    let guard_watch_rx = watch_rx.clone();

    // Second watch channel: the receiver's friend set, kept current in-flight by
    // Stage 1 on FriendAdded/FriendRemoved so presence stays correctly scoped
    // without a reconnect (§4.3). Receiver-local — plays no role in publishing.
    let (friends_tx, friends_rx) = watch::channel(friend_ids.clone());

    // ── Presence: register connection, broadcast effective status ──
    // WHY: connect() returns the EFFECTIVE status atomically — a brand-new
    // presence is Online, but a reconnect or second-tab user who is dnd/idle
    // keeps that status. Broadcasting a hardcoded Online here would silently reset
    // DND to online for every observer on every SSE reconnect (routine on the
    // ~50-min JWT-rotation timer). Using connect()'s return value — rather than a
    // separate get_status() — guarantees this local broadcast matches the value
    // the cross-instance NOTIFY carries (no TOCTOU on a concurrent status change).
    let server_id_vec: Vec<ServerId> = server_ids.iter().cloned().collect();
    let effective_status = state
        .presence_tracker()
        .connect(user_id.clone(), server_id_vec);

    let presence_event = ServerEvent::PresenceChanged {
        sender_id: user_id.clone(),
        user_id: user_id.clone(),
        status: effective_status.clone(),
        server_ids: server_ids.iter().cloned().collect(),
    };

    // WHY: Subscribe BEFORE publish so the new subscriber does not miss
    // events published between publish() and subscribe() (race condition).
    let rx = state.event_bus().subscribe();

    let receivers = state.event_bus().publish(presence_event);
    tracing::info!(
        server_count = server_ids.len(),
        receivers,
        status = ?effective_status,
        "SSE connection established, presence broadcast"
    );

    // §10 traffic signal: session connect (fire-and-forget). Deliberately
    // NOT a retention "meaningful action" — connecting to browse an empty
    // server is not retention (Tempo).
    super::track(
        &state,
        AnalyticsEvent::new(AnalyticsEventName::SessionConnected).user(user_id.clone()),
    );

    // Clone user_id for the heartbeat stream, guard, and unread query before moving into event closures.
    let heartbeat_user_id = user_id.clone();
    let guard_user_id = user_id.clone();
    let intercept_user_id = user_id.clone();
    let unread_user_id = user_id.clone();

    // ── Stage 1 (intercept): update server_ids on membership changes ──
    // WHY: MemberJoined for a server the user just joined has server_id = X,
    // but X is NOT in the snapshot yet. Without this intercept, Stage 2 would
    // drop the event before the user ever sees it. By updating the watch
    // channel BEFORE filtering, Stage 2 sees the updated set for THIS event.
    let intercept_stream = BroadcastStream::new(rx).map(move |result| {
        let event = match result {
            Ok(ref event) => event,
            Err(_) => return result,
        };

        match event {
            // WHY: When THIS user joins a server, add the server_id (with the
            // joiner's role) so subsequent events (and this MemberJoined itself)
            // pass the filter. member.role carries the new member's role.
            ServerEvent::MemberJoined {
                server_id, member, ..
            } if member.user_id == intercept_user_id => {
                let sid = server_id.clone();
                let role = member.role;
                watch_tx.send_modify(|set| {
                    if set.insert(sid.clone(), role).is_none() {
                        tracing::debug!(
                            %sid,
                            ?role,
                            "server_ids watch: added (MemberJoined)"
                        );
                    }
                });
            }
            // WHY: When THIS user is removed from a server, remove the
            // server_id so subsequent events are no longer delivered.
            ServerEvent::MemberRemoved {
                server_id, user_id, ..
            } if *user_id == intercept_user_id => {
                let sid = server_id.clone();
                watch_tx.send_modify(|set| {
                    if set.remove(&sid).is_some() {
                        tracing::debug!(
                            %sid,
                            "server_ids watch: removed (MemberRemoved)"
                        );
                    }
                });
            }
            // WHY: When THIS user's role changes, update the stored role so
            // Stage 2's private-channel gate uses the fresh role immediately
            // (e.g. a demotion Moderator→Member loses access to a moderator-only
            // channel with no SSE reconnect). member.role is the NEW role; keyed
            // on member.user_id (the subject). get_mut only updates an EXISTING
            // membership — a role update never grants membership on its own.
            ServerEvent::MemberRoleUpdated {
                server_id, member, ..
            } if member.user_id == intercept_user_id => {
                let sid = server_id.clone();
                let role = member.role;
                watch_tx.send_modify(|set| {
                    if let Some(current) = set.get_mut(&sid) {
                        *current = role;
                        tracing::debug!(
                            %sid,
                            ?role,
                            "server_ids watch: role updated (MemberRoleUpdated)"
                        );
                    }
                });
            }
            // WHY: DmCreated carries sender_id (creator) and target_user_id
            // (recipient). Both participants need the DM server_id in their
            // filter sets to receive messages. The recipient matches on
            // target_user_id; the creator matches on sender_id. Role is
            // irrelevant (DM channels are never private) — store Member.
            ServerEvent::DmCreated {
                sender_id,
                target_user_id,
                dm,
            } if *target_user_id == intercept_user_id || *sender_id == intercept_user_id => {
                let sid = dm.server_id.clone();
                watch_tx.send_modify(|set| {
                    if set.insert(sid.clone(), Role::Member).is_none() {
                        tracing::debug!(
                            %sid,
                            "server_ids watch: added (DmCreated)"
                        );
                    }
                });
            }
            // WHY: keep this receiver's friend set current so friend-only presence
            // stays scoped without a reconnect (§4.3). Block-induced removals also
            // publish FriendRemoved, so they are covered by the same arm.
            ServerEvent::FriendAdded {
                target_user_id,
                friend,
                ..
            } if *target_user_id == intercept_user_id => {
                let fid = friend.user_id.clone();
                friends_tx.send_modify(|set| {
                    set.insert(fid);
                });
            }
            ServerEvent::FriendRemoved {
                target_user_id,
                user_id,
                ..
            } if *target_user_id == intercept_user_id => {
                let fid = user_id.clone();
                friends_tx.send_modify(|set| {
                    set.remove(&fid);
                });
            }
            _ => {}
        }

        result
    });

    // ── Stage 2 (filter + serialize): apply server_ids filter ─────────
    // WHY take_until_lagged between the stages: on broadcast lag the stream
    // must END (forcing the client to reconnect and resync, ADR-SSE-006)
    // rather than skip the error and keep a permanently out-of-sync client.
    let event_stream = take_until_lagged(intercept_stream).filter_map(move |event| {
        // WHY: Read the LATEST server_ids from the watch channel. Stage 1
        // may have just updated it for this very event (e.g. MemberJoined
        // adding a new server_id), so borrow() reflects the new state.
        let current_server_ids = watch_rx.borrow();
        // Latest friend set for receiver-side presence scoping (§4.3).
        let current_friends = friends_rx.borrow();

        // ── Filter: target_user_id BEFORE server scope ────────────
        // WHY: Events like ForceDisconnect and MemberBanned have BOTH
        // server_id and target_user_id. If the server-scope filter ran
        // first, it would pass the event through to all server members.
        // But these are directed — only the target should receive them.
        // Checking target_user_id first also handles the race where
        // a kicked/banned user's server_ids snapshot no longer contains
        // the server (the event would be dropped before reaching them).
        if let Some(target) = event.target_user_id() {
            // WHY: DmCreated carries both sender_id and target_user_id.
            // Both participants need the event — the recipient (target)
            // and the creator on their OTHER devices (multi-device support).
            // Other targeted events (ForceDisconnect, MemberBanned) only
            // go to the target, so this check is DmCreated-specific.
            let is_dm_sender = matches!(
                &event,
                ServerEvent::DmCreated { sender_id, .. } if *sender_id == user_id
            );
            if *target != user_id && !is_dm_sender {
                return None; // Not for this user
            }
            // IS for this user — bypass server_ids check
        } else if let Some(event_server_id) = event.server_id()
            && !current_server_ids.contains_key(event_server_id)
        {
            return None; // User not in this server
        }

        // ── Filter: private-channel access ─────────────────────────
        // WHY: A server member WITHOUT a grant to a PRIVATE channel must not
        // receive its message/reaction/typing events — otherwise plaintext
        // `MessagePayload.content` (and deletes/typing/reactions) leak — nor its
        // channel-lifecycle/voice events (F5) — otherwise the channel's
        // name/topic and voice roster leak. The event
        // carries the channel's authorized-role set as routing metadata; drop
        // unless the receiver's role in that server grants access. `None` scope =
        // public channel = deliver. The metadata is redacted below before serialize.
        if let Some(scope) = event.channel_access() {
            let receiver_role = event
                .server_id()
                .and_then(|sid| current_server_ids.get(sid).copied());
            if !channel_visible_to(Some(scope), receiver_role) {
                return None;
            }
        }

        // ── Filter: presence scope (shared server / DM / self) ─────
        // WHY: PresenceChanged has neither target_user_id nor server_id, so it
        // used to reach EVERY connected user — leaking online status (and its
        // timing) to strangers with no shared server or DM. The event now
        // carries the subject's memberships as routing metadata; deliver only
        // on overlap with this receiver's memberships (or to the subject
        // itself). The metadata is redacted below before serialization.
        if let ServerEvent::PresenceChanged {
            user_id: subject,
            server_ids: subject_servers,
            ..
        } = &event
            && !presence_visible_to(
                subject,
                subject_servers,
                &user_id,
                &current_server_ids,
                &current_friends,
            )
        {
            return None;
        }

        // ── Filter: profile scope (shared server / DM / self) ──────
        // WHY: ProfileUpdated, like PresenceChanged, carries neither
        // target_user_id nor server_id, so it would otherwise reach EVERY
        // connected user — leaking a display-name/avatar change (and its
        // timing) to strangers. It carries the subject's memberships as routing
        // metadata; `profile_visible_to` delivers only to users sharing a
        // server/DM (or the subject's own tabs) and — unlike presence — fails
        // CLOSED to self on an empty scope (F8: a membership-lookup failure
        // must not broadcast the profile to everyone). The metadata is
        // redacted below before serialization.
        if let ServerEvent::ProfileUpdated {
            user_id: subject,
            server_ids: subject_servers,
            ..
        } = &event
            && !profile_visible_to(subject, subject_servers, &user_id, &current_server_ids)
        {
            return None;
        }

        // Explicitly drop the borrows before serialization to release the locks.
        drop(current_server_ids);
        drop(current_friends);

        // ── Redact routing metadata from the client payload ────────
        // WHY: `channel_access` (private-channel gate) and `server_ids`
        // (presence scope) are delivery-routing only — never for clients. One
        // exhaustive method on the event (co-located with the field defs) empties
        // them; `skip_serializing_if` then omits the emptied fields, keeping the
        // client JSON byte-identical. Using the method (not a local rebuild)
        // makes it a compile error to forget a future scoped variant.
        let mut event = event;
        event.redact_routing_metadata();

        // ── Filter: sender exclusion (create/update only) ──────────
        // WHY: The sender already has optimistic UI for create and update.
        // message.deleted is NOT suppressed because moderation-triggered
        // deletions use the message author as sender_id — suppressing them
        // would prevent the author from seeing their message disappear.
        // The frontend handler (handleMessageDeleted) is idempotent, so
        // user-initiated deletes arriving twice (optimistic + SSE) are harmless.
        let is_self_echo = matches!(event.event_name(), "message.created" | "message.updated");
        if is_self_echo && *event.sender_id() == user_id {
            return None;
        }

        // Serialize the event payload as JSON for the SSE `data:` field.
        let data = match serde_json::to_string(&event) {
            Ok(json) => json,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    event_type = event.event_name(),
                    "Failed to serialize SSE event"
                );
                return None;
            }
        };

        Some(Ok(Event::default().event(event.event_name()).data(data)))
    });

    // ── Heartbeat task: calls touch() every 30s ─────────────────
    // WHY: The background sweep task (main.rs) removes presence entries
    // with last_heartbeat older than 90s. This touch keeps the entry
    // alive as long as the SSE connection is open. The 30s interval
    // matches the SSE keep-alive, giving a 60s buffer before sweep.
    // WHY a spawned task and not a stream merged into the response: see
    // `AbortOnDrop` — a merged interval stream never ends and would hold the
    // response open after the event stream terminates on broadcast lag.
    // WHY: AppState is cheap to clone (all fields are Arc).
    let heartbeat_state = state.clone();
    let heartbeat_guard = AbortOnDrop(tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            heartbeat_state.presence_tracker().touch(&heartbeat_user_id);
        }
    }));

    // ── Presence snapshot: initial sync event ───────────────────
    // WHY: Clients that connect after other users are already online have no
    // way to learn their status — PresenceChanged events are ephemeral.
    // Emitting a presence.sync event as the first SSE event gives every client
    // a full snapshot on connect (and reconnect). This is the "initial snapshot
    // + incremental deltas" pattern (à la Discord READY).
    // WHY not in ServerEvent enum: this is a per-connection synthetic event,
    // never published to the broadcast bus.
    let mut presence_users: HashMap<String, UserStatus> = HashMap::new();
    for sid in &server_ids {
        for (uid, status) in state.presence_tracker().get_server_presence(sid) {
            presence_users.insert(uid.0.to_string(), status);
        }
    }
    // WHY: friends without a shared server would otherwise be absent from the
    // snapshot and render offline until their next transition (§4.3.5). Merge
    // their live status from the same connect-time friend set.
    let friend_id_vec: Vec<UserId> = friend_ids.iter().cloned().collect();
    for (uid, status) in state.presence_tracker().get_users_presence(&friend_id_vec) {
        presence_users.insert(uid.0.to_string(), status);
    }
    let presence_data = serde_json::json!({
        "type": "presenceSynced",
        "users": presence_users,
    });
    let presence_event = Event::default()
        .event("presence.sync")
        .data(presence_data.to_string());

    // ── Unread snapshot: initial sync event ──────────────────────
    // WHY: Clients need full unread counts on connect (and reconnect) without
    // N per-server REST calls. Same "initial snapshot + incremental deltas"
    // pattern as presence.sync (à la Discord READY).
    // WHY after subscribe(): the broadcast subscription (line 126) captures
    // events from this point. Running the SQL query after ensures no gap where
    // events are missed. Brief under-count window is accepted (see plan).
    // WHY synthetic (not ServerEvent): per-user data, cannot go through broadcast bus.
    let unread_states = state
        .read_state_service()
        .list_all_for_user(&unread_user_id)
        .await?;
    let mut unread_channels: HashMap<String, i64> = HashMap::new();
    let mut mention_channels: HashMap<String, i64> = HashMap::new();
    for rs in &unread_states {
        unread_channels.insert(rs.channel_id.0.to_string(), rs.unread_count);
        // WHY only > 0: keep the mentions map sparse — most channels have no
        // mention, and clients treat an absent entry as zero (§4.3).
        if rs.mention_count > 0 {
            mention_channels.insert(rs.channel_id.0.to_string(), rs.mention_count);
        }
    }
    let unread_data = serde_json::json!({
        "type": "unreadSynced",
        "channels": unread_channels,
        "mentions": mention_channels,
    });
    let unread_event = Event::default()
        .event("unread.sync")
        .data(unread_data.to_string());

    // WHY iter(vec![...]): both synthetic events must be emitted BEFORE any
    // broadcast events. chain() guarantees this ordering, preventing the
    // client from receiving message.created deltas before the snapshot.
    let initial_stream = tokio_stream::iter(vec![
        Ok::<Event, Infallible>(presence_event),
        Ok::<Event, Infallible>(unread_event),
    ]);

    // ── Disconnect guard: instant offline on stream drop ─────────
    // WHY: Capturing the guard in a `.map()` closure ties its lifetime to the
    // stream. When Axum drops the stream (client disconnect), the closure is
    // dropped, which drops the guard, which calls `disconnect()`. If the
    // connection count reaches 0, it publishes the offline event. The
    // background sweep remains as a safety net (e.g., process crash).
    let guard = PresenceGuard {
        user_id: guard_user_id,
        state: state.clone(),
        server_ids: guard_watch_rx,
    };

    // Prepend the snapshot events to the live event stream. The composed
    // stream ENDS when `event_stream` ends (broadcast lag) — that EOF is what
    // makes the client reconnect and resync (ADR-SSE-006). Both guards ride
    // the closure so presence disconnect + heartbeat abort fire on drop.
    let merged = initial_stream.chain(event_stream).map(move |item| {
        let _guard = &guard;
        let _heartbeat = &heartbeat_guard;
        item
    });

    Ok(Sse::new(merged).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("heartbeat"),
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn uid(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }
    fn sid(n: u128) -> ServerId {
        ServerId::new(Uuid::from_u128(n))
    }
    /// Build a membership map where the receiver is a plain `Member` of each
    /// server — the role is irrelevant to presence visibility (only the key set
    /// matters), so `Member` keeps these tests focused on server overlap.
    fn member_map(ids: &[ServerId]) -> HashMap<ServerId, Role> {
        ids.iter().cloned().map(|s| (s, Role::Member)).collect()
    }

    /// Empty friend set — the receiver befriends nobody.
    fn no_friends() -> HashSet<UserId> {
        HashSet::new()
    }

    #[test]
    fn presence_hidden_from_users_with_no_shared_server() {
        let receiver_servers = member_map(&[sid(1), sid(2)]);
        // Disjoint memberships AND not friends — the stranger must not learn it.
        assert!(!presence_visible_to(
            &uid(10),
            &[sid(3), sid(4)],
            &uid(20),
            &receiver_servers,
            &no_friends(),
        ));
    }

    #[test]
    fn presence_visible_with_shared_server_or_dm() {
        let receiver_servers = member_map(&[sid(1), sid(2)]);
        // sid(2) is shared — DMs are servers too, so this covers DM partners.
        assert!(presence_visible_to(
            &uid(10),
            &[sid(2), sid(9)],
            &uid(20),
            &receiver_servers,
            &no_friends(),
        ));
    }

    /// §4.3: a friend sees the subject's presence with ZERO shared servers —
    /// the receiver-side friend clause, not any server overlap, delivers it.
    #[test]
    fn presence_visible_to_friend_with_no_shared_server() {
        let receiver_servers = member_map(&[sid(1), sid(2)]);
        let friends: HashSet<UserId> = [uid(10)].into_iter().collect();
        assert!(presence_visible_to(
            &uid(10),
            &[sid(3), sid(4)], // disjoint servers
            &uid(20),
            &receiver_servers,
            &friends,
        ));
    }

    /// §7.1: a STRANGER receives nothing from a subject with 500 friends — the
    /// subject's friend count is irrelevant; only the RECEIVER's friend set is.
    /// (Replaces the draft's cap test — there is no cap.)
    #[test]
    fn presence_hidden_from_stranger_regardless_of_subject_friend_count() {
        let receiver_servers = member_map(&[sid(1)]);
        // The receiver is friends with 500 OTHER users, but not the subject.
        let friends: HashSet<UserId> = (100..600).map(uid).collect();
        assert!(!presence_visible_to(
            &uid(10),
            &[sid(3)],
            &uid(20),
            &receiver_servers,
            &friends,
        ));
    }

    #[test]
    fn presence_always_visible_to_self() {
        // Multi-device self-sync: even with zero shared/known servers.
        let receiver_servers: HashMap<ServerId, Role> = HashMap::new();
        assert!(presence_visible_to(
            &uid(10),
            &[],
            &uid(10),
            &receiver_servers,
            &no_friends(),
        ));
    }

    #[test]
    fn presence_with_empty_scope_broadcasts() {
        // Empty routing metadata = older instance or lookup failure — fail
        // open to the legacy broadcast behavior, never drop the event.
        let receiver_servers = member_map(&[sid(1)]);
        assert!(presence_visible_to(
            &uid(10),
            &[],
            &uid(20),
            &receiver_servers,
            &no_friends(),
        ));
    }

    // ── profile_visible_to: ProfileUpdated fan-out gate (F8) ───────────

    /// Success path (reactivity invariant): a profile update MUST keep reaching
    /// legitimate shared-server members — live rehydrate depends on it.
    #[test]
    fn profile_visible_with_shared_server_or_dm() {
        let receiver_servers = member_map(&[sid(1), sid(2)]);
        // sid(2) is shared — DMs are servers too, so this covers DM partners.
        assert!(profile_visible_to(
            &uid(10),
            &[sid(2), sid(9)],
            &uid(20),
            &receiver_servers
        ));
    }

    #[test]
    fn profile_hidden_from_users_with_no_shared_server() {
        let receiver_servers = member_map(&[sid(1), sid(2)]);
        assert!(!profile_visible_to(
            &uid(10),
            &[sid(3), sid(4)],
            &uid(20),
            &receiver_servers
        ));
    }

    /// F8 regression: a membership-lookup DB error at publish time yields an
    /// EMPTY scope. It used to fail OPEN (broadcast to every connected user);
    /// it must now fail CLOSED — strangers receive nothing.
    #[test]
    fn profile_with_empty_scope_hidden_from_others() {
        let receiver_servers = member_map(&[sid(1)]);
        assert!(!profile_visible_to(
            &uid(10),
            &[],
            &uid(20),
            &receiver_servers
        ));
    }

    /// F8: on the same empty-scope (lookup-error) event, the subject's own
    /// tabs/devices still receive it — fail closed TO SELF, not dropped.
    #[test]
    fn profile_with_empty_scope_still_visible_to_self() {
        let receiver_servers: HashMap<ServerId, Role> = HashMap::new();
        assert!(profile_visible_to(
            &uid(10),
            &[],
            &uid(10),
            &receiver_servers
        ));
    }

    // ── channel_visible_to: private-channel access gate ────────────────

    /// A PUBLIC channel (`None` scope) is visible to every server member,
    /// whatever their role — and even to a receiver whose role is unknown.
    #[test]
    fn channel_public_visible_to_everyone() {
        assert!(channel_visible_to(None, Some(Role::Member)));
        assert!(channel_visible_to(None, Some(Role::Moderator)));
        assert!(channel_visible_to(None, Some(Role::Admin)));
        assert!(channel_visible_to(None, Some(Role::Owner)));
        assert!(channel_visible_to(None, None));
    }

    /// Owner and Admin hold IMPLICIT access to every private channel — they are
    /// never listed in `authorized_roles`, so an empty set must still admit them.
    #[test]
    fn channel_private_visible_to_admin_and_owner_implicitly() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![],
        };
        assert!(channel_visible_to(Some(&scope), Some(Role::Admin)));
        assert!(channel_visible_to(Some(&scope), Some(Role::Owner)));
    }

    /// A member whose role is in the granted set may see the private channel.
    #[test]
    fn channel_private_visible_to_granted_role() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Moderator],
        };
        assert!(channel_visible_to(Some(&scope), Some(Role::Moderator)));
    }

    /// THE LEAK GUARD: a plain Member with NO grant must NOT see a private
    /// channel's events. If this ever returns true, plaintext message content
    /// leaks to unauthorized server members.
    #[test]
    fn channel_private_hidden_from_ungranted_member() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Moderator],
        };
        assert!(!channel_visible_to(Some(&scope), Some(Role::Member)));
    }

    /// A receiver with no known role (should not happen past the server gate) is
    /// denied private channels — fail closed.
    #[test]
    fn channel_private_hidden_from_unknown_role() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Member],
        };
        assert!(!channel_visible_to(Some(&scope), None));
    }

    // ── F5: gate applies to channel-lifecycle + voice events ────────────

    /// Replays the exact Stage-2 decision for an event and receiver role:
    /// `channel_access()` feeds `channel_visible_to`, `None` scope = deliver.
    fn passes_stage2_gate(event: &ServerEvent, receiver_role: Option<Role>) -> bool {
        match event.channel_access() {
            Some(scope) => channel_visible_to(Some(scope), receiver_role),
            None => true,
        }
    }

    /// Builds the four F5 event variants carrying the given access scope.
    fn channel_and_voice_events(channel_access: Option<ChannelAccessScope>) -> Vec<ServerEvent> {
        use crate::domain::models::server_event::ChannelPayload;
        use crate::domain::models::{ChannelId, ChannelType, VoiceAction};
        use chrono::Utc;

        let channel_id = ChannelId::new(Uuid::from_u128(42));
        let payload = ChannelPayload {
            id: channel_id.clone(),
            name: "ops-private".to_string(),
            topic: Some("secret".to_string()),
            channel_type: ChannelType::Voice,
            position: 0,
            is_private: true,
            is_read_only: false,
            encrypted: false,
            slow_mode_seconds: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        vec![
            ServerEvent::ChannelCreated {
                sender_id: uid(1),
                server_id: sid(1),
                channel: payload.clone(),
                channel_access: channel_access.clone(),
            },
            ServerEvent::ChannelUpdated {
                sender_id: uid(1),
                server_id: sid(1),
                channel: payload,
                channel_access: channel_access.clone(),
            },
            ServerEvent::ChannelDeleted {
                sender_id: uid(1),
                server_id: sid(1),
                channel_id: channel_id.clone(),
                channel_access: channel_access.clone(),
            },
            ServerEvent::VoiceStateUpdate {
                sender_id: uid(1),
                server_id: sid(1),
                channel_id,
                user_id: uid(1),
                action: VoiceAction::Joined,
                display_name: "Ada".to_string(),
                is_muted: None,
                is_deafened: None,
                channel_access,
            },
        ]
    }

    /// THE F5 LEAK GUARD: a plain Member with NO grant must NOT receive a
    /// private channel's lifecycle events (name/topic) nor its voice roster
    /// (`VoiceStateUpdate`) — while Owner/Admin (implicit) and granted roles
    /// still do. Neutralizing the gate makes this fail.
    #[test]
    fn private_channel_and_voice_events_dropped_for_ungranted_member() {
        let scope = ChannelAccessScope {
            authorized_roles: vec![Role::Moderator],
        };
        for event in channel_and_voice_events(Some(scope)) {
            assert!(
                !passes_stage2_gate(&event, Some(Role::Member)),
                "{} leaked to an ungranted member",
                event.event_name()
            );
            assert!(
                !passes_stage2_gate(&event, None),
                "{} leaked to a receiver with no role",
                event.event_name()
            );
            // Authorized receivers still get the event in real time.
            assert!(passes_stage2_gate(&event, Some(Role::Moderator)));
            assert!(passes_stage2_gate(&event, Some(Role::Admin)));
            assert!(passes_stage2_gate(&event, Some(Role::Owner)));
        }
    }

    /// REACTIVITY INVARIANT: public-channel lifecycle/voice events (`None`
    /// scope) still reach every server member — the F5 gate must never
    /// over-drop live updates for authorized users.
    #[test]
    fn public_channel_and_voice_events_still_delivered_to_all_members() {
        for event in channel_and_voice_events(None) {
            for role in [
                Some(Role::Member),
                Some(Role::Moderator),
                Some(Role::Admin),
                Some(Role::Owner),
            ] {
                assert!(
                    passes_stage2_gate(&event, role),
                    "{} wrongly dropped for {role:?}",
                    event.event_name()
                );
            }
        }
    }

    #[test]
    fn presence_routing_metadata_is_omitted_when_redacted() {
        // The Stage-2 redaction empties server_ids; serde must then omit the
        // field entirely so the client payload is unchanged from pre-scoping.
        let redacted = ServerEvent::PresenceChanged {
            sender_id: uid(1),
            user_id: uid(1),
            status: UserStatus::Online,
            server_ids: Vec::new(),
        };
        let json = serde_json::to_string(&redacted).unwrap();
        assert!(
            !json.contains("serverIds"),
            "redacted payload leaked: {json}"
        );

        // The unredacted event (bus/pg_notify path) must carry it and survive
        // a serde round-trip so remote instances can scope delivery.
        let routed = ServerEvent::PresenceChanged {
            sender_id: uid(1),
            user_id: uid(1),
            status: UserStatus::Online,
            server_ids: vec![sid(7)],
        };
        let json = serde_json::to_string(&routed).unwrap();
        assert!(json.contains("serverIds"));
        let back: ServerEvent = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(
                back,
                ServerEvent::PresenceChanged { ref server_ids, .. } if *server_ids == vec![sid(7)]
            ),
            "routing metadata must survive the bus round-trip"
        );
    }

    #[tokio::test]
    async fn take_until_lagged_terminates_stream_on_broadcast_lag() {
        // Tiny capacity so a burst of sends overflows the receiver.
        let (tx, rx) = tokio::sync::broadcast::channel::<u32>(2);
        let mut stream = std::pin::pin!(take_until_lagged(BroadcastStream::new(rx)));

        // Within capacity: events pass through unchanged.
        tx.send(1).unwrap();
        assert_eq!(stream.next().await, Some(1));

        // Overflow: capacity 2, three sends → the oldest is overwritten and
        // the receiver observes Lagged on its next poll.
        tx.send(2).unwrap();
        tx.send(3).unwrap();
        tx.send(4).unwrap();

        // The stream must END at the lag (None), not skip it and continue
        // delivering the still-buffered events.
        assert_eq!(stream.next().await, None);

        // Terminated for good — later events never resurrect the stream.
        tx.send(5).unwrap();
        assert_eq!(stream.next().await, None);
    }

    /// Pins the RESPONSE-BODY composition: snapshot prefix chained onto the
    /// lag-terminating live stream, with NO merged side-stream. A previous
    /// version merged an infinite heartbeat interval here, which kept the
    /// response open after lag and defeated the forced reconnect entirely.
    #[tokio::test]
    async fn chained_response_stream_ends_on_broadcast_lag() {
        let (tx, rx) = tokio::sync::broadcast::channel::<u32>(2);
        let initial = tokio_stream::iter(vec![100_u32, 101]);
        let mut stream = std::pin::pin!(initial.chain(take_until_lagged(BroadcastStream::new(rx))));

        // Snapshot events flow first, in order.
        assert_eq!(stream.next().await, Some(100));
        assert_eq!(stream.next().await, Some(101));

        // Live events flow after the snapshot.
        tx.send(1).unwrap();
        assert_eq!(stream.next().await, Some(1));

        // Overflow the capacity-2 channel → the composed stream must reach
        // EOF (None), because EOF is what triggers the client reconnect.
        tx.send(2).unwrap();
        tx.send(3).unwrap();
        tx.send(4).unwrap();
        assert_eq!(stream.next().await, None);
    }
}
