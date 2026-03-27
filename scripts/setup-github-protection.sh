#!/usr/bin/env bash
set -euo pipefail

# Sets branch protection rules on main.
# Run AFTER making the repo public and AFTER CI workflows exist.
# Usage: bash scripts/setup-github-protection.sh

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo 'zcharef/harmony')}"

# Pre-flight checks
gh auth status &>/dev/null || { echo "ERROR: gh CLI not authenticated. Run 'gh auth login' first."; exit 1; }
gh repo view "$REPO" --json name &>/dev/null || { echo "ERROR: Cannot access repo $REPO. Check repo name and token scopes (needs admin:repo)."; exit 1; }

echo "==> Setting branch protection on main..."
gh api "repos/$REPO/branches/main/protection" -X PUT --input - <<'RULES'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "App Quality Wall",
      "Rust Quality Wall",
      "E2E Tests (Playwright)"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_linear_history": true
}
RULES

echo "==> Done. Branch protection active on main."
echo ""
echo "What this enforces:"
echo "  - PRs required to merge (no direct pushes)"
echo "  - 1 approving review required (CODEOWNERS enforced)"
echo "  - Stale reviews dismissed on new pushes"
echo "  - CI must pass: App Quality Wall + Rust Quality Wall + E2E"
echo "  - strict: true = branch must be up-to-date with main before merge"
echo "    → serializes migration PRs (CI re-runs against latest main)"
echo "  - Linear history only (squash merge)"
echo "  - No force pushes, no branch deletion"
echo ""
echo "Admin bypass: DISABLED (enforce_admins=true)"
echo "  → For genuine hotfixes, temporarily disable protection via GitHub UI"
