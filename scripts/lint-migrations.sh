#!/usr/bin/env bash
set -euo pipefail

# Migration Linter for Harmony
# Enforces: ADR-019 (non-destructive), ADR-040 (RLS enforcement)

MIGRATIONS_DIR="supabase/migrations"
VIOLATIONS=0

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "No migrations directory found. Skipping."
  exit 0
fi

# Check migration naming convention
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$file" ] || continue
  basename=$(basename "$file")
  if ! [[ "$basename" =~ ^[0-9]{14}_.+\.sql$ ]]; then
    echo "ERROR: Migration filename does not match YYYYMMDDHHMMSS_description.sql: $basename"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# Check for destructive operations
FORBIDDEN_PATTERNS=(
  "DROP COLUMN"
  "DROP TABLE"
  "RENAME COLUMN"
  "RENAME TABLE"
)

for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$file" ] || continue
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    # Skip lines with -- lint:allow:destructive override
    if grep -in "$pattern" "$file" | grep -v "lint:allow:destructive" > /dev/null 2>&1; then
      echo "ERROR: Forbidden destructive operation '$pattern' in $(basename "$file")"
      echo "       Use '-- lint:allow:destructive: <reason>' to override with justification"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done

  # Check ALTER COLUMN ... TYPE (type changes)
  if grep -inE "ALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE" "$file" | grep -v "lint:allow:destructive" > /dev/null 2>&1; then
    echo "ERROR: ALTER COLUMN TYPE change in $(basename "$file"). Use add-migrate-remove pattern."
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# RLS enforcement: CREATE TABLE must be paired with ENABLE ROW LEVEL SECURITY
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$file" ] || continue
  # Find all CREATE TABLE statements and extract table names
  while IFS= read -r table_name; do
    if ! grep -qi "ALTER TABLE.*$table_name.*ENABLE ROW LEVEL SECURITY" "$file" && \
       ! grep -qi "ALTER TABLE public\.$table_name ENABLE ROW LEVEL SECURITY" "$file"; then
      echo "WARNING: Table '$table_name' created in $(basename "$file") without ENABLE ROW LEVEL SECURITY"
      echo "         Every table MUST have RLS enabled (ADR-040)"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done < <(grep -i 'CREATE TABLE' "$file" 2>/dev/null | sed -E 's/.*CREATE TABLE[[:space:]]+(IF NOT EXISTS[[:space:]]+)?(public\.)?([a-zA-Z_][a-zA-Z0-9_]*).*/\3/' || true)
done

if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  echo "Found $VIOLATIONS migration lint violation(s). Fix them before merging."
  exit 1
fi

echo "Migration lint passed."
