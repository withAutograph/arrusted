#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -lt 2 || ( "$1" != "true" && "$1" != "false" ) ]]; then
  echo "usage: $0 <true|false> <hk-step> [<hk-step> ...]" >&2
  exit 2
fi

readonly pr_mode="$1"
shift
steps=("$@")

unset INIT_CWD npm_config_local_prefix npm_package_json npm_package_name

command=(check)
if [[ "${pr_mode}" == "true" ]]; then
  if [[ -n "${HK_PR_BASE_REF:-}" || -n "${HK_PR_BASE_SHA:-}" ]]; then
    [[ -n "${HK_PR_BASE_REF:-}" && -n "${HK_PR_BASE_SHA:-}" ]] \
      || { echo "HK PR range mode requires both HK_PR_BASE_REF and HK_PR_BASE_SHA" >&2; exit 1; }
    [[ "${HK_PR_BASE_SHA}" =~ ^[0-9a-f]{40}$ ]] \
      || { echo "HK_PR_BASE_SHA must be an exact lowercase 40-character commit SHA" >&2; exit 1; }
    [[ "$(git rev-parse --verify "${HK_PR_BASE_REF}^{commit}")" == "${HK_PR_BASE_SHA}" ]] \
      || { echo "HK_PR_BASE_REF does not resolve to HK_PR_BASE_SHA" >&2; exit 1; }
    command+=(--from-ref "${HK_PR_BASE_SHA}" --to-ref HEAD)
  else
    command+=(--pr)
  fi
else
  command+=(--all)
fi

for step in "${steps[@]}"; do
  command+=(--step "${step}")
done

readonly clx_eagain_signature='clx: Io(Os { code: 11, kind:'
readonly stdout_eagain_signature="'standard output'\": Resource temporarily unavailable (os error 11)"
log_file="$(mktemp "${TMPDIR:-/tmp}/workspace-check-lane.XXXXXX")"

set +e
mise exec -- hk "${command[@]}" 2>&1 | tee "${log_file}"
pipeline_status=("${PIPESTATUS[@]}")
set -e
status="${pipeline_status[0]}"
capture_status="${pipeline_status[1]}"

if [[ "${capture_status}" -ne 0 ]]; then
  rm -f "${log_file}"
  exit "${capture_status}"
fi

if { [[ "${status}" -eq 101 ]] && grep -Fq "${clx_eagain_signature}" "${log_file}"; } ||
  { [[ "${status}" -ne 0 ]] && grep -Fq "${stdout_eagain_signature}" "${log_file}"; }; then
  echo "::warning::Retrying workspace quality lane once after transient EAGAIN (OS code 11)."
  set +e
  mise exec -- hk "${command[@]}"
  retry_status=$?
  set -e
  rm -f "${log_file}"
  exit "${retry_status}"
fi

rm -f "${log_file}"
exit "${status}"
