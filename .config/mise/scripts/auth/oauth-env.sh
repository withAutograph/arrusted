#!/bin/sh

OAUTH_STABLE_PRODUCTION_ORIGIN="https://apps.autograph.so"
OAUTH_STABLE_GOOGLE_CALLBACK="${OAUTH_STABLE_PRODUCTION_ORIGIN}/api/auth/callback/google"

oauth_google_ui_enabled() {
  case ",$(printf '%s' "${VITE_PLATFORM_AUTH_SOCIAL_PROVIDERS:-}" | tr '[:upper:]' '[:lower:]' | tr -d ' ')," in
    *,google,*) return 0 ;;
    *) return 1 ;;
  esac
}

oauth_configuration_requested() {
  [ -n "${GOOGLE_CLIENT_ID:-}" ] \
    || [ -n "${GOOGLE_CLIENT_SECRET:-}" ] \
    || [ -n "${OAUTH_PROXY_PRODUCTION_URL:-}" ] \
    || [ -n "${OAUTH_PROXY_SECRET:-}" ] \
    || oauth_google_ui_enabled
}

oauth_missing_names() {
  oauth_missing=""
  for oauth_name in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET OAUTH_PROXY_PRODUCTION_URL OAUTH_PROXY_SECRET; do
    case "$oauth_name" in
      GOOGLE_CLIENT_ID) oauth_value="${GOOGLE_CLIENT_ID:-}" ;;
      GOOGLE_CLIENT_SECRET) oauth_value="${GOOGLE_CLIENT_SECRET:-}" ;;
      OAUTH_PROXY_PRODUCTION_URL) oauth_value="${OAUTH_PROXY_PRODUCTION_URL:-}" ;;
      OAUTH_PROXY_SECRET) oauth_value="${OAUTH_PROXY_SECRET:-}" ;;
    esac
    if [ -z "$oauth_value" ]; then
      if [ -n "$oauth_missing" ]; then
        oauth_missing="$oauth_missing, $oauth_name"
      else
        oauth_missing="$oauth_name"
      fi
    fi
  done
  printf '%s' "$oauth_missing"
}

oauth_configuration_status() {
  if ! oauth_configuration_requested; then
    printf 'disabled'
  elif [ -n "$(oauth_missing_names)" ] \
    || [ "${OAUTH_PROXY_PRODUCTION_URL:-}" != "$OAUTH_STABLE_PRODUCTION_ORIGIN" ]; then
    printf 'incomplete'
  else
    printf 'ready'
  fi
}

oauth_configuration_action() {
  printf '%s\n' \
    "Configure the required OAuth values in the local fnox profile or environment." \
    "For deployments, configure the same OAUTH_PROXY_PRODUCTION_URL and OAUTH_PROXY_SECRET in Vercel Production, Preview, and Development."
}

oauth_print_incomplete_details() {
  oauth_missing="$(oauth_missing_names)"
  if [ -n "$oauth_missing" ]; then
    echo "Missing: $oauth_missing" >&2
  fi
  if [ -n "${OAUTH_PROXY_PRODUCTION_URL:-}" ] \
    && [ "$OAUTH_PROXY_PRODUCTION_URL" != "$OAUTH_STABLE_PRODUCTION_ORIGIN" ]; then
    echo "OAUTH_PROXY_PRODUCTION_URL must be $OAUTH_STABLE_PRODUCTION_ORIGIN." >&2
  fi
  oauth_configuration_action >&2
}

oauth_require_complete_configuration() {
  oauth_context="$1"
  oauth_status="$(oauth_configuration_status)"
  if [ "$oauth_status" != "incomplete" ]; then
    return 0
  fi

  echo "$oauth_context has incomplete Google OAuth proxy configuration." >&2
  oauth_print_incomplete_details
  return 1
}
