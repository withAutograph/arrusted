# Principles

The root `app/` single-deployment starter is scoped separately; historical multi-app deployment rules below do not describe that starter.

## Product Center

Autograph builds data-centric software -- operational, analytics, and planning around structured domain data: imports, review, reconciliation, agent assistance, and audited writes. It should fit around systems of record, not replace them wholesale. Some early use cases include headcount planning / org design, people analytics, requisition / hiring pipeline management, and subscription -> ARR calculations.

The first app should be narrow but representative of the operational/analytics/planning bias: a few typed models, CSV import, relation lookup, mainline writes, filtered + projected reads of one model, one cross-model read, and one period comparison. Broad app-shell work waits until the substrate proves itself.

## Layer Boundaries

The [generated application implementation contract](contracts.md#generated-application-implementation-contract)
defines the accepted authority chain and the separate Local, CI, Preview, and
Production evidence predicates. Roadmap goals are planned behavior until the
named implementation and evidence exist.

**Decision:** Autograph has four layers.

1. **Kernel** is a generic PostgreSQL runtime API compiled by Rust from
   app-owned manifests. PostgreSQL owns schema installation, row-version apply,
   draft/revert mechanics, audit envelope, idempotency, provenance, and
   auth/policy enforcement. Rust owns build-time validation, lowering,
   installation, generated artifacts, migrations, and parity tests; it is not
   the target request-time authority.
2. **Libraries** are reusable accelerants. They may provide Rust helpers, TypeScript components, import scaffolds, review surfaces, generated-client helpers, and reference implementations. They may know kernel contracts. They must not know app-specific product semantics.
3. **Domain libraries** (`packages/domain-libs/`) own domain knowledge that is app-agnostic but not generic: schema definitions, seed vocabulary, structural reconciliation shape, canonical ordered field-group partitions, and the explicit ordered identity policy for each domain entity. Employee identity and field organization remain Employee concerns whether HC or Compensation consumes them. Borrowable by >=2 apps; no I/O and no app workflow. They may know kernel/library contracts; they must not know app workflows.
4. **Apps** own domain _workflow_. They compose schema and import the relevant domain identity policies unchanged, then own relation/lookup-create actions, product-specific confirmation thresholds, connectors, auth/routes, persistence, prompt guidance and overrides, integration glue, and UI composition. Reusable engines execute supplied policies without embedding domain orderings; reusable agent packages may own agent-type mechanics, tool contracts, and domain-neutral prompt scaffolding.

Treat these as if they were separate repos where each layer imports only the layers below it.

### Repository layout

**Decision:** directory names express ownership, not implementation language.

- `apps/` holds deployable, app-owned code in any language.
- `packages/kernel/` contains the distinct Rust/Postgres compiler, installer,
  verifier, migration, and parity support; it is a Cargo crate,
  but is not a peer utility package.
- `packages/domain-libs/` holds app-agnostic domain knowledge under the rules above.
- `packages/` holds every reusable unit, including Cargo-only Rust packages,
  cross-language contracts, and private platform infrastructure. A Rust package
  under `packages/` does not need a `package.json`; Cargo workspace membership
  is its build identity.

The repository has no root `crates/` directory. The consolidation maps the
Rust substrate to explicit package owners such as `packages/platform-http` and
`packages/integration-compiler`. The compiler stays a sibling of
`packages/integrations`, never a child of it: the former compiles
already-authorized app input into kernel contracts, while the latter owns only
generic frontend external-library mechanics. This path convention changes no
layering or dependency direction. New reusable Rust code follows the same
`packages/` rule; it does not recreate `crates/`.

### Compiler And Runtime Authority

**Decision:** app-owned manifests are the logical schema source, Rust is the
compiler, and PostgreSQL is the compiled execution target.

- CUE is the first external authoring frontend. Equivalent Rust fixtures remain
  available for compiler and parity tests; neither is a request-time dependency.
- Reusable TypeScript `packages/domain-libs` vocabulary enters CUE only through the
  deterministic checked `packages/domain-libs/catalog.json`; an app selects and overlays
  that vocabulary in its own CUE package. TypeScript recipes are not parallel
  persisted-schema authority.
- `packages/engines/schema-catalog` owns the generic TypeScript catalog AST,
  traversal, validation, and serialization. `packages/domain-libs` may import its types
  and expose declarative construction helpers, but must not export catalog
  compiler behavior.
- The compiler emits canonical `schema.json`, generated wire/client artifacts,
  deterministic SQL, install metadata, checksums, and drift assertions.
- Raw app-authored SQL, ORM metadata, GraphQL schemas, frontend types, and YAML
  are not schema authority.
- Generated SQL must run in Neon managed Postgres without true superuser, host
  access, C extensions, privileged hooks, or an in-database Rust runtime.
- During migration, the existing Rust runtime is the behavioral reference. An
  operation changes authority only when its SQL function passes the same
  black-box fixtures and application callers switch atomically.
- Completion means no application request path depends on the Rust kernel
  runtime. Rust remains compiler, installer, migration, and verification code.
- Apps own import policy, provider selection, target bindings, source identity,
  matching precedence and workflow even when persisted schema is compiled from
  CUE. Platform-maintained provider recipe factories may normalize supported
  provider formats; apps select those factories and bind their writable generated
  schema. Neither provider semantics nor recipe selection is lowered into kernel
  SQL. The shared runtime executes supplied recipes and authorization contracts.

### Deterministic Architecture Enforcement

**Decision:** every architecture boundary that matters in review must have a
deterministic enforcement mechanism. Prose and reviewer attention explain a
boundary but do not enforce it.

Use the smallest mechanism that owns the invariant. Prefer, in order:

1. enforcement by construction through package exports or visibility, typed or
   generated APIs, and runtime schemas at the authority boundary;
2. declarative structural enforcement through Cargo/package dependency
   metadata or ast-grep when the violation is a dependency or local syntax
   shape;
3. a focused checker for a repository-specific invariant that cannot be
   expressed clearly by construction or declaratively;
4. the central boundary scanner only for rules that genuinely require its
   repository-wide import graph or classification model.

Every architecture enforcement rule must name the allowed and forbidden edges
or states and include both positive proof and a negative fixture that
demonstrates the violation fails. Rule changes must update that proof. Existing
enforcement stays active until an equivalent replacement and its proof land
together. Changing the mechanism must never weaken a product, tenant,
authority, or security boundary.

CI gates cover observable behavior, actual repository or provider command
failures, credential and tenant isolation, approval boundaries, and security
properties. Spelling, naming, branding, product vocabulary, visual design,
style preferences, and design scores may produce useful reports, but are
advisory only and do not block merge, delivery, or app acceptance. Preserve
these findings in their reports; do not turn them into app-content admission
rules. Tests may gate behavior, credentials, tenant isolation, approval,
security, and actual command failures.

**Decision:** the kernel uses opaque `app_id`, `customer_id`, and active schema revision for scoping. These scope ids are non-empty text, not SQL identifiers. They may come from external platform ids and must not derive physical table or column names.

`app_id` is a platform-level scope. One `app_id` may host multiple mini-apps / UI surfaces (e.g., a comp-architecture surface and a people-analytics surface inside the same `apps/<platform>/`); they share kernel scope and may share models. Restricting which mini-app sees which models or change types is an app-level concern (route config, navigation, app-side authorization). The kernel does not infer mini-app scoping. RLS enforces the `(app_id, customer_id)` boundary; optional app-owned CUE authorization policies additionally compile into database-enforced model, field, and record grants. Route and navigation ownership remain app concerns.

**Decision:** multi-tenant isolation is enforced in Postgres with row-level
security on `schema_revision`, `change_set`, and every model record/version
table. The installer binds immutable login principals and capabilities to
explicit `(app_id, customer_id)` scopes. Application code still passes the
scope, but request JSON and user-settable GUCs never authorize it; generated
entrypoints verify `session_user` and RLS repeats the binding check as the final
tenant boundary.

The kernel must not hardcode specific apps, models, provider catalogs, or domain semantics. Everything else is app-owned code/config unless a contract explicitly says the kernel reads it.

Hosted integrations follow the same layer rule. Public setup is an app route
contract for authorized integration management, health, and token minting.
Provider manifests, object selection, mappings, source identity, normalization
policy and provider-to-app recipes remain app-owned. Platform-maintained shared
runtime packages may execute the transport, signature verification, exact
installation checks, lifecycle and delivery mechanics supplied with that policy,
as permitted by the optional integration handler contract. Provider semantics
and connection authority do not move into the kernel. Generated apps compose
the supported handlers through thin wiring, not arbitrary REST backends; see
[Optional App Builder / Autograph integrations](integrations/optional-app-integrations.md).
Provider objects are retrieved only when the app recipe needs them to produce
app model rows. Raw provider payloads, signed URLs, and provider secrets remain
transient and are never persisted or logged.

### Tenant connection and app-binding boundary

**Decision:** the Integrations app owns the platform control-plane record for a
tenant-owned provider connection and the authorization/routing metadata that
allows a domain app to activate it. A connection is not an app installation.
It is a tenant-scoped opaque platform identity with one provider/system
descriptor and no provider payload, credential, catalog, mapping, object
selection, recipe, or health interpretation. An app binding names the one
domain app permitted to use that connection and carries only the app-facing
routing identity and lifecycle state needed to authorize an activation.

The owning domain app creates and owns its installation/configuration after an
activation grant. It owns provider catalog entries, manifests, object/field
selection, mappings, provider ingress, sync/retry behavior, health
interpretation, matching, normalized writes, and direct apply. It must not use
an Integrations record as a substitute for app policy or permission to read
another app's data. Kernel/Postgres remains the only persisted data-plane
boundary: every canonical write stays scoped by `(app_id, customer_id)` and
enters through ordinary app-owned apply.

`packages/integrations` remains generic external-library mechanics. It cannot
own connection policy, app bindings, provider catalogs, generated app clients,
kernel DTOs, or activation-grant verification. The generic integration compiler
remains outside both kernel and provider policy: it may compile already-
authorized app input, but cannot query connection metadata or make
authorization decisions. New cross-process DTOs are generated from their
Rust/OpenAPI authority or live in `packages/contracts`; no consumer may hand-
type a mirror.

The kernel may store generic platform/workflow evidence such as agent run
records, source artifact references, or import job metadata when a contract
names that storage. That does not make the kernel aware of frontend packages,
agent framework concepts, prompts, tools, skills, or app-domain policy.

## Extraction Timing

**Decision:** extract abstractions when good engineering says so, not by reflex and not by LOC count.

Reasons to extract:

- **Substrate-shaped or lifecycle-shaped abstractions, even with one consumer.** The abstraction is forced by the system's invariants — schema, type system, kernel lifecycle, UI lifecycle (blocking vs degraded reads, dirty buffer, apply/revert mechanics) — not extrapolated from observed behavior. The shape is canonical; there is no "first consumer's accidental decisions" to lock in.
- **No-regret separation of concerns and composability.** When two responsibilities are obviously different — rendering vs orchestrating, mechanics vs policy, layout vs content — keep them in separate units. Cheap to do up front, expensive to untangle later.
- **DRYness within a single consumer.** Eliminate intra-page or intra-app duplication even when no second consumer exists. Hand-writing N columns that re-encode what the schema already declares is duplication today, regardless of future consumers.
- **Avoid parallel implementations of the same business logic within one app or domain.** Two formatters, two validators, two change_type catalogs in the same app are drift waiting to happen. Centralize.
- **App-wide domain policy.** Domain rules that apply across multiple flows in
  one app should become app-level shared code, not generic library code and not
  flow-local code. For example, HC relation policy, identity ordering,
  normalization, and lookup policy may be shared across CSV import, grid edits,
  org-chart edits, and non-agent flows while still belonging to the HC app.

Reasons to wait — defer extraction until the second consumer:

- **Behavior-shaped abstractions across consumers.** When the abstraction's shape would be informed by patterns across different consumers or domains — page layout taxonomy, slot naming, role conventions, product copy taxonomy — the first consumer's choices may be accidental. Extracting prematurely locks in the wrong shape, and the abstraction either ossifies under multi-tenancy or fights the second consumer when it arrives.
- **Product chrome rather than substrate mechanics.** Toolbar layout, sheet copy, page composition, and form ordering belong in apps. Substrate mechanics belong in libraries.

One-line version: extract schema- and lifecycle-shaped abstractions early; wait for second-consumer pressure on product-layout or behavior-shaped abstractions. Apps declare policy; libraries execute generic schema and lifecycle mechanics.

When placement is ambiguous, pause and ask. Specifically ask whether the object
is likely to be reused by another near-term flow, whether it is app-domain
policy or generic substrate mechanics, and whether keeping it flow-local would
create a parallel implementation inside the same app. Do not silently promote
uncertain behavior-shaped code into a shared package.

In-tree precedents that informed this rule:

- The AG Grid pivot deleted four modules (`schema-browser`, `record-editor`, `draft-inbox`, `activity-feed`) that were extracted from a single `apps/dev/frontend` consumer. When the consumer was wiped, the modules went with it because their shape was a single-consumer accident dressed as a contract. These were behavior-shaped extractions; they should have waited for a second consumer.
- The same pivot kept `@modules/editable-grid` and its underlying engines (`edit-buffer`, `field-value-adapter`, `field-validation`) because they are substrate-shaped: the schema declares fields, the kernel apply lifecycle exists, the substrate mechanics are canonical regardless of which app consumes them.

## Persisted Meaning

**Decision:** one active kernel path owns persisted correctness. The target is
generated PostgreSQL, installed by a Rust compiler. During migration, each
operation remains on the existing Rust/PostgreSQL path until SQL parity and
caller cutover complete atomically.

- TypeScript may compose UI, generated clients, forms, review panels, workflow layout, prompts, and non-authoritative previews.
- If a TypeScript bug can corrupt persisted business meaning, that invariant
  belongs in the app-owned manifest and must compile into PostgreSQL enforcement.
- Prompts are never correctness authority.

## Authority Boundaries

**Decision:** frontend and library helpers may preview, transform, and propose. They
do not create canonical business state.

- TypeScript engines are advisory. They can parse CSV, compile chart specs,
  derive form visibility, rank matches, and prepare review UI. The kernel apply
  path is the only authority for persisted data.
- Imports are source-artifact workflows, not a second lifecycle authority. An
  import preview/commit may store source bytes, compiled plans, and reviewed
  status for the import job, but record state still changes only through
  `apply_change_set(...)`.
- Agents are proposal/review workflows, not a second lifecycle authority. Agent
  runs may store model/tool evidence, artifacts, and reviewed plans, but those
  artifacts do not create canonical business records and cannot bypass kernel
  apply.
- SQL reads are read surfaces, not shadow models. Query results can power charts,
  tables, and saved views, but they do not define persisted schema, lifecycle,
  or write semantics.
- Saved views and composition specs may persist UI state (columns, filters,
  chart config, layout). They may not persist values that contradict the kernel's
  row-version state or bypass kernel validation.

## App Builder Ownership

**Decision:** the app is the durable product object; a conversation or build
attempt works on it, and execution capacity can be replaced. Source, app
identity, access policy, data, environments and release history retain their
owners across attempts. Continuing an app does not recreate it or implicitly
approve new resource effects.

Acknowledged private source recovery requires durable bytes and demonstrated
restoration; conversation checkpoints alone do not prove it. These are product
requirements, not claims that every recovery capability has shipped.
[The building guide](guides/building-apps-with-app-builder.md) and
[contracts](contracts.md#generated-application-implementation-contract) retain
current implementation and evidence authority.

## Deployment Authority

**Decision:** Vercel environment, deployment, domain, and provider-issued
identity state owns hosted activation. The custom authenticated Gateway owns
deployed composition. Repository Git topology does not.

In the current physical topology, applications build independently inside one
Vercel Services project. A successful
deployment atomically activates its physical Service graph; Vercel owns rollback
of that deployment. The Gateway maps the logical `microfrontends.json` catalog
to in-deployment bindings and never selects a binding through Git, aliases,
deployment listing, time/readiness election, or Production fallback.

The concrete delivery sequence is `Git push → one native Vercel Services
deployment → provider-owned atomic activation/rollback → Gateway routing →
read-only CD proof`. Vercel's native Git integration is the sole deployer.
Repository CD never deploys, promotes, aliases, rolls
back, or selects a Vercel deployment. Its `REPOSITORY_RELEASE_ENABLED` value is
template-instance safety only: active Arrusted enables its repository CD lanes,
while generated repositories remain disabled by default. This flag never gates
native Vercel delivery. Ampersand source ordering is an explicit exception for
that lane's own manifest mutation and cannot affect Vercel proof or routing.

The pinned MIT `@vercel/microfrontends` library remains mandatory for standard
configuration, validation, route matching, framework adapters, and local
development. Vercel's paid Microfrontends product, project groups, native
shared-domain router, and product fallback are prohibited by the selected cost
decision. Using the library never implies using the product.

CI may prove source and trigger repository CD, and deployed proof may retain Git metadata
for diagnosis. Deployment selection must not map a merge commit back to a pull
request, promote a pre-merge PR artifact after merge, require a branch to be up
to date, compare a proof SHA with current `main`, cancel when `main` advances,
use ancestry or commit containment as activation state, or reconstruct a
repository release graph. No merge queue is required for deployment correctness.

The target ownership model keeps app ownership on one Arrusted Git main,
independent app databases and reviewed runtime boundaries, without treating
them as current provider state or changing Gateway authority, and separates
the synthetic schema baseline from retained live environments.
`mise run check:deployment-policy` makes this durable: direct official-library
imports, the Gateway-only composition plane, and the neutral-to-private
dependency direction are checked structurally.

Provider-generic Gateway and Vercel adapter mechanics belong in the
open-sourceable neutral package. The private platform may retain only
Autograph-specific identity, entitlements, fleet mapping, secrets,
provisioning policy, receipts, and operations. Vercel is the only supported
hosting adapter today; other environments remain documented future adapters.

## Storage Authority

**Decision:** every persisted model uses typed row-version storage.

- `<model>_record` stores stable record identity and external keys.
- `<model>_version` stores full typed snapshots with effective ranges and row stage.
- `change_set` groups one atomic write, review, import commit, or revert.

Do not add another canonical value store for domain/client model state.
Platform/workflow artifacts such as uploaded files, import jobs, source
artifact metadata, saved UI configs, and agent run evidence may use separate
storage when a contract explicitly names them, but they may not become a
parallel store for model values or lifecycle state. Do not wrap the write
boundary in compatibility translators. Fallbacks, backwards compatibility,
shims, adapters, or similar compatibility layers require explicit developer
permission. Never infer that hosted stores are empty from the V0 label;
retained users, sessions, app records and audit history require verified
ownership and an explicitly approved migration/retention plan.

## Write Boundary

**Decision:** all client/domain data writes flow through one path.
`apply_change_set(...)` opens a `change_set` envelope and emits one or more
`<model>_version` rows that reference it. There is no direct field-write API,
no per-field write event, and no second envelope shape. Schema apply (DDL) is
the only other write surface and is separate from data apply.

Forms, CSV rows, connector events, and agent proposals are prepared and
validated before kernel apply. The agent-led CSV workspace stages ordinary
typed rows in one transient human-editable draft; it has no plan DSL or durable
unfinished-session authority. By the time data reaches the kernel, every flow
is shaped as `RowVersionWrite[]` carried inside an `ApplyChangeSet`.

Different workflows may have different review surfaces and may store
non-canonical workflow artifacts before commit. After review, any change to
client/domain model state must enter the same apply lifecycle. Do not add
parallel save hooks, direct import apply endpoints, agent save endpoints,
compatibility translators, or alternate data-write envelopes.

Agents in a canvas work session stage values into the session overlay through
the platform agent context; they have no apply, approval, revert or Save path.
The kernel treats a context marked as agent as an agent on every app and
refuses its canonical writes. A human reviews the staged changes and Save is
the one canonical write: staged agent work a human saves is human-disposed
and enters ordinary apply under the human's attribution.

The interactive CSV workspace's exact pending-Save recovery receipt is not a
second write path or durable import session. It retains the same request for
idempotent replay after an uncertain response. Separate universal kernel
durable-import APIs remain valid substrate for workflows that explicitly use
them.

## Lifecycle Authority

**Decision:** lifecycle has two related authorities with different jobs.

- `version.stage` tracks one row's relationship to mainline: `draft`, `mainline`, `discarded`, `reverted`.
- `change_set.status` tracks the batch/review envelope: `draft`, `mainline`, `discarded`.

They move together at draft → mainline (approval) and at draft → discarded (rejection). They **diverge on revert**: the original change_set's `status` stays `mainline` (it was, and remains historically, applied), and its `applied_at` stays set. Only its version rows transition to `stage = 'reverted'` and clear `applied_at`. The revert action is a new `status = 'mainline'` change_set with `source_kind = 'revert'` and `source_ref = <target_change_set_id>`. Reverting a revert is not supported in V0; restoring a reverted effect is a fresh ordinary write or draft. Mental model: a reverted git commit stays in history; the revert is a new commit.

Invariant: `change_set.applied_at IS NOT NULL ⇔ change_set.status = 'mainline'`. No exceptions, no conditional CHECKs.

Do not add event logs, prompt-derived status, side tables, or competing lifecycle columns as canonical state.

## Attribution Granularity

**Decision:** attribution is per-change_set, not per-field. `change_set` carries `actor_id`, `source_kind`, `source_ref`, `change_type_id`, and free-text `notes`; every version row inherits this attribution via its `change_set_id`. Optional version-row `provenance jsonb` carries per-record metadata that doesn't earn its own column.

Staged agent work in a canvas session that a human saves is human-disposed: the
Save change set is the human's, with `source_kind = 'work_session'`, and carries
no agent run id. Who staged each value stays session-level working provenance
(the entry's author and turn) and is not copied onto canonical rows.

Changes move in sets. Unless a dramatic and unexpected need arises (e.g. a flow where the same record-write must record different sources or actors per field), there should be no per-field provenance, no per-field event log, and no field-level attribution table. If such a need does appear, document it explicitly with the triggering flow before introducing a new substrate.

## Universal Capabilities

**Decision:** capabilities are universal substrate, not app-level toggles.

Audit, provenance, idempotency, generated clients, imports, draft writes, agent actions, and source artifacts are substrate capabilities. Apps configure how they use them; they do not declare whether the capability exists.

## Tests

**Decision:** tests are contract tests.

When code exists, tests must prove:

- materialized DDL exactly matches declared row-version contracts
- invalid drift fails loudly
- writes are transactional and idempotent
- generated/client-facing contracts stay aligned with stored schema revisions
- no ignored tests or dead public APIs ship

Tests must assert observable behavior, a public contract, or an externally
meaningful effect. Do not test production code by reading its source text or by
asserting the presence or absence of strings, syntax, imports, private helper
calls, or a particular implementation sequence. The only exception is an
owning static-analysis, generated-artifact freshness, or configuration-policy
checker whose stated purpose is to inspect that artifact; keep those checks in
their dedicated validation lane with a documented invariant and positive and
negative fixtures.

Platform tests own controlled application, schema and compiled-release inputs.
Do not copy a mutable generated application's source or release archives into a
platform fixture. A generated app's current roles, schema shape, workflow and
release version are app policy, not platform requirements. Compile minimal
test-owned schemas to exercise compiler, installer, authorization, rollback and
runtime behavior, preserving the real isolation and approval assertions.
App-owned tests can verify their accepted product requirements. This ownership
rule is guidance for test design, not another checker or admission gate.

Application check and test lifecycles compile the current app inputs before
exercising behavior. Do not require a previously checked release to match the
current compiler byte for byte before compilation: ordinary compiler and app
changes are expected. Compilation failures and verification of the selected
release's actual payload hashes remain authoritative. CI compiles in its
disposable checkout; it does not publish regenerated app releases or change an
approved hosted release, its hash, or its installation history. Explicit
generated-artifact freshness checks belong to their owning diagnostic lane.
