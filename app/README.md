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
run `bun run setup:env` for local development. It creates missing values in
ignored `.env.local` and `.env.migrate` with mode `0600` and prints variable
names only. Existing values, including empty values, are never overwritten.
Production runtime values live separately in ignored `app/.env.production.secrets`
(not auto-loaded by Next or Bun) and `app/.env.production.migrate`, prepared with
`bun run setup:env --production`. Configure connection hosts and credentials
privately in a **local editor**; generated local defaults do not provision
PostgreSQL. Never paste env files, passwords, setup links or invite links into
agent chat. Never ask an agent to read secret files or browser form values.
The owner chooses their own password in their browser.

Never put migration credentials (`MIGRATION_DATABASE_URL`) or Neon API keys in
`.env.local`, `.env.production.secrets`, or Vercel's runtime environment. Use a
separate restricted login for `APP_DATABASE_URL`. Package scripts wrap explicit
`--env-file` loading so bare `bun run migrate`, `bun run migrate:undo`,
`bun run records:import`, `bun run start` use local files while
`bun run release` (and `--production` on `migrate`, `migrate:undo`,
`records:import`, `owner:claim`) uses production files.

For a disposable local PostgreSQL server, create the database as its owner:

```sql
CREATE DATABASE starter;
```

Set `APP_DATABASE_URL` to a separate runtime login with a generated password of
at least 32 characters; migrate creates it. Run these from `app/`:

```sh
bun run compile
bun run migrate
bun run owner:setup
bun run dev
# In another terminal once dev is listening:
bun run owner:open
```

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

Run `bun run release --check` (no TTY required; connects read-only to read the
applied schema and compute the plan, makes no changes, and never migrates or
deploys) to run preflight and print the schema plan.

`bun run release` fetches the remote and requires HEAD to equal its default
branch, verifies the app- or repo-level Vercel project link and `.vercelignore`
coverage (refusing if any `.env*` file or `.local/` secret/restore-point path
would be uploaded), compiles and checks, verifies source commit provenance,
shows the changes against the previous applied schema, and asks the human to
type the app's configured name (read from `app/schema/app.cue`).
It prints progress at each step, creates a restore point, migrates, verifies the
applied release, deploys to production, and prints the deployment URL.
Migration failure prevents deployment. Deployment failure leaves the database
migrated: retry `bun run release` from the same source, or run
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
redacted (stripping URL credentials, secret env var values, and setup/invite
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

### Owner setup and invitations

Signup is closed by default. Before any members exist, even open signup requires
a one-time setup code. Run `bun run owner:setup` (or `bun run owner:setup --production`
for production): it rotates `APP_OWNER_SETUP_HASH` in `.env.local` (or
`.env.production.secrets`) and writes a private `0600` link file under
`app/.local/` without opening a browser or printing the code. Re-running
`owner:setup` rotates the code deliberately. For production, push with
`bun run secrets:push` and deploy with `bun run release` first.

Once the app is answering at `BETTER_AUTH_URL`, run `bun run owner:open` (or
`bun run owner:open --production`). It checks `/api/auth/owner-setup-status`
(unauthenticated boolean only, plus a constant-time hash-of-hash match check so
a stale deployed `APP_OWNER_SETUP_HASH` is caught before opening without
exposing the hash) and opens the local HTML file in the browser (never passing
the setup URL on argv). If the app does not answer yet or is running an older
setup hash, it tells you to start or push and release the app first. The link
file remains on disk until owner setup finishes so reloading the tab cannot lose
the code; delete it afterwards or re-run `owner:open`, which deletes the file
automatically once setup is complete. First successful signup becomes owner;
simultaneous claims serialize, merge into `organization.metadata`, and
subsequent claims are refused. Missing `APP_OWNER_SETUP_HASH` refuses signup
with setup instructions.

Owners use `/members` to view members, promote a member to owner, remove members
(never the last owner; removal revokes browser sessions, OAuth grants/tokens,
and deactivates the kernel projection), and create or revoke email-bound
invitation links. Copy the link at creation: only its SHA-256 hash is stored in
Better Auth's existing invitation row. Links expire in seven days, work once,
and roll back with failed account creation. Previously removed members can open
a new invite link and sign in with their existing password to rejoin (no account
takeover by email alone and no password reset from an invite). No email delivery
is configured.
Setup and invitation secrets use URL fragments, which the sign-in page reads and
clears on load. The sign-in page offers account creation only for a proof link
or `APP_ALLOW_SIGN_UP=true` (exactly). Open signup still grants only member
access after initial owner setup. All organization-plugin HTTP endpoints are
blocked in this deployment (Agent OAuth uses `/agent-grant/*` and `/oauth2/*`);
its server-only `addMember` is also refused. `autograph_sync_member` projects
both owners and members to kernel role `member`.

Existing members remain signed in after upgrade. If no owner exists, a human
runs `bun run owner:claim <existing-member-email>` (or
`bun run owner:claim --production <existing-member-email>`) and confirms in a
real terminal. This promotes only an existing member and refuses if an owner
already exists. There is no automatic promotion at sign-in.

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
