# Generated Data Operations

This is the current generated server-side interface for supported CUE-backed
apps. The [implementation contract](contracts.md#generated-application-implementation-contract)
defines its schema authority and evidence classes. The future reference app,
packaged app kit, and provider integrations in the roadmap are planned work;
this interface alone does not prove those product flows or hosted delivery.

## Explicit app-base installation targets

Repository-owned setup can use
`installGeneratedAppProductionTargets({ appId, customerIds, databaseUrl, releaseDirectory, sourceCue })`
from `@autograph/generated-app-runtime/server` to install a checked release
without demo seeds for an explicit tenant set. It prepares and validates every
requested tenant before one atomic app-base activation. Batch preparation,
readiness validation and activation share one transaction, so a later-target
failure leaves no earlier target staged by that attempt. Tenants sharing a
database must be included in the explicit complete target set; sequential
singleton installation does not establish a multi-tenant release.

The same complete, already-active set can be replayed. An explicitly requested
expansion may mix exact already-active targets with pending targets: the active
targets retain their revisions, activation timestamps and history while the
pending targets advance atomically. A failed attempt rolls back its preparation
and leaves existing active targets unchanged. Empty or duplicate sets and omitted
prepared targets fail closed. The helper never adds unrequested tenants or changes kernel
activation rules. Existing singleton and local setup interfaces retain their
behavior. This API grants no deployment, provider, migration, or Production
authority; callers still need the applicable environment authorization.

The application CUE schema generates its data-access interface. Server-only app data modules import from `@/schema`; Next Server Components
consume their authorized presentation results. Apps explicitly export browser mutations
from ordinary Server Action modules. Business workflows compose generated data operations.

## Three ownership strata

The schema generates the vocabulary; features compose it into workflows and views.
Keep these strata distinct:

1. **Schema vocabulary** is generated from CUE: fields, scalars, enums, relations,
   canonical keys, write options, accepted create/update and form fields, selected
   result inference, generated model records, persistence receipts, and form
   errors. Generated `<Model>CreateField` and `<Model>UpdateField` aliases
   exclude readonly, derived, and retired fields while including active supported extension fields;
   prefer inference from generated operations and presentation return types.
   `CanonicalRecordKey` keeps UUID and external-key meaning explicit.
2. **Feature usage** is app-owned: form subsets, action state, route interpretation,
   presentation disclosure and reshaping, filters, ordering, limits, `asOf`,
   metrics, and business workflows. Features select the fields and policy values
   they need; projection does not grant authorization. Consolidate imports, not
   ownership.
3. **Trusted server context** is owned by the app's server foundation: authentication, app/customer/tenant/
   actor resolution, checked release and schema identity, database credentials,
   connection pooling, and local-demo restrictions. Generated database policy
   enforces operation, field, and record authorization for policy-enabled releases;
   apps retain resource-specific checks for policy-absent releases. The
   server-only app DAL constructs and binds this context; `app/data/context.ts`
   is the only application data-access boundary and returns safe feature DTOs. It does not move request scope,
   credentials, or authentication into CUE, nor expose generated records as
   browser identity contracts. Persisted actor or audit fields may still be
   ordinary app-owned schema vocabulary. Persistence receipts describe database
   outcomes; features still decide what is safe to disclose to the UI.

Prefer inference at feature boundaries. Generated create/update field aliases are
generated vocabulary, while the feature chooses its accepted subset. A small
Feature modules define their own accepted field subsets and action state.
Server Actions reuse that field subset for parsing and safe error projection;
parsing, authorization, persistence, and invalidation remain server-side.
`FormActionResult<Field>` is an optional convenience shape for simple form
submissions whose shared result is `ok: true` or a browser-safe `FormError`.
Features may return richer action-specific results, and own the initial `null`,
workflow state, runtime validation, authorization, and security. Route-local and
shared-feature modules can import model types from `@/schema` while keeping
presentation types and disclosure decisions feature-owned. Existing workflows
such as Review Queue, Request Detail, and `resolvePurchaseRequest`, including
their `asOf` choice, sorting, filtering, metrics, and state transitions, remain
feature/view policy rather than CUE vocabulary; `auth`, actor, and `sourceKind`
resolution remain in the app DAL.

## Build and release

`mise run schema:compile` discovers `apps/<app>/schema/<app>.cue`, validates and
normalizes it with the Rust compiler, and emits the checked release. HC and
Vendor retain their explicit predecessor inputs and existing client surfaces.
Issued bundles remain immutable. The local generated-app runtime selects the
unique checked bundle whose source map matches the current app CUE file, then
verifies its checksums. Directory ordering never selects a release.

`schema/index.ts` is a compiler-owned one-line static re-export of the current
release's `data-server.ts`. App imports use the `@/schema` app-root alias and stay
unchanged when a new release is compiled. The pointer is mutable and outside
the immutable release bundle; the release `data-server.ts` remains guarded and
immutable.
`schema:check` verifies its exact content and the unique matching checked release.
Do not hand-edit it or select a release by directory order.

The generated app inherits the shared workspace source alias map, including
`@/*`. Its `${configDir}` target resolves app-root files, including `@/schema`
to `schema/index.ts`. The map contains no app-owned client aliases. The backend
scaffold declares its generated-runtime package dependency, which TypeScript
resolves through package exports.

The release `data-server.ts` also exports shared application types: `CanonicalRecordKey`,
`QueryInput`, `WriteOptions`, `DataWrite`, `FormError`, `FormErrorCode`, and
`FormActionResult<Field>`, alongside each model's record, create-field, and
update-field types.
Use `import type` for these and model record types, including in client modules;
type-only imports do not load the server runtime. Runtime context/session types
remain implementation details. The compiler rejects model record names that
collide with these shared names or the internal `DataContext`, `DataDefinition`,
and `ModelRecord` aliases, rather than emitting ambiguous or invalid TypeScript.

The generated-app release adds these checksummed artifacts:

- `operation-manifest.json`: model/field types, stable names, capabilities,
  constraints, supported operators, limits, and operation descriptions.
- `data-operations.ts`: framework-neutral typed bindings and record types.
- `data-server.ts`: includes the `server-only` import guard for Next apps.
  Non-Next apps receive a framework-neutral re-export; it is not a browser security boundary.
- `data-operations.md`: the generated operation reference.

The normalized contract is the only model input. Runtime validators and field
conversion consume this generated metadata; no app maintains another schema.
`mise run schema:check` regenerates into temporary directories and detects drift,
including the unrelated Asset Register typed fixture.

A release that adds one optional text field can include a compiler-verified
predecessor in the operation manifest and generated bindings. When that exact
predecessor is still active, ordinary record queries and writes can continue
under the tenant activation lock. The new field reads as null until the update
completes. A write using the new field returns a pending error without changing
any records. Filtering, sorting, searching, grouping, or aggregating by the new
field also requires the update to finish. Work-session operations continue to
require the current schema.

An authenticated server data loader can call
`operations.<model>.fieldActivation({ field, operation: "create" })`
(or specify `"update"`) for a generated writable field. It uses the selected
operation's authorization and the same scoped schema read as writes. It
returns `"pending"` for the field waiting on the checked predecessor and
`"active"` for fields available in the active schema. An app can omit
the pending input while retaining the rest of the form, then refresh its
status on the next request. The result reports schema readiness only.
Server Actions still enforce record and field permissions, and mutations
recheck the active schema when submitted.

For an existing managed database, a new checked release may also include an
online materialization plan in `transition-plan.json`. The compiler emits
this plan only when it can compare the exact checked predecessor and prove
that the physical change is one nullable text column and its record-event
constraint. The protected installer verifies the active tenant revisions,
retained policy and role boundaries, and catalog entries before activation.
It adds the column and unvalidated constraint in a short transaction that
does not queue for an exclusive table lock. If the table is busy, the
installer rolls back the attempt and retries. Constraint validation runs in
a separate transaction that permits ordinary reads and writes. Retries
verify and reuse the same physical changes. The existing prepare, readiness,
and activation contract still binds the exact release and approved tenants.
When checking an issued online release, the generator resolves its predecessor
by the recorded artifact digest from the app's checked release history.
Initial installs and releases without this plan use the checked full bundle.

The generated runtime treats every successful kernel response as untrusted until
the operation boundary validates its wire shape. It validates active schema
identity before applying writes, complete or selected record projections before
exposing them, count receipts, apply receipts, and historical field events
against their event-time structure. A selected projection may omit containers
that were not selected and never receives full-record provenance. Full reads
enforce the compiler's active required-field backfill invariant; optional and
retired declared values remain nullable, while absent many-relations normalize
to an empty list. Malformed responses remain server failures rather than
browser-safe form errors, and diagnostics identify only the operation, shape
path, and expected structure.

One compatibility exception is deliberately narrow: legacy PostgreSQL history
JSON may encode an enum event's positive safe-integer schema revision as a JSON
number, although the public contract is its canonical decimal string. The
runtime accepts only that exact safe numeric representation and normalizes it
losslessly at the history boundary; active-revision and apply-receipt IDs remain
strict canonical strings. This preserves issued release SQL and the public read
shape without applying general response coercion.

Generated Next.js apps use the shared release configuration at build time to
trace the checked CUE and selected release at their mount and exclude historical
release files. The app supplies its verified public origin from the protected
boundary so the Next configuration can bind Server Actions to that exact host.

## Authenticated app foundation

For a generated Next app with CUE data, the generator places its server-only data
foundation under `app/data/`. This is the sole data-access boundary: it owns
trusted request scope, authentication, release verification, database setup,
authorization, and generated-operation calls. Feature-specific functions return
minimal DTOs and perform authorized mutations. Static apps receive neither this
foundation nor database dependencies.

Server Components call DAL read functions directly. Server Actions validate
untrusted input, call DAL mutation commands, then revalidate affected routes only
after successful persistence. Route and action modules never import generated
operations or return raw generated records. The DAL verifies the checked release
and binds app, customer, and actor scope for each operation; database policy
continues to enforce operation, field, and row access. Legacy mode shares only the connection pool between requests. Protected mode
uses request pools closed by the DAL lifecycle helpers.

Authentication does not install a database principal or membership. Those must
already be configured by the administrator. The scaffold does not generate
product-specific read or mutation functions, demo workflows, or browser actions.

## Application interface

Server Components call feature-specific DAL read functions and receive only
their DTOs. The DAL performs authorized reads and maps them to presentation
shapes. Server Actions validate form input, delegate writes to `app/data/`
mutation commands, and revalidate after they succeed. Generated
operations stay private to the DAL.

### Authorization policy

Authorization metadata is optional CUE policy. When an app declares it, the
compiler validates role and grant references and emits an immutable policy
artifact keyed by app and base schema version. A grant names a role, model,
operation (`read`, `create`, `update`, `delete`, or `history`), permitted
`read_fields`/`write_fields`, optional relation navigation, and either all rows
or an `actor_equals_field` row predicate. The database enforces the installed
policy for model, field, and row access; the policy is never inferred from a
route, form, capability flag, or browser state. Unsupported combinations fail
at compilation.

For a `document` model with a required text `owner_id` field, this grant lets
editors read selected fields and change the title of documents they own:

```cue
authorization: {
  roles: [{id: "editor", label: "Editor"}]
  grants: [{
    role: "editor"
    model: "document"
    operations: ["read", "update"]
    read_fields: ["$id", "$version", "title", "owner_id"]
    write_fields: ["title"]
    record: {kind: "actor_equals_field", field: "owner_id"}
  }]
}
```

Policy references resolve normalized spelling to the declared logical schema IDs; case, spaces, and hyphens do not change the stored identity. Physical PostgreSQL identifier shortening does not change policy enforcement. Application code uses the generated
names, for example `document.list({ asOf, select: ["id", "title", "$version"] })`.
Omitted permission lists grant nothing; no role or operation is implicit.
A role string in application code cannot add a database membership.

The host authenticates the human session and resolves its app, customer, and actor
server-side. Roles come from administrator-managed database memberships. A pooled runtime connection delegates that verified
actor through an administrator-installed membership for the exact principal,
app, customer, and actor. Database scope and grants remain authoritative:
membership is delegation, not human authentication, and it cannot widen a
grant. Missing or inactive membership, mismatched or unbound actor/scope, and altered or
missing policy artifacts fail closed. A revision retains whether its compiled release declared a policy, so removing the policy catalogs cannot turn that revision into legacy access. Pre-policy revisions without this marker retain their historical contract. Legacy policy-absent releases retain their
tenant-only contract and must not claim fine-grained authorization.

Reads authorize the complete requested projection before caller filters,
ordering, grouping, aggregates, pagination, external-key lookup, or relation target
access. Per-row grants may combine only when their row predicates match that
row; full reads omit unauthorized rows rather than redact fields. A literal
`select` still determines the exact TypeScript result shape, while authorization
determines whether that projection may be returned. `$version` and other
metadata are explicit permissions, never authority. History uses current
membership and policy against each requested temporal image and returns all or
an authorization error; it does not use an old policy snapshot to bypass a
revoked grant.

Every generated write and exact replay performs current scope, membership, and
operation/field/row authorization in the transaction. Policy-enabled generated
writes use immutable `new_record_id` create subjects and `record_id` existing
subjects; the low-level `external_key` record-subject form is unsupported. Relation
values may still use external keys and require the target `$externalKey` read grant.
Relations grant navigation only; target row and field permissions still apply. Raw SQL, prepared queries,
low-level helpers, native request paths, and table access cannot bypass a
declared policy. A path that cannot enforce it must reject policy-enabled
revisions explicitly. Policy does not provide provider provisioning, a browser
identity flow, or business workflow decisions; those remain host/app-owned.

The policy-enabled `operation-manifest.json` adds an `authorization` contract object. It records exact active principal/app/customer/actor/role membership, per-matching-row grant evaluation, and all-or-error temporal history. Its `supported` inventory is generated CRUD, selected queries, counts, aggregates, inverse relation lists, and history. Its `unsupported` inventory is legacy raw SQL and prepared-query access, native request endpoints, draft approval/read/discard and revert lifecycle operations, lookup lifecycle/hydration/reference-count operations, and agent-run endpoints. The object is omitted for legacy policy-absent releases.

Numbers and money-rate amounts are decimal strings. Dates are calendar strings,
datetimes include a timezone, enums use option IDs, and relations retain explicit
record-key identity. Known custom fields have `custom<FieldName>` properties;
persisted lookup many-relation values use record-key arrays. Derived fields
(compiled `derivedFields` and tenant-authored derived custom fields) are
read-only custom fields: `kernel_data_query` evaluates them over each
authorized read image and returns them as `custom_fields` entries, omitted when
the value is null. Generated clients may select, filter, order, group, bin, and
aggregate them like their stored type; create and update inputs exclude them,
and the kernel rejects writes with `derived_field_read_only`. Record-image reads
outside `kernel_data_query` (history, diffs, visible-record reads) return stored
values only. Derived values are computed from the request's read image:
mainline rows, overlaid with the owner session's staged values when the query
names `work`. Per-query
`computed` columns are a `kernel_data_query` request capability for trusted
server and agent callers; the generated typed client does not yet expose them.
For instant per-cell previews over staged values, use the TypeScript evaluator
in `packages/engines/derived-expression`, which follows the kernel's rules
exactly but never replaces kernel values.
Schema changes require regenerated bindings; dynamic schema administration is
not silently folded into CRUD.

### Writes and lifecycle

Mutations use `create(values, options)`, `update(recordOrId, changes, options)`,
and `delete(recordOrId, options)`. Options contain explicit `effectiveStart` and
`idempotencyKey`; derive a workflow idempotency key from the resolved canonical
record `id` when a workflow targets an existing record. Update and delete options also accept an explicit
`ifVersion` token when the definition advertises `capabilities.versionPreconditions`.
The token is compared with the visible mainline version locked for the write; it is
never inferred from the target. Capable full records expose a readonly `$version`
UUID. Narrow reads can explicitly select `"$version"`; other selected results omit
it. Selected objects cannot be used as generated record references. Legacy definitions
reject `ifVersion` and `$version` selections, and creates never accept a guard.
Update options also accept `clear` and `metadataPatch`.
Deferred `model.writes` builders use the same argument order, with optional
builder options; `operations.apply` supplies the batch date and idempotency key.
Create builder options can specify `id` and `metadataPatch`. There are no
compatibility overloads for the previous nested `values` input.

The exact-optional-properties compiler setting keeps absent optional members
distinct from explicit `undefined`. Clearing remains an explicit `clear` entry
or metadata patch operation, and explicit metadata `null` remains distinct from
omission on the wire.

Create reserves a new explicit UUID; it never upserts by external key. Direct
create derives a stable UUID from trusted app/tenant scope, schema version, model, and idempotency key.
The lower-level create builder also accepts a caller-retained UUID for atomic
cross-model composition. External-key assignment remains outside this initial
create projection; existing external keys remain readable.

Update addresses an existing UUID, changes supplied values only, and accepts an
explicit `clear` list for optional fields. Required or derived fields cannot be
cleared. Opted-in models also accept the canonical bounded `metadataPatch`. An
omitted guard preserves current behavior; malformed or non-UUID conditions are
invalid input, while a valid token for a missing or stale visible version returns
the safe fieldless `version_conflict`. The kernel compares each guarded write with
the pre-apply visible version at that write's effective date after canonical locks.
Delete creates a tombstone; historical assertions are retained.
`history` returns canonical field-history entries, not an app's narrative audit
model. Restore, drafts, revert, and schema administration are explicitly recorded
as unsupported projection capabilities; none is disguised as update or delete.

Workflow mutations can be composed in one `operations.apply` batch. Explicit
`ifVersion` guards make concurrent updates fail safely instead of overwriting a
newer status.

Relation inputs accept generated records and pending creates of the declared
target model, as well as explicit canonical UUID/external-key `RecordKey` values.
This applies to scalar relations, relation lists, and custom relations. Generated
records and creates retain app, tenant, schema, model, and original UUID provenance
internally; read-result JSON is unchanged. Copied or serialized objects lose that
provenance and must use an explicit canonical key. References grant no permissions.

Pending creates referenced by another write must be included in the same batch.
Use explicit IDs and keys for cyclic creates. Update/delete accept a generated
existing record or UUID, never a pending create. Builders normalize references
before taking immutable snapshots; changing caller objects cannot rewrite an intent.

Builders produce opaque write intents. A version guard is an explicit precondition
inside that intent; do not read a fresh version after building it or compare a
planned intra-batch version. Exact replay returns the original receipt even after
later writes; reusing the same idempotency key with a changed token is an
`idempotency_conflict`. Retain the same intents/payload and key when retrying an
uncertain atomic submission. The kernel owns replay validation,
atomicity, constraints, audit, and rollback. Separate unguarded reads and writes do not
enforce a version or business precondition. Spend Review's
request-scoped idempotency key permits only one review submission. Its form action
does not retain write intents across requests: after an uncertain response, reload
the persisted decision rather than resubmit it as a new operation. Other workflows
must define their own concurrency and retry rules.

### Query limits

Filtering, sorting, counts, aggregates, and grouping execute in PostgreSQL over canonical
visible versions, optionally overlaid with an owner session through `work`. `count` returns an integer decimal string, independently of
list pagination; `countBy` returns bounded `{ value, count }` groups whose
`value` has the selected supported group field's generated read type and whose
`count` remains an integer decimal string. Inverse relation
helpers generate target-model filters; resolving ordinary relation keys uses the
target model's `get` operation.

- Default page: 50 records; maximum: 100. Maximum offset: 10,000.
- At most 20 filters and five sort fields; record UUID breaks sorting ties.
- `eq`, `ne`, comparisons, `contains` for text, and `isNull` have field-type
  checks. Structured JSON, lists, and money-rate composite query operands are
  rejected; they are not coerced to misleading scalar comparisons.
- An optional `search: { query, fields }` (1–10 declared text, list-of-text or
  alias fields) keeps records matching the shared search rule and sorts them
  best match first, ahead of `order_by`. The query must be a JSON string of at
  most 200 characters; anything else fails with `contract_validation_failed`.
  Values and query are normalized (accents stripped, lowercased, whitespace
  trimmed and collapsed) exactly as JavaScript's `normalize("NFD")`, accent
  strip, `toLowerCase()` and `/\s+/gu` do, whatever the database locale:
  `kernel_search_normalize` lowercases and finds word characters through the
  ICU root collation `und-x-icu` (so Greek, Cyrillic and other non-ASCII
  letters fold and split as in JavaScript even under the `C` locale; ICU is
  required, and Neon provides it) and collapses Unicode whitespace such as
  no-break and ideographic spaces. Values are then graded
  exact > prefix > word start > substring > fuzzy, where fuzzy means every
  query term starts a word of the value or is within an optimal string
  alignment distance (a transposition is one edit) of a word or of its
  same-length prefix: no edits under 4 characters, 1 for 4–7, 2 for 8+. It is
  plain SQL (`kernel_search_*`); generated installs use no extensions. HC
  Explore applies the same rule client-side (`apps/hc/frontend/src/explore/search-index.ts`).
- `exclude_retired: true` leaves retired lookup records out; entities have no
  retirement.
- `aggregate` accepts 0–2 group fields and 1–8 metrics: `count`,
  `count_distinct`, `sum`, `avg`, `min`, `max`, `median`, and `percentile`
  (`p` from 0 to 1). Non-count metrics require number or money-rate fields.
  Results contain `groups: [{ key: [...], metrics: [...] }]` and
  `total: { metrics: [...] }`; metric values are decimal strings or null.
  Aggregate response header: `{ as_of, units, groups, total }` (plus `other_units`
  for money bins). `units` has one entry per metric: `{ currency, period }`
  when a money metric has exactly one non-null unit among eligible rows, otherwise
  `null` (including non-money metrics and empty populations).
  Counts include rows; other metrics ignore null values. Empty `count` and
  `count_distinct` are `"0"`;
  other empty metrics are null. Reads use mainline rows at one `as_of`.
- Group fields support numbers, text, enums, booleans, dates, country, currency, and
  relations (target record identity), with null as its own group. Enum keys sort
  in declared option order for built-in and custom fields in either `group_by`
  position, with null last. Numeric keys
  use numeric equality and canonical decimal strings: `1`, `1.0`, and `1.00`
  form one group keyed by `"1"`, including custom number fields. At most 100
  result groups are allowed across both dimensions and implicit money units;
  excess groups fail with `query_rejected: group limit exceeded`.
- Numeric and money amount bins use 2–51 strictly ascending decimal-string
  edges. Intervals are left closed and right open, except the final interval
  includes its upper edge. Keys are `{ from, to }`, `"below"`, `"above"`, or null.
  Money bins require an explicit currency and period; `other_units` counts rows
  excluded because they are in another unit, not the number of distinct units.
- Money metrics append a `{ unit: { currency, period } }` key dimension for
  each distinct money metric field, in first metric occurrence order (null units
  identify absent values). Units
  never mix in a group. A money total spanning multiple units is null; use the
  separate unit groups for meaningful amounts. No conversion occurs.
- Groups sort lexicographically by the explicit grouping entries: discrete numbers
  numerically, dates chronologically, booleans false before true, text and record
  IDs by database collation, with null last. Bins sort `below`, then bins in edge
  order, then `above`, then null. For `[0,5,10]`, `[0,5)` precedes `[5,10]`.
  Appended money unit dimensions break ties deterministically by JSON key order.
- `count` and `countBy` build count metrics through the same SQL aggregate path.
  Group, bin, and metric fields participate in field authorization, and row
  grants filter before aggregation. Denied fields fail the whole query.
- At most 100 atomic writes and a 1 MiB serialized write payload.
- Shared PostgreSQL contexts use 10-second statement and five-second lock
  timeouts. Offset pages are deterministic for a stable dataset, not snapshots
  across separate concurrent requests.

## App-owned Server Actions

Apps write ordinary `"use server"` modules. Their exported async functions define
which mutations browsers may invoke. Generated data operations are server-side
capabilities; generating CRUD does not publish it as a browser endpoint.

Each action authenticates and authorizes its caller, parses its input, invokes or
composes generated data operations, and invalidates app-owned routes after
successful persistence. No action configuration file or binding adapter is needed.

### Feature ownership and the data boundary

Keep the single data-access boundary under `app/data/`. Add feature-specific
server-only read functions and mutation commands there when the feature defines
real data needs. Reads return minimal DTOs; mutation commands recheck scope and
resource authorization. Server Components call reads directly, while dedicated
`"use server"` modules validate browser input, delegate mutations, and revalidate
after successful persistence. Do not create separate backend or server code
roots, expose generic generated-operation getters, or import raw generated
operations from route and action modules.

## Verification

`mise run test:data-plane` creates and removes an isolated Asset Register database
on the local generated-app PostgreSQL server. It checks type/decimal round trips,
CRUD, clearing, replay conflicts, cyclic relations, bounded queries/aggregates,
rollback, history, and restricted-principal tenant/table denial.
Start that disposable server with `mise run app:local -- spend-review setup`, or configure
`DATA_PLANE_PROOF_DATABASE_URL` for an existing disposable PostgreSQL server.
If local setup cannot start `initdb` or `pg_ctl`, the task reports the executable
error; if either exits unsuccessfully, it reports the exit status and preserves
PostgreSQL's own output so the missing tool, data directory, permission, or
startup failure can be fixed before retrying.
The task sends server output to `.scratch/generated-app-postgres/server.log`,
which lets the local PostgreSQL process continue running after the setup
command exits and retains startup diagnostics for inspection.
`mise run test:data-plane` owns these generated-runtime database suites.
The Spend Review application test task runs its app suite; it does not run this
repository task. Credit database-suite CI coverage only when the run records an
actual invocation of the owning task, rather than inferring it from a passing
application job or dependency selection.

The release-upgrade suite compiles minimal test-owned v1/v2 schemas with the
current compiler and supplies the generated v1 artifact as v2's predecessor.
It checks atomic activation failure and retry across two tenants, retained
record identities and decoded history, and writes through the upgraded schema.
It does not establish compatibility between immutable historical app SQL bundles
and a newer shared client. Historical app releases remain unchanged. History
decoding requires the complete current protocol; withheld values remain unknown,
never empty or unchanged.

Compiler tests validate deterministic catalogs and named types. App action tests
verify explicit exports, per-invocation authorization, form validation, and
invalidation only after successful persistence. Spend Review app tests cover authenticated workflow composition and pagination.
Protected Preview acceptance proves persistence, concurrent decisions, and browser behavior. This proof does not provision providers, change
deployment routing, or migrate HC/Vendor callers.

Generated Next app TypeScript programs include both `app/**/__tests__/**` and
`e2e/**/*.ts`. Tests should use the same inferred selected-read shapes, accepted
form field tuples and errors, grouped-count unions, model-specific relations,
clearing, and version options as their owning feature. Do not replace these
contracts with broad mocks, ambient declarations, or test-only exclusions.

### TypeScript advisory baseline (2026-09-16)

This is an advisory local baseline, not a CI timing threshold. It uses TypeScript
7.0.2 on Darwin 24.6.0 arm64, with `--noEmit --incremental false
--extendedDiagnostics`; three sequential runs used the same installed workspace
and process environment. `check` and `total` report median seconds with the
three-run range; file, type, and instantiation counts were stable.

| Project                                        | Files |  Types | Instantiations |       Memory median (range) |  Check median (range) |  Total median (range) |
| ---------------------------------------------- | ----: | -----: | -------------: | --------------------------: | --------------------: | --------------------: |
| `packages/generated-app-runtime/tsconfig.json` |   295 | 39,300 |         53,702 | 115,639K (115,632–115,641K) | 0.069s (0.068–0.074s) | 0.111s (0.109–0.114s) |
| `apps/spend-review/tsconfig.json`              |   916 | 49,193 |         66,552 | 217,237K (217,208–217,261K) | 0.090s (0.086–0.105s) | 0.167s (0.161–0.181s) |

Use the named repository task to print diagnostics for one project. To reproduce
the three-run advisory measurement above, the caller runs the task three times;
no timing threshold is enforced:

```sh
mise run check:types-diagnostics -- packages/generated-app-runtime/tsconfig.json
```

## Form errors

- Form actions may return browser-safe `FormError` values for
  expected validation, conflict, constraint, not-found, or forbidden results.
  Use `import type` from `@/schema` for these types. Use
  `model.toFormError(error, { fields: ["fieldName"] })` with an exact writable
  field tuple; an undefined result is unexpected and must be rethrown. Never
  classify `Error.message` or serialize database diagnostics, IDs, values,
  paths, SQL, or constraint names.
- Use ordinary React `useActionState` in a small feature-owned client leaf for
  interactive forms. Keep authorization and persistence on the server, keep
  revalidation after successful persistence and outside error mapping catches,
  and preserve the existing atomic/idempotent operation flow.

Declared CHECK errors use compiler-owned physical table and constraint identities,
with referenced fields derived from the typed constraint expression. Each checked
release emits one immutable catalog per app and base schema version. Its bundle
binds the compiler-owned app and customer context transaction-locally before
writing the protected source. Authorized tenant installations share this definition
and retain separate tenant-scoped snapshots. A new installer prepare requires
that source for its base schema version; an empty
catalog is present and valid. Active source-less historical revisions remain
usable, but their CHECK failures stay generic database errors. Active schema
revisions retain their own catalog snapshot, including after tenant extensions;
unknown constraints remain unexpected errors. This metadata is generated
automatically and adds no app configuration.

## Transaction retries

Generated PostgreSQL transactions replay only aborted serialization failures
(SQLSTATE `40001`), preserving the same request and idempotency key. A transaction
callback must contain only database work; send notifications and other outward
effects after commit. Three immediate retries allow the kernel to reevaluate
version preconditions after a concurrent winner commits. Continuing contention
returns `serialization_retry_required`; the caller may retry the same request.
This bounds work within one request and does not limit subsequent recovery.

## Operator-selected protected Next foundation

New data foundations include a public `app/data/protected-config.ts` loader and
`proxy.ts`. Normal repository delivery publishes `<APP>_APP_BOUNDARY`, where
`<APP>` is the app ID uppercased with hyphens replaced by underscores. Its version
1 `protected-gateway-v1` value contains the exact app ID, approved public
origin/JWKS URL, and independent runtime host, port, database, role and environment.
These facts come from the protected operator's saved destination and owned storage,
not browser input or the database credential itself. The app's own
`<APP>_DATABASE_URL` stays separate. A shared Services project can therefore carry
several apps' boundaries without one selecting another app's configuration.

The generated loader selects its app-scoped key first and falls back to historical
`PLATFORM_APP_BOUNDARY` only when that key is absent. A present empty, malformed or
conflicting scoped value fails closed even if the historical value is valid.
Absence of both preserves the existing Auth path. Protected requests use public
Gateway verification and only the app's runtime PostgreSQL credential; they do not
initialize the shared Auth database client or receive its browser session cookies.
Static frontend-only generation does not allocate storage or require this data
boundary.

The protected proxy covers every route and forwards verified request facts after
checking the signed request body. `skipProxyUrlNormalize` preserves the signed
request target. The generated Next configuration reads this same public boundary
once, uses it for `skipProxyUrlNormalize`, and passes its exact
`verification.publicOrigin` to the shared `nextAppConfig` factory as
`trustedPublicOrigin`. The factory adds only that public host and explicit port
to Next's Server Action origin list when native service ingress reports an
internal host. Loading the configuration requires no app database, Auth session,
or provider credential. Without a boundary, the existing local/frontend behavior
is retained. Existing custom proxies/configuration remain app-owned; an author
must explicitly integrate this mandatory ingress before enabling protected mode.

Use `getAppSession()` for session-only rendering. For DAL reads, use
`withAppDataContext({ requiredRole }, async ({ operations }) => ...)`; its
verified read context permits only the fixed generated read entry points while
retaining fresh actor-binding locks, including an RSC refresh after a Server
Action. It denies mutation calls before invocation without consuming the nonce. For actions, validate and normalize a plain JSON
DTO, then call `withAppActionDataContext(dto, { requiredRole }, async ({ operations })
=> ...)`. Every generated mutation in that callback shares one request transaction
and the signed request nonce. Both helpers close the request pool in `finally`.
The low-level `createAppDataContext` handle requires the caller to close it.
Current actor binding and fence checks still run inside actual database transactions.
No separate backend or self-HTTP endpoint is generated.

## Working sessions

Generated operations expose `workSessions`, a typed platform client for
`kernel_work_session`. It supports create/duplicate/get/list, layout and scope
updates, pin/archive/unarchive, staging and unstaging, source discard, rules
and parameter changes, threads/messages/proposals, and human Save. Edits
(`stage`, `unstage`, `discard_source`, `discard_turn`, `update`) are
last-write-wins and include only `session_id`; the client refuses one that
names `expected_revision` or `request_id`. Every other mutation includes
`session_id`, `expected_revision` and `request_id`; create and duplicate
supply a caller-retained UUID and revision zero. Mutations
answer with the new `revision` and only what they touched (`entries`,
`removed`) or produced (`session_id`, `thread`, `message`, `proposal`, `rule`
and `overlaps`, `change_set`); only `get` returns the session. A replay answers
in the same shape from current state without repeating its effect. Reads and
retries always use the current trusted actor and current data grants.

`QueryInput.work: { sessionId }` selects the session's overlay for list, count
and aggregate reads. Its query date must equal the session's immutable `as_of`.
A session is working state, not a generated business model; incomplete form
text remains local until it parses into a typed staged value. A scenario is a
duplicated session.

A staged change uses compiler model/field IDs and tagged kernel values. The
server captures its first baseline and canonical version. Session reads mark
changed bases stale and expose the current version for explicit confirmation.
Save supplies the expected revision of the overlay the user saw and any
confirmed stale current versions; pull and dismiss likewise rely on the
expected revision. Save always writes one draft change set (an approver
publishes it through draft approval), returns its receipt and clears the
overlay. A confirmed all-gone Save clears the
overlay, performs no canonical write, and returns `change_set: null`. Agents cannot Save, even if they
claim a human source in request JSON. Under a declared policy Save is refused
without changing the overlay. Entries and proposals record trusted author
principal and kind separately from owner and source. Humans and agents change
any staged entry; an entry an agent overwrites keeps the human's value as
`replaced` for Restore, and an agent never unstages a person's entry. Rules (`WorkRule`) are
derived expressions (`DerivedExpr` with `parameter` references) for a
`value` and an optional boolean `condition`, with typed parameters.

The earlier per-record working-drafts proposal is retired. This interface adds no form editor, canvas UI, MCP tools or app
workflow.

## Atomic source identity resolution

`@autograph/generated-app-runtime/source` composes generic source identity
resolution with ordinary generated apply. `kernel_resolve_source_identities`
locks source references and canonical subjects, resolves relation references,
and returns an ordinary apply request. It creates no records or receipts.
The caller holds the same database transaction through `kernel_apply_change_set`,
which remains the sole lifecycle, authorization, audit and idempotency authority.
Resolver output is server-only and never a UI DTO. Provider normalization and
recipe/field selection remain outside the kernel.

Source identity evidence is reserved to administrator-provisioned `service`
actors. Human memberships cannot seed the source index or elevate themselves.
The resolver also supports a write-less exact replay lookup using a SHA-256
digest of the authenticated input. It verifies current scope, membership and
field/record/relation permissions before returning the saved request; ordinary
apply authorizes it again. A miss returns null without inventing a receipt.
This lets integrations retry committed deliveries without downloading expiring
URL payloads. Changed authenticated input conflicts with the prior receipt.

For a cutover from a native ingestion writer, an explicit legacy receipt lookup
may supply complete normalized writes. The resolver accepts an existing
mainline receipt only when its source, payload provenance and submitted values
match, under the current service membership and policy. It returns the receipt
identity without executing the old actor's request. An explicit same-day mode
likewise returns a prior receipt only for an unchanged complete batch; changed,
mixed, or partial batches fail. Callers that use a maintenance fence hold their
application's transaction lock until the receipt check and apply finish.

### Authenticated apps without business roles

An app may omit schema authorization and still require authenticated app access.
Its protected server data context selects explicit app admission with `role: null`;
Gateway must supply a signed positive `appAccess.fenceGeneration` for the exact app,
organization and actor. PostgreSQL checks the matching active `kernel_actor_access`
row under the restricted runtime principal on every transaction. This does not
create a business role or satisfy any declared schema policy. A request selecting
a named role still requires that role's ordinary signed grant and membership.
Activating a schema with named roles closes existing role-free database admissions
in the same transaction, including access to work-session headers. It retains their
fence tombstones, so an old grant cannot restore them. Installing an already-active
named policy reconciles admissions left by older installers. Preparing an inactive
revision does not change current admission.

The protected installer binds app admission before publishing its Auth projection,
closes Auth before database admission on removal, and reconciles both stores at the
same fence generation. Switching between named roles and role-free admission first
closes the actor's previous mode in Auth and PostgreSQL before opening the new
mode. Removal closes both modes; reconciliation cannot report success while the
previous mode remains active. A newer fence in either mode prevents an older
operation from changing access. Interrupted transitions finish that same closure
before granting, preserving the app database and its records. The owning Builder
workspace is required when existing or requested app admission is present in Auth. Stale grants cannot restore removed access; interrupted grants resume against
the same app database. Generated server foundations use app admission only when no
business role was requested or granted. App-authored operations and schema policy
continue to own which data an authenticated actor may read or change.
