#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 || ( "$1" != "true" && "$1" != "false" ) ]]; then
  echo "usage: $0 <true|false>" >&2
  exit 2
fi

readonly pr_mode="$1"
readonly clx_eagain_signature='clx: Io(Os { code: 11, kind:'

prepare_pr_base() {
  local actual_base_sha

  if [[ -z "${HK_PR_BASE_REF:-}" && -z "${HK_PR_BASE_SHA:-}" ]]; then
    return
  fi
  if [[ -z "${HK_PR_BASE_REF:-}" || -z "${HK_PR_BASE_SHA:-}" ]]; then
    echo "HK PR range mode requires both HK_PR_BASE_REF and HK_PR_BASE_SHA" >&2
    exit 1
  fi
  if [[ ! "${HK_PR_BASE_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "HK_PR_BASE_SHA must be an exact lowercase 40-character commit SHA" >&2
    exit 1
  fi

  actual_base_sha="$(git rev-parse --verify "${HK_PR_BASE_REF}^{commit}")" \
    || {
      echo "HK PR base ref ${HK_PR_BASE_REF} is not a resolvable commit" >&2
      exit 1
    }
  if [[ "${actual_base_sha}" != "${HK_PR_BASE_SHA}" ]]; then
    echo "HK PR base ref resolved to ${actual_base_sha}, expected ${HK_PR_BASE_SHA}" >&2
    exit 1
  fi
  if ! git merge-base HEAD "${HK_PR_BASE_SHA}" >/dev/null; then
    echo "HK PR base ${HK_PR_BASE_SHA} has no resolvable ancestry with HEAD" >&2
    exit 1
  fi

  # All parallel consumers inherit the immutable object identity. The fetched
  # ref remains only a preflight receipt and is no longer a runtime dependency.
  export HK_PR_BASE_REF="${HK_PR_BASE_SHA}"
}

if [[ "${pr_mode}" == "true" ]]; then
  prepare_pr_base
fi

unset INIT_CWD npm_config_local_prefix npm_package_json npm_package_name

run_hk() {
  local capture_status
  local log_file
  local -a pipeline_status
  local retry_status
  local status
  log_file="$(mktemp "${TMPDIR:-/tmp}/workspace-check.XXXXXX")"

  set +e
  mise exec -- hk "$@" 2>&1 | tee "${log_file}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  status="${pipeline_status[0]}"
  capture_status="${pipeline_status[1]}"

  if [[ "${capture_status}" -ne 0 ]]; then
    rm -f "${log_file}"
    return "${capture_status}"
  fi

  if [[ "${status}" -eq 101 ]] && grep -Fq "${clx_eagain_signature}" "${log_file}"; then
    echo "::warning::Retrying workspace quality gate once after transient clx EAGAIN (OS code 11)."
    set +e
    mise exec -- hk "$@"
    retry_status=$?
    set -e
    rm -f "${log_file}"
    return "${retry_status}"
  fi

  rm -f "${log_file}"
  return "${status}"
}

if [[ "${pr_mode}" == "true" ]]; then
  if [[ -n "${HK_PR_BASE_REF:-}" ]]; then
    run_hk check \
      --from-ref "${HK_PR_BASE_REF}" \
      --to-ref HEAD \
      --skip-step check:rust
  else
    run_hk check --pr \
      --skip-step check:rust
  fi
else
  run_hk check --all
fi
