#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -lt 3 || "$2" != "--" ]]; then
  echo "usage: $0 <label> -- <command> [args ...]" >&2
  exit 2
fi

label="$1"
shift 2
start_epoch="$(date +%s)"
start_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

set +e
"$@"
status=$?
set -e

end_epoch="$(date +%s)"
duration=$((end_epoch - start_epoch))
end_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  if ! grep -Fq '| CI step | Duration | Started | Finished |' "${GITHUB_STEP_SUMMARY}" 2>/dev/null; then
    printf '\n### CI timing\n\n| CI step | Duration | Started | Finished |\n| --- | ---: | --- | --- |\n' >>"${GITHUB_STEP_SUMMARY}"
  fi
  printf '| %s | %ss | %s | %s |\n' "$label" "$duration" "$start_iso" "$end_iso" >>"${GITHUB_STEP_SUMMARY}"
fi
echo "::notice title=CI timing::${label} took ${duration}s (${start_iso} to ${end_iso})"

exit "$status"
