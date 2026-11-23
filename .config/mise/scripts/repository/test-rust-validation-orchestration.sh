#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/rust-validation.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT HUP INT TERM

mock_bin="$fixture_root/bin"
log="$fixture_root/cargo.log"
cwd_log="$fixture_root/cargo.cwd.log"
mkdir -p "$mock_bin"

cat >"$mock_bin/cargo" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"${PLATFORM_RUST_VALIDATION_LOG:?}"
printf '%s\n' "$PWD" >>"${PLATFORM_RUST_VALIDATION_CWD_LOG:?}"
if [ "${PLATFORM_FAIL_TYPEGEN:-0}" = 1 ] && [ "${1:-}" = run ]; then
  exit 17
fi
MOCK
chmod +x "$mock_bin/cargo"
printf '#!/bin/sh\nexit 0\n' >"$mock_bin/mise"
chmod +x "$mock_bin/mise"

(
  cd "$repo_root/packages/kernel"
  PATH="$mock_bin:$PATH" \
    GIT_DIR="$fixture_root/not-a-repository" \
    GIT_WORK_TREE="$fixture_root" \
    PLATFORM_RUST_VALIDATION_LOG="$log" \
    PLATFORM_RUST_VALIDATION_CWD_LOG="$cwd_log" \
    "$repo_root/.config/mise/tasks/kernel/check"
)

expected='run -p typegen -- --check
clippy --workspace --all-targets --features kernel/testing -- -D warnings'
[ "$(cat "$log")" = "$expected" ] || {
  echo "Rust validation commands or ordering changed" >&2
  exit 1
}
[ "$(cat "$cwd_log")" = "$repo_root
$repo_root" ] || {
  echo "Rust validation commands did not run from the repository root" >&2
  exit 1
}

: >"$log"
: >"$cwd_log"
if (
  cd "$repo_root/packages/kernel"
  PATH="$mock_bin:$PATH" \
    GIT_DIR="$fixture_root/not-a-repository" \
    GIT_WORK_TREE="$fixture_root" \
    PLATFORM_RUST_VALIDATION_LOG="$log" \
    PLATFORM_RUST_VALIDATION_CWD_LOG="$cwd_log" \
    PLATFORM_FAIL_TYPEGEN=1 \
    "$repo_root/.config/mise/tasks/kernel/check"
); then
  echo "Rust validation unexpectedly continued after typegen failed" >&2
  exit 1
fi

[ "$(cat "$log")" = 'run -p typegen -- --check' ] || {
  echo "Clippy ran after generated-contract validation failed" >&2
  exit 1
}
[ "$(cat "$cwd_log")" = "$repo_root" ] || {
  echo "Failed Rust validation command did not run from the repository root" >&2
  exit 1
}

PYTHONDONTWRITEBYTECODE=1 python3 "$repo_root/.config/mise/scripts/repository/run-affected-rust-workspace.test.py"
echo "Rust validation orchestration fixtures passed"
