#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../../.." && pwd)"
# shellcheck source=.config/mise/scripts/repository/developer-lib.sh
source "${script_dir}/developer-lib.sh"

require_commands createdb dropdb grep psql sed

auth_test_bun_bin="$(dirname "$(mise which bun)")"
PATH="${auth_test_bun_bin}:${PATH}"
export PATH

# Provisioning and schema checks share a nonempty, test-owned application catalog.
export AUTH_CATALOG_APP_IDS='["fixture-a","fixture-b"]'

database_suffix="${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-0}_$$"
fresh_database_name="$(sanitize_db_name "local_apps_auth_fresh_${database_suffix}")"
require_safe_database_name "${fresh_database_name}"

generated_schema="$(mktemp "${repo_root}/.auth-schema-generated.XXXXXX")"

cleanup() {
  rm -f "${generated_schema}"
  drop_database_if_exists "${fresh_database_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb "${fresh_database_name}"
if [[ -n "${PGPASSWORD:-}" || ( -n "${PGHOST:-}" && "${PGHOST}" != /* ) ]]; then
  fresh_database_url="postgres://$(postgres_authority)/${fresh_database_name}?sslmode=disable"
elif [[ -n "${PGHOST:-}" ]]; then
  fresh_database_url="postgres:///${fresh_database_name}?host=$(urlencode_component "${PGHOST}")&sslmode=disable"
else
  socket_directories="$(psql --no-psqlrc --no-align --tuples-only --quiet --dbname=postgres --command='show unix_socket_directories')"
  socket_directory="${socket_directories%%,*}"
  fresh_database_url="postgres:///${fresh_database_name}?host=$(urlencode_component "${socket_directory}")&sslmode=disable"
fi


PLATFORM_AUTH_ALLOW_PLACEHOLDER_CONFIG=1 \
PLATFORM_AUTH_DATABASE_URL="${fresh_database_url}" \
BETTER_AUTH_APP_NAME=Autograph \
BETTER_AUTH_URL="http://localhost:3000" \
BETTER_AUTH_SECRET="01234567890123456789012345678901" \
  mise exec -- bun x auth@1.7.3 generate \
    --config "${repo_root}/packages/auth/auth.ts" \
    --output "${generated_schema}" \
    --yes >/dev/null

if ! grep -Eq 'create table "organization"[^;]*"appIds" jsonb' "${generated_schema}"; then
  echo "Better Auth schema generation omitted organization.appIds jsonb." >&2
  exit 1
fi

run_provision() {
  local database_url="$1"
  (
    cd "${repo_root}/packages/auth"
    PLATFORM_AUTH_DATABASE_URL="${database_url}" \
      BETTER_AUTH_URL="http://localhost:3000" \
      BETTER_AUTH_SECRET="01234567890123456789012345678901" \
      "${repo_root}/.config/mise/scripts/auth/db-provision" >/dev/null
  )
}

run_schema_check() {
  local database_url="$1"
  (
    cd "${repo_root}"
    PLATFORM_AUTH_DATABASE_URL="${database_url}" \
      BETTER_AUTH_URL="http://localhost:3000" \
      BETTER_AUTH_SECRET="01234567890123456789012345678901" \
      "${repo_root}/.config/mise/scripts/auth/schema-check"
  )
}

organization_snapshot() {
  local database_url="$1"
  psql --no-psqlrc --no-align --tuples-only --quiet --set ON_ERROR_STOP=1 \
    --dbname="${database_url}" <<'SQL'
select string_agg("id" || ':' || "name" || ':' || "appIds"::text, ',' order by "id")
from "organization" where "id" in ('hc', 'vendor', 'dev');
SQL
}

catalog_app_ids="${AUTH_CATALOG_APP_IDS}"
expected_organizations="$(
  psql --no-psqlrc --no-align --tuples-only --quiet --set ON_ERROR_STOP=1 \
    --set "catalog_app_ids=${catalog_app_ids}" --dbname="${fresh_database_url}" <<'SQL'
select 'dev:Dev:' || :'catalog_app_ids'::jsonb::text || ',hc:HC:["hc"],vendor:Vendor:["vendor", "integrations"]';
SQL
)"

run_provision "${fresh_database_url}"
fresh_first="$(organization_snapshot "${fresh_database_url}" | sed '/^$/d')"
run_provision "${fresh_database_url}"
fresh_second="$(organization_snapshot "${fresh_database_url}" | sed '/^$/d')"

psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname="${fresh_database_url}" <<'SQL'
alter table "account" add column "issuer" text;
insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
values ('legacy-credential-user', 'Legacy Credential User', 'legacy-credential@example.test', true, now(), now());
insert into "account" (
  "id", "issuer", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt"
)
values (
  'credential:legacy-credential-user',
  'local:credential',
  'legacy-credential-user',
  'credential',
  'legacy-credential-user',
  'legacy-password-hash',
  now(),
  now()
);
insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
values ('legacy-google-user', 'Legacy Google User', 'legacy-google@example.test', true, now(), now());
insert into "account" (
  "id", "issuer", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "createdAt", "updatedAt"
)
values (
  'google:legacy-google-user',
  'https://accounts.google.com',
  'google-subject-123',
  'google',
  'legacy-google-user',
  'legacy-google-access-token',
  'legacy-google-refresh-token',
  'legacy-google-id-token',
  now(),
  now()
);
insert into "session" (
  "id", "expiresAt", "token", "createdAt", "updatedAt", "userId"
)
values (
  'legacy-google-session',
  now() + interval '1 day',
  'legacy-google-session-token',
  now(),
  now(),
  'legacy-google-user'
);
alter table "account" alter column "issuer" set not null;
SQL
psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname="${fresh_database_url}" <<'SQL'
drop index "account_provider_id_account_id_uidx";
insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
values ('legacy-collision-user', 'Legacy Collision User', 'legacy-collision@example.test', true, now(), now());
insert into "account" (
  "id", "issuer", "accountId", "providerId", "userId", "createdAt", "updatedAt"
)
values (
  'google:legacy-collision-user',
  'https://legacy.accounts.google.com',
  'google-subject-123',
  'google',
  'legacy-collision-user',
  now(),
  now()
);
SQL
if run_provision "${fresh_database_url}" >/dev/null 2>&1; then
  echo "Auth provisioning accepted duplicate (providerId, accountId) identities." >&2
  exit 1
fi
psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname="${fresh_database_url}" \
  --command='delete from "account" where "id" = '\''google:legacy-collision-user'\''; delete from "user" where "id" = '\''legacy-collision-user'\'';' >/dev/null
run_provision "${fresh_database_url}"
legacy_identities="$(psql --no-psqlrc --no-align --tuples-only --quiet --set ON_ERROR_STOP=1 \
  --dbname="${fresh_database_url}" \
  --command='select "id" || '\''|'\'' || "issuer" || '\''|'\'' || "accountId" from "account" where "id" in ('\''credential:legacy-credential-user'\'', '\''google:legacy-google-user'\'') order by "id";')"
legacy_session="$(psql --no-psqlrc --no-align --tuples-only --quiet --set ON_ERROR_STOP=1 \
  --dbname="${fresh_database_url}" \
  --command='select "token" || '\''|'\'' || "userId" from "session" where "id" = '\''legacy-google-session'\'';')"
issuer_nullable="$(psql --no-psqlrc --no-align --tuples-only --quiet --set ON_ERROR_STOP=1 \
  --dbname="${fresh_database_url}" \
  --command='select is_nullable from information_schema.columns where table_schema = '\''public'\'' and table_name = '\''account'\'' and column_name = '\''issuer'\'';')"
fresh_memberships="$(psql --no-psqlrc --no-align --tuples-only --quiet --set ON_ERROR_STOP=1 --dbname="${fresh_database_url}" --command 'select count(*) from "member";')"
run_schema_check "${fresh_database_url}" >/dev/null

psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --set "catalog_app_ids=${catalog_app_ids}" --dbname="${fresh_database_url}" <<'SQL' >/dev/null
update "organization"
set "appIds" = (
  select coalesce(jsonb_agg(value order by ordinal desc), '[]'::jsonb)
  from jsonb_array_elements(:'catalog_app_ids'::jsonb) with ordinality as app(value, ordinal)
)
where "id" = 'dev';
SQL
run_schema_check "${fresh_database_url}" >/dev/null
run_provision "${fresh_database_url}"

for organization_id in hc vendor dev; do
  psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname="${fresh_database_url}" \
    --command="update \"organization\" set \"appIds\" = '[]'::jsonb where \"id\" = '${organization_id}';" >/dev/null
  if run_schema_check "${fresh_database_url}" >/dev/null 2>&1; then
    echo "Auth schema check accepted a stale canonical ${organization_id} app assignment." >&2
    exit 1
  fi
  run_provision "${fresh_database_url}"
done

for organization_id in hc vendor dev; do
  psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname="${fresh_database_url}" \
    --command="delete from \"organization\" where \"id\" = '${organization_id}';" >/dev/null
  if run_schema_check "${fresh_database_url}" >/dev/null 2>&1; then
    echo "Auth schema check accepted a missing canonical ${organization_id} app assignment." >&2
    exit 1
  fi
  run_provision "${fresh_database_url}"
done

run_schema_check "${fresh_database_url}" >/dev/null

if [[ "${fresh_first}" != "${expected_organizations}" || "${fresh_second}" != "${fresh_first}" || "${legacy_identities}" != $'credential:legacy-credential-user|local:credential|legacy-credential-user\ngoogle:legacy-google-user|https://accounts.google.com|google-subject-123' || "${legacy_session}" != "legacy-google-session-token|legacy-google-user" || "${issuer_nullable}" != "YES" || "${fresh_memberships}" != "0" ]]; then
  echo "Auth provisioning did not preserve identities, sessions and idempotent organization state." >&2
  exit 1
fi
echo "Auth schema generation, duplicate identity rejection, legacy identity/session preservation and idempotent provisioning passed."
