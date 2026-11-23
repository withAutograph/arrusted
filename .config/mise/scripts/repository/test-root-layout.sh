#!/usr/bin/env bash
set -euo pipefail

repo_root="${MISE_MONOREPO_ROOT:-${MISE_PROJECT_ROOT:-$PWD}}"
checker="$repo_root/.config/mise/scripts/repository/check-root-layout.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

create_final_tree_fixture() {
  local destination="$1"

  git -C "$destination" init -q
  mkdir -p \
    "$destination/.claude" \
    "$destination/.config" \
    "$destination/.github" \
    "$destination/.storybook" \
    "$destination/app" \
    "$destination/docs" \
    "$destination/packages" \
    "$destination/.config/app-specs"
  touch \
    "$destination/.claude/.keep" \
    "$destination/.config/.keep" \
    "$destination/.github/.keep" \
    "$destination/.storybook/.keep" \
    "$destination/app/.keep" \
    "$destination/docs/.keep" \
    "$destination/packages/.keep" \
    "$destination/.config/app-specs/.keep"
  git -C "$destination" add .
}

create_final_tree_fixture "$fixture"
if ! bash "$checker" "$fixture" >/dev/null; then
  echo "root layout checker rejected the final repository tree fixture" >&2
  exit 1
fi

for retired_root in apps tools schemas examples scripts kernel domain-libs prototype unclassified-root; do
  negative_fixture="$(mktemp -d)"
  create_final_tree_fixture "$negative_fixture"
  mkdir -p "$negative_fixture/$retired_root"
  touch "$negative_fixture/$retired_root/.keep"
  git -C "$negative_fixture" add .

  if bash "$checker" "$negative_fixture" >/dev/null 2>&1; then
    echo "root layout checker accepted prohibited root $retired_root" >&2
    exit 1
  fi

  rm -rf "$negative_fixture"
done
