#!/bin/sh

auth_fnox_config="${PLATFORM_FNOX_CONFIG:-.config/fnox/local.toml}"
auth_fnox_profile="${PLATFORM_FNOX_PROFILE:-local}"

auth_has_direct_env() {
  [ -n "${PLATFORM_AUTH_DATABASE_URL:-}" ] \
    && [ -n "${BETTER_AUTH_URL:-}" ] \
    && { [ -n "${BETTER_AUTH_SECRET:-}" ] || [ -n "${BETTER_AUTH_SECRETS:-}" ]; }
}

auth_has_partial_direct_env() {
  [ -n "${PLATFORM_AUTH_DATABASE_URL:-}" ] \
    || [ -n "${BETTER_AUTH_URL:-}" ] \
    || [ -n "${BETTER_AUTH_SECRET:-}" ] \
    || [ -n "${BETTER_AUTH_SECRETS:-}" ]
}

auth_fnox_get() {
  fnox -c "$auth_fnox_config" -P "$auth_fnox_profile" --no-defaults \
    get "$1" --if-missing ignore 2>/dev/null || true
}

auth_run_with_completed_env() {
  auth_database_url="${PLATFORM_AUTH_DATABASE_URL:-$(auth_fnox_get PLATFORM_AUTH_DATABASE_URL)}"
  better_auth_url="${BETTER_AUTH_URL:-$(auth_fnox_get BETTER_AUTH_URL)}"
  better_auth_secret="${BETTER_AUTH_SECRET:-$(auth_fnox_get BETTER_AUTH_SECRET)}"
  better_auth_secrets="${BETTER_AUTH_SECRETS:-$(auth_fnox_get BETTER_AUTH_SECRETS)}"

  if [ -z "$auth_database_url" ]; then
    echo "PLATFORM_AUTH_DATABASE_URL is required." >&2
    exit 1
  fi
  if [ -z "$better_auth_url" ]; then
    echo "BETTER_AUTH_URL is required." >&2
    exit 1
  fi
  if [ -z "$better_auth_secret" ] && [ -z "$better_auth_secrets" ]; then
    echo "BETTER_AUTH_SECRET or BETTER_AUTH_SECRETS is required." >&2
    exit 1
  fi

  PLATFORM_AUTH_DATABASE_URL="$auth_database_url"
  BETTER_AUTH_URL="$better_auth_url"
  export PLATFORM_AUTH_DATABASE_URL BETTER_AUTH_URL

  if [ -n "$better_auth_secret" ]; then
    BETTER_AUTH_SECRET="$better_auth_secret"
    export BETTER_AUTH_SECRET
  else
    unset BETTER_AUTH_SECRET
  fi

  if [ -n "$better_auth_secrets" ]; then
    BETTER_AUTH_SECRETS="$better_auth_secrets"
    export BETTER_AUTH_SECRETS
  else
    unset BETTER_AUTH_SECRETS
  fi

  "$@"
}

auth_run() {
  if auth_has_direct_env; then
    "$@"
    return
  fi

  if [ ! -f "$auth_fnox_config" ]; then
    echo "Complete auth env is required, or $auth_fnox_config must exist." >&2
    exit 1
  fi

  if auth_has_partial_direct_env; then
    auth_run_with_completed_env "$@"
    return
  fi

  fnox -c "$auth_fnox_config" -P "$auth_fnox_profile" --no-defaults run -- "$@"
}

auth_default_local_emails() {
  git_user_email="$(git config user.email 2>/dev/null || true)"
  case "$git_user_email" in
    *@*) printf 'admin@apps.localhost,%s' "$git_user_email" ;;
    *) printf 'admin@apps.localhost' ;;
  esac
}
