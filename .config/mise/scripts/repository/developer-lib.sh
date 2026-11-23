#!/usr/bin/env bash

readonly local_db_name_pattern='^[A-Za-z0-9_]+$'

urlencode_component() (
  LC_ALL=C
  printf '%s' "$1" | od -An -tx1 -v | awk '
    BEGIN {
      for (n = 48; n <= 57; n++) {
        safe[sprintf("%02X", n)] = sprintf("%c", n)
      }
      for (n = 65; n <= 90; n++) {
        safe[sprintf("%02X", n)] = sprintf("%c", n)
      }
      for (n = 97; n <= 122; n++) {
        safe[sprintf("%02X", n)] = sprintf("%c", n)
      }
      safe["2D"] = "-"
      safe["2E"] = "."
      safe["5F"] = "_"
      safe["7E"] = "~"
    }
    {
      for (i = 1; i <= NF; i++) {
        byte = toupper($i)
        if (byte in safe) {
          printf "%s", safe[byte]
        } else {
          printf "%%%s", byte
        }
      }
    }
  '
)

postgres_authority() {
  local authority_user
  local authority_host="${PGHOST:-127.0.0.1}"
  authority_user="$(urlencode_component "${PGUSER:-postgres}")"

  if [[ -n "${PGPASSWORD:-}" ]]; then
    authority_user="${authority_user}:$(urlencode_component "${PGPASSWORD}")"
  fi

  printf '%s@%s' "${authority_user}" "${authority_host}"
  if [[ -n "${PGPORT:-}" ]]; then
    printf ':%s' "${PGPORT}"
  fi
}

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
}

require_commands() {
  local command_name
  for command_name in "$@"; do
    require_command "${command_name}"
  done
}

sanitize_db_name() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c '[:alnum:]' '_'
}

require_safe_database_name() {
  local database_name="$1"

  if [[ -z "${database_name}" || ! "${database_name}" =~ ${local_db_name_pattern} ]]; then
    echo "Invalid database name: ${database_name}" >&2
    exit 1
  fi

  case "${database_name}" in
    postgres | template0 | template1)
      echo "Refusing protected database name: ${database_name}" >&2
      exit 1
      ;;
  esac

  if [[ "${database_name}" != local_apps_* ]]; then
    echo "Refusing non-local-apps database name: ${database_name}" >&2
    exit 1
  fi
}

database_exists_value() {
  local database_name="$1"
  local exists
  require_safe_database_name "${database_name}"

  exists="$(
    psql \
      --no-psqlrc \
      --no-align \
      --tuples-only \
      --quiet \
      --set=ON_ERROR_STOP=1 \
      --dbname=postgres \
      --command="SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${database_name}');"
  )"

  case "${exists}" in
    t | f)
      printf '%s\n' "${exists}"
      ;;
    *)
      echo "Unexpected database existence result for ${database_name}: ${exists}" >&2
      return 1
      ;;
  esac
}

database_exists() {
  local exists
  exists="$(database_exists_value "$1")"
  [[ "${exists}" == "t" ]]
}

database_missing() {
  local exists
  exists="$(database_exists_value "$1")"
  [[ "${exists}" == "f" ]]
}

drop_database_if_exists() {
  local database_name="$1"
  require_safe_database_name "${database_name}"
  dropdb --force --if-exists "${database_name}"
}

wait_until() {
  local attempts="$1"
  local delay_seconds="$2"
  shift 2

  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if "$@"; then
      return 0
    fi

    if ((attempt < attempts)); then
      sleep "${delay_seconds}"
    fi
  done

  return 1
}
