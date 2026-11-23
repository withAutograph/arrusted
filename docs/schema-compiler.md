# SQL Schema Compiler And Generated Runtime

## Single-app build and field identity

The strip-down starter compiles every `app/schema/*.cue` file with
`bun app/scripts/compile.ts`. It reuses the compiler and release generator to
write the complete verified release under `app/.generated/release`; these are
build outputs, not committed release history. Compilation needs no database.
The build version hashes the schema and compiler/kernel sources, so a core
upgrade also creates a migration candidate. `app/.generated/build.json` records
the source commit, dirty state, build hash and exact compiler binary hash outside
that release. The compiler executable is copied to `app/.generated/schema-compiler`
so migration uses the compiler that produced the candidate. Source archives
without `.git` must provide `SOURCE_COMMIT`; set `SOURCE_DIRTY=true` if that
archive includes uncommitted changes (otherwise it defaults to false). Git
checkouts record their actual dirty state.

Default inputs also include the existing domain catalog and CUE selection
contracts. Additional schema files can extend the manifest using those catalog
models; the build does not create another migration system. For example, select
an employee name field using its library type and label:

```cue
// In app/schema/app.cue, include this model alongside Note.
// domain_catalog is loaded from packages/domain-libs/catalog.json.
domain_catalog: #DomainCatalog
_employee: domain_catalog.models.employee
// {id: "employee", kind: _employee.kind, label: _employee.label,
//  fields: [{id: "name", label: _employee.fields.name.label,
//            type: _employee.fields.name.type, required: true}]}
```

Required field additions and optional-to-required changes on existing models
are refused; add an optional field instead. Existing model storage kinds also
cannot change. Historical pre-rework session/settings schemas are unsupported
and fail before installation; their tables and data are preserved. No reset
block or obsolete-signature deletion is emitted.

A field's `id` is its permanent storage identity. Change `label` for display
text. To rename its generated API property, use `name` and retain earlier public
names in `aliases`:

```cue
{id: "title", name: "heading", aliases: ["subject"], label: "Heading", type: "text"}
```

Here `heading` is writable; `title` (the original ID-derived property) and
`subject` are read-only aliases of the same stored value. Alias descriptors have
`aliasOf` pointing to the primary property, allowing UI consumers to hide them.
The transition planner refuses removal of a previous public name unless it
remains an alias. Changing a persisted field's type is always refused with a
suggestion to add a new field and explicitly copy data. Deploy-time callers
must validate against every retained historical compiled artifact, including
artifacts preceding field retirement, to protect later reintroduction.

## Status And Authority

The SQL schema compiler is implemented and has generated PostgreSQL behavioral
parity with the current kernel test contract. HC and Vendor production request
paths use hash-pinned generated PostgreSQL operations; request-time Rust facade
dispatch is prohibited. HC and Vendor retain checked, immutable release
bundles; the protected operator owns approved installation through direct
initializer connections. Generated tenant administration and generic lookup
activation are active, and the exact artifacts have completed the isolated
managed-Neon rehearsal. That rehearsal does not establish that the selected
release is installed in current Production; operator readback and tenant
readiness are separate evidence.

The durable authority chain is:

```text
app-owned logical schema
        |
        v
CUE package and declarative domain catalog
        |
        v
Rust compiler, validator, planner, and artifact verifier
        |
        +--> normalized schema and app metadata
        +--> seed change-set templates
        +--> SQL artifact manifest and checksum
        +--> non-destructive transition plan
        +--> generated PostgreSQL installation/runtime bundle
        +--> parity and coverage ledgers
        |
        v
PostgreSQL runtime API
```

CUE is the target app-authoring frontend. Rust structs are the typed compiler
boundary. PostgreSQL DDL, SQL, and PL/pgSQL are generated execution artifacts;
they are not hand-authored app schema authority. In the completed design, Rust
remains build-time compiler, installer client, verifier, and parity harness but
does not enforce kernel behavior at request time.

The [contracts](contracts.md) remain authoritative for externally observable
behavior.

## Ownership Boundary

The compiler owns persisted schema and generic lifecycle mechanics:

- models, fields, field groups, relations, enum options, and change types;
- authoritative and advisory constraints through a validated expression AST;
- derived fields and inverse-relation metadata;
- idempotent seed change-set templates;
- typed schema transitions, retirements, checksums, drift checks, and activation;
- generated apply, dry-run, read, query, draft, revert, history, activity,
  agent-run, lookup, and tenant-schema APIs;
- tenant isolation, role grants, forced RLS, and result/error envelopes;
- platform working sessions, staged overlays, duplication, rules, threads and human Save.

Apps retain business and integration policy:

- provider authentication, transport, recipes, normalization, and matching;
- QuickBooks, Xero, Ramp, and other provider-specific semantics;
- workflow, prompts, presentation, and automatic lookup-creation policy;
- raw delivery capture, retention, purge, and replay evidence.

Raw SQL, in-database Rust, provider policy, and arbitrary tenant DDL are not
compiler inputs.

## Generated-app integration

Generated App Builder applications use repository-owned validation commands:

```sh
mise run app:check <app-id>
mise run app:test <app-id> <shard>
```

Both commands run `app:compile` first. It is the only supported application
build integration for the compiler: it resolves the app descriptor, invokes the
Rust compiler as a platform implementation detail, and writes the complete
checked release to `apps/<app-id>/schema/release/`. It is a no-op for static
apps. `app:check` then runs the normal application check and build commands.
The generated app uses the resulting typed operation and Server Action boundary;
it never invokes Cargo directly at application build time.

The generated-app contract requires `backend.kind = "compiled-postgres"` and
`api.kind = "generated-operations"`. Generated apps cannot declare Rust
services, Cargo or Rust entrypoints, build hooks,
deployment-specific build commands, raw SQL, or direct database inputs. Rust
remains the platform compiler and verifier, not a generated app runtime. HC and
Vendor Rust services are compatibility/product surfaces outside the generated
template and must not be copied into new apps.

App-owned Next.js Route Handlers can expose protocol endpoints and provider
callbacks inside the app's registered route topology. They authenticate and
authorize the caller and invoke the same server-only application operations
used by Server Actions. The generated data boundary still owns persistence
and authorization. An MCP endpoint also needs an app-owned protocol and
session implementation. The schema compiler does not supply an MCP server.

The supported manifest vocabulary below is current compiler behavior. Typed
unknown members fail CUE/JSON compilation, and supported members must appear in
the normalized schema, compiler extras, or app client metadata. `connectors`
and `agents` are opaque app-owned client metadata, preserved with a required
app `label`; they do not generate integrations or agents. The exact evidence
predicates for Local, CI, Preview, and Production are in
[contracts](contracts.md#evidence-classes). This compiler's tests and artifact
checks establish local/CI evidence only; hosted claims require separate
provider read-back and exercised delivery.

Release artifacts are checked in so source, compiler metadata, transition
inputs, and checksums are reviewable and reproducible. The app owns only its
CUE source and product policy inputs; the platform owns artifact naming,
transition planning, checksum verification, installation, and activation.

## Authoring Inputs

The base CUE definitions are
[`packages/schema-compiler/cue/app-manifest.cue`](../packages/schema-compiler/cue/app-manifest.cue) and
[`packages/schema-compiler/cue/app-selection.cue`](../packages/schema-compiler/cue/app-selection.cue). A manifest can
declare local models directly or select ordered models and fields from the
checked [`packages/domain-libs/catalog.json`](../packages/domain-libs/catalog.json). The catalog
is generated deterministically as part of `mise run schema:compile`, and
reusable domain libraries
contain vocabulary rather than compiler policy.

The manifest compiler supports:

- entity and lookup models with immutable IDs and mutable labels;
- text, number, bool, date, datetime, relation, text-list, aliases, JSON, enum,
  ISO country, ISO currency, and money-rate fields;
- required and unique fields, scalar and many relations, inverse relations,
  cyclic relations, and field groups;
- typed custom-field definitions and bounded record metadata;
- enum option IDs, labels, aliases, lifecycle, ownership, and revisions;
- boolean, presence, count/cardinality, comparison, literal-set, field-set,
  and literal text-prefix constraint expressions;
- root-level cross-record `non_overlapping_intervals` constraints, enforced by
  generated mainline apply, draft approval, revert, and installer readiness
  rather than a row CHECK (see [contracts](contracts.md#authoring-and-compilation));
- typed derived expressions, evaluated at read time by the generated runtime,
  including comparisons, `if`, `min`/`max`/`clamp` and authorized
  `relation_field` lookups (`inverse_aggregate`, and `parameter` outside
  working-session rules, are rejected with `unsupported_derived_expression`);
- mainline seed change sets with stable identities, audit metadata,
  idempotency keys, and ordered writes.

For example, an administrator can require purchase-order codes to start with
the literal namespace `PO-` by declaring an authoritative constraint with
`expression: {type: "text_starts_with", field: "code", value: "PO-"}` on a text
field. The check is case-sensitive and treats `%` and `_` as ordinary characters,
not patterns. A missing field, non-text field, empty prefix, extra SQL property,
or unknown expression type fails compilation. The generated PostgreSQL check
enforces writes for both entity and lookup models; generated operation metadata
includes the referenced field ID. This expression does not authorize arbitrary
SQL or change the existing advisory-constraint coverage classification.

[`apps/vendor/schema/vendor.cue`](../apps/vendor/schema/vendor.cue) is the first
complete app-owned CUE package. It composes reusable catalog vocabulary with an
app-local transaction model and emits the persisted schema, seed templates,
Vendor import policy, and coverage report as separate checked outputs. Import
policy is validated beside the schema but never lowered into the kernel.

HC emits [`apps/hc/schema/hc-schema.json`](../apps/hc/schema/hc-schema.json)
from its app-owned [`hc.cue`](../apps/hc/schema/hc.cue) selection package and
the checked domain catalog. Its lookup seeds are normalized compiler
`seed_change_sets`; the Rust app adapts those templates for its existing
materialization path.

## Compiler Interface

`schema-compiler` accepts one or more CUE or JSON inputs. JSON inputs are
imported into CUE before the selected expression is exported and normalized.
The supported output modes are:

| Mode                        | Output                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| default                     | normalized `CompiledManifest` with kernel `Schema` and compiler-only extras                   |
| `--data-plane`              | generated operation catalog, typed TypeScript bindings, and reference documentation           |
| `--app-artifact`            | schema, optional generated app metadata, and normalized extras                                |
| `--sql-manifest`            | ordered SQL artifacts, capability coverage, retirements, source checksum, and bundle checksum |
| `--sql-bundle`              | deterministic executable PostgreSQL bundle                                                    |
| `--raw --expression <name>` | a non-kernel sibling CUE output such as import policy or coverage                             |

For example:

```sh
mise exec -- cargo run --quiet -p schema-compiler -- \
  --app-artifact packages/schema-compiler/cue/app-manifest.cue docs/examples/schema-compiler/company.cue

mise exec -- cargo run --quiet -p schema-compiler -- \
  --sql-manifest packages/schema-compiler/cue/app-manifest.cue docs/examples/schema-compiler/company.cue

mise exec -- cargo run --quiet -p schema-compiler -- \
  --sql-bundle packages/schema-compiler/cue/app-manifest.cue docs/examples/schema-compiler/company.cue
```

Transition planning is also exposed as the Rust API
`compile_sql_materialization_plan(previous, next)`. It validates both schemas,
rejects unsupported type changes, records retired logical elements, and emits
the deterministic artifact plan. The CLI accepts `--compiled-artifact` for a
previously normalized app artifact and `--sql-transition-plan` with an optional
`--previous-compiled-artifact`; its existing CUE/stdout modes remain unchanged.
`--schema-transition-contract` accepts the current normalized artifact and its
checked predecessors (including checked historical artifacts while a deployed
cutover still needs them), then emits the exact schema snapshots that a
generated installer may advance from. It is compiler output, not an application
hook.

## Generated Artifacts

The normalized app artifact contains the kernel `Schema` plus compiler-only
metadata that cannot be represented as ordinary stored fields: constraints,
inverse and many relations, derived fields, field/model metadata, and seed
templates. The SQL artifact manifest contains ordered objects and a checksum
over the normalized source, coverage declarations, retirements, and SQL.

Generated SQL includes:

- shared change-set, revision, identity, lookup, tenant-schema, principal, and
  installer substrate;
- typed entity record/version tables and generic lookup storage/projections;
- checks, foreign keys, indexes, forced RLS, canonical policies, and grants;
- version-aware runtime functions and stable public wrappers;
- installer preparation, readiness, drift, activation, and rollback controls.

The bundle is the supported installation unit. It is transactional for its
schema objects and reconciles recognized compiler-owned catalog revisions,
including the validation state of generated constraints, before validating the
resulting catalog. Replaying an already activated revision is
idempotent when its immutable release inputs match; its pre-activation expected
hash and invocation provenance are not reinterpreted as mutable revision
identity. Multi-transaction work such as bounded backfill and concurrent index
construction is coordinated through the compiler-owned phase ledger and
activated only after readiness and expected-hash compare-and-swap checks
succeed.

Generated plans never emit `DROP TABLE`, `DROP COLUMN`, or destructive enum
cleanup. Removed identities are retired and hidden while physical data and
history remain available to the revision that owns them. Type changes require
a typed migration path.

Native tenant activation registers generic lookup authority when neither legacy
typed records nor typed versions exist for that app/customer/model. Empty
legacy tables and rows belonging only to another tenant do not imply typed
authority. Existing authority conflicts remain unchanged, and selected-tenant
typed history still requires the normal migration path. This rule prevents new
missing-authority installations.

For an already-active installation missing lookup authority, generated lookup
preparation can restore generic authority only when the immutable active schema
and installer hashes agree, scoped typed history is empty, and every generic
record and version is accounted for by the installation's applied seed ledger.
Seed identities, template fingerprints, ordered reserved record IDs, idempotency
keys and mainline change-set revision bindings must agree, with exact record and
version coverage. Recovery takes nonwaiting database locks while checking these facts and
inserts only missing generic authority using the recorded first applied-write
time; contention returns a recoverable `lookup_recovery_busy` result without
adopting authority. It never fabricates typed authority or rewrites records, versions or
projections. Missing or skipped receipts, extra unseeded history, conflicting
authority, stale installations and mixed typed history retain the forward-only
failure. This runs during lookup preparation, before callers replay installer
activation; unrelated generic history still requires explicit reconciliation.

### Runtime release observability

`kernel_read_runtime_release_observability({"app_id", "customer_id"})` is the
generated runtime's capability-scoped, read-only release snapshot. It reports
only the requested tenant's immutable artifact hashes, active/base/effective
revision identity, preparation ledger and backfill phase counts recorded at
readiness, current tenant activation-lock waiters, expected-versus-active
activation CAS comparison, stored logical-schema checksum comparison, and the
forward-recovery posture of each prepared release. A runtime caller receives
no table privileges and the entrypoint does not acquire locks or invoke
preparation, validation, repair, or activation.

`would_conflict` is a comparison at snapshot time, not evidence that an
activation attempt failed. Phase results are committed at readiness; a
preparing release can have external resumable work whose partial progress is
not in this ledger. `drift_reconciliation.status = not_measured_by_snapshot`
means this read did not run catalog validation. The stored-schema checksum
detects a mismatch in the persisted logical schema, not physical table drift.
Installer error receipts and catalog validation remain the sources for actual
CAS failure and physical drift diagnosis.

The response is diagnostic evidence, not release authority. Providers and the
installer retain the only activation path; a `conflict`, `mismatch`, or
`resume_preparation` signal must be resolved through that existing controlled
path rather than by monitoring.

## Checked Release Packages

`mise run schema:compile` is the repository-owned entrypoint that regenerates
every app schema artifact and the complete release package for each current
app-owned revision. `mise run schema:release -- compile` regenerates only the
release packages; `mise run schema:release -- check` verifies them without
writing. CI reaches the same verification through `mise run schema:check`.

Compilation still runs every generation phase and validates the complete staged
package. Before installation, an existing checked package that verifies against
the selected app source is retained when its complete normalized app artifact and
server adapter bytes match the newly generated package. Compiler-emitted SQL or
transition changes alone do not rewrite that issued package. All of its members
and provenance stay unchanged; only the mutable schema index and Rust pointers
are refreshed. New or changed app artifacts or server adapters follow the normal
generation and installation path, including adding or removing the Next.js
server-only boundary.
The explicit release `check` command continues to compare current compiler output;
retaining an issued package does not claim that regenerated SQL is identical.
For an integrity-verified plan issued by older schema tooling, check can re-prove
the frozen plan with the historical oldest-first predecessor rule. Only that
plan and its manifest hash are accepted in place of current output; other
generated members remain checked. Newly generated plans use the corrected
selection, and an explicit external predecessor never uses this compatibility path.

Each package is checked at
`apps/<app>/schema/release/<schema-version>/` and contains exactly:

- `app-artifact.json`: normalized schema, client metadata, and compiler extras;
- `sql-manifest.json` and `sql-bundle.sql`: the ordered artifact manifest and
  executable installation unit;
- `transition-plan.json`: the non-destructive plan, using the most recent
  checked app artifact strictly before the target release when one exists.
  Local cuts are ordered by leading date, then trailing numeric `vN`, then
  name. Retained newer releases never become an older target's plan predecessor;
- `transition-contract.json`: the compiler-owned, exact predecessor-schema
  closure that the generated installer must validate before activation. It
  retains all historical artifact inputs, including retained newer releases;
- `runtime-coverage.json` and `cue-to-sql-source-map.json`: coverage evidence
  and deterministic compiler-input-to-generated-SQL object mappings. Source-map
  entries name the owning CUE model, field, constraint expression, or migration
  version rather than copying SQL text; and
- `release-manifest.json`: compiler/format versions, source hashes, schema,
  transition-plan, transition-contract, bundle, client, coverage, SQL-manifest,
  and source-map hashes; and
- `operation-manifest.json`, `data-operations.ts`, `data-server.ts`,
  and `data-operations.md`: checksummed typed data operations, server read
  boundaries, and their operation reference. The operation manifest also
  records CUE-known static model, field, enum-option, change-type, and
  constraint IDs. The generated TypeScript exports these as literal `ids`,
  plus branded runtime IDs, tagged-value helpers, typed data-query and
  schema-admin request builders, and result/error envelope types. Builders
  only construct JSON; PostgreSQL validates requests under its runtime or
  schema-admin capability. Generated reference examples use the same manifest.
  Compiler generation fails on an unclassified field type rather than silently
  weakening the client contract.

The installer consumes `sql-bundle.sql` and the checksummed generated
transition contract, and binds activation to
`release-manifest.json.installer.expected_hash` (the SQL manifest checksum),
with `source_hash` retained for provenance. It must compare that expected hash
at prepare/activation time; callers must not substitute an app-authored SQL
file. Model inputs are CUE or normalized compiler artifacts. Browser mutations
are ordinary app-owned Server Actions outside the generated release.
The package verifier fails on a missing, stale, or unexpected checked member.
The compiler owns this package layout and SQL; apps own only their declarative
schema inputs and consume the resulting immutable release.
The repository release check also regenerates each package. A change to the
repository release script alone may change its recorded source hash without
changing an app's release. In that case the check retains the frozen package
only when its checked hashes verify, every other generated member matches, and
the source map and release manifest differ solely in that script hash and its
derived source hashes. Changes to authored inputs, SQL, transitions, or source
mapping still require a new checked release.

Trusted runtime and installer tooling resolves stable diagnostic codes through
the checked source map to a CUE origin. This produces an operator-facing code
plus `{source, path, kind}` and deliberately excludes PostgreSQL messages,
constraint names, table names, and SQL text. Browser-facing form errors remain
the separate fixed-message contract and never consume this diagnostic surface.

The compiler also maintains `apps/<app>/schema/index.ts`, a one-line static
re-export of the current release's server bindings. Shared application types
are exported inside that release `data-server.ts`. The index is the mutable
pointer outside the immutable bundle; the release `data-server.ts` remains
guarded and immutable. Compile updates the index; check validates its exact
content and the unique verified release matching the current CUE source. App
feature imports therefore remain stable across schema releases. Next apps keep
the server-only guard; other frameworks retain the neutral export.

## Runtime API

The generated public API uses `kernel_*` functions and JSON request/result
contracts derived from Rust wire metadata. Major operation families are:

- schema state, installer preparation/readiness/activation, drift, and repair;
- single and transactional apply, lookup-or-create, and defaults-once seeds;
- single and atomic batch dry-run;
- visible collection, keyed, model-filtered, text-filtered, locking, and safe
  query reads;
- draft list/read/notes/approve/discard and revert;
- diff, field history, recent activity, and advisory diagnostics;
- agent-run record and status update;
- lookup list, exact batch resolution, hydration, reference counts, lifecycle,
  alias transfer, and typed-to-generic migration;
- tenant schema dry-run/commit for models, fields, enum options, and custom
  fields.

`SchemaRevisionId` is a signed PostgreSQL `bigint`; public JSON and generated
TypeScript represent it as a decimal string so optimistic-concurrency tokens
remain exact beyond JavaScript's safe-integer range. Generated SQL results may
remain numeric internally while the Rust boundary accepts them and serializes
the public string form.

Applications call generated wrappers, never substrate tables. Runtime roles do
not receive direct table or sequence DML. Definer helpers use fixed compiler
search paths, authorize immutable principal-to-tenant bindings, pin schema
hashes, and execute under forced RLS.

The machine-readable operation ledger is
[`sql-runtime-parity-coverage.json`](../packages/schema-compiler/tests/fixtures/sql-runtime-parity-coverage.json).
It currently classifies all 34 Rust facade operations: 20 exact replacements,
8 generated-client protocol replacements, 3 non-destructive retirement
replacements, and 3 typed-activation replacements. All are at behavioral
parity. The more detailed test inventory covers 291 kernel tests: 251 map to a
generated SQL counterpart and 40 remain compiler, client, shared-wire,
identifier, installer, or retired-Rust mechanics. The checked coverage test
derives the inventory from current source tests and guards this documented
baseline, so a count change cannot silently leave the canonical docs stale.

## Integrated Features

| Feature                        | Compiler/SQL status                                                                                                                                  | Application status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor schema and seeds        | CUE-authored and compiled; current Vendor schema passes generated SQL parity                                                                         | The protected operator applies the checked Vendor release over the direct initializer connection; installer preparation, readiness, activation, and defaults-once seed staging are the materialization authority. Rust supplies the immutable artifact and retains only bounded legacy-transition cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| HC schema and constraints      | CUE-authored schema, constraints, lookup seeds, and generated artifacts pass generated SQL parity                                                    | The protected operator applies the checked HC release as the production installation and seed authority. During an entity-to-generic-lookup transition, the exact bundle may leave only lookup-target foreign keys unvalidated while generated prepare/validate/activate and defaults-once writes establish their targets; replaying the same immutable bundle then validates them. Before the first generic write, each replay establishes typed authority, then re-proves and, when needed, reconciles the retained fail-closed typed shadow before migration phases. Generated repair restores value-free retained relation identities and validates their physical foreign keys in the same transaction. After the first generic write, generic authority remains forward-only, except it may restore an absent typed-source record identity with `ON CONFLICT DO NOTHING` to preserve a physical foreign key without overwriting generic data. Fresh activation declares generic lookup authority from the active declarative schema, while typed predecessors remain fail-closed until the generated migration activates them. Local CLI setup and test fixtures can exercise the same path; native build hooks do not install schemas. Rust retains only immutable bundle orchestration, app-owned operational-table setup, and test fixtures; it authors no schema, seed, migration, or backfill SQL. |
| Enums                          | Typed text values with revision-pinned option identity, aliases, lifecycle, audit labels, and tenant mutation                                        | Generated tenant API and the HC administration experience are the sole authority; the application does not interpret tenant DDL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Lookups                        | Generic model-qualified storage, typed projections, aliases, search, hydration, reference counts, lifecycle, migration, and million-row keyset proof | HC and Vendor use the generated API; retained typed tables are inaccessible retired evidence, not a read or write fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Custom fields                  | Typed definitions, opt-in entity and lookup models, clear semantics, revisions, validation, and historical snapshots                                            | Generated clients and tenant administration own the runtime path; applications retain only authentication, capability, and presentation policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Record metadata                | Bounded object snapshots with explicit set/remove/clear semantics                                                                                    | Generated runtime owns persistence and validation; application workflows remain consumers of its stable API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Constraints and derived fields | Compiler-owned AST and generated SQL enforcement/read expressions; derived fields lower to read-only derived custom fields that tenants can also author at runtime, and queries may declare per-request computed columns; compiler, SQL and the TypeScript evaluator agree on shared parity cases | HC `org_assignment` constraints and Vendor schema compile in parity fixtures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Runtime lifecycle              | Apply, dry-run, reads, safe query, drafts, revert, audit, transactions, locking, idempotency, same-day ordering, and agent runs                      | HC and Vendor production request paths use hash-pinned generated PostgreSQL operations; request-time Rust facade dispatch is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Installation and security      | Deterministic bundle, checksums, drift, phase ledger, activation CAS, grants, and forced RLS                                                         | HC and Vendor independently install checked immutable bundles through direct initializer connections; managed-Neon rehearsal and Production materialization are complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Temporary Compatibility Register

This register records retired migration paths. They must not be reintroduced,
copied into the final SQL API, or treated as extension points.

| Temporary path                    | Why it exists                                                                                            | Generated replacement                                                            | Removal condition                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Per-operation Rust facade callers | Retired after endpoint cutover                                                                           | Hash-pinned generated functions and clients                                      | Enforced permanently: application request paths must not import or dispatch through the Rust facade          |
| Root `kernel/` directory          | Historical compiler, installer client, artifact verifier, migration tooling, and parity harness location | `packages/kernel/`, generated PostgreSQL functions, and compiler-owned contracts | Removed; `packages/kernel/` is not a request-time runtime and must not regain application endpoint authority |
| Root `domain-libs/` directory     | Historical location for the reusable vocabulary packages before the approved Turborepo layout            | `packages/domain-libs/` with unchanged package identities and catalog semantics  | Removed; the root-layout gate rejects the former root directory                                              |

There is no generated policy-repair endpoint, compatibility translator, dual
write, or fallback runtime. A failed cutover leaves the old authority active;
after activation, correction is forward-only through the new authority.

## Verification

The compiler tests run without a database:

```sh
mise exec -- cargo test --locked -p schema-compiler
```

The required live suite discovers every `sql_parity_*` and `sql_runtime_*` target
and rejects a missing database, unreachable database, or fixture-level skip.
Runtime fixtures include installer, lookup, seed, and PostgreSQL 17 behavior:

```sh
KERNEL_TEST_DATABASE_URL=postgresql://... mise run schema:test-parity
mise run schema:test-parity-runner
```

CI runs the generated parity suite against PostgreSQL 17. The isolated
managed-Neon installation, activation, interruption/resume, rollback, tenant
isolation, audit, latency/lock, and forward-recovery rehearsal is a completed
release receipt; future releases must repeat the same proof for their exact
immutable artifacts.

Any new kernel facade operation, schema type, wire error, or behavior test must
add or update a coverage-ledger entry and a generated counterpart before it can
land. Unsupported constructs fail compilation; they are not silently omitted.

## Landing Steps

1. Add one release packaging entrypoint that writes and verifies the normalized
   app artifact, SQL manifest, SQL bundle, transition plan, coverage ledger, and
   source map together. Checked output drift must fail CI.
2. Convert HC authoring and lookup seeds to the CUE compiler contract, preserving
   exact model/field order, constraints, values, and generated clients.
3. Rebase the compiler branch on current `origin/main`, regenerate all artifacts,
   and classify every newly added kernel/schema behavior before review.
4. Run compiler tests, the fail-closed runner test, PostgreSQL 17 generated SQL
   parity, HC/Vendor materialization suites, application checks, and repository
   checks from repository-owned mise tasks.
5. Complete adversarial code/security review of generated SQL, definer grants,
   identifier quoting, RLS, drift reconciliation, and non-destructive plans.
6. Land the compiler, docs, checked artifacts, and parity gates without changing
   production runtime authority in the merge itself.

## Full Integration Steps

1. Rehearse the installed HC and Vendor generated bundles on isolated managed
   Neon branches, including expected hashes, phase-ledger resume, grants, and drift.
2. Cut over each application operation family in dependency order: schema state,
   apply/transactions/dry-run, reads/query, drafts/revert, then audit/agent runs.
   Every endpoint has exactly one authority.
3. Migrate typed lookup history into generic storage, validate model-qualified
   relation projections, and atomically switch lookup authority by schema hash.
4. Ship schema-driven administration for tenant-managed enum labels/options,
   lookup definitions/rows/aliases, custom-field definitions, and retirement or
   restoration.
5. Rehearse installation, activation, interruption/resume, rollback, tenant
   isolation, and application smoke flows on an isolated managed-Neon branch.
6. Activate one app revision at a time, observe the hash-pinned runtime, and
   forward-correct any post-activation failure without dual writes.
7. Remove remaining request-time Rust kernel code and enforce compile-time and
   CI boundaries against facade imports or direct substrate access.

## Future Improvements

- Generate richer TypeScript helpers and documentation from the same app
  artifact without introducing a second schema authority.
- Expose additional runtime-authored constraint forms, and the remaining
  derived-expression form (`inverse_aggregate`), only after
  adding them to the validated AST, SQL lowering, and the shared parity cases in
  `packages/contracts/__fixtures__/derived-expressions.json`.
- Add compiler diagnostics that map generated SQL objects and database errors
  directly to CUE source locations.
- Persist intermediate backfill checkpoints and installer failure receipts if
  operators need history beyond the current release snapshot and direct
  installer responses.
- Maintain the measured generated-runtime baseline and capacity limits with a
  managed Neon scale benchmark.
- No retention authority exists for physical erasure; any future workflow
  must be separately authorized. Physical erasure remains impossible in app
  manifests and ordinary tenant-schema operations.

### Scoped seed allocation and first-install collision recovery

Seed record tables can have a global UUID primary key even though external keys
and ownership are tenant scoped. For an external-key default whose legacy
compiler UUID cannot be reserved, the shared seed runtime first checks for an
existing selected subject. Existing subjects retain their custom data. If no
selected subject exists, it reserves a deterministic UUID derived from the app,
customer, model, and original UUID, and applies the unchanged external-key write
through the normal change-set API. The applied ledger records the allocated ID;
the immutable template fingerprint and source idempotency key stay unchanged.
Existing applied ledgers and their identities are never rewritten. Explicit
record-ID collisions return an error; the runtime does not relocate references.

A historical `skipped_existing` receipt is normally permanent. The runtime may
retry only the narrow first-install defect: its timestamp equals the original
app-base or tenant-overlay installation activation, its template fingerprint, original IDs and
idempotency key match that installation, no earlier scoped schema revision or
scoped change-set history exists, and no intended selected subject exists. Pre-batch audit history is captured
once under the normal tenant activation lock so recovered templates do not
disqualify one another within the same atomic batch.
Reservation must still reproduce an actual collision before recovery applies.
The original installation timestamp remains available during a later normal
release upgrade even when its schema revision is no longer active. This relies
on the ordinary installer activating and seeding atomically and ordinary data
writes retaining change-set history; it does not infer historical ownership from
present row absence alone. Older, mismatched, or otherwise ambiguous skips stay
unchanged. No provider database reset or manual data rewriting is involved.

## Generated application data operations

The compiler projects model-specific CRUD, structured reads, bounded declarative aggregates, grouped counts,
relations, and canonical field history from the normalized contract. Generated
Next apps use server-only reads and app-owned Server Actions by
default. Durable writes remain `kernel_apply_change_set` calls; the generated
`kernel_data_query` entrypoint performs bounded structured queries over canonical
visible row versions in PostgreSQL. Counts and grouped counts use the same
aggregate execution path as numeric and unit-separated money metrics. Aggregate
fields are authorized before execution; aggregate results never depend on list
pagination. Neither client input nor a transport can
supply arbitrary SQL or override trusted scope.

[Generated Data Operations](generated-data-operations.md) documents the interface,
release members, app-owned Server Actions, limits, and focused verification.

For an owner-bound compilation whose canonical active artifact is retained outside
the mutable checkout, set `APP_SCHEMA_TRANSITION_PREDECESSOR_FILES` to a JSON
array of absolute `app-artifact.json` paths and select one app. Normal
`app:compile` and compiler `check` inherit this input. The first artifact is the
explicit predecessor for the transition plan; every artifact contributes to the
transition contract. These inputs are excluded from mutable source provenance.
The caller must bind them to the canonical active release ID and hash before
invocation. A changed schema requires a new release version: the installer
rejects a different artifact for an already installed app/customer/version.

`mise run app:runtime installed <app> local` inspects the existing owned local
runtime checkpoint without selecting the current source release or preparing
resources. It returns each recorded tenant's actual active schema revision ID,
release ID, base artifact hash, and effective artifact hash. This receipt can
identify the canonical predecessor even when a failed preparation already
updated the checkpoint's selected plan. Missing or inaccessible installed
identity fails inspection; the command does not start a stopped database.

`mise run app:runtime resume-installed <app> local` is the mutating counterpart
for the same owned checkpoint. It starts only the PostgreSQL cluster recorded
there, after confirming its existing data directory and `PG_VERSION`, then
returns the same installed identity receipt. It never initializes, replaces,
or resets a cluster. `installed` remains read-only.

## Platform working-state runtime

The compiler installs `work_session` and `work_session_record` alongside history
and change sets for every generated app. Session metadata, rules and threads are
owner-private JSON on the session row. Each staged entry is one
`work_session_record` row per (model, record, field) with its provenance;
mutations insert, update or delete only the rows they touch, under the session
revision guard. A scenario is a duplicated session.
Historical fork-shaped session layouts and the removed per-app settings layout
are no longer upgraded automatically. Installation detects those shapes in the
installation schema and fails with `legacy_schema_upgrade_unsupported` before
changing them. Empty, populated, RLS-hidden, and concurrently written legacy
state is retained. The compiler emits no legacy table reset or obsolete
function-signature deletion; supported current layouts reinstall idempotently.

It is independent of app CUE models and canonical version history. The generated
`workSessions` binding invokes `kernel_work_session`; helpers also expose its
wire request builder. Mutations use expected revisions and replay-safe request
IDs. Save is restricted by administrator-bound human actor classification and
always composes one ordinary canonical apply in draft mode (an approver
publishes the draft); a confirmed all-gone Save instead clears the overlay
without a canonical write and returns `change_set: null`. Under a declared
policy Save is refused until the policy draft lifecycle is supported.

`kernel_data_query` remains the list and aggregate read entrypoint. Optional
`work: { session_id }` overlays a session before filtering and aggregation,
preserving current field and record grants. Rules are derived expressions with
parameters, evaluated by this same query (with the rule's own outputs excluded)
and lowered by the same SQL as derived fields; there is no second expression
grammar or arithmetic. There is no request-time Rust evaluator, arbitrary SQL
expression input, or app-specific staging store. See [Working sessions](contracts.md#working-sessions).
