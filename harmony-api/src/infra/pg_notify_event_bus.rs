//! Cross-instance event bus using Postgres LISTEN/NOTIFY.
//!
//! Dual-path delivery: events are broadcast locally via `tokio::sync::broadcast`
//! AND relayed to other instances via `pg_notify` / `PgListener`. K8s-native
//! multi-instance support with zero additional infrastructure (ADR-SSE-002).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use sqlx::postgres::PgListener;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::domain::models::ServerEvent;
use crate::domain::ports::EventBus;

/// Broadcast channel capacity.
///
/// WHY: 1024 provides ~10 seconds of headroom at 100 events/sec. If a slow
/// SSE consumer falls behind, `BroadcastStream` returns `Lagged` and the
/// handler logs + skips missed events. No data loss — clients invalidate
/// queries on reconnect (ADR-SSE-006).
const BROADCAST_CAPACITY: usize = 1024;

/// Safety margin under Postgres's 8 KB NOTIFY payload limit.
///
/// WHY: `pg_notify` silently truncates payloads above 8000 bytes. We reject
/// at 7500 to leave room for channel name overhead and avoid corrupt JSON
/// on the receiving end.
const MAX_PG_NOTIFY_PAYLOAD: usize = 7500;

/// Postgres LISTEN/NOTIFY channel name for cross-instance event relay.
pub const EVENT_CHANNEL: &str = "harmony_events";

/// Wire format for Postgres NOTIFY payloads.
///
/// WHY: Short field names (`i`, `e`) to minimize payload size — Postgres
/// NOTIFY has an 8 KB limit.
#[derive(Serialize, Deserialize)]
struct NotifyEnvelope {
    /// Originating instance ID — used to skip self-originated events.
    i: Uuid,
    /// The event payload.
    e: ServerEvent,
}

/// Cross-instance event bus backed by Postgres LISTEN/NOTIFY.
///
/// `publish()` delivers locally via broadcast AND queues the event for
/// async relay to Postgres. Two background workers (spawned by the caller)
/// handle the `pg_notify` send and LISTEN receive paths.
#[derive(Debug)]
pub struct PgNotifyEventBus {
    instance_id: Uuid,
    local_tx: broadcast::Sender<ServerEvent>,
    notify_tx: mpsc::UnboundedSender<ServerEvent>,
}

impl PgNotifyEventBus {
    /// Create a new event bus and return the mpsc receiver for the notify worker.
    ///
    /// The caller must spawn `event_notify_worker` with the returned receiver
    /// and `event_listen_worker` with `local_sender()`.
    #[must_use]
    pub fn new(instance_id: Uuid) -> (Self, mpsc::UnboundedReceiver<ServerEvent>) {
        let (local_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();

        let bus = Self {
            instance_id,
            local_tx,
            notify_tx,
        };

        (bus, notify_rx)
    }

    /// Broadcast sender for the listen worker to forward remote events.
    #[must_use]
    pub fn local_sender(&self) -> &broadcast::Sender<ServerEvent> {
        &self.local_tx
    }

    /// This instance's unique ID.
    #[must_use]
    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }
}

impl EventBus for PgNotifyEventBus {
    fn publish(&self, event: ServerEvent) -> usize {
        // WHY: Local delivery first — zero latency for same-instance subscribers.
        // send() returns Err only when there are zero active receivers, which is
        // normal (no SSE clients connected).
        let receivers = self.local_tx.send(event.clone()).unwrap_or(0);

        // WHY: Async relay to Postgres for cross-instance delivery.
        // The mpsc channel is unbounded so publish() never blocks. If the
        // notify worker is gone, the event was already delivered locally.
        if let Err(err) = self.notify_tx.send(event) {
            tracing::warn!(
                error = %err,
                "pg notify mpsc send failed — notify worker may have stopped"
            );
        }

        receivers
    }

    fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.local_tx.subscribe()
    }
}

/// Serialize an envelope for `pg_notify`, degrading oversize message events.
///
/// WHY: `pg_notify` payloads over [`MAX_PG_NOTIFY_PAYLOAD`] would be dropped
/// entirely — remote instances silently never see the message (clients patch
/// caches via `setQueryData` only; there is no refetch fallback). When the
/// full envelope exceeds the cap, the attachments are shed and the envelope
/// re-serialized: remote readers still get the message text live, and the
/// attachments heal on the next REST fetch / reconnect invalidation.
///
/// Returns `None` when the envelope cannot be delivered even degraded
/// (serialization failure, or still over the cap after shedding) — the
/// caller skips it; local subscribers already got the full event.
fn bounded_payload(envelope: &mut NotifyEnvelope) -> Option<String> {
    let payload = match serde_json::to_string(envelope) {
        Ok(p) => p,
        Err(err) => {
            tracing::error!(
                error = %err,
                event_type = envelope.e.event_name(),
                "failed to serialize notify envelope — skipping"
            );
            return None;
        }
    };

    if payload.len() <= MAX_PG_NOTIFY_PAYLOAD {
        return Some(payload);
    }

    let full_bytes = payload.len();
    if envelope.e.shed_attachments() {
        match serde_json::to_string(envelope) {
            Ok(degraded) if degraded.len() <= MAX_PG_NOTIFY_PAYLOAD => {
                // WHY warn, not error: graceful degradation — the event is
                // still delivered cross-instance, minus attachments (ADR-046).
                tracing::warn!(
                    payload_bytes = full_bytes,
                    degraded_bytes = degraded.len(),
                    max_bytes = MAX_PG_NOTIFY_PAYLOAD,
                    event_type = envelope.e.event_name(),
                    "notify payload exceeded pg limit — shed attachments for cross-instance delivery"
                );
                return Some(degraded);
            }
            Ok(degraded) => {
                tracing::error!(
                    payload_bytes = degraded.len(),
                    max_bytes = MAX_PG_NOTIFY_PAYLOAD,
                    event_type = envelope.e.event_name(),
                    "notify payload exceeds pg limit even after shedding attachments — skipping"
                );
                return None;
            }
            Err(err) => {
                tracing::error!(
                    error = %err,
                    event_type = envelope.e.event_name(),
                    "failed to serialize degraded notify envelope — skipping"
                );
                return None;
            }
        }
    }

    tracing::error!(
        payload_bytes = full_bytes,
        max_bytes = MAX_PG_NOTIFY_PAYLOAD,
        event_type = envelope.e.event_name(),
        "notify payload exceeds pg limit — skipping"
    );
    None
}

/// Background worker: drains the mpsc queue and sends events to Postgres via `pg_notify`.
///
/// Exits when the mpsc sender is dropped (all `PgNotifyEventBus` clones gone).
/// Oversize message events are degraded (attachments shed) before being sent;
/// events that fail to serialize or still exceed the payload limit are logged
/// and skipped — they were already delivered locally, so no data loss for
/// same-instance subscribers.
pub async fn event_notify_worker(
    pool: PgPool,
    instance_id: Uuid,
    mut rx: mpsc::UnboundedReceiver<ServerEvent>,
) {
    tracing::info!(%instance_id, "pg notify worker started");

    while let Some(event) = rx.recv().await {
        let mut envelope = NotifyEnvelope {
            i: instance_id,
            e: event,
        };

        let Some(payload) = bounded_payload(&mut envelope) else {
            continue;
        };

        if let Err(err) = sqlx::query("SELECT pg_notify($1, $2)") // allow: runtime-sql
            .bind(EVENT_CHANNEL)
            .bind(&payload)
            .execute(&pool)
            .await
        {
            // WHY: warn, not error — the event was already delivered locally.
            // Cross-instance subscribers will miss it, but the next event will
            // re-establish state (clients reconcile on reconnect anyway).
            tracing::error!(
                error = %err,
                event_type = envelope.e.event_name(),
                "pg_notify failed — event lost for remote instances"
            );
        }
    }

    tracing::info!(%instance_id, "pg notify worker exiting — mpsc closed");
}

/// Background worker: listens for Postgres NOTIFY events and forwards remote ones locally.
///
/// Reconnects with exponential backoff on connection errors.
/// Respects the cancellation token for graceful shutdown.
pub async fn event_listen_worker(
    pool: PgPool,
    instance_id: Uuid,
    local_tx: broadcast::Sender<ServerEvent>,
    cancel: tokio_util::sync::CancellationToken,
) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);

    tracing::info!(%instance_id, "pg listen worker started");

    loop {
        if cancel.is_cancelled() {
            break;
        }

        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(l) => {
                backoff = Duration::from_secs(1);
                l
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    backoff_secs = backoff.as_secs(),
                    "failed to connect PgListener — retrying"
                );
                tokio::select! {
                    () = tokio::time::sleep(backoff) => {}
                    () = cancel.cancelled() => break,
                }
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };

        if let Err(err) = listener.listen(EVENT_CHANNEL).await {
            tracing::warn!(
                error = %err,
                "failed to LISTEN on channel — reconnecting"
            );
            tokio::select! {
                () = tokio::time::sleep(backoff) => {}
                () = cancel.cancelled() => break,
            }
            backoff = (backoff * 2).min(max_backoff);
            continue;
        }

        tracing::info!("pg listener subscribed to {EVENT_CHANNEL}");

        // WHY: Inner loop handles notifications until a recv error triggers reconnect.
        loop {
            tokio::select! {
                result = listener.recv() => {
                    match result {
                        Ok(notification) => {
                            let envelope: NotifyEnvelope = match serde_json::from_str::<NotifyEnvelope>(notification.payload()) {
                                Ok(env) => env,
                                Err(err) => {
                                    tracing::warn!(
                                        error = %err,
                                        payload_len = notification.payload().len(),
                                        "failed to deserialize notify envelope — skipping"
                                    );
                                    continue;
                                }
                            };

                            // WHY: Skip events from this instance — already delivered locally.
                            if envelope.i == instance_id {
                                continue;
                            }

                            // WHY: send() returns Err only when zero receivers are active.
                            let _ = local_tx.send(envelope.e);
                        }
                        Err(err) => {
                            tracing::warn!(
                                error = %err,
                                "pg listener recv error — reconnecting"
                            );
                            break;
                        }
                    }
                }
                () = cancel.cancelled() => {
                    tracing::info!("pg listen worker shutting down");
                    return;
                }
            }
        }

        // WHY: After inner loop breaks (recv error), apply backoff before reconnect.
        tokio::select! {
            () = tokio::time::sleep(backoff) => {}
            () = cancel.cancelled() => break,
        }
        backoff = (backoff * 2).min(max_backoff);
    }

    tracing::info!(%instance_id, "pg listen worker exiting");
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::domain::models::{
        AttachmentId, ChannelId, MessageId, MessageType, ServerId, UserId,
        server_event::{AttachmentPayload, MessagePayload, ServerEvent},
    };
    use crate::domain::ports::EventBus;

    fn test_user_id() -> UserId {
        UserId::new(Uuid::new_v4())
    }

    fn test_server_id() -> ServerId {
        ServerId::new(Uuid::new_v4())
    }

    fn test_channel_id() -> ChannelId {
        ChannelId::new(Uuid::new_v4())
    }

    /// Realistic attachment wire entry (uuid-path Supabase public URL).
    fn test_attachment() -> AttachmentPayload {
        AttachmentPayload {
            id: AttachmentId::new(Uuid::new_v4()),
            url: format!(
                "https://xyz.supabase.co/storage/v1/object/public/attachments/{}/{}.webp",
                Uuid::new_v4(),
                Uuid::new_v4()
            ),
            mime: "image/webp".to_string(),
            size: 8_388_608,
            width: Some(1920),
            height: Some(1080),
            moderation_status: crate::domain::models::AttachmentModerationStatus::Approved,
        }
    }

    fn make_message_event_with(
        content: String,
        attachments: Vec<AttachmentPayload>,
    ) -> ServerEvent {
        let sender = test_user_id();
        let server = test_server_id();
        let channel = test_channel_id();

        ServerEvent::MessageCreated {
            sender_id: sender.clone(),
            server_id: server,
            channel_id: channel.clone(),
            message: MessagePayload {
                id: MessageId::new(Uuid::new_v4()),
                channel_id: channel,
                content,
                author_id: sender,
                author_username: "alice".to_string(),
                author_display_name: None,
                author_avatar_url: None,
                encrypted: false,
                sender_device_id: None,
                edited_at: None,
                parent_message_id: None,
                message_type: MessageType::Default,
                system_event_key: None,
                moderated_at: None,
                moderation_reason: None,
                mentions: vec![],
                attachments,
                is_pinned: false,
                pinned_by: None,
                pinned_at: None,
                created_at: Utc::now(),
            },
            channel_access: None,
        }
    }

    fn make_message_event() -> ServerEvent {
        make_message_event_with("hello world".to_string(), vec![])
    }

    #[tokio::test]
    async fn publish_sends_to_local_broadcast_and_mpsc() {
        let instance_id = Uuid::new_v4();
        let (bus, mut notify_rx) = PgNotifyEventBus::new(instance_id);
        let mut local_rx = bus.subscribe();

        let event = make_message_event();
        bus.publish(event.clone());

        // Local broadcast receiver gets the event.
        let received_local = local_rx.try_recv().unwrap();
        assert_eq!(received_local.event_name(), event.event_name());
        assert_eq!(received_local.sender_id(), event.sender_id());

        // mpsc notify queue also receives the event.
        let received_notify = notify_rx.try_recv().unwrap();
        assert_eq!(received_notify.event_name(), event.event_name());
        assert_eq!(received_notify.sender_id(), event.sender_id());
    }

    #[tokio::test]
    async fn subscribe_returns_working_receiver() {
        let instance_id = Uuid::new_v4();
        let (bus, _notify_rx) = PgNotifyEventBus::new(instance_id);

        let mut rx1 = bus.subscribe();
        let mut rx2 = bus.subscribe();

        let event = make_message_event();
        bus.publish(event.clone());

        let got1 = rx1.try_recv().unwrap();
        let got2 = rx2.try_recv().unwrap();

        assert_eq!(got1.event_name(), event.event_name());
        assert_eq!(got2.event_name(), event.event_name());
        assert_eq!(got1.sender_id(), event.sender_id());
        assert_eq!(got2.sender_id(), event.sender_id());
    }

    #[test]
    fn notify_envelope_round_trip() {
        let instance_id = Uuid::new_v4();
        let event = make_message_event();

        let envelope = NotifyEnvelope {
            i: instance_id,
            e: event.clone(),
        };

        let json = serde_json::to_string(&envelope).unwrap();
        let decoded: NotifyEnvelope = serde_json::from_str(&json).unwrap();

        assert_eq!(decoded.i, instance_id);
        assert_eq!(decoded.e.event_name(), event.event_name());
    }

    #[test]
    fn notify_envelope_dedup_skip_self() {
        let self_id = Uuid::new_v4();
        let other_id = Uuid::new_v4();

        // WHY: The listen worker skips envelopes where i == instance_id to avoid
        // re-delivering events this instance already published locally.
        let same_origin = NotifyEnvelope {
            i: self_id,
            e: make_message_event(),
        };
        let remote_origin = NotifyEnvelope {
            i: other_id,
            e: make_message_event(),
        };

        assert!(same_origin.i == self_id);
        assert!(remote_origin.i != self_id);
    }

    #[test]
    fn payload_size_check() {
        let instance_id = Uuid::new_v4();
        let event = make_message_event();
        let envelope = NotifyEnvelope {
            i: instance_id,
            e: event,
        };

        let payload = serde_json::to_string(&envelope).unwrap();

        assert!(
            payload.len() <= MAX_PG_NOTIFY_PAYLOAD,
            "payload {} bytes exceeds {} byte limit",
            payload.len(),
            MAX_PG_NOTIFY_PAYLOAD
        );
    }

    /// An in-cap event passes through `bounded_payload` untouched —
    /// attachments are never shed gratuitously.
    #[test]
    fn bounded_payload_keeps_attachments_when_under_cap() {
        let mut envelope = NotifyEnvelope {
            i: Uuid::new_v4(),
            e: make_message_event_with("short caption".to_string(), vec![test_attachment()]),
        };

        let payload = bounded_payload(&mut envelope).unwrap();

        assert!(payload.len() <= MAX_PG_NOTIFY_PAYLOAD);
        let decoded: NotifyEnvelope = serde_json::from_str(&payload).unwrap();
        let ServerEvent::MessageCreated { message, .. } = decoded.e else {
            panic!("expected MessageCreated");
        };
        assert_eq!(message.attachments.len(), 1);
    }

    /// Regression (review finding): a max-attachments (Creator plan: 10) message
    /// with a long caption exceeds the `pg_notify` cap. It must DEGRADE (shed
    /// attachments, keep the text) instead of being dropped — otherwise readers
    /// on other API instances silently never see the message (clients patch
    /// caches via `setQueryData` only, no refetch fallback).
    #[test]
    fn bounded_payload_sheds_attachments_when_over_cap() {
        let caption = "x".repeat(6000);
        let attachments: Vec<AttachmentPayload> = (0..10).map(|_| test_attachment()).collect();
        let mut envelope = NotifyEnvelope {
            i: Uuid::new_v4(),
            e: make_message_event_with(caption.clone(), attachments),
        };
        let full = serde_json::to_string(&envelope).unwrap();
        assert!(
            full.len() > MAX_PG_NOTIFY_PAYLOAD,
            "fixture must exceed the cap to exercise degradation ({} bytes)",
            full.len()
        );

        let payload = bounded_payload(&mut envelope).unwrap();

        assert!(
            payload.len() <= MAX_PG_NOTIFY_PAYLOAD,
            "degraded payload {} bytes still exceeds the cap",
            payload.len()
        );
        let decoded: NotifyEnvelope = serde_json::from_str(&payload).unwrap();
        let ServerEvent::MessageCreated { message, .. } = decoded.e else {
            panic!("expected MessageCreated");
        };
        assert!(message.attachments.is_empty(), "attachments must be shed");
        assert_eq!(message.content, caption, "text must survive degradation");
    }

    /// When even the degraded envelope exceeds the cap (content alone is over
    /// it — `MAX_MESSAGE_LENGTH` is 8000 chars, see `message_service.rs`),
    /// `bounded_payload` returns `None`: the event is skipped for remote
    /// instances, never sent truncated/corrupt. Pre-existing limitation for
    /// oversize text; attachments no longer make it worse.
    #[test]
    fn bounded_payload_drops_event_still_over_cap_after_shedding() {
        let mut envelope = NotifyEnvelope {
            i: Uuid::new_v4(),
            e: make_message_event_with("x".repeat(8000), vec![test_attachment()]),
        };

        assert!(bounded_payload(&mut envelope).is_none());
    }
}
