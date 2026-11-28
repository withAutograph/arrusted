# `@arrusted/core`

Core CUE schema compiler, shared-Postgres migration CLI, resilient connection pooling, generated data client, and Next.js App Router helpers for Arrusted applications.

## CLI (`arrusted`)

```bash
# Compile schema/*.cue into .generated/release/
bunx arrusted compile

# Apply additive schema & per-app auth_* / role migrations
bunx arrusted migrate

# Restore the shared public schema to the prior restore point (preserving marked auth_* schemas)
bunx arrusted migrate:undo
```

> **Shared-database warning (`migrate:undo`):** `migrate:undo` restores the **entire shared `public` schema** to the local restore point captured before the last migration. In a multi-app shared database, this rolls back app-table writes across **all** sibling apps since that migration (while preserving `auth_*` accounts, memberships, and sessions).

Native `schema-compiler` and `cue` binaries are resolved automatically from `@arrusted/cli-darwin-arm64` or `@arrusted/cli-linux-x64` (`optionalDependencies`).

## Environment Variables (`migrate` & Runtime)

| Variable                      | Required                                        | Description                                                                                                                                                                               |
| :---------------------------- | :---------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL`      | `migrate` / `migrate:undo` / `migrate:rehearse` | Direct (non-`-pooler`) PostgreSQL owner connection URL. Remote hosts require `?sslmode=verify-full` (on Neon, replace `?sslmode=require` with `?sslmode=verify-full`).                    |
| `APP_DATABASE_URL`            | `migrate` / App runtime                         | Restricted per-app PostgreSQL runtime login URL (supports Neon `-pooler` endpoints; remote hosts require `?sslmode=verify-full`). `migrate` provisions the role automatically if missing. |
| `AUTH_DATABASE_URL`           | Optional (`migrate` / Auth runtime)             | Dedicated Better Auth PostgreSQL login URL; defaults to `APP_DATABASE_URL` when omitted.                                                                                                  |
| `AUTH_SCHEMA`                 | Multi-app deployments                           | Dedicated Better Auth schema for this app (`public` default, or `auth_<app>` such as `auth_crm`).                                                                                         |
| `APP_KERNEL_ROLE`             | Policy-enabled schemas                          | CUE `authorization.roles` identifier granted to human members of this app (for example `crm_user`).                                                                                       |
| `PRODUCTION_APP_DATABASE_URL` | `migrate:rehearse` only                         | Production database URL used as a safety guard so rehearsal never runs against production.                                                                                                |

Local `pg_dump` restore points are written to `./.local/restore-points` with `./.local/.gitignore` (`*`) created automatically so backups are excluded from git.

## `0.1.0-alpha.2` Scope Notes

- **Mainline human CRUD:** `createAppRoutes` and `createDataClient` target human-authenticated mainline reads and writes.
- **Policy-enabled schemas (`policy_declared = true`):** Role-scoped `list`, `get`, `aggregate`, `history` field values, and mainline `apply` are active in `0.1.0-alpha.2`. Staging `draft` writes, `revert`, recent-activity feeds, change-set comparison/diff, actor/notes disclosure in `history`, and Canvas work sessions are deferred to `0.2`.
- **Additive-by-default migrations:** Retiring existing models, fields, enum options, or change types requires explicit `--allow-retire`.
