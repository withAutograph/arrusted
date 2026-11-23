#!/usr/bin/env bash
set -euo pipefail

for name in $(git rev-parse --local-env-vars); do
  unset "$name"
done
unset GIT_INTERNAL_SUPER_PREFIX

export TURBO_SCM_BASE="${HK_PR_BASE_REF:-origin/main}"
export TURBO_SCM_HEAD=HEAD
mise exec -- turbo run check lint --affected
