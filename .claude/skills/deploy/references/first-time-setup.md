# First deployment

Reuse or, with the builder's authorization, create a Neon database and a Vercel
project for `app/` (repo-level or `app/`-level Vercel link both work). The
builder signs in themselves. Use manual deployments; leave Git auto-deploy
disconnected (`app/vercel.json` sets `git.deploymentEnabled: false`).

1. Run `bun run setup:env --production` from `app/`. It creates ignored,
   mode-`0600` files `app/.env.production.secrets` (runtime values, not
   auto-loaded by Next or Bun) and `app/.env.production.migrate` (migration
   owner URL) without touching `.env.local`, and prints variable names only.
2. Ask the builder to open both files privately in a **local editor** (never
   paste URLs or secrets into chat):
   - In `app/.env.production.migrate`, set `MIGRATION_DATABASE_URL` to the
     direct Neon owner connection (plus `NEON_API_KEY`, `NEON_PROJECT_ID`,
     `NEON_BRANCH_ID` if using Neon branch restore points; otherwise local
     `pg_dump` restore points are saved in `app/.local/restore-points` using
     PostgreSQL 17 client tools on PATH).
   - In `app/.env.production.secrets`, set `APP_DATABASE_URL` to a separate
     unprivileged runtime login (with a generated password of at least 32
     characters; `bun run release` creates the SQL login if missing — do not
     create it in the Neon console) and set `BETTER_AUTH_URL` to the app's
     public `https://` origin. `AUTH_DATABASE_URL` may be omitted.
   Never put `MIGRATION_DATABASE_URL` or `NEON_*` in `.env.local`,
   `.env.production.secrets`, or Vercel's runtime environment.
3. Configure the Vercel build for the repository's pinned Bun, Rust and CUE
   toolchain.

## Owner and team

1. Run `bun run owner:setup --production`. It rotates `APP_OWNER_SETUP_HASH` in
   `app/.env.production.secrets` and writes a private `0600` link file at
   `app/.local/owner-setup.production.html` without opening a browser. Re-running
   `owner:setup --production` rotates the code deliberately.
2. Push runtime variables to Vercel with `bun run secrets:push`. It reads only
   `app/.env.production.secrets`, refuses loopback hosts or non-`https://`
   origins, excludes migration/Neon credentials, updates existing variables with
   `--force`, and never prints values.
3. Run `bun run release` (follow the `deploy` skill) so the database is migrated
   and the updated runtime environment is live.
4. Once the app is live, run `bun run owner:open --production`. It checks that
   the app answers at `BETTER_AUTH_URL` and is running the current
   `APP_OWNER_SETUP_HASH` (refusing to open if you still need to push and
   release), then opens the local HTML file (never the setup URL on argv) in the
   builder's browser. They choose their own password; never ask for it, suggest
   it or type it.
5. The link file stays on disk until owner setup finishes so reloading the tab
   will not lose the code. After finishing setup, delete
   `app/.local/owner-setup.production.html` or re-run
   `bun run owner:open --production` to delete it automatically once the server
   reports setup is complete.
6. Sign-up is closed to everyone else. From **/members**, an owner can create
   and revoke seven-day single-use email-bound invite links, promote another
   member to owner, and remove members (which revokes their sessions and OAuth
   grants and deactivates kernel access; the last owner cannot be removed).
   Previously removed members can be re-admitted by opening a new invite link
   for their email and signing in with their existing password.
7. Check it: open the app in a private window and confirm there is no way to
   create an account.

If an upgraded deployment already has members but no owner, the builder runs
`bun run owner:claim --production <existing-member-email>` in their terminal.
The first member is the terminal CSV import actor.
