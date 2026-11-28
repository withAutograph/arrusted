# `@arrusted/core`

Core CUE schema compiler, shared-Postgres migration CLI, resilient connection pooling, generated data client, and Next.js App Router helpers for Arrusted applications.

## CLI (`arrusted`)

```bash
# Compile schema/*.cue into .generated/release/
bunx arrusted compile

# Apply additive schema & per-app auth_* / role migrations
bunx arrusted migrate

# Restore public schema to the prior restore point (preserving marked auth_* schemas)
bunx arrusted migrate:undo
```

Native `schema-compiler` and `cue` binaries are resolved automatically from `@arrusted/cli-darwin-arm64` or `@arrusted/cli-linux-x64` (`optionalDependencies`).

## `0.1.0-alpha.1` Scope Notes

- **Mainline human CRUD:** `createAppRoutes` and `createDataClient` target human-authenticated mainline reads and writes.
- **Policy-enabled schemas (`policy_declared = true`):** Role-scoped `list`, `get`, `aggregate`, `history` field values, and mainline `apply` are active in `0.1.0-alpha.1`. Staging `draft` writes, `revert`, recent-activity feeds, change-set comparison/diff, actor/notes disclosure in `history`, and Canvas work sessions are deferred to `0.2`.
- **Additive-by-default migrations:** Retiring existing models, fields, enum options, or change types requires explicit `--allow-retire`.
