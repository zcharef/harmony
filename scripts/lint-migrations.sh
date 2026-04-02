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
# WHY: "DROP TABLE" is checked with word boundary to avoid false positives on
# "ALTER PUBLICATION ... DROP TABLE" which only removes from replication, not data.
FORBIDDEN_PATTERNS=(
  "DROP COLUMN"
  "RENAME COLUMN"
  "RENAME TABLE"
)
# Separate check for DROP TABLE: must be standalone (not ALTER PUBLICATION ... DROP TABLE)
STANDALONE_DROP_TABLE="(^|;)[^;]*DROP[[:space:]]+TABLE"

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

  # WHY: Separate check for DROP TABLE that excludes ALTER PUBLICATION ... DROP TABLE.
  # ALTER PUBLICATION removes from replication, not from the database — non-destructive.
  if grep -inE "DROP[[:space:]]+TABLE" "$file" | grep -iv "ALTER PUBLICATION" | grep -v "lint:allow:destructive" > /dev/null 2>&1; then
    echo "ERROR: Forbidden destructive operation 'DROP TABLE' in $(basename "$file")"
    echo "       Use '-- lint:allow:destructive: <reason>' to override with justification"
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
  done < <(grep -i 'create table' "$file" 2>/dev/null | tr '[:upper:]' '[:lower:]' | sed -E 's/.*create table[[:space:]]+(if not exists[[:space:]]+)?(public\.)?([a-z_][a-z0-9_]*).*/\3/' || true)
done

if [ "$VIOLATIONS" -gt 0 ]; then
  echo ""
  echo "Found $VIOLATIONS migration lint violation(s). Fix them before merging."
  exit 1
fi

echo "Migration lint passed."
