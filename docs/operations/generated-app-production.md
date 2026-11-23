# Generated app Production handoff

The App Builder returns a reviewed app source, its public route, checked CUE
release and digest, and Preview evidence. An operator names the organization,
actors and roles before any hosted mutation. The first application of this
path is the restricted Spend Review pilot. A Builder preview, a passing build,
and a provider READY deployment do not establish Production readiness.

## Review the plan

Set `APP_PRODUCTION_TARGET_HOST` to the exact reviewed PostgreSQL endpoint
hostname. It is an identifier, not a credential. Run the plan separately for
each actor and intended app role:

```sh
mise run app:production -- plan spend-review <organization-id> <actor-id> member
mise run app:production -- plan spend-review <organization-id> <reviewer-id> reviewer
```

Review the app ID, organization, actor, role, database, runtime principal,
release ID, artifact hash, target host, and digest. A later source or host
change changes the digest. Keep the output with the operator approval record.

## Prepare and bind

In protected operator execution, provide
`APP_PRODUCTION_CLUSTER_DATABASE_URL` (cluster login to the reviewed host),
`APP_PRODUCTION_RUNTIME_PASSWORD` (new runtime login password when the role is
first created), and the same
`APP_PRODUCTION_TARGET_HOST`. The endpoint must use verified TLS. Run:

```sh
mise run app:production -- prepare spend-review <organization-id> <actor-id> member <reviewed-digest>
```

`prepare` creates or verifies `platform_spend_review`, installs the checked
bundle without any CUE demo seed sets, activates it for the exact organization,
and binds `platform_spend_review_runtime` to that scope. It is repeatable and
prints a sanitized receipt. A local disposable PostgreSQL rehearsal may use
`NODE_ENV=test`; Production rejects loopback and requires `sslmode=verify-full`.
Repeated preparation preserves the existing runtime password. Change that
password only through a separate reviewed rotation with coordinated provider
environment replacement.
The cluster login must own the dedicated database and be able to create the
generated capability roles. Resolve provider permission failures before any
grant. Keep it outside the Vercel runtime.

Bind `SPEND_REVIEW_DATABASE_URL` in the single `apps` Services project's
protected runtime environment using the runtime login and the dedicated
database. Read back the environment binding without printing its value.
Provider environment management, native deployment and provider-owned
activation are operator actions; repository CD does not perform them. Save the
Production-only runtime binding before the next native Git delivery. A saved
variable does not modify an already-built deployment, and rerunning CD cannot
activate it. Verify the newly activated deployment before crediting its proof.
Ensure the `apps` runtime has its existing Auth configuration and that
`auth:db:provision` has installed `app_actor_assignment` before granting
access.
Prepare the checked release for the controlled `dev` QA organization as well
as the named pilot organization. Use separate reviewed plan digests for each;
the public read-only Production proof authenticates to `dev` and checks its
scoped release receipt.

## Grant and prove

The actor must already exist in Better Auth and be a member of the named
organization. The Gateway authenticates the request, strips browser session
cookies before forwarding, and signs a short-lived principal for the app,
organization, method, and request target. Spend Review verifies that principal
and checks its exact database-backed app role before each generated operation.
Provide `PLATFORM_AUTH_DATABASE_URL` only to protected operator execution. It
must target the live Auth database and use an operator role permitted to read
organization membership and write app assignments. The cluster installer login
is not necessarily permitted to read or write Auth tables; do not assume its
database-creation privileges grant Auth access. Then run `grant` with that
actor's reviewed digest. The task checks membership, binds
the database actor, enables the organization app entry and the exact app role,
and reads back both stores. This direct CLI is the generation-zero compatibility
path; it refuses to change either assignment after a protected operation has
advanced that row's fence generation. Protected resumable grants and revokes
must run through the operator journal, which supplies a positive generation.
Run `grant` for each member and reviewer. One actor may hold both roles, but
Spend Review rejects self-approval.
Grant the controlled `dev` QA account its reviewed app role before provider
activation, so the read-only Production proof can authenticate. Keep pilot
business access closed until the Preview and Production evidence passes.

In an isolated Preview tenant, use two real test identities: submit a manual
USD request as a member, decide it with a required note as a reviewer, reload,
and confirm one terminal status and ordered audit history. Check member-only
visibility, reviewer denial for an unassigned actor, self-approval denial,
cross-tenant denial, and concurrent decision conflict. Do not use synthetic
fixtures for hosted acceptance. Keep the public route unavailable to pilot
actors until this evidence and the provider binding are reviewed.

After native Git delivery and provider-owned activation, the read-only CD
proof verifies the current Gateway binding and authenticated Spend Review page
response. It does not infer application readiness from a page marker or schema
receipt. Local acceptance exercises the mounted app-owned data and command
flows directly. Separately read back the active provider deployment and public domain.
Grant named pilot access only after both are correct. A Production write test
must never use customer business data.

## Export and retention

Set `APP_PRODUCTION_EXPORT_DIR` to a new path on protected operator storage,
provide `APP_PRODUCTION_CLUSTER_DATABASE_URL` and the reviewed target host,
then run:

```sh
mise run app:production -- export spend-review <organization-id> <actor-id> <role> <reviewed-digest>
```

It takes one read-only database snapshot and writes newline-delimited JSON for
every table carrying that app and organization scope. The manifest records the
release, row counts and SHA-256 digests. The directory and files are private
to the operator account. Store the export under the organization's approved
data handling policy; it may contain request details and audit history.
The command never prints record contents. It requires an active checked
release and never deletes source data.

### Protected prepared-installation export worker

The protected operator has a separate fixed worker mode for an explicitly
approved tenant export. It receives the prepared installation's exact resource
and selected release rather than the legacy Production naming convention or
the checkout's current release pointer. This worker does not authorize an
export: its trusted caller must verify current owner authority, original setup,
the specific export approval and the physical resource before dispatch.

The existing `build-protected-generated-app-worker.mjs` entry builds the fixed
worker with this additional subcommand:

```text
protected-generated-app-export --file-spool /tmp/autograph-tenant-export-input/<exportId>/<attemptId>.json
```

Both IDs are server-issued UUIDs. The input is the strict version-one
`TenantExportWorkerInput` metadata, without credentials or SQL. Its root and
export parent are private `0700` directories; its exclusively created file is
`0600`. The supported Sandbox command environment supplies only
`AUTOGRAPH_TENANT_EXPORT_APP_MIGRATOR_URL` to the trusted worker. It must never
appear in arguments, input files, logs, app code, public results or snapshots.
The worker also accepts the same JSON on stdin for a controlled standalone
invocation. Neither interface accepts an output path or arbitrary command.

The private output directory is always
`/tmp/autograph-tenant-export/<exportId>/<attemptId>/`. The worker creates that
attempt directory exclusively; a caller must not precreate it or reuse it after
an uncertain attempt. It writes `table-000001.ndjson` and subsequent table
members with `0600` permissions, then writes `manifest.json` last. The manifest
contains each catalog table's identity, decimal row/byte counts, SHA-256 and
ordered 65,536-byte raw chunk identities (the last chunk may be shorter;
an empty member has no chunks). Chunk references are scoped to the export and
attempt. Table selection includes ordinary and partitioned public tables,
including partition children, carrying both `app_id` and `customer_id`.
Counts describe exported members; they are not a count of globally distinct
business records across a partition parent and its child.

One repeatable-read, read-only transaction establishes transaction-local app
and customer settings immediately, verifies the restricted migrator and exact
active installation, and retains explicit app/customer predicates on every
cursor. Authorized business strings remain opaque. Empty tables and empty
business scopes are valid; no business data is changed. On failure, private
partial members may remain, but no successful completion is reported.

Stdout contains one closed `tenant-export-worker-result` metadata object with
export/attempt/snapshot/plan identities, manifest digest and decimal totals.
Failure emits only `tenant_export_failed` to stderr. The trusted operator reads
the exact private manifest and its named members, verifies them, and publishes
through its separate owner-bound artifact capability. The worker has no
artifact-store credentials, Auth connection or provider token. An uncertain
attempt must be reconciled rather than dispatched again under the same IDs.
This source capability alone is not evidence that an export was approved,
executed, retained or made downloadable.

## Failure and retention

Run the same plan digest with `revoke` for each pilot assignment to stop new
browser access before investigating a failure. It disables the Auth role
first, then database membership. Preserve requests, decisions, and audit
events. Export retained history before later data changes. Rolling back the
whole `apps` Services deployment requires checking schema compatibility and
sibling HC/Vendor behavior; a forward fix is preferred if old code cannot
read the active schema. Database reset is not a rollback operation.

The first pilot has no automatic deletion policy. A broader retention,
export, and deletion contract remains a separate product decision.

The repository-owned `mise run test:protected-installer` acceptance also uses
independent OS workers against its disposable PostgreSQL fixture. It delays an
older grant while a newer revoke completes, terminates an interrupted worker,
and retries/restarts against the retained generation rows. These cases assert
closed Auth/kernel access, preserved sibling app metadata, user/session identity
and app data. This is local consumer evidence with trusted synthetic operation
contexts; deployed operator journal/fence delivery remains unassessed.

The generated-app fixture records the following local recovery observations:

| Injected interruption | Observed before retry | Same-generation retry |
| --- | --- | --- |
| Grant after kernel readback | Kernel active, Auth inactive | Auth assignment opens after kernel verification |
| Grant fence expires after pre-transaction check | Kernel active, Auth assignment closed at the failed generation | A later approved operation needs a newer generation |
| Newer revoke during grant post-commit check | Both authority rows inactive at the newer generation | Failed grant cleanup leaves the newer rows untouched |
| Caller membership removed after kernel write | Kernel active, Auth inactive; grant rejected | Grant succeeds only after membership is restored |
| Revoke after Auth readback, including killed worker | Auth inactive, kernel still active | Kernel closes; both fence rows read back inactive |
| Synthetic spool fence denial after Auth closure | Auth inactive, kernel still active; no effect receipt | Cleanup resumes and reads back both inactive |
| Lost synthetic checkpoint response after successful grant effect | Auth and kernel active; worker reports no acknowledged receipt | Same operation identity and generation retry reads back active without allocating a second assignment |
| Delayed old grant after newer revoke | Newer inactive generations in both stores | Old grant cannot reopen either row |

The spool fixture also inspects PostgreSQL activity on each operator fence
request and rejects a request made while an Auth transaction is open. Auth row
generation compare-and-set and membership locking run inside the short Auth
transaction; operator fence requests run before and after that transaction.
If the post-commit check rejects the grant, generation-scoped Auth cleanup
closes the failed assignment without touching a newer generation.

The spool replies and worker contexts in this fixture are synthetic. They do not
prove a hosted provider allocation, Builder journal lease/CAS result, or a
deployed HC/Vendor adapter run.
