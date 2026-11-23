# arrusted

Build a real business app (a CRM, a stock tracker, an order book) by talking to
your own coding agent (Claude Code, Codex or Cursor) on your own machine.

You describe what you want. The agent edits a small CUE schema and a Next.js
app, and arrusted compiles the schema into a safe Postgres data layer. That
layer comes with:
- auth;
- audit history;
- CSV import;
- safe migrations;
- one-step undo.

When you're ready, the agent deploys it to your own Vercel account and Postgres (Neon).

There is no hosted builder and no account to create with us. Your code, your
data, your agent.

> **Status: pre-release.** This repository was just split out of an internal
> codebase. It works end to end for the apps we've tested (see
> [docs/release-plan.md](docs/release-plan.md)), but expect rough edges, large
> packages that are still being pruned, and breaking changes before 1.0.

## Quick start

Requirements: [mise](https://mise.jdx.dev), which pins Bun, Node, Rust and the
other tools, plus a local PostgreSQL 16+ for development.

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
```

Then open the repo in your coding agent and describe your app.
- The starter app lives in [`app/`](app/README.md).
- The agent skills that guide the build (`design-app`, `add-section`, `deploy`)
  live in [`.claude/skills`](.claude/skills).

Run checks and tests with `mise run check` and `mise run test`.

## What's inside

- `app/`: the starter Next.js app your agent builds on.
- `packages/schema-compiler`, `packages/kernel`: the CUE-to-Postgres compiler,
  and the Rust/Postgres kernel that enforces every write.
- `packages/auth`: Better Auth integration (email/password, plus OAuth for agents).
- `packages/canvas`, `packages/canvas-host`: grids, draft review and history.
- `packages/generated-app-runtime`, `packages/csv-workspace`: the runtime and
  CSV import.

Architecture and rules:
- [AGENTS.md](AGENTS.md)
- [principles](docs/principles.md)
- [contracts](docs/contracts.md)
- [documentation map](docs/README.md)

## License

[MIT](LICENSE). Some UI packages currently depend on AG Grid and AG Charts
Enterprise, which are commercially licensed; see the release plan.
