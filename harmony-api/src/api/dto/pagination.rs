//! Cursor-based pagination envelope for collection endpoints.

use serde::Serialize;
use utoipa::ToSchema;

/// Paginated collection response envelope (ADR-020).
///
/// All collection endpoints return this envelope instead of bare arrays.
/// Cursor-based pagination only — no offset (ADR-036).
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedResponse<T: ToSchema> {
    /// The items in this page.
    pub items: Vec<T>,
    /// Total count of items matching the query (without pagination).
    pub total: i64,
    /// Cursor for the next page. `None` if this is the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}
