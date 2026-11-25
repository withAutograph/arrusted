# Integration Data Model

Status: canonical tenant connection and app-binding storage contract for hosted
integrations.

## Decision

Ampersand is the provider-connection system of record. Arrusted's Integrations
app is the system of record only for minimal tenant connection identity and
tenant-to-app authorization/routing metadata. Domain apps remain the system of
record for their installations/configuration and all provider data-plane
decisions. This explicitly narrows A-132's V0 “no local integration tables”
rule; it does not create a local copy of Ampersand state.

## No New Local Tables

Do not add these Ampersand mirrors or data-plane tables:

- `vendor_integration_import`
- `vendor_integration_record_link`
- `vendor_integration_mapping`
- shared provider schema manifest tables
- selected-field manifest tables
- delivery ledger tables (except an independently designed, bounded outcome
  store; it is not connection metadata)
- integration preview or accepted-plan tables
- source identity ledger tables

Those tables would duplicate state Ampersand already owns or recreate the CSV
import architecture in a flow where Ampersand is doing the provider work. The
following narrowly defined control-plane records are the sole exception.

## Arrusted-owned control-plane metadata

The Integrations app may persist exactly these logical records, all keyed by an
opaque tenant (`customer_id`) and opaque ids. Physical names and DTOs are
implementation details, but their fields and ownership may not expand without
an architecture decision.

| Record | Owner and purpose | Allowed fields | Forbidden fields |
| --- | --- | --- | --- |
| Connection | Integrations app; one tenant-owned handle to an external provider connection | `connection_id`, `customer_id`, provider/system key, external installation reference or opaque locator, lifecycle, timestamps, revision | credentials, OAuth tokens, selected objects/fields, mappings, provider response/payload, health diagnosis, recipe, canonical record ids |
| App binding | Integrations app; authorizes one domain app to address one connection and supplies its app-local route key | `binding_id`, `connection_id`, `customer_id`, `app_id`, app-local routing id, lifecycle, timestamps, revision | app installation/config blob, catalog/manifest, object selection, mappings, sync cursor, health, provider payload, kernel row ids |
| Activation grant | Integrations app; short-lived, single-purpose authorization evidence for a domain app to create/refresh its own installation | grant id/JTI, binding id, tenant/app audience, grant action, expiry, issued/revoked/consumed timestamps, binding revision | credentials, provider payload, app configuration, reusable bearer authority |

Connection and binding records use independent revisions. Every read/write is
tenant authorized; an app may read only a binding addressed to its exact
`app_id`. A connection is not activated for an app merely by existing. A grant
is audience-bound to `(app_id, customer_id, binding_id)`, short-lived,
single-use, and invalid once its binding revision/lifecycle changes. The
Integrations app never calls the provider data plane on a domain app's behalf.

### Lifecycle and safe disconnect

Connection lifecycle is `pending -> connected -> disconnecting -> disconnected`
or `failed`; binding lifecycle is `pending -> active -> suspending -> removed`.
Only the Integrations app changes connection/binding lifecycle and creates or
revokes grants. A domain app may request activation or removal but cannot
write the control-plane state directly.

Activation first commits a **pending** binding revision, then issues the bound
grant. The domain app consumes it once, reconciles the exact app route and
connection, and creates or refreshes its app-owned installation. The authority
independently verifies installation identity and a provisioned service actor
before changing the binding to active. A consumed or expired grant cannot be
reused; a fresh grant is required. A fresh attempt preserves the routing identity
and reconciles uncertain provider results before creating anything. Pending
bindings cannot ingest. Failure leaves the binding pending for reconciliation.
An operator may expire a pending binding after five minutes only when every
grant is expired and no provider create attempt was recorded. A claimed or
uncertain provider create remains pending and requires exact provider
reconciliation; expiry never turns uncertain external state into authority.

The implementation in `packages/integration-control-plane` uses three operational
PostgreSQL tables: `integration_connection`, `integration_app_binding`, and
`integration_activation_grant`. They have forced tenant RLS and independent
connection/binding revisions. The connection stores its verified opaque external
connection and group references, a safe provider-derived display label, and the registering actor.
The binding repeats the tenant, references the connection through a composite
tenant foreign key, and stores the app integration key, verified opaque external
installation reference, and acting actor. Public
`IntegrationConnectionSummary` and `IntegrationAppBindingSummary` omit all
external references. An active delivery must match the registered group and
installation references as well as its tenant, app, connection, binding, and
route; provider readback still confirms the current external state. Legacy rows
without these references require reconciliation before delivery can resolve.
Install these tables only in the central Integrations database. They are not
domain models and are never installed into generated app databases. Runtime
credentials must not own these tables or have `BYPASSRLS`. The host authenticates
every operation and separately authorizes organization-wide connection management.

Entitlement removal revokes unconsumed grants and changes the binding to
`suspending` before the app loses access. The domain app stops new provider
work, drains/aborts in-flight work under its own policy, deletes/revokes its
app-owned installation state, then acknowledges removal. The Integrations app
marks the binding `removed` only after that acknowledgement or a documented
safe timeout/reconciliation result. Disconnect first revokes every active
binding/grant, waits for the same app acknowledgements, then asks Ampersand to
disconnect. It never deletes canonical app rows, and it never retains provider
credentials or raw payloads as a recovery shortcut.

Reconciliation is control-plane only: Integrations compares opaque external
installation references and lifecycle observations with Ampersand, then
creates bounded repair work or changes connection/binding state. It does not
copy provider configuration, infer domain health, run sync, or apply data.
Domain apps reconcile their installations and data-plane health after an
authorized binding is active.

### APIs and wire ownership

The only cross-app API surface is tenant-authorized control-plane operations:
create/list/read connection metadata, create/read/remove an app binding,
request/consume an activation grant, acknowledge removal, and read a bounded
reconciliation result. Provider payloads and app configuration are not API
fields. The server derives tenant and actor; callers cannot supply another
tenant, app id, lifecycle transition, or routing identity without authorization.

Each new request/response/event DTO is generated from its owning wire contract
or is exported from `packages/contracts`. App clients consume that source; they
must not hand-type structurally similar connection, binding, lifecycle, or
grant interfaces. Generated DTO ownership does not move provider/app policy
into a shared package.

## What Ampersand Stores

Ampersand stores or exposes:

- provider credentials and connection state
- per-customer integration installation state
- saved installation config
- selected provider objects and fields
- user-defined object and field mappings
- provider metadata, including standard and custom fields
- operation state, logs, health, retries, and backfill progress

Use Ampersand APIs, dashboard, and prebuilt UI for that state.

## What Autograph Stores

Autograph stores only:

1. canonical app records and row versions produced from integration deliveries
2. existing `change_set` metadata and idempotency for those writes
3. optional app-schema source reference fields when a product workflow needs the
   provider id as app data
4. optional small version-row provenance

The app-owned integration adapter emits ordinary `ApplyChangeSet` input from an
app-owned integration recipe plus the Ampersand delivery. Durable writes go
through the app-owned apply endpoint or persistence bridge, which validates app
scope and policy before calling the Postgres-backed kernel path. The kernel
validates the already-compiled write against the active app schema revision,
opens the `change_set`, applies row-version writes, and enforces existing
idempotency.

Use `change_set.source_kind = 'integration'`. Use a source ref derived from
Ampersand delivery identity, such as
`ampersand:<installationId>:<operationId-or-event-ref>`. Single-message read
deliveries can use `operationId`; split read deliveries for the same operation
must add provider/Ampersand message or chunk identity, or use deterministic
record-level identity available before any URL payload download, such as
installation/object/source ref plus provider update/version metadata.
Subscribe deliveries may need source record/event metadata instead. Derive the
idempotency key from verified envelope identity before any
`resultInfo.type = url` download. After a payload is available, compute its hash
for provenance and duplicate/conflict comparison. Payload hash is not part of
the replay key, but non-empty URL deliveries must download and compile before
accepting an existing change_set replay result so the trusted apply path can
prove the persisted source-record and payload provenance still match. Never
treat a later split read message as a duplicate solely because it shares an
`operationId`.

Small provenance may include:

- `provider`
- `installationId`
- `operationId`
- `integrationId`
- `configId` or `installationUpdateTime`, when available
- `objectName`
- `rawObjectName`
- `readType` or `subscribeEventType`
- `providerEventType`
- `source_record_ref`

Do not store or log raw provider payloads, notification envelopes, signed URLs,
or provider secrets. No environment switch or retention-policy exception exists
in V0. Persist only normalized app writes and the bounded provenance fields
listed above.

## Source Identity

Do not use model `external_key` for provider ids. It is within-batch authoring
plumbing, not integration identity. Hashing or prefixing an Ampersand
installation id, QuickBooks id, source record ref, or recipe source ref does not
change that; compiler-emitted `RecordKey::ExternalKey` for provider/source
identity is still a boundary violation.

Ampersand supports installation identity: each webhook carries installation and
group context, and Ampersand APIs can fetch installation state. Multiple
installations should stay represented by Ampersand installation identity plus
app-owned matching rules, not by a generic platform source-identity table.
Ampersand does not decide which app canonical record an external row should
mutate; that is app policy.

If an app needs automated update/delete from a provider, the app-owned recipe
must have a deterministic matching policy using app schema data and Ampersand
delivery context. If that policy requires a provider id to become durable app
data, add it as an app-schema field for that app because the product needs it,
not as generic integration substrate.

Repeat provider rows are update attempts once the app can resolve their source
reference to an existing canonical record. They must not target the canonical
record unless the app recipe both enables the mutation and provides a
deterministic app-owned match. Create-only recipes should either compile
keyless writes that the app-owned persistence bridge rejects as duplicate source
identity, or return a structured no-op/conflict before kernel apply. They must
not turn the provider id into model `external_key` to make repeats addressable.

For QuickBooks read deliveries, the vendor app policy persists the stable
source identity in write-row provenance: `source_record_ref` names the app-owned
source reference and `mapped_field_ids` names the recipe fields that were
mapped for provider-clear detection. The trusted vendor app backend locks that
`source_record_ref`, looks up exactly one prior canonical row from persisted
mainline version provenance, reads the visible row `FOR UPDATE`, and only then
supplies a kernel `record_id` target for a matched update in the same
transaction as provider-clear checks and kernel apply. New source refs remain
keyless creates. Caller-supplied kernel `record_key` values are rejected for
trusted integration writes, so QuickBooks ids never enter model `external_key`.

Reject update/delete events when the app recipe cannot deterministically match
the affected canonical record.

Source-reference recipe components use Ampersand `mappedFields.<mapToName>` for
fields declared through Ampersand object/field mapping. Raw provider
`fields.*` paths are for deliberately unmapped provider envelope data only.

## App Schema Scope

App data stays inside the app schema. Each app declares any source reference
fields it truly needs, plus an app-owned integration recipe that maps Ampersand
`mappedFields`, source refs, and installation context to app schema fields. The
app integration adapter executes that recipe into row-version writes carried by
ordinary `ApplyChangeSet`.

The repeatable external-library wrapper lives in `packages/integrations`:
Ampersand prebuilt UI adapters, external-library styles, and generic token
request types. It must not know app schema, Platform API clients, provider
capability catalogs, manifest/config schema helpers, kernel DTOs,
provider-to-app normalization, or `ApplyChangeSet`.

The repeatable trusted ingestion pattern is composed at the app boundary, not in
core kernel apply: verify the webhook, parse the Ampersand envelope, validate
installation and customer scope, normalize through the app-owned recipe, compile
`ApplyChangeSet`, and then persist through kernel apply. A reusable
`packages/integration-compiler` crate may compile already-verified recipe input
into generic kernel write contracts, but it must stay outside kernel and outside
app/provider semantics. App-owned recipes bind provider data to normalized
CUE-generated models and fields; provider selection, source identity, date/sign
rules, clearing and accepted canonical effects remain explicit app-owned policy.
Rust app code may provide route glue, schema
materialization, app policy, and the kernel apply bridge; it must not own
provider ingress. The per-app data contract stays in the app schema; the kernel
receives an ordinary write envelope.

Trusted runtime routes reject caller-supplied `record_key` unless an app-owned
update policy carries recipe/version proof into apply. Compiler support for
deterministic source-reference matching does not by itself authorize generic
trusted routes to accept `record_key` updates. The QuickBooks trusted route is
the narrow first update-enabled path: TypeScript deliveries stay keyless, and
Rust resolves a repeat delivery to a kernel `record_id` only after deterministic
source-reference matching and app policy checks pass. Optional generated SQL
ingestion uses the equivalent narrowly scoped compiler-owned operation with
row locks, provenance matching, replay validation and current service-actor
authorization in one transaction. No generated Rust service is required.

An admitted canonical write holds the control-plane active-binding lease through
the app transaction. Revocation drains these admitted writes before completing;
all subsequent leases fail. Provider network calls and configuration are not
canonical writes and require their own reconciled lifecycle sequencing. Lease
transport must preserve this boundary; a cached active flag is not a substitute.

V0 can reprocess only failures that reached existing `change_set` state or can
be replayed by Ampersand. Do not add a delivery ledger solely for pre-apply
failures; if operators need local replay of those failures, design a minimal
delivery-outcome store separately.
