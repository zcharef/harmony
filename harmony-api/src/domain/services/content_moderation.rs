//! Tiered evaluation of `OpenAI` Moderation API results.
//!
//! Pure domain logic -- no I/O, no async, no infra dependencies.
//! Takes pre-fetched category scores/flags and decides whether to delete.
//!
//! Two enforcement tiers:
//! - **Tier 1**: Always enforced, non-disableable safety categories (auto-delete).
//! - **Tier 2**: Server-configurable, default OFF. Only enforced when admin opts in.
//!
//! Unknown categories default to Tier 1 (safe-by-default).

use std::collections::HashMap;

// ── Constants ────────────────────────────────────────────────────────

/// Minimum confidence score for a category to trigger action.
/// WHY 0.8: `OpenAI`'s default boolean thresholds are ~0.5, too aggressive for chat.
pub const SCORE_THRESHOLD: f64 = 0.8;

/// Tier 1 categories: always enforced, non-disableable.
/// Auto-delete when category boolean is true AND score >= `SCORE_THRESHOLD`.
/// WHY these four: subcategories (/instructions, /intent, /graphic, /minors)
/// distinguish "discussing a topic" from "actively promoting/depicting it."
pub const TIER1_CATEGORIES: &[&str] = &[
    "self-harm/instructions",
    "self-harm/intent",
    "sexual/minors",
    "violence/graphic",
];

/// Tier 2 categories: server-configurable, default OFF.
/// Only enforced when the server admin has opted in.
pub const TIER2_CATEGORIES: &[&str] = &[
    "violence",
    "harassment",
    "harassment/threatening",
    "hate",
    "hate/threatening",
    "sexual",
    "self-harm",
];

// ── Public types ─────────────────────────────────────────────────────

/// Decision produced by [`evaluate_moderation`].
#[derive(Debug, PartialEq, Eq)]
pub enum ModerationDecision {
    /// No action needed.
    Pass,
    /// Auto-delete. `is_tier1` = true means always-enforced safety category.
    Delete { reason: String, is_tier1: bool },
}

// ── Core logic ───────────────────────────────────────────────────────

/// Evaluate moderation result against tiered category system.
///
/// Checks Tier 1 first (short-circuits). Unknown categories default to Tier 1.
/// Only checks Tier 2 if the server has opted in for that category.
///
/// # Arguments
/// - `category_scores`: per-category scores from the moderation API (0.0-1.0)
/// - `category_flags`: per-category boolean flags from the moderation API
/// - `server_categories`: server's Tier 2 opt-in settings (empty = all OFF)
/// - `score_threshold`: minimum score to trigger action
pub fn evaluate_moderation(
    category_scores: &HashMap<String, f64>,
    category_flags: &HashMap<String, bool>,
    server_categories: &HashMap<String, bool>,
    score_threshold: f64,
) -> ModerationDecision {
    let mut tier2_reasons: Vec<&str> = Vec::new();

    for (category, &flagged) in category_flags {
        // Both boolean flag AND score threshold must be met
        let score = category_scores.get(category).copied().unwrap_or(0.0);
        if !flagged || score < score_threshold {
            continue;
        }

        // Tier 1: always enforced, short-circuit
        if TIER1_CATEGORIES.contains(&category.as_str()) {
            return ModerationDecision::Delete {
                reason: format!("Tier 1 safety violation: {category}"),
                is_tier1: true,
            };
        }

        // Unknown category: treat as Tier 1 (safe-by-default)
        if !TIER2_CATEGORIES.contains(&category.as_str()) {
            tracing::warn!(
                category = %category,
                score = score,
                "Unknown moderation category flagged -- treating as Tier 1"
            );
            return ModerationDecision::Delete {
                reason: format!("Unknown safety category: {category}"),
                is_tier1: true,
            };
        }

        // Tier 2: only if server opted in
        if server_categories.get(category).copied() == Some(true) {
            tier2_reasons.push(category.as_str());
        }
    }

    if !tier2_reasons.is_empty() {
        return ModerationDecision::Delete {
            reason: format!("Tier 2 policy violation: {}", tier2_reasons.join(", ")),
            is_tier1: false,
        };
    }

    ModerationDecision::Pass
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    /// Helper: build category maps from a slice of (name, score, flagged) tuples.
    fn make_categories(
        entries: &[(&str, f64, bool)],
    ) -> (HashMap<String, f64>, HashMap<String, bool>) {
        let mut scores = HashMap::new();
        let mut flags = HashMap::new();
        for &(name, score, flagged) in entries {
            scores.insert(name.to_string(), score);
            flags.insert(name.to_string(), flagged);
        }
        (scores, flags)
    }

    /// Helper: build server opt-in map from a slice of (category, enabled) tuples.
    fn make_server_categories(entries: &[(&str, bool)]) -> HashMap<String, bool> {
        entries
            .iter()
            .map(|&(name, enabled)| (name.to_string(), enabled))
            .collect()
    }

    // ── Tier 1 ───────────────────────────────────────────────────────

    #[test]
    fn tier1_category_flagged_above_threshold() {
        let (scores, flags) = make_categories(&[("sexual/minors", 0.95, true)]);
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(
            result,
            ModerationDecision::Delete {
                reason: "Tier 1 safety violation: sexual/minors".to_string(),
                is_tier1: true,
            }
        );
    }

    #[test]
    fn tier1_category_flagged_below_threshold() {
        // Flag is true but score is below threshold -- should pass
        let (scores, flags) = make_categories(&[("violence/graphic", 0.5, true)]);
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(result, ModerationDecision::Pass);
    }

    #[test]
    fn tier1_all_categories_detected() {
        for &cat in TIER1_CATEGORIES {
            let (scores, flags) = make_categories(&[(cat, 0.9, true)]);
            let server = HashMap::new();

            let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

            assert!(
                matches!(result, ModerationDecision::Delete { is_tier1: true, .. }),
                "Tier 1 category {cat} should trigger Delete"
            );
        }
    }

    // ── Tier 2 ───────────────────────────────────────────────────────

    #[test]
    fn tier2_category_flagged_server_enabled() {
        let (scores, flags) = make_categories(&[("harassment", 0.9, true)]);
        let server = make_server_categories(&[("harassment", true)]);

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(
            result,
            ModerationDecision::Delete {
                reason: "Tier 2 policy violation: harassment".to_string(),
                is_tier1: false,
            }
        );
    }

    #[test]
    fn tier2_category_flagged_server_disabled() {
        let (scores, flags) = make_categories(&[("harassment", 0.9, true)]);
        let server = make_server_categories(&[("harassment", false)]);

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(result, ModerationDecision::Pass);
    }

    #[test]
    fn tier2_category_flagged_server_empty() {
        // Empty server_categories means all Tier 2 OFF (default)
        let (scores, flags) = make_categories(&[("hate", 0.95, true)]);
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(result, ModerationDecision::Pass);
    }

    // ── Unknown categories ───────────────────────────────────────────

    #[test]
    fn unknown_category_flagged() {
        let (scores, flags) = make_categories(&[("future-category/new", 0.95, true)]);
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(
            result,
            ModerationDecision::Delete {
                reason: "Unknown safety category: future-category/new".to_string(),
                is_tier1: true,
            }
        );
    }

    // ── Threshold edge cases ─────────────────────────────────────────

    #[test]
    fn score_exactly_at_threshold() {
        // >= not > -- exactly at threshold should trigger
        let (scores, flags) = make_categories(&[("self-harm/intent", SCORE_THRESHOLD, true)]);
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert!(
            matches!(result, ModerationDecision::Delete { is_tier1: true, .. }),
            "Score exactly at threshold should trigger deletion"
        );
    }

    #[test]
    fn all_below_threshold_but_flagged_true() {
        // All categories flagged=true but scores below threshold -- no action
        let (scores, flags) = make_categories(&[
            ("violence/graphic", 0.3, true),
            ("harassment", 0.5, true),
            ("hate", 0.6, true),
        ]);
        let server = make_server_categories(&[("harassment", true), ("hate", true)]);

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(result, ModerationDecision::Pass);
    }

    // ── Tier precedence ──────────────────────────────────────────────

    #[test]
    fn both_tier1_and_tier2_match_tier1_wins() {
        // Both a Tier 1 and Tier 2 category are flagged -- Tier 1 short-circuits
        let (scores, flags) = make_categories(&[
            ("harassment", 0.95, true),
            ("self-harm/instructions", 0.99, true),
        ]);
        let server = make_server_categories(&[("harassment", true)]);

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        // Must be Tier 1 regardless of iteration order
        assert!(
            matches!(result, ModerationDecision::Delete { is_tier1: true, .. }),
            "Tier 1 should take precedence over Tier 2"
        );
    }

    // ── Boolean flag requirement ─────────────────────────────────────

    #[test]
    fn score_without_boolean_flag() {
        // High score but flag=false -- should pass (both conditions required)
        let (scores, flags) = make_categories(&[("violence/graphic", 0.99, false)]);
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(result, ModerationDecision::Pass);
    }

    // ── Empty / no-op cases ──────────────────────────────────────────

    #[test]
    fn empty_categories() {
        let scores = HashMap::new();
        let flags = HashMap::new();
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(result, ModerationDecision::Pass);
    }

    #[test]
    fn dm_server_empty_categories() {
        // DMs have no server-level opt-in -- Tier 2 is OFF, only Tier 1 matters
        let (scores, flags) = make_categories(&[("harassment", 0.95, true), ("hate", 0.9, true)]);
        let server = HashMap::new();

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        assert_eq!(result, ModerationDecision::Pass);
    }

    // ── Multiple Tier 2 ──────────────────────────────────────────────

    #[test]
    fn multiple_tier2_categories_flagged() {
        let (scores, flags) = make_categories(&[("harassment", 0.85, true), ("hate", 0.9, true)]);
        let server = make_server_categories(&[("harassment", true), ("hate", true)]);

        let result = evaluate_moderation(&scores, &flags, &server, SCORE_THRESHOLD);

        match result {
            ModerationDecision::Delete { reason, is_tier1 } => {
                assert!(!is_tier1, "Should be Tier 2, not Tier 1");
                assert!(
                    reason.contains("harassment") && reason.contains("hate"),
                    "Reason should list both categories, got: {reason}"
                );
            }
            ModerationDecision::Pass => panic!("Expected Delete, got Pass"),
        }
    }
}
