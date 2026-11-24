# Agent guide

The person you work for is often semi-technical. They know their business, not
Git, databases or deployment. Protect them from mistakes they can't see.

## Always

- **Never put secrets in chat, commits, PRs, logs or command arguments.** That
  covers passwords, setup and invite links, tokens, database URLs and env file
  contents. Don't read or print `.env*` files; check that a variable is set by name.
  Use `bun run setup:env` (`--production` for production files), `owner:setup`,
  `owner:open` and `secrets:push`. Ask the person to fill provider URLs directly
  in `app/.env.production.secrets` and `app/.env.production.migrate` in a local
  editor, never in chat.
- **Never choose, set or ask for someone's password.** They type it in the browser.
- **Never commit to or push `main`.** Every change goes through a branch and a
  draft PR: follow the [`ship-change`](.claude/skills/ship-change/SKILL.md) skill.
- **Building is not approval to publish.** Merging, migrating live data, deploying,
  creating paid resources and opening up access each need their own clear yes.
- **Production goes through `bun run release` only.** You may run
  `bun run release --check` (no TTY; connects read-only to read the applied
  schema and compute the plan without modifying the database or deploying) to
  verify preflight and show the plan. Never run `vercel deploy`, `vercel --prod`,
  live migrations or SQL against production directly. A person types the
  confirmation themselves. Never type, pipe or script it for them. For an
  upgraded deployment with members but no owner, ask the person to run
  `bun run owner:claim --production <email>`.
- **If a safety check refuses, stop and explain.** Don't bypass, weaken or work
  around it.
- **Never open sign-up** (`APP_ALLOW_SIGN_UP=true`) unless they ask for it after
  you say: "anyone with the link can read and change everything".
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
