#!/bin/bash

set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly test_dir="${repo_root}/packages/schema-compiler/tests"
readonly psql_bin="${PSQL_BIN:-psql}"
readonly cargo_bin="${CARGO_BIN:-cargo}"
readonly only_targets="${SQL_PARITY_ONLY_TARGETS:-}"
readonly excluded_targets="${SQL_PARITY_EXCLUDE_TARGETS:-}"

if [[ -n "${only_targets}" && -n "${excluded_targets}" ]]; then
  echo "generated SQL parity accepts only one of SQL_PARITY_ONLY_TARGETS or SQL_PARITY_EXCLUDE_TARGETS" >&2
  exit 64
fi

if [[ -z "${KERNEL_TEST_DATABASE_URL:-}" ]]; then
  echo "generated SQL parity requires KERNEL_TEST_DATABASE_URL" >&2
  exit 64
fi

if ! command -v "${psql_bin}" >/dev/null 2>&1; then
  echo "generated SQL parity requires the PostgreSQL client: ${psql_bin}" >&2
  exit 69
fi

if ! "${psql_bin}" "${KERNEL_TEST_DATABASE_URL}" \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 \
  --quiet \
  --tuples-only \
  --command 'select 1' >/dev/null 2>&1; then
  echo "generated SQL parity requires a reachable KERNEL_TEST_DATABASE_URL" >&2
  exit 69
fi

targets=()
while IFS= read -r test_file; do
  target="$(basename "${test_file}" .rs)"
  targets+=("${target}")
done < <(find "${test_dir}" -maxdepth 1 -type f \( -name 'sql_parity_*.rs' -o -name 'sql_runtime_*.rs' \) -print | LC_ALL=C sort)

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "generated SQL parity found no generated SQL test targets" >&2
  exit 66
fi

contains_target() {
  local candidate="$1"
  shift
  local target
  for target in "$@"; do
    [[ "${target}" == "${candidate}" ]] && return 0
  done
  return 1
}

validate_target_selector() {
  local selector_name="$1"
  local selector_value="$2"
  local selected_target
  local -a selected_targets=()

  if [[ "${selector_value}" == ,* || "${selector_value}" == *, ]]; then
    echo "generated SQL parity ${selector_name} contains an empty target" >&2
    exit 64
  fi
  IFS=',' read -r -a selected_targets <<<"${selector_value}"
  for selected_target in "${selected_targets[@]}"; do
    if [[ -z "${selected_target}" ]]; then
      echo "generated SQL parity ${selector_name} contains an empty target" >&2
      exit 64
    fi
    if ! contains_target "${selected_target}" "${targets[@]}"; then
      echo "generated SQL parity ${selector_name} names an unknown target: ${selected_target}" >&2
      exit 64
    fi
  done
}

selector_contains_target() {
  local candidate="$1"
  local selector_value="$2"
  local -a selector_targets=()

  IFS=',' read -r -a selector_targets <<<"${selector_value}"
  contains_target "${candidate}" "${selector_targets[@]}"
}

if [[ -n "${only_targets}" ]]; then
  validate_target_selector "SQL_PARITY_ONLY_TARGETS" "${only_targets}"
  selected_targets=()
  for target in "${targets[@]}"; do
    if selector_contains_target "${target}" "${only_targets}"; then
      selected_targets+=("${target}")
    fi
  done
  targets=("${selected_targets[@]}")
elif [[ -n "${excluded_targets}" ]]; then
  validate_target_selector "SQL_PARITY_EXCLUDE_TARGETS" "${excluded_targets}"
  selected_targets=()
  for target in "${targets[@]}"; do
    if ! selector_contains_target "${target}" "${excluded_targets}"; then
      selected_targets+=("${target}")
    fi
  done
  targets=("${selected_targets[@]}")
fi

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "generated SQL parity selected no generated SQL test targets" >&2
  exit 66
fi

cargo_args=(test --locked -p schema-compiler)
for target in "${targets[@]}"; do
  cargo_args+=(--test "${target}")
done

readonly output_log="$(mktemp "${TMPDIR:-/tmp}/generated-sql-parity.XXXXXX")"
trap 'rm -f "${output_log}"' EXIT

echo "running ${#targets[@]} generated SQL parity test targets"
set +e
"${cargo_bin}" "${cargo_args[@]}" -- --nocapture --test-threads=1 2>&1 | tee "${output_log}"
readonly cargo_status="${PIPESTATUS[0]}"
set -e

if [[ "${cargo_status}" -ne 0 ]]; then
  exit "${cargo_status}"
fi

if grep -Eiq 'skipping .*(test|SQL|parity)' "${output_log}"; then
  echo "generated SQL parity rejected a fixture-level database skip" >&2
  exit 1
fi
