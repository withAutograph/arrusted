# Starter app

One Next.js app uses the existing kernel, compiler, Canvas Host and Better Auth
packages from source. The deployment scope is `starter/starter`. The organization
is created when the first person is added and never appears as a picker. Every
signed-in person has equal access: they may open each table, review drafts and
save. OAuth agents can stage work; the kernel still refuses their canonical
writes. Membership and OAuth consent are rechecked for every data operation.
The migrator derives the kernel actor membership from the Auth member row in
the same database transaction; there is no separate app grant to provision.

From the repository root, install dependencies with the pinned Bun. In `app/`,
run `bun run setup:env` for local development. It creates missing values in
ignored `.env.local` and `.env.migrate` with mode `0600` and prints variable
names only. Existing values, including empty values, are never overwritten.
Production runtime values live separately in ignored `app/.env.production.secrets`
(not auto-loaded by Next or Bun) and `app/.env.production.migrate`, prepared with
`bun run setup:env --production`. Configure connection hosts and credentials
privately in a **local editor**; generated local defaults do not provision
PostgreSQL. Never paste env files, passwords, or password-setup links into
agent chat. Never ask an agent to read secret files, `.local/people/*` link
files, or browser form values. Each person chooses their own password in their
browser.

Never put migration credentials (`MIGRATION_DATABASE_URL`) or Neon API keys in
`.env.local`, `.env.production.secrets`, or Vercel's runtime environment. Use a
separate restricted login for `APP_DATABASE_URL`. Scripts read their own env
files (and still work when local files are absent): bare `bun run migrate`,
`bun run migrate:undo`, `bun run records:import`, `bun run people`, and
`bun run start` read `.env.local`/`.env.migrate` as local defaults, while
`--production` is accepted by `setup:env`, `migrate`, `migrate:undo`,
`records:import`, and `people` (`secrets:push` and `release` always use the
production files). `--production` refuses loopback `MIGRATION_DATABASE_URL`
targets.

For a disposable local PostgreSQL server, create the database as its owner:

```sql
CREATE DATABASE starter;
```

Set `APP_DATABASE_URL` to a separate runtime login with a generated password of
at least 32 characters; migrate creates it. Run these from `app/`:

```sh
bun run compile
bun run migrate
bun run people add you@example.com
bun run dev
```

Open the private `.local/people/*.txt` file printed by `people add`, open that
link in your browser to set your password, then sign in.

The migrator grants the runtime login only
the generated kernel capabilities and Auth table access (never direct access to
`autograph_applied_schema`). `bun run build` compiles the CUE source without
database credentials and builds Next.js. `bun run start` applies pending
migrations only to loopback databases. For a non-loopback target it checks the
active release through `kernel_read_runtime_release_observability` and refuses
startup if migration is pending; migration and Neon credentials are removed
before the HTTP server starts.

### Production release

`bun run release` is the only supported production deployment entry point. It
loads `app/.env.production.secrets` and `app/.env.production.migrate`
automatically. Leave Vercel Git auto-deploy disabled (`app/vercel.json` sets
`git.deploymentEnabled: false`). There is no hosted setup or release service.
Run from the clean default branch after the PR has merged and the local checkout
is updated.

The builder runs `bun run release --check` in their own terminal (requires a
real TTY; connects read-only with the production owner login to read the applied
schema and compute the plan, runs the local prebuilt Vercel build and
`.vercel/output` private-path check, makes no database changes, and never
migrates or deploys).

`bun run release` fetches the remote and requires HEAD to equal its default
branch, verifies the app- or repo-level Vercel project link, compiles and
checks, verifies source commit provenance, shows the changes against the
previous applied schema, then runs the local Vercel build before confirmation
(`vercel pull --yes --environment production`, `vercel build --prod`, deletes
pulled `.vercel/.env*` files, and checks `.vercel/output` and every
`.vc-config.json` `filePathMap` for any `.env`, `.env.*` except `.env.example` /
`.env.*.example`, or `.local` path segment). A failed build stops the release
with nothing changed. After the build succeeds, it asks the human to type the
app's configured name (read from `app/schema/app.cue`), prints progress at each
step, creates a restore point, migrates, verifies the applied release, deploys
the prebuilt output (`vercel deploy --prebuilt --prod`), and prints the
deployment URL. Migration failure prevents deployment. Deployment failure leaves
the database migrated: retry `bun run release` from the same source, or run
`bun run migrate:undo --production`, restore the reported source commit and
release it. Undo loses app record edits since the restore point; current Auth
records survive.

No remote is refused unless explicitly using `--local-only-repo`; the clean
default branch and human confirmation are still required. Direct non-loopback
`migrate` / `migrate:undo` / `records:import` also require preflight and
confirmation. Rehearsal remains ungated but refuses its supplied production
target. Confirmation requires stdin and stdout to be real TTYs, with no `--yes`
or environment bypass. A determined agent with a PTY can fake typing: this
prevents accidents, while branch protection and credential access are the real
boundary.

**Tunnel limitation:** the loopback check identifies local databases by hostname
(`localhost`, `127.0.0.1`, `[::1]`). An SSH tunnel or local proxy forwarding to
a production database looks like loopback and bypasses the local mutation gate;
never point a local tunnel at production.

Use `bun run secrets:push` to send runtime values from
`app/.env.production.secrets` to Vercel production after the same human
confirmation. It refuses loopback hosts and non-`https://` origins, excludes
migration and Neon credentials, sends values on stdin only (never argv or
output), and overwrites existing variables with `--force`. Error messages are
redacted (stripping URL credentials, secret env var values, and token
fragments) rather than suppressed, so actionable refusals and PostgreSQL error
codes remain visible without leaking credentials. Do not troubleshoot by pasting
raw secret files into chat.

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

### Managing people

Sign-up is always closed and everyone signed in has equal access. All
organization-plugin HTTP endpoints are blocked (Agent OAuth uses
`/agent-grant/*` and `/oauth2/*`). People are managed with two commands from
`app/`:

- `bun run people add <email>` (optional `--production`): creates the user and
  deployment membership if missing, invalidates any earlier unused password
  link for that person, and writes a single-use 7-day `/auth/set-password` link
  to an ignored `0600` file under `app/.local/people/`. The command prints only
  the file path and instructions, never the link. Open the file yourself and
  send the link privately; re-running issues a new link for a lost password. An
  agent may run `people add` locally; with `--production`, the human runs it in
  their own terminal and confirms by typing the app name. Nobody puts a
  password or link in chat.
- `bun run people remove <email>` (optional `--production`): revokes reset
  tokens, sessions, OAuth tokens/consents/codes, device codes, and kernel
  membership, clears `oauthClient."userId"`, and deletes the user in one
  transaction without deleting business records.

In-app management can be added later on the same Better Auth tables.

The example currently uses tenant isolation without a declared fine-grained
schema policy; it does not claim per-field or per-role restrictions.

Local checks: `bun run check`; the Auth regression tests accept an explicit
loopback `SINGLE_ORG_TEST_DATABASE_URL`, create a unique database, and drop it
when complete. Provider deployment and connector UI behavior require separate
hosted proof.

Mise exposes the same app-owned commands from the repository root:
`mise //app:compile`, `mise //app:dev`, `mise //app:build`,
`mise //app:migrate`, `mise //app:migrate:undo`, `mise //app:migrate:rehearse`,
`mise //app:records:import`, `mise //app:people`, and `mise //app:release`. All four owner
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
mise exec -- ./node_modules/.bin/vp test --config packages/auth/vite.config.ts --run packages/auth/__tests__/single-organization.test.ts packages/auth/__tests__/people.test.ts
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
