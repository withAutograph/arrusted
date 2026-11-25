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
3. `bun run release` builds locally (`vercel pull --yes --environment production`
   then `vercel build --prod`) using the local Bun, Rust and CUE toolchain and
   deploys prebuilt output (`vercel deploy --prebuilt --prod`), so Vercel does
   not need Rust or CUE remotely.

## Adding people

1. Push runtime variables to Vercel with `bun run secrets:push`. It reads only
   `app/.env.production.secrets`, refuses loopback hosts or non-`https://`
   origins, excludes migration/Neon credentials, updates existing variables with
   `--force`, and never prints values.
2. Run `bun run release` (follow the `deploy` skill) so the database is migrated
   and the updated runtime environment is live.
3. Ask the builder to add themselves in their own terminal:
   `bun run people add <email> --production` (they type the app name to
   confirm). It creates the user and membership and writes a single-use 7-day
   `/auth/set-password` link to an ignored `0600` file under
   `app/.local/people/`. They open that file themselves and choose their own
   password in the browser; never ask for, suggest, or paste a password or link
   in chat.
4. Sign-up is always closed and everyone signed in has equal access. To add
   teammates or issue a new password link, the builder runs
   `bun run people add <email> --production` in their terminal and sends the
   saved link privately. To remove someone (ending sessions, OAuth grants, and
   kernel access while keeping business records), the builder runs
   `bun run people remove <email> --production` in their terminal.
5. Check it: open the app in a private window and confirm there is no way to
   create an account.

The first member is the terminal CSV import actor.
