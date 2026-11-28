# `@arrusted/auth`

Single-organization Better Auth integration with isolated `auth_<app>` PostgreSQL schemas, closed sign-up by default (`allowSignUp: false`), and operator member provisioning CLI.

## CLI (`arrusted-auth`)

```bash
# Provision a member and write a generated temporary password to a 0600 file
# at .local/credentials/<auth_schema>--<email>.txt (prints only the file path to stdout)
bunx arrusted-auth people add alice@example.com --name "Alice" --org my-org --schema auth_crm

# Revoke active membership and sessions in auth_<app>
bunx arrusted-auth people remove alice@example.com --org my-org --schema auth_crm
```

Generated temporary passwords are never accepted via CLI flags or printed to `stdout`. `.local/.gitignore` (`*`) is created automatically so `.local/credentials/` is excluded from git.

## Environment Variables

- `AUTH_DATABASE_URL` (or `APP_DATABASE_URL`): PostgreSQL connection URL for the app's Auth login.
- `AUTH_SCHEMA`: Better Auth PostgreSQL schema (`public` default, or `auth_<app>` such as `auth_crm`).
- `AUTH_ORGANIZATION_ID` (or `CUSTOMER_ID`): Default organization identifier when `--org` is omitted.
- `BETTER_AUTH_SECRET` & `BETTER_AUTH_URL`: Better Auth signing secret (>=32 characters) and canonical app origin.
