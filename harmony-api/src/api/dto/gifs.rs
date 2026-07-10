//! GIF picker DTOs (Klipy proxy).
//!
//! Flattened response shape the generated TypeScript client consumes — Klipy's
//! raw envelope (ad payloads, unstable nesting) is never proxied to the client.

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::infra::klipy::{KlipyGif, KlipyGifPage};

/// Query parameters for `GET /v1/gifs/search`.
// WHY no `deny_unknown_fields`: Axum's query deserializer forwards every URL
// param to the struct, so a cache-buster would 400 an otherwise-valid request.
// Same reasoning as `MessageListQuery`.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct GifSearchQuery {
    /// Search text. Rejected when empty/whitespace (400).
    pub q: String,
    /// 1-based page (Klipy pagination). Default 1, clamped 1..=50.
    #[serde(default)]
    pub page: Option<u32>,
}

/// Query parameters for `GET /v1/gifs/trending`.
#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct GifTrendingQuery {
    /// 1-based page (Klipy pagination). Default 1, clamped 1..=50.
    #[serde(default)]
    pub page: Option<u32>,
}

/// A single GIF in a picker result.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GifItem {
    /// Klipy slug/id (stable key for React lists + telemetry).
    pub id: String,
    /// Alt text for a11y (falls back to the query if Klipy gives none).
    pub title: String,
    /// Hosted animated GIF URL — this is what gets inserted as message content.
    pub url: String,
    /// A smaller preview URL for the picker grid (webp preferred, gif fallback).
    pub preview_url: String,
    pub width: u32,
    pub height: u32,
}

impl From<KlipyGif> for GifItem {
    fn from(gif: KlipyGif) -> Self {
        Self {
            id: gif.id,
            title: gif.title,
            url: gif.url,
            preview_url: gif.preview_url,
            width: gif.width,
            height: gif.height,
        }
    }
}

/// One page of GIF results.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GifListResponse {
    pub items: Vec<GifItem>,
    /// True when a next page exists (Klipy `has_next`) — drives infinite scroll.
    pub has_next: bool,
    pub page: u32,
}

impl From<KlipyGifPage> for GifListResponse {
    fn from(page: KlipyGifPage) -> Self {
        Self {
            items: page.items.into_iter().map(GifItem::from).collect(),
            has_next: page.has_next,
            page: page.page,
        }
    }
}
