//! Async link-unfurl pipeline (link previews).
//!
//! Runs where the other post-send tasks run — a `tokio::spawn` AFTER the
//! message committed and `message.created` fanned out — so unfurling never
//! blocks or fails a send. Results persist as `message_embeds` rows and fan
//! out via a single `MessageUpdated` carrying the FULL message (attachments +
//! mentions + embeds), mirroring the attachment-scan pipeline.
//!
//! Failures are silent to users (the message simply has no preview) but every
//! failure path logs `tracing::warn!` with the URL's DOMAIN only — never the
//! full URL (query strings can carry tokens/PII).

use std::sync::Arc;

use crate::api::state::AppState;
use crate::domain::models::server_event::MessagePayload;
use crate::domain::models::{
    ChannelId, MessageId, NewEmbed, SYSTEM_MODERATOR_ID, ServerEvent, ServerId, UnfurledPage,
};
use crate::domain::ports::{ChannelRepository, EmbedRepository, EventBus};
use crate::domain::services::{MessageService, resolve_channel_access_by_id};
use crate::infra::link_unfurl::{LinkUnfurler, normalize_url};
use crate::infra::safe_browsing::extract_urls;

/// At most this many URLs per message are unfurled (first-occurrence order).
pub const MAX_URLS_PER_MESSAGE: usize = 3;

/// Unfurl-cache freshness window (~24h): a cached result younger than this —
/// success OR failure — is reused instead of refetching.
pub const CACHE_TTL_SECS: i64 = 24 * 60 * 60;

/// Cloned dependencies the unfurl task needs, captured for a `tokio::spawn`.
#[derive(Clone, Debug)]
pub struct LinkUnfurlDeps {
    pub embed_repo: Arc<dyn EmbedRepository>,
    pub channel_repo: Arc<dyn ChannelRepository>,
    pub message_service: Arc<MessageService>,
    pub event_bus: Arc<dyn EventBus>,
    pub unfurler: Arc<LinkUnfurler>,
}

impl LinkUnfurlDeps {
    /// Clone the unfurl dependencies out of the shared app state.
    #[must_use]
    pub fn from_state(state: &AppState) -> Self {
        Self {
            embed_repo: state.embed_repository().clone(),
            channel_repo: state.channel_repository_arc().clone(),
            message_service: state.message_service_arc().clone(),
            event_bus: state.event_bus_arc().clone(),
            unfurler: state.link_unfurler().clone(),
        }
    }
}

/// The `warn` target for a URL: its host only — never the full URL.
fn url_domain(raw: &str) -> String {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "<unparseable>".to_string())
}

/// Resolve one URL to an `UnfurledPage`, using the cache (TTL ~24h) and
/// caching BOTH successes and failures (an all-`None` page is the negative
/// cache — dead links don't get refetched on every repost).
async fn resolve_one(deps: &LinkUnfurlDeps, raw_url: &str) -> Option<UnfurledPage> {
    let normalized = match normalize_url(raw_url) {
        Ok(u) => u.to_string(),
        Err(e) => {
            tracing::warn!(
                domain = %url_domain(raw_url),
                error = %e,
                "link unfurl: URL rejected before fetch"
            );
            return None;
        }
    };

    match deps
        .embed_repo
        .get_cached(&normalized, CACHE_TTL_SECS)
        .await
    {
        Ok(Some(page)) => return Some(page),
        Ok(None) => {}
        Err(e) => {
            // Cache read failure degrades to a fetch — never fails the unfurl.
            tracing::warn!(
                domain = %url_domain(raw_url),
                error = %e,
                "link unfurl: cache read failed — fetching"
            );
        }
    }

    let page = match deps.unfurler.unfurl(&normalized).await {
        Ok(page) => page,
        Err(e) => {
            // Silent to the user (no preview); observable to us. Domain only.
            tracing::warn!(
                domain = %url_domain(&normalized),
                error = %e,
                "link unfurl: fetch failed"
            );
            UnfurledPage::default()
        }
    };

    if let Err(e) = deps.embed_repo.upsert_cache(&normalized, &page).await {
        tracing::warn!(
            domain = %url_domain(&normalized),
            error = %e,
            "link unfurl: cache write failed"
        );
    }

    Some(page)
}

/// Unfurl up to [`MAX_URLS_PER_MESSAGE`] URLs from a freshly-sent plaintext
/// message, persist the resulting embeds, and fan out one `MessageUpdated`
/// carrying the full message so every reader's cache patches live.
pub async fn unfurl_message_links(
    deps: &LinkUnfurlDeps,
    message_id: &MessageId,
    channel_id: &ChannelId,
    server_id: &ServerId,
    content: &str,
) {
    let urls: Vec<String> = extract_urls(content)
        .into_iter()
        .take(MAX_URLS_PER_MESSAGE)
        .collect();
    if urls.is_empty() {
        return;
    }

    let mut new_embeds: Vec<NewEmbed> = Vec::new();
    for url in urls {
        if let Some(page) = resolve_one(deps, &url).await
            && page.has_content()
        {
            new_embeds.push(NewEmbed { url, page });
        }
    }
    if new_embeds.is_empty() {
        return;
    }

    if let Err(e) = deps.embed_repo.insert_embeds(message_id, &new_embeds).await {
        tracing::warn!(
            message_id = %message_id,
            error = %e,
            "link unfurl: failed to persist embeds — message stays preview-less"
        );
        return;
    }

    emit_message_updated(deps, message_id, channel_id, server_id).await;
}

/// Reload the message and publish `MessageUpdated` so every reader's cache
/// patches in the new previews.
///
/// WHY the FULL message (not an embeds-only patch): a past bug wiped
/// reactions by fanning out a partial message on `message.updated` — the
/// payload must always be the complete established shape.
pub async fn emit_message_updated(
    deps: &LinkUnfurlDeps,
    message_id: &MessageId,
    channel_id: &ChannelId,
    server_id: &ServerId,
) {
    let message = match deps
        .message_service
        .reload_for_moderation_event(message_id)
        .await
    {
        Ok(Some(m)) => m,
        Ok(None) => return, // message deleted meanwhile — nothing to show
        Err(e) => {
            tracing::warn!(
                message_id = %message_id,
                error = %e,
                "link unfurl: reload for MessageUpdated failed"
            );
            return;
        }
    };

    // Gate the event for private channels (fail OPEN on lookup error, ADR-027
    // — same posture as the attachment-scan fan-out).
    let channel_access = resolve_channel_access_by_id(deps.channel_repo.as_ref(), channel_id)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(
                channel_id = %channel_id,
                error = %e,
                "link unfurl: channel-access resolve failed — failing open"
            );
            None
        });

    // WHY SYSTEM_MODERATOR_ID as sender: the SSE layer excludes the sender
    // from their own events; the AUTHOR must also receive the preview flip,
    // so the sender must be the system sentinel, never the author.
    let event = ServerEvent::MessageUpdated {
        sender_id: SYSTEM_MODERATOR_ID,
        server_id: server_id.clone(),
        channel_id: channel_id.clone(),
        message: MessagePayload::from(message),
        channel_access,
    };
    let receivers = deps.event_bus.publish(event);
    tracing::debug!(message_id = %message_id, receivers, "emitted unfurl message.updated");
}
