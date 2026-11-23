---
name: deploy
description: Deploy the comparison app from the builder's machine, or undo its last schema change.
---

# Deploy

Run commands from `app/`. Reuse the builder's Neon database and Vercel project;
follow `references/first-time-setup.md` if they do not exist. Honor existing
authorization and ask before creating resources or spending money. The builder
completes provider login themselves. Keep credentials out of git and output.

1. Run `bun run compile` and `bun run check` for the intended source.
2. Optionally run `bun run migrate:rehearse` on a disposable copy. Supply
   `MIGRATION_DATABASE_URL` and required `APP_DATABASE_URL` for that copy, plus
   `PRODUCTION_APP_DATABASE_URL` so the command can refuse the production target.
3. Run `bun --env-file=.env.local --env-file=.env.migrate run migrate` with
   the Neon owner connection in `MIGRATION_DATABASE_URL` and the required
   restricted login in `APP_DATABASE_URL`. This creates a restore
   point, locks, applies, and binds the restricted runtime login. Stop on failure.
4. After migration succeeds, run `vercel deploy --prod` from the same source.
5. Open the app, sign in, and check the changed table and an existing table.

Run one deploy at a time. Do not configure Git auto-deploy for this flow: it
would serve code without this migration step. There is no hosted deployment
workflow, preview automation, or Deployment Check runner in the spike.

A completed migration is a checked no-op on retry; a failed one rolls back.
If another migration holds the lock, wait. Rebuild the same source if the command
reports a build mismatch. If deployment fails after migration, retry deployment
from that source or follow `references/undo.md`; do not migrate older source as
a substitute for undo. Archives are one-way.

For undo, run `bun run migrate:undo` with the same owner environment, then
redeploy the matching commit it reports. Follow `references/undo.md` for data
loss confirmation. Report what actually ran; hosted behavior is unproved until
exercised. Check current provider documentation when executing provider steps.

All owner commands (`migrate`, `migrate:undo`, `migrate:rehearse`, and
`records:import`) use `MIGRATION_DATABASE_URL`. Keep it in the builder terminal;
the start command scrubs it from the app runtime environment. Apply refuses a
missing `APP_DATABASE_URL` before database work.
