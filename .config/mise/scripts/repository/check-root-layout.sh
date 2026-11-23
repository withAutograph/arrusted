#!/usr/bin/env bash
set -euo pipefail

root="${1:-${MISE_MONOREPO_ROOT:-${MISE_PROJECT_ROOT:-$PWD}}}"

readonly source_roots=(app docs packages)
readonly configuration_roots=(.claude .config .github .storybook)

is_approved_root() {
  local candidate="$1"
  local root_name

  for root_name in "${source_roots[@]}" "${configuration_roots[@]}"; do
    [[ "$candidate" == "$root_name" ]] && return 0
  done

  return 1
}

invalid=""
while IFS= read -r candidate; do
  if ! is_approved_root "$candidate"; then
    invalid+="${candidate}"$'\n'
  fi
done < <(git -C "$root" ls-files | awk -F/ 'NF > 1 { print $1 }' | sort -u)

if [[ -n "$invalid" ]]; then
  printf 'tracked root directories are not approved:\n%s' "$invalid" >&2
  printf 'approved source roots: app/, packages/, docs/\n' >&2
  printf 'approved configuration roots: .claude/, .config/, .github/, .storybook/\n' >&2
  exit 1
fi
