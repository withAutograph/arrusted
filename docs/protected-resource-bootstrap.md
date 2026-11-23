# Protected resource bootstrap protocol

The fixed `neon-resource-bootstrap-v1` worker prepares one app or Auth database.
It does not install application schemas, create provider branches, classify their
contents, activate Production, or own an operation journal. The trusted host
persists encrypted credentials and acknowledges that checkpoint before launch;
a credential digest alone is not persistence evidence.

## Context and credentials

The strict version 1 context has these fields, in canonical serialization order:

- `kind`: `neon_resource_bootstrap`; `version`: `1`.
- `operation`: `operation_id`, `approval_digest` (lowercase SHA-256), and positive
  safe-integer `fence_generation`.
- `app_id`: app slug, or exactly `auth` for the Auth scope.
- `resource`: `scope` (`app_database` or `auth_database`), `resource_id`,
  `environment` (`local` or `preview`), `hostname`, integer `port`, `database`,
  `migrator_role`, `runtime_role`, `maintenance_database`, `bootstrap_role`,
  optional `provider_project_id`, `provider_branch_id`, `provider_endpoint_id`,
  then `credentials_sha256`.
- `release`: `id`, `sha256`; `installer`: `id`, `sha256`.
- `tenant_targets`: exactly `[]`.

Database and role names use the SQL identifier schema in
`packages/protected-installer/node-spool.ts`. Target and maintenance databases
must differ; target cannot be `postgres` or `neondb`. Migrator, runtime, and
bootstrap roles must differ. Local uses `127.0.0.1` with no provider identifiers.
Preview requires a `.neon.tech` hostname and all three provider identifiers;
actual connection identity must match them. Production is unsupported.

`digestResourceBootstrapContext` validates the strict schema and hashes UTF-8
`JSON.stringify` bytes using the order above, omitting absent optional fields.
Nested operation/release/installer members use the order shown. No whitespace
or trailing newline is included. Hosts should use the exported helper.

The strict secret bundle contains `migratorPassword`, then `runtimePassword`.
Each is 32–512 characters without NUL, CR, or LF.
`digestResourceBootstrapCredentials` hashes its canonical UTF-8 JSON bytes in
that order. Passwords and the direct URL must never enter protocol frames,
receipts, lifecycle facts, or logs.

## Startup and frames

Invoke `neon-resource-bootstrap --file-spool <directory> <runId> <timeoutMs>`.
The private startup directory contains `context.json`, `direct-database-url.json`
(a JSON string), `resource-credentials.json`, and `ready.json` with
`{version:1,run_id:<runId>,frame_id:0}`. Secret files are removed on consumption;
startup failure must also remove them. The URL is direct, uses the exact
maintenance database/bootstrap login, and has `sslmode=disable` locally or
`sslmode=verify-full` in Preview. Only optional `channel_binding=require` is
accepted alongside `sslmode`.

The ordered effect identifiers are `resources:roles`, `resources:database`, and
`resources:acl`. Every request has null `tenant_id` and exactly the frozen
`resource_id`. Authorization requests include `kind:authorize_effect`,
`version`, `operation_id`, `approval_digest`, `context_digest`,
`fence_generation`, positive `sequence`, `effect_id`, `app_id`, `resource_id`,
`release_id`, `installer_id`, `installer_sha256`, and `tenant_id`.
Checkpoint requests carry the same authority fields with
`kind:checkpoint_effect` and `receipt`.

Replies contain `kind:effect_authorized` with `allowed`, or
`kind:checkpoint_recorded` with `recorded`, plus `version`, `operation_id`,
`context_digest`, `fence_generation`, `sequence`, and `effect_id`. All identifiers
must match the outstanding request. Receipts are `{state:applied|no_change,
readback_sha256:<SHA-256>}` or `{state:unknown}`. Each effect requires its own
host authorization before SQL and durable checkpoint acknowledgement afterward.
Request/reply files and ready markers use the shared protected-installer spool
protocol; stdout contains readiness notices, not secret-bearing payloads.

## Ownership, recovery, and completion

Physical role/database comments bind scope and resource identity. Unknown
existing roles or databases are rejected. A database with matching owner but
no comment is recoverable only when its owned migrator role carries the exact
resource/database pending-create marker, written after an absence read under
session locks. This is physical creation intent, not a second operation ledger.
The marker survives process loss between nontransactional CREATE DATABASE and
COMMENT; it is cleared only after database tagging and temporary membership
cleanup. Existing SET membership without that intent is rejected unchanged.
Standalone workers serialize database and role identities with PostgreSQL
session advisory locks; process loss releases locks.

App migrators require CREATEROLE for generated capability installation; Auth
migrators and all runtime logins require NOCREATEROLE. All target logins prohibit
superuser, CREATEDB, replication, BYPASSRLS and privileged reachable membership.
Runtime memberships permit only the deterministic app runtime/query capability
roles (and no memberships for Auth); unrelated inherited readers are rejected.
The database belongs to its migrator. PUBLIC database access and public-schema
USAGE/CREATE are revoked; runtime receives CONNECT and schema USAGE, without
CREATE or TEMP. Final role and connection readback precedes success.

Lifecycle files report `worker_started`, then `worker_succeeded` or
`worker_failed` with a bounded failure code. Startup rejection can fail before
started. Transport timeout/protocol failure and unknown readback are distinct
from denied authority and failed SQL. Missing terminal or checkpoint evidence
never proves success; the host resumes its sole durable operation using the
same persisted credentials and resource identities.
