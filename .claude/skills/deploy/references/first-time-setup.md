# First deployment

Reuse or, with the builder's authorization, create a Neon database and a Vercel
project for `app/`. The builder signs in themselves. Use manual deployments;
leave Git auto-deploy disconnected.

Keep the direct Neon owner URL as `MIGRATION_DATABASE_URL` in ignored
`app/.env.migrate`. Never put it or Neon API credentials in Next's `.env.local`
or Vercel's app environment. Local `pg_dump` restore points work with the owner
connection; keep `app/.local/restore-points` available for undo. PostgreSQL 17
client tools must be on the builder's PATH.

Generate a separate SQL runtime login name and a password of at least 32
characters. Set its connection URL as `APP_DATABASE_URL` in `.env.local` and
Vercel. Do not create the login in the Neon console: `bun run migrate` creates
it if missing, checks that it is unprivileged, and grants kernel/Auth access.
`AUTH_DATABASE_URL` may be omitted to reuse that login. Existing passwords are
never reset on migration retries.

Also set `BETTER_AUTH_URL` to the app's public origin and generate a
`BETTER_AUTH_SECRET` of at least 32 characters. Use `.env.example` for remaining
runtime settings. Configure the Vercel build for the repository workspace and
its pinned Bun/Rust/CUE toolchain; verify the build can compile the schema.

Follow the deploy skill: compile/check, owner `migrate`, then
`vercel deploy --prod`. Sign up as the builder first, then admit the comparison
team. The first member is the terminal CSV import actor. Set
`APP_ALLOW_SIGN_UP=false` after onboarding if no more signups are needed.
