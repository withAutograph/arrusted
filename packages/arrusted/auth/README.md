# `@arrusted/auth`

Single-organization Better Auth integration with isolated `auth_<app>` PostgreSQL schemas, closed sign-up by default (`allowSignUp: false`), and operator member provisioning CLI.

## CLI (`arrusted-auth`)

```bash
# Provision a member and write a generated temporary password to a 0600 file
# (defaults to .local/credentials/<email>.txt; prints only the file path to stdout)
bunx arrusted-auth people add alice@example.com --name "Alice" --org my-org --schema auth_crm

# Or write the generated temporary password to an explicit 0600 file path
bunx arrusted-auth people add alice@example.com --password-file ./.local/alice.pwd --org my-org --schema auth_crm

# Revoke active membership and sessions in auth_<app>
bunx arrusted-auth people remove alice@example.com --org my-org --schema auth_crm
```

Generated temporary passwords are never printed to `stdout`; ensure `.local/` is listed in `.gitignore`.
