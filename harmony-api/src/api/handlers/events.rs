//! SSE event stream handler.
//!
//! `GET /v1/events` — single persistent connection per user that delivers
//! all real-time events (messages, members, channels, DMs, presence).
//!
//! Auth: session cookie (`withCredentials: true` from browser `EventSource`).
//! The `AuthUser` extractor works with both cookies and Bearer tokens —
//! `EventSource` uses the cookie path (ADR-SSE-005).

use std::collections::HashSet;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::AuthUser;
use crate::api::state::AppState;
use crate::domain::models::{ServerEvent, ServerId, UserStatus};
use crate::domain::ports::EventBus;

/// SSE event stream — delivers real-time events to the authenticated user.
///
/// The stream filters events based on:
/// 1. **Server scope**: only events for servers the user is a member of.
/// 2. **User scope**: user-targeted events (DMs, bans) only for this user.
/// 3. **Sender exclusion**: message events skip the sender (client has
///    optimistic UI).
///
/// On reconnect, the client invalidates all queries (ADR-SSE-006) — no
/// event buffering or `Last-Event-ID` replay needed.
///
/// **Presence lifecycle**: On connect, the user is marked online in the
/// `PresenceTracker` and a `PresenceChanged` event is emitted. A heartbeat
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
    // Fetch the user's server memberships to build the filter set.
    // WHY: Snapshot at connect time. If the user joins/leaves a server,
    // they must reconnect (EventSource auto-reconnects). This avoids
    // per-event DB lookups.
    let servers = state.server_service().list_for_user(&user_id).await?;
    let server_ids: HashSet<ServerId> = servers.into_iter().map(|s| s.id).collect();

    // ── Presence: mark user online ──────────────────────────────
    let server_id_vec: Vec<ServerId> = server_ids.iter().cloned().collect();
    state
        .presence_tracker()
        .set_online(user_id.clone(), server_id_vec);

    let online_event = ServerEvent::PresenceChanged {
        sender_id: user_id.clone(),
        user_id: user_id.clone(),
        status: UserStatus::Online,
    };

    // WHY: Subscribe BEFORE publish so the new subscriber does not miss
    // events published between publish() and subscribe() (race condition).
    let rx = state.event_bus().subscribe();

    let receivers = state.event_bus().publish(online_event);
    tracing::info!(
        server_count = server_ids.len(),
        receivers,
        "SSE connection established, user marked online"
    );

    // Clone user_id for the heartbeat stream before moving into the event closure.
    let heartbeat_user_id = user_id.clone();

    // ── Event stream: filters broadcast events for this user ────
    let event_stream = BroadcastStream::new(rx).filter_map(move |result| {
        let event = match result {
            Ok(event) => event,
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(count)) => {
                // WHY: Slow consumer missed events. Log and continue —
                // client will catch up via query invalidation on next
                // reconnect (ADR-SSE-006).
                tracing::warn!(
                    missed_events = count,
                    "SSE consumer lagged behind broadcast"
                );
                return None;
            }
        };

        // ── Filter: server-scoped events ──────────────────────────
        if let Some(event_server_id) = event.server_id()
            && !server_ids.contains(event_server_id)
        {
            return None;
        }

        // ── Filter: user-targeted events ──────────────────────────
        // Events with a `target_user_id` are delivered only to that user.
        if let Some(target) = event.target_user_id()
            && *target != user_id
        {
            return None;
        }

        // ── Filter: user-scoped events without server_id ──────────
        // DmCreated and PresenceChanged have no server_id. If they also
        // have no target_user_id match, they were not meant for this user.
        // DmCreated always has target_user_id (handled above).
        // PresenceChanged has no target — it broadcasts to all. For now,
        // let it through (presence is global). The client filters by
        // displayed server.

        // ── Filter: sender exclusion (message events only) ────────
        // WHY: The sender already has optimistic UI. Receiving their own
        // event would cause duplicate renders.
        let is_message_event = matches!(
            event.event_name(),
            "message.created" | "message.updated" | "message.deleted"
        );
        if is_message_event && *event.sender_id() == user_id {
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

    // ── Heartbeat stream: calls touch() every 30s ───────────────
    // WHY: The background sweep task (main.rs) removes presence entries
    // with last_heartbeat older than 90s. This touch keeps the entry
    // alive as long as the SSE connection is open. The 30s interval
    // matches the SSE keep-alive, giving a 60s buffer before sweep.
    // WHY: AppState is cheap to clone (all fields are Arc).
    let heartbeat_state = state.clone();
    let heartbeat_interval = tokio::time::interval(Duration::from_secs(30));
    let heartbeat_stream = tokio_stream::wrappers::IntervalStream::new(heartbeat_interval)
        .filter_map(move |_| {
            heartbeat_state.presence_tracker().touch(&heartbeat_user_id);
            // WHY: Return None — heartbeat touches are side-effects only.
            // The SSE keep-alive (Axum KeepAlive) handles the actual comment
            // sent to the client. This stream just refreshes the presence entry.
            None::<Result<Event, Infallible>>
        });

    // Merge event delivery with heartbeat touches into a single stream.
    let merged = event_stream.merge(heartbeat_stream);

    Ok(Sse::new(merged).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("heartbeat"),
    ))
}
