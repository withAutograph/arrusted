#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 <base-repository-url> <base-commit-sha>" >&2
  exit 2
fi

readonly base_repository_url="$1"
readonly expected_base_sha="$2"
readonly pr_base_ref="refs/remotes/ci/pr-event-base"

if [[ ! "${expected_base_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "PR base must be an exact lowercase 40-character commit SHA" >&2
  exit 1
fi

fetch_args=(
  fetch
  --no-tags
  --no-write-fetch-head
  "${base_repository_url}"
  "+${expected_base_sha}:${pr_base_ref}"
)
if [[ -n "${GITHUB_TOKEN:-}" && "${base_repository_url}" == https://github.com/* ]]; then
  authorization="$(
    printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64 | tr -d '\n'
  )"
  git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${authorization}" \
    "${fetch_args[@]}"
else
  git "${fetch_args[@]}"
fi

actual_base_sha="$(git rev-parse --verify "${pr_base_ref}^{commit}")"
if [[ "${actual_base_sha}" != "${expected_base_sha}" ]]; then
  echo "fetched PR base ${actual_base_sha}, expected ${expected_base_sha}" >&2
  exit 1
fi
if ! git merge-base HEAD "${actual_base_sha}" >/dev/null; then
  echo "fetched PR base ${actual_base_sha} has no resolvable ancestry with HEAD" >&2
  exit 1
fi
