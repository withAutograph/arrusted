# Agent guide

The person you work for is often semi-technical. They know their business, not
Git, databases or deployment. Protect them from mistakes they can't see.

## Always

- **Never put secrets in chat, commits, PRs, logs or command arguments.** That
  covers passwords, sign-in/password-setup links, tokens, database URLs and env
  file contents. Don't read or print `.env*` files or `.local/people/*` link
  files; check that a variable is set by name. Use `bun run setup:env`
  (`--production` for production files) and `secrets:push`. Ask the person to
  fill provider URLs directly in `app/.env.production.secrets` and
  `app/.env.production.migrate` in a local editor, never in chat.
- **Never choose, set or ask for someone's password.** They type it in the browser.
- **Manage people through `bun run people`.** Use `bun run people add <email>`
  (creates the account if missing and writes a private one-time 7-day
  set-password link under `app/.local/people/`) and `bun run people remove <email>`.
  You may run `bun run people add <email>` locally; with `--production`, the
  human runs `people add` / `people remove` in their own terminal. Nobody puts a
  password or link in chat.
- **Never commit to or push `main`.** Every change goes through a branch and a
  draft PR: follow the [`ship-change`](.claude/skills/ship-change/SKILL.md) skill.
- **Building is not approval to publish.** Merging, migrating live data, deploying,
  creating paid resources and opening up access each need their own clear yes.
- **Production goes through `bun run release` only.** The builder runs both
  `bun run release --check` (requires a real TTY; connects read-only with the
  production owner login to read the applied schema, compute the plan, and run
  the local prebuilt Vercel build and `.vercel/output` secret check without
  modifying the database or deploying) and `bun run release` themselves in their
  own terminal, not the agent. Commands that accept `--production` are
  `setup:env` (prepares `app/.env.production.secrets` and
  `app/.env.production.migrate` with names-only output) and the builder-run
  production commands `migrate`, `migrate:undo`, `records:import`, and
  `people` (`secrets:push` and `release` always target production). Never run
  `vercel deploy`, `vercel --prod`, live migrations or SQL against production
  directly. A person types the confirmation themselves. Never type, pipe or
  script it for them.
- **If a safety check refuses, stop and explain.** Don't bypass, weaken or work
  around it.
- **Never use** `git push --force`, `git reset --hard`, `git clean`, history
  rewrites, or anything that deletes a repo, project or database. If it's really
  needed, explain what would be lost and let them do it.

## Where things are

- [`docs/`](docs/README.md) is the implementation contract. Follow
  [`docs/principles.md`](docs/principles.md) and
  [`docs/contracts.md`](docs/contracts.md); change code and contracts together.
- App work happens in `app/`, guided by the skills in `.claude/skills`:
  `design-app`, `add-section`, `ship-change`, `deploy`.
- Repository tasks are mise tasks; see
  [tooling ownership](docs/tooling-script-ownership.md).

## Working on the code

- Keep changes task-scoped and small. Commit with `HK=true` so the repository
  hooks run.
- Reproduce failures locally, fix the cause, and test behavior rather than exact
  wording. Report what you ran and what failed; never claim an unrun check.
- Platform tests own their fixtures. Don't copy a user's app into them.
- Prefer maintained packages and existing components over new ones.
