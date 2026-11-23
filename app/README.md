# Starter app

One Next.js app uses the existing kernel, compiler, Canvas Host and Better Auth
packages from source. The deployment scope is `starter/starter`. The organization
is created on first email/password signup and never appears as a picker. Every
member may open each table, review drafts and save. OAuth agents can stage work;
the kernel still refuses their canonical writes. Membership and OAuth consent
are rechecked for every data operation. The migrator derives the kernel actor
membership from the Auth member row in the same database transaction; there is
no separate app grant to provision.

From the repository root, install dependencies with the pinned Bun. In `app/`,
copy `.env.example` to `.env.local` for the runtime connections and random secret.
Copy `.env.migrate.example` separately to `.env.migrate` for the owner connection.
Never put owner credentials or Neon API keys in a Next `.env*` file such as
`.env.local`: Next loads these into the HTTP process. `.env.migrate` is read only
when explicitly passed to Bun. Do not use the owner as `APP_DATABASE_URL`.

For a disposable local PostgreSQL server, create the database as its owner:

```sql
CREATE DATABASE starter;
```

Set `APP_DATABASE_URL` to a separate runtime login with a generated password of
at least 32 characters; migrate creates it. Run these from `app/`:

```sh
bun scripts/compile.ts
bun --env-file=.env.local --env-file=.env.migrate scripts/migrate.ts apply
bun run dev
```

The migrator grants the runtime login only
the generated kernel capabilities and Auth table access. `bun run build`
compiles the CUE source without database credentials and builds Next.js.
`bun --env-file=.env.local --env-file=.env.migrate run start` applies the separate
migration step before opening the HTTP listener, then removes migration and Neon credentials from the server process.
A failed migration prevents startup. For hosted deploys, run owner `bun run migrate`
from the builder's machine, then `vercel deploy --prod`. Disable Git auto-deploy.
There is no hosted setup/check runner. See the deploy skill for the short flow.
Migration creates a missing restricted SQL login from `APP_DATABASE_URL` (use a
generated password of at least 32 characters), then grants kernel/Auth access.
No provider deployment has been exercised.

The tables page discovers every model from the compiled definition. Opening a
table creates a dated Canvas session with that model. The existing Canvas
supplies grids, draft review and history. Every table page and Canvas session
also provides record creation and CSV import: map columns, preview, then apply
directly or save native drafts. Imports accept up to 100 rows / 512 KiB. Map an
external key column to update existing records on repeated imports; duplicate
keys within one file are refused. The same kernel write path validates both
creation and imports. The Overview custom section remains a generated-operations
example. Session creation keeps its
request ID on retries. `app/(sections)/overview/page.tsx` is an ordinary custom
section; add navigation in `app/(sections)/layout.tsx`.

Connect an MCP client to `/starter/api/mcp` using the existing OAuth PKCE flow.
Discovery is at `/.well-known/oauth-protected-resource/starter/api/mcp` and
`/.well-known/oauth-authorization-server/api/auth`. Cookie-only MCP requests are
rejected. Device pairing at `/auth/device` gives the chat Canvas its separate
human token. The app’s build and dev commands build `packages/canvas-host` to
include its MCP Apps HTML resource. If that artifact is missing, the existing
host deliberately serves text tools only.
Set `CANVAS_FRAME_ORIGINS` for additional trusted MCP frame origins.
Claude's `propose_records` and `import_csv` tools return validated, unpersisted
proposal JSON. A member pastes it into the Canvas entry panel, previews it, and
applies or saves drafts. Agents still cannot persist new-record drafts: native
session staging supports existing rows only. Existing `stage_changes` and
`create_rule` tools can copy/fill existing fields for a member to review and Save.
From the builder terminal, `MIGRATION_DATABASE_URL` (owner connection) plus
`bun run records:import <table> <file.csv> [--key column]` persists ordinary kernel
writes as the deployment's first member. Headers identify fields; a `--key` column that also names a field is stored in
that field as well as the external key. Use external
keys for repeat imports and copy/fill updates; blank/omitted fields stay unchanged.
Without keys, rerunning creates new records. The owner connection stays out of
the running app's environment.

Public signup is enabled in this example. Set `APP_ALLOW_SIGN_UP=false` after
onboarding if the instance should accept only existing accounts. There is no
email delivery, invitation UI, or password-reset sender configured in this spike.
The example currently uses tenant isolation without a declared fine-grained
schema policy; it does not claim per-field or per-role restrictions.

Local checks: `bun run check`; the Auth regression test accepts an explicit
loopback `SINGLE_ORG_TEST_DATABASE_URL`, creates a unique database, and drops it
when complete. Provider deployment and connector UI behavior require separate
hosted proof.

Mise exposes the same app-owned commands from the repository root:
`mise //app:compile`, `mise //app:dev`, `mise //app:build`,
`mise //app:migrate`, `mise //app:migrate:undo`, and
`mise //app:migrate:rehearse`, and `mise //app:records:import`. All four owner
commands use `MIGRATION_DATABASE_URL` for the target connection. Apply and
rehearsal also require `APP_DATABASE_URL`; omission is refused before migration.
For rehearsal, point both URLs at the disposable database and supply
`PRODUCTION_APP_DATABASE_URL` only for the production-target isolation check.
`AUTH_DATABASE_URL` is optional. Rehearsal refuses the production target and
executes every section list query using the restricted runtime login.
`MIGRATION_DATABASE_URL` is scrubbed before the app server starts.

The migration stores normalized schema, checksum, source commit, timestamp and
restore-point identity in `autograph_applied_schema`. Undo restores data and that
record together and prints the source commit to revert. It preserves current
Auth tables (users, accounts/passwords, sessions, memberships and OAuth grants),
and re-syncs the kernel membership projection using current runtime bindings.
The installed Auth checksum survives even undo of the first app migration.
Hosted libpq commands use
`sslmode=verify-full` with system root certificates. Local archives live in
ignored `.local/restore-points`; keep them on durable storage if they are your
recovery mechanism. Setting all three of `NEON_API_KEY`, `NEON_PROJECT_ID` and
`NEON_BRANCH_ID` selects the Neon branch adapter. Its provider path has only
mock evidence in this phase. Backups are retained until the owner removes them.

Run the database regressions from the repository root with the pinned toolchain
and PostgreSQL 17 client programs on PATH. Each suite creates and drops its own
disposable database; no provider credentials are used:

```sh
export KERNEL_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres
export RESTORE_POINTS_TEST_DATABASE_URL="$KERNEL_TEST_DATABASE_URL"
export SINGLE_ORG_TEST_DATABASE_URL="$KERNEL_TEST_DATABASE_URL"
export CARGO_TARGET_DIR="$PWD/target"
export CARGO_INCREMENTAL=0
mise exec -- ./node_modules/.bin/vp test --config app/vite.config.ts --run
mise exec -- bun test app/scripts/restore-points.test.ts
mise exec -- ./node_modules/.bin/vp test --config packages/auth/vite.config.ts --run packages/auth/__tests__/single-organization.test.ts
```

The migration suite covers table/field additions, rename aliases with rows,
retirement, historical type refusal, real process interruption, lock exclusion,
undo alignment, runtime membership and agent write denial. The core upgrade
fixture changes real package SQL while leaving the model unchanged, and proves
upgrade/retry/undo through the same command. This is a controlled package fixture,
not evidence of a published npm package upgrade.

## Supported schema changes

The compiler supports new tables, optional fields on existing tables, stable-id
renames with retained aliases, and one-way archival by removing fields or tables. Archived IDs, names and
aliases cannot be reused: create a differently named field or table instead. Table public `name` and `aliases` work
like fields; choice options retain their stable ids and previous labels as aliases.

Required and unique constraints check current open mainline versions; closed
history and pending drafts keep their data. Failures list record ids. To add a
required field: add it optional, fill records through ordinary writes, then require
it. To change a type: add a new field, copy values through ordinary writes while
reporting conversion failures, then archive the old field. Types are immutable
across archival. Permanent deletion and bespoke data migrations are not supported.

The compiler accepts the deterministic build version as an explicit input;
release tooling does not rewrite compiled artifacts. Returning to identical
source after adding a field applies its removal as an archive. The ledger may
record the same release at separate applied positions; retrying the current
release remains a no-op. Re-running migration with
`APP_DATABASE_URL` repairs a missing runtime binding even without a schema change.

The create/import regression and rendered control tests can be run separately:

```sh
WORK_SESSION_TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres \
  CARGO_TARGET_DIR="$PWD/target" CARGO_INCREMENTAL=0 \
  mise exec -- ./node_modules/.bin/vp test --config packages/work-session-tools/vite.config.ts \
  --run packages/work-session-tools/__tests__/records-postgres.test.ts
mise exec -- ./node_modules/.bin/vp test --config packages/work-session-tools/vite.config.ts \
  --run packages/work-session-tools/__tests__/records.test.ts \
  packages/work-session-tools/__tests__/core.test.ts packages/work-session-tools/__tests__/adapters.test.ts
mise exec -- ./node_modules/.bin/vp test --config app/vite.ui.config.ts --run
```
