//! Shared serde helpers for DTO deserialization.

/// Distinguishes an omitted field from an explicit JSON `null` in a
/// `Option<Option<T>>` PATCH field.
///
/// WHY: with a plain `Option<Option<T>>`, serde deserializes BOTH a missing key
/// and an explicit `null` to `None` — so "keep unchanged" and "clear the field"
/// are indistinguishable. This deserializer only runs when the key IS present,
/// so wrapping the parsed value in `Some` yields the three-way contract:
/// - missing → `None` (via `#[serde(default)]`) → keep unchanged
/// - `null` → `Some(None)` → clear the field
/// - `"x"` → `Some(Some("x"))` → set the field
///
/// Pair with `#[serde(default, deserialize_with = "double_option")]`.
pub(crate) fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}
