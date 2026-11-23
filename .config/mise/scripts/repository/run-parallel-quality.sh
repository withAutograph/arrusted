#!/usr/bin/env bash
set -euo pipefail

# The caller performs shared setup before starting the quality lanes.
: "${QUALITY_CONTEXT:?}" "${RUN_LINT:?}" "${RUN_TYPES:?}"
RUN_FORMAT="${RUN_FORMAT:-false}"
case "$QUALITY_CONTEXT" in pr|main) ;; *) echo "Invalid quality context" >&2; exit 2 ;; esac
for flag in "$RUN_LINT" "$RUN_TYPES" "$RUN_FORMAT"; do
  case "$flag" in true|false) ;; *) echo "Invalid quality selection" >&2; exit 2 ;; esac
done
mode=true
if [[ "$QUALITY_CONTEXT" == main && "${FULL:-false}" == true ]]; then mode=false; fi
logs="$(mktemp -d)"
cleanup() {
  trap - INT TERM
  local pid_name watchdog
  local -a groups=()
  for pid_name in lint_pid types_pid format_pid; do
    if [[ -v "$pid_name" ]]; then
      groups+=("${!pid_name}")
      kill -TERM -- "-${!pid_name}" 2>/dev/null || kill -TERM "${!pid_name}" 2>/dev/null || true
    fi
  done
  if (( ${#groups[@]} > 0 )); then
    # Each command owns a process group so descendants receive cancellation too.
    (sleep 2; for process in "${groups[@]}"; do
      kill -KILL -- "-$process" 2>/dev/null || true
    done) &
    watchdog=$!
    for pid_name in lint_pid types_pid format_pid; do
      if [[ -v "$pid_name" ]]; then wait "${!pid_name}" 2>/dev/null || true; fi
    done
    wait "$watchdog" 2>/dev/null || true
  fi
  rm -rf "$logs"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
lint=skipped types=skipped format=skipped
if [[ "$RUN_LINT" == true ]]; then
  GITHUB_STEP_SUMMARY="$logs/lint-summary" python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' .config/mise/scripts/repository/check-ci-timing.sh "quality-lint" -- .config/mise/scripts/repository/run-workspace-check-lane.sh "$mode" lint:app >"$logs/lint" 2>&1 &
  lint_pid=$!
fi
if [[ "$RUN_TYPES" == true ]]; then
  GITHUB_STEP_SUMMARY="$logs/types-summary" python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' .config/mise/scripts/repository/check-ci-timing.sh "quality-types" -- .config/mise/scripts/repository/run-workspace-check-lane.sh "$mode" check:types >"$logs/types" 2>&1 &
  types_pid=$!
fi
if [[ "$RUN_FORMAT" == true && "${FORMAT_AVAILABLE:-true}" != true ]]; then
  format=unavailable
  echo '::warning::Advisory format checks unavailable because prerequisite setup failed.'
elif [[ "$RUN_FORMAT" == true ]]; then
  GITHUB_STEP_SUMMARY="$logs/format-summary" python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' .config/mise/scripts/repository/check-ci-timing.sh "quality-format" -- .config/mise/scripts/repository/run-workspace-check-lane.sh "$mode" format:app format:kernel >"$logs/format" 2>&1 &
  format_pid=$!
fi
for lane in lint types format; do
  pid_name="${lane}_pid"
  if [[ -v "$pid_name" ]]; then
    if wait "${!pid_name}"; then
      printf -v "$lane" success
    else
      printf -v "$lane" failure
    fi
    unset "$pid_name"
    echo "::group::Quality ($lane)"
    cat "$logs/$lane"
    echo '::endgroup::'
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "$logs/${lane}-summary" ]]; then
      cat "$logs/${lane}-summary" >> "$GITHUB_STEP_SUMMARY"
    fi
  fi
done
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'lint=%s\ntypes=%s\n' "$lint" "$types" >> "$GITHUB_OUTPUT"
fi
if [[ "$format" == failure ]]; then
  echo '::warning::Advisory format checks failed.'
fi
[[ "$lint" != failure && "$types" != failure ]]
