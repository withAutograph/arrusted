#!/usr/bin/env bash
set -euo pipefail

# Deleted source files cannot contain a remaining forbidden import. Structural
# and checker configuration changes still run the complete convention suite.
paths=()
for file in "$@"; do
  if [[ -e "$file" ]]; then paths+=(--paths "$file"); fi
done
if [[ ${#paths[@]} -eq 0 ]]; then exit 0; fi
mise exec -- konsistent check --config-path .config/konsistent.json "${paths[@]}"
