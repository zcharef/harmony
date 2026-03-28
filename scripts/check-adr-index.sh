#!/usr/bin/env bash
set -euo pipefail

# Verify all ADR files are listed in the README index
ADR_DIR="docs/adr"
INDEX="$ADR_DIR/README.md"
VIOLATIONS=0

for adr in "$ADR_DIR"/[0-9]*.md; do
  [ -e "$adr" ] || continue
  basename=$(basename "$adr")
  if ! grep -q "$basename" "$INDEX" 2>/dev/null; then
    echo "ERROR: $basename exists but is not listed in $INDEX"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "Found $VIOLATIONS ADR(s) not indexed in README.md"
  exit 1
fi

echo "ADR index is up to date."
