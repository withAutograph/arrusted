#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
bun_bin="$(mise which bun)"
scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT

fail() {
  echo "mise Rust cache path fixture test failed: $*" >&2
  exit 1
}

fixture_root="${scratch}/repo"
mkdir -p "${fixture_root}/scripts" "${fixture_root}/.config/mise/scripts/repository"
cp "${repo_root}/.config/mise/scripts/repository/check-mise-rust-cache-paths.ts" "${fixture_root}/.config/mise/scripts/repository/"
printf '%s\n' '[env]' >"${fixture_root}/.config/mise/config.toml"

clean_git_env() {
  env \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    -u GIT_COMMON_DIR \
    -u GIT_CONFIG \
    -u GIT_CONFIG_COUNT \
    -u GIT_CONFIG_PARAMETERS \
    -u GIT_DIR \
    -u GIT_GRAFT_FILE \
    -u GIT_IMPLICIT_WORK_TREE \
    -u GIT_INDEX_FILE \
    -u GIT_INTERNAL_SUPER_PREFIX \
    -u GIT_NO_REPLACE_OBJECTS \
    -u GIT_OBJECT_DIRECTORY \
    -u GIT_PREFIX \
    -u GIT_REPLACE_REF_BASE \
    -u GIT_SHALLOW_FILE \
    -u GIT_WORK_TREE \
    "$@"
}

fixture_git() {
  clean_git_env git -C "${fixture_root}" "$@"
}

fixture_git init -q
fixture_git add --intent-to-add \
  .config/mise/scripts/repository/check-mise-rust-cache-paths.ts .config/mise/config.toml

mkdir -p \
  "${fixture_root}/apps/fixture-app/~/toolchain"
printf '%s\n' 'apps/fixture-app/~/' >"${fixture_root}/.gitignore"
fixture_git add --intent-to-add .gitignore

set +e
output="$(
  cd "${fixture_root}" &&
    clean_git_env env \
      CARGO_HOME="${scratch}/cargo-home" \
      RUSTUP_HOME="${scratch}/rustup-home" \
      "${bun_bin}" .config/mise/scripts/repository/check-mise-rust-cache-paths.ts 2>&1
)"
status=$?
set -e

[ "${status}" -ne 0 ] || fail "nested literal toolchain tree unexpectedly passed"
[[ "${output}" == *"repository-local literal ~/ directory exists at apps/fixture-app/~/"* ]] ||
  fail "nested literal toolchain tree did not report its repository-relative path"

rm -rf "${fixture_root}/apps/fixture-app/~"
mkdir -p "${fixture_root}/apps/fixture-app/{{ xdg_data_home }}/toolchain"
printf '%s\n' 'untracked literal path' \
  >"${fixture_root}/apps/fixture-app/{{ xdg_data_home }}/toolchain/marker"
set +e
output="$(
  cd "${fixture_root}" &&
    clean_git_env env \
      CARGO_HOME="${scratch}/cargo-home" \
      RUSTUP_HOME="${scratch}/rustup-home" \
      "${bun_bin}" .config/mise/scripts/repository/check-mise-rust-cache-paths.ts 2>&1
)"
status=$?
set -e

[ "${status}" -ne 0 ] || fail "untracked literal xdg_data_home tree unexpectedly passed"
[[ "${output}" == *"repository-local literal {{ xdg_data_home }}/ directory exists at apps/fixture-app/{{ xdg_data_home }}/toolchain/marker"* ]] ||
  fail "untracked literal xdg_data_home tree did not report its repository-relative path"

fixture_git add --intent-to-add \
  "apps/fixture-app/{{ xdg_data_home }}/toolchain/marker"
set +e
output="$(
  cd "${fixture_root}" &&
    clean_git_env env \
      CARGO_HOME="${scratch}/cargo-home" \
      RUSTUP_HOME="${scratch}/rustup-home" \
      "${bun_bin}" .config/mise/scripts/repository/check-mise-rust-cache-paths.ts 2>&1
)"
status=$?
set -e

[ "${status}" -ne 0 ] || fail "tracked literal xdg_data_home tree unexpectedly passed"
[[ "${output}" == *"repository-local literal {{ xdg_data_home }}/ directory exists at apps/fixture-app/{{ xdg_data_home }}/toolchain/marker"* ]] ||
  fail "tracked literal xdg_data_home tree did not report its repository-relative path"

echo "mise Rust cache path fixture tests passed."
