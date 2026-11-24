#!/usr/bin/env bash

set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "${repo_root}"

case "${1:-}" in
  compile)
    bun .config/mise/scripts/repository/schema-release.ts compile
    bun .config/mise/scripts/repository/data-plane-fixture.ts compile
    ;;
  check)
    bun .config/mise/scripts/repository/schema-release.ts check
    bun .config/mise/scripts/repository/data-plane-fixture.ts check
    ;;
  *)
    echo "usage: schema-artifacts.sh <compile|check>" >&2
    exit 64
    ;;
esac
