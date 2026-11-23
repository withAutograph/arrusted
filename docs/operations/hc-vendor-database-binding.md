# HC and Vendor database binding observation

This procedure resolves which database and login the active service actually
uses. Source readiness, a database's name, environment-key metadata, local
installed-release inspection and a provider `READY` deployment do not establish
that identity. This observation does not adopt a database, install a release,
alter grants, or authorize a migration.

## Protected observation

Use the provider's current deployment/service identity and its private runtime
logs. Deployment or configuration changes retain their separate coordinator
approval and native-delivery ownership.

1. Record the provider-current deployment, environment and exact HC/Vendor API
   service identity before making the request. Use the existing authenticated
   Gateway and an already-authorized app session for the read-only
   `/<app>/api/schema/active` request. Never create a new assignment, mint an
   installer credential, call materialization/seed, or trigger a schema-admin
   mutation to obtain evidence.
2. Read the private runtime log events named `service-database-binding` for
   that service process/deployment and observation time. Accept only
   `state: observed`. Runtime and initialization connections are separate
   events even when they select the same database. The event occurs once for
   each connection kind per process, so an earlier event from the same process
   may already exist. A failed observation, missing logs, or absent deployment
   association leaves the binding unresolved. Build/installer logs cannot
   stand in for a serving process observation.
3. Compare configured host/database/login fingerprints with read-only provider
   catalog metadata, hashing exact UTF-8 strings with SHA-256. The pooled and
   direct endpoint hostnames may differ; map each through provider metadata.
   Compare `current_database_sha256`, `session_user_sha256` and
   `current_user_sha256` independently. A login and effective role can differ.
   Preserve null schema or absent Neon settings as unknown; never infer a
   branch/project from a missing setting. No connection URL or password is
   needed in the receipt.
4. Re-read the provider-current deployment/service binding after observation.
   A change during the observation invalidates attribution. Keep a sanitized
   receipt containing the deployment/service, timestamp, selected key, binding
   kind, fingerprints, provider metadata correlation and unresolved fields.

The observer uses the selected connection after its normal timeout/search-path
setup. Its transaction is read-only, has a two-second local statement timeout,
and rolls back. It reads only PostgreSQL identity functions and optional Neon
settings, without table scans or customer records. Failed diagnostics do not
replace application results and raw database errors are omitted.

HC schema-admin identity appears only when that separately authorized connection
is actually used. Absence means unobserved; this procedure must not invoke a
mutation to populate it. Existing local/CLI diagnostics are outside the serving
process predicate. Each new process may produce its own event; a single event
does not prove every retained writer shares the binding.

## Inventory after attribution

Once the exact serving endpoint and login are known, inspect effective grants,
database/schema ownership, installed release and canonical predecessor,
readiness metadata and all retained writers using read-only catalog access.
Record HC overlays, lookup authority, seed/default markers, history/replay and
CSV dependencies; record Vendor overlays, history/shared-schema/lookup
dependencies and durable integration callbacks/retries. Do not copy only tables
whose names start with the app name.

Choose in-place adoption only after dedicated storage is authoritative and its
ownership, credential separation and release transition are verified. If mixed
storage is authoritative, prepare an app-only migration rehearsal with complete
dependency closure, write pause/drain, independent readback and forward recovery
after new writes. Preserve both resources when attribution is ambiguous. That
plan and its provider/data effects require separate review before execution.
