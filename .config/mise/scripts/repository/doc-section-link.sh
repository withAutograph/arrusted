#!/usr/bin/env bash
# Given the current branch diff (vs main), suggest which docs/ sections the
# change likely implements. This is a discovery aid, not a verifier.
#
# Usage: .config/mise/scripts/repository/doc-section-link.sh [base-ref]
#   base-ref defaults to "main"

set -euo pipefail

base="${1:-main}"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

changed=$(git diff --name-only "$base"...HEAD 2>/dev/null || git diff --name-only --cached)

if [ -z "$changed" ]; then
  echo "No changes detected vs $base." >&2
  exit 0
fi

echo "Changed paths:"
echo "$changed" | sed 's/^/  /'
echo ""

# Build a list of search terms from changed paths: top-level dirs + filename stems.
terms=$(echo "$changed" \
  | awk -F/ '{ print $1; if (NF>1) print $2; print $NF }' \
  | sed 's/\.[a-z]*$//' \
  | sort -u \
  | grep -v '^$')

echo "Likely-relevant docs/ sections (grep across docs/*.md):"
echo ""
for t in $terms; do
  # Skip noisy tokens.
  case "$t" in
    src|test|tests|__tests__|index|mod|lib|main|node_modules|target) continue ;;
  esac
  matches=$(grep -ilw "$t" docs/*.md 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "  '$t' → $(echo "$matches" | tr '\n' ' ')"
  fi
done

echo ""
echo "Confirm that changed behavior agrees with its canonical contract."
