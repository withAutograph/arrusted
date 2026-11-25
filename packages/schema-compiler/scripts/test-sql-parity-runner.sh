#!/usr/bin/env bash

set -euo pipefail

# CI sets these for the real run; each case below sets its own.
unset SQL_PARITY_EXCLUDE_TARGETS SQL_PARITY_ONLY_TARGETS

trap 'status=$?; printf "parity fixture command failed (%s): %s\n" "${status}" "${BASH_COMMAND}" >&2' ERR

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly runner="${repo_root}/packages/schema-compiler/scripts/run-sql-parity.sh"
readonly fixture="$(mktemp -d "${TMPDIR:-/tmp}/generated-sql-parity-runner.XXXXXX")"

cleanup() {
  local status="$1"
  if [[ "${status}" -ne 0 ]]; then
    for log in "${fixture}"/*.out "${fixture}"/*.err; do
      [[ -f "${log}" ]] || continue
      echo "--- $(basename "${log}") ---" >&2
      cat "${log}" >&2
    done
  fi
  rm -rf "${fixture}"
}
trap 'status=$?; trap - EXIT; cleanup "${status}"; exit "${status}"' EXIT

fail() {
  echo "generated SQL parity runner test failed: $*" >&2
  exit 1
}

require_literal() {
  local file="$1"
  local literal="$2"
  grep -Fq -- "${literal}" "${file}" || fail "${file} is missing ${literal}"
}

cat >"${fixture}/psql" <<'EOF'
#!/bin/bash
if [[ "${FAKE_PSQL_MODE:-unreachable}" == "reachable" ]]; then
  printf '1\n'
  exit 0
fi
exit 1
EOF

cat >"${fixture}/cargo" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" >"${FAKE_CARGO_LOG}"
if [[ "${FAKE_CARGO_MODE:-pass}" == "skip" ]]; then
  echo "skipping PostgreSQL parity test: synthetic unavailable database"
elif [[ "${FAKE_CARGO_MODE:-pass}" == "runtime_skip" ]]; then
  echo "skipping SQL admin runtime test: synthetic unavailable database"
elif [[ "${FAKE_CARGO_MODE:-pass}" == "incidental_skip" ]]; then
  echo "skipping batch 2"
fi
EOF

chmod +x "${fixture}/psql" "${fixture}/cargo"

if (
  unset KERNEL_TEST_DATABASE_URL
  PSQL_BIN="${fixture}/psql" CARGO_BIN="${fixture}/cargo" /bin/bash "${runner}"
) >"${fixture}/missing.out" 2>"${fixture}/missing.err"; then
  fail "runner accepted a missing KERNEL_TEST_DATABASE_URL"
fi
require_literal "${fixture}/missing.err" "generated SQL parity requires KERNEL_TEST_DATABASE_URL"

if KERNEL_TEST_DATABASE_URL="postgresql://unreachable/parity" \
  FAKE_PSQL_MODE=unreachable \
  PSQL_BIN="${fixture}/psql" \
  CARGO_BIN="${fixture}/cargo" \
  FAKE_CARGO_LOG="${fixture}/unreachable-cargo.log" \
  /bin/bash "${runner}" >"${fixture}/unreachable.out" 2>"${fixture}/unreachable.err"; then
  fail "runner accepted an unreachable KERNEL_TEST_DATABASE_URL"
fi
require_literal \
  "${fixture}/unreachable.err" \
  "generated SQL parity requires a reachable KERNEL_TEST_DATABASE_URL"
[[ ! -e "${fixture}/unreachable-cargo.log" ]] || fail "cargo ran after the database probe failed"

KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
  FAKE_PSQL_MODE=reachable \
  PSQL_BIN="${fixture}/psql" \
  CARGO_BIN="${fixture}/cargo" \
  FAKE_CARGO_LOG="${fixture}/cargo.log" \
  /bin/bash "${runner}" >"${fixture}/reachable.out" 2>"${fixture}/reachable.err"

expected_count=0
for test_file in "${repo_root}"/packages/schema-compiler/tests/sql_parity_*.rs \
  "${repo_root}"/packages/schema-compiler/tests/sql_runtime_*.rs; do
  target="$(basename "${test_file}" .rs)"
  require_literal "${fixture}/cargo.log" "${target}"
  expected_count=$((expected_count + 1))
done
actual_count="$(grep -Ec '^sql_(parity|runtime)_[a-z0-9_]+$' "${fixture}/cargo.log")"
[[ "${actual_count}" -eq "${expected_count}" ]] ||
  fail "runner selected ${actual_count} of ${expected_count} generated parity targets"

KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
  FAKE_PSQL_MODE=reachable \
  SQL_PARITY_ONLY_TARGETS=sql_runtime_lookup_scale \
  PSQL_BIN="${fixture}/psql" \
  CARGO_BIN="${fixture}/cargo" \
  FAKE_CARGO_LOG="${fixture}/only-cargo.log" \
  /bin/bash "${runner}" >"${fixture}/only.out" 2>"${fixture}/only.err"

require_literal "${fixture}/only-cargo.log" "sql_runtime_lookup_scale"
only_count="$(grep -Ec '^sql_(parity|runtime)_[a-z0-9_]+$' "${fixture}/only-cargo.log")"
[[ "${only_count}" -eq 1 ]] || fail "runner did not restrict the selected scale target"

KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
  FAKE_PSQL_MODE=reachable \
  SQL_PARITY_EXCLUDE_TARGETS=sql_runtime_lookup_scale \
  PSQL_BIN="${fixture}/psql" \
  CARGO_BIN="${fixture}/cargo" \
  FAKE_CARGO_LOG="${fixture}/exclude-cargo.log" \
  /bin/bash "${runner}" >"${fixture}/exclude.out" 2>"${fixture}/exclude.err"

if grep -Fxq 'sql_runtime_lookup_scale' "${fixture}/exclude-cargo.log"; then
  fail "runner retained an excluded generated parity target"
fi
exclude_count="$(grep -Ec '^sql_(parity|runtime)_[a-z0-9_]+$' "${fixture}/exclude-cargo.log")"
[[ "${exclude_count}" -eq $((expected_count - 1)) ]] ||
  fail "runner selected ${exclude_count} instead of ${expected_count} minus the excluded target"

if KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
  FAKE_PSQL_MODE=reachable \
  SQL_PARITY_ONLY_TARGETS=sql_runtime_does_not_exist \
  PSQL_BIN="${fixture}/psql" \
  CARGO_BIN="${fixture}/cargo" \
  FAKE_CARGO_LOG="${fixture}/unknown-cargo.log" \
  /bin/bash "${runner}" >"${fixture}/unknown.out" 2>"${fixture}/unknown.err"; then
  fail "runner accepted an unknown generated parity target"
fi
require_literal "${fixture}/unknown.err" "generated SQL parity SQL_PARITY_ONLY_TARGETS names an unknown target"
[[ ! -e "${fixture}/unknown-cargo.log" ]] || fail "cargo ran after target selection failed"

for selector_name in SQL_PARITY_ONLY_TARGETS SQL_PARITY_EXCLUDE_TARGETS; do
  if env \
    KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
    FAKE_PSQL_MODE=reachable \
    "${selector_name}=sql_runtime_lookup_scale," \
    PSQL_BIN="${fixture}/psql" \
    CARGO_BIN="${fixture}/cargo" \
    FAKE_CARGO_LOG="${fixture}/empty-target-cargo.log" \
    /bin/bash "${runner}" >"${fixture}/empty-target.out" 2>"${fixture}/empty-target.err"; then
    fail "runner accepted a trailing selector delimiter for ${selector_name}"
  fi
  require_literal "${fixture}/empty-target.err" "generated SQL parity ${selector_name} contains an empty target"
  [[ ! -e "${fixture}/empty-target-cargo.log" ]] || fail "cargo ran after empty target selection failed"
done

if KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
  FAKE_PSQL_MODE=reachable \
  SQL_PARITY_ONLY_TARGETS=sql_runtime_lookup_scale \
  SQL_PARITY_EXCLUDE_TARGETS=sql_runtime_lookup_scale \
  PSQL_BIN="${fixture}/psql" \
  CARGO_BIN="${fixture}/cargo" \
  FAKE_CARGO_LOG="${fixture}/conflict-cargo.log" \
  /bin/bash "${runner}" >"${fixture}/conflict.out" 2>"${fixture}/conflict.err"; then
  fail "runner accepted conflicting target selectors"
fi
require_literal "${fixture}/conflict.err" "generated SQL parity accepts only one of SQL_PARITY_ONLY_TARGETS or SQL_PARITY_EXCLUDE_TARGETS"
[[ ! -e "${fixture}/conflict-cargo.log" ]] || fail "cargo ran after target selection conflicted"

KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
  FAKE_PSQL_MODE=reachable \
  FAKE_CARGO_MODE=incidental_skip \
  PSQL_BIN="${fixture}/psql" \
  CARGO_BIN="${fixture}/cargo" \
  FAKE_CARGO_LOG="${fixture}/incidental-cargo.log" \
  /bin/bash "${runner}" >"${fixture}/incidental.out" 2>"${fixture}/incidental.err"

for skip_mode in skip runtime_skip; do
  if KERNEL_TEST_DATABASE_URL="postgresql://reachable/parity" \
    FAKE_PSQL_MODE=reachable \
    FAKE_CARGO_MODE="${skip_mode}" \
    PSQL_BIN="${fixture}/psql" \
    CARGO_BIN="${fixture}/cargo" \
    FAKE_CARGO_LOG="${fixture}/skip-cargo.log" \
    /bin/bash "${runner}" >"${fixture}/skip.out" 2>"${fixture}/skip.err"; then
    fail "runner accepted a fixture-level PostgreSQL skip"
  fi
  require_literal "${fixture}/skip.err" "generated SQL parity rejected a fixture-level database skip"
done

readonly workflow="${repo_root}/.github/workflows/ci.yml"
readonly hooks="${repo_root}/.config/hk.pkl"
require_literal "${runner}" '#!/bin/bash'
require_literal "${workflow}" 'name: Database (Parity)'
require_literal "${workflow}" 'name: Database (Scale parity)'
require_literal "${workflow}" 'mise run schema:test-parity-runner'
require_literal "${workflow}" 'mise run --no-deps schema:test-parity'
awk '/^  parity:/{selected=1; next} selected && /^  [a-zA-Z0-9_-]+:/{exit} selected {print}' "${workflow}" >"${fixture}/parity-job.yml"

require_literal \
  "${fixture}/parity-job.yml" \
  'KERNEL_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres'
require_literal "${fixture}/parity-job.yml" 'SQL_PARITY_EXCLUDE_TARGETS: sql_runtime_lookup_scale'
awk '/^  scale-parity:/{selected=1; next} selected && /^  [a-zA-Z0-9_-]+:/{exit} selected {print}' "${workflow}" >"${fixture}/scale-parity-job.yml"

require_literal \
  "${fixture}/scale-parity-job.yml" \
  'KERNEL_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres'
require_literal "${fixture}/scale-parity-job.yml" 'SQL_PARITY_ONLY_TARGETS: sql_runtime_lookup_scale'
require_literal "${workflow}" 'parity, scale-parity]'
require_literal "${workflow}" 'all(.[]; .result == "success")'
require_literal "${hooks}" 'packages/schema-compiler'
require_literal "${hooks}" 'check:generated-sql-parity-runner'
require_literal "${hooks}" 'packages/schema-compiler/scripts/{run-sql-parity,test-sql-parity-runner}.sh'
require_literal "${repo_root}/.config/mise/tasks/schema/test-parity" '#!/bin/bash'
require_literal "${repo_root}/.config/mise/tasks/schema/test-parity" 'packages/schema-compiler/scripts/run-sql-parity.sh'
require_literal "${repo_root}/.config/mise/tasks/schema/test-parity-runner" '#!/bin/bash'
require_literal "${repo_root}/.config/mise/tasks/schema/test-parity-runner" 'packages/schema-compiler/scripts/test-sql-parity-runner.sh'

echo "generated SQL parity runner enforcement is valid"
