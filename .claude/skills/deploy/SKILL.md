---
name: deploy
description: Put a merged change live from the builder's machine, manage people's access, or undo the last schema change. Use only after the change is merged to main through ship-change.
---

# Deploy

Run commands from `app/`. Reuse the builder's Neon database and Vercel project;
follow `references/first-time-setup.md` if they do not exist. Ask before creating
resources or spending money. The builder completes provider login themselves.
Never print or read secret values.

1. Confirm the change is merged and you're on an up-to-date, clean `main`.
2. For a schema change, rehearse on a disposable copy: `bun run migrate:rehearse`
   with `MIGRATION_DATABASE_URL` and `APP_DATABASE_URL` for that copy, plus
   `PRODUCTION_APP_DATABASE_URL` so it can refuse the production target.
3. Run `bun run release --check` to verify preflight (clean `main` equal to the
   remote default branch, Vercel project link, `.vercelignore` secret coverage,
   compile/check, source commit) and print the schema plan. It connects
   read-only to read the applied schema so it can compute the plan, without
   modifying the database or deploying.
4. Say in plain words what will change for people, what happens to existing data,
   and how to undo it. Ask whether to go live now.
5. On a yes, ask the builder to run `bun run release` in their own terminal. It
   loads `app/.env.production.secrets` and `app/.env.production.migrate`, checks
   the source, shows the plan, and asks **them** to type the app's name; then it
   takes a restore point, migrates, verifies the applied release, deploys, and
   prints the deployment URL. Don't type it for them.
6. Open the app, sign in, and check the changed table and an existing one.

`release` refuses a dirty tree, a branch other than `main`, or commits that aren't on
GitHub. Fix the cause; never work around it. Run one release at a time and leave Vercel's
Git auto-deploy off (`app/vercel.json` sets `git.deploymentEnabled: false`), because
auto-deploy would serve code without the migration.

A completed migration is a checked no-op on retry; a failed one rolls back and
nothing is deployed. If the deploy fails after the migration, retry `bun run release`
from the same source or follow `references/undo.md`. Never migrate older source as
a substitute for undo. Archives are one-way.

For undo, ask the builder to run `bun run migrate:undo --production` in their
terminal, then revert and release the matching commit it reports. Follow
`references/undo.md` for data loss confirmation. Report what actually ran; hosted
behavior is unproved until exercised. Check current provider documentation when
executing provider steps.

Local commands (`bun run migrate`, `bun run migrate:undo`, `bun run records:import`,
`bun run people`, `bun run start`) use `app/.env.local` and `app/.env.migrate`.
Production commands (`bun run release`, or `--production` on `migrate`,
`migrate:undo`, `records:import`, `people`) read `app/.env.production.secrets`
and `app/.env.production.migrate`. Never put `MIGRATION_DATABASE_URL` or `NEON_*`
in `.env.local`, `.env.production.secrets`, or Vercel's runtime environment.

**Tunnel limitation:** local commands skip the production gate when the database
hostname is loopback (`localhost`, `127.0.0.1`, `[::1]`). An SSH tunnel or local
proxy forwarding to a production database looks like loopback and bypasses that
guard — never point a local tunnel at production.

Sign-up is always closed and everyone signed in has equal access. To add a
person, reset a lost password, or remove a person in production, ask the builder
to run `bun run people add <email> --production` or
`bun run people remove <email> --production` in their own terminal (typing the
app name to confirm). `people add` saves a one-time 7-day set-password link to
an ignored `0600` file under `app/.local/people/`; the builder opens that file
themselves and sends the link privately. Nobody puts a password or link in chat.
