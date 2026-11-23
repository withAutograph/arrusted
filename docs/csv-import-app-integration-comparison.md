# CSV Import App Integration Comparison

Status: historical comparison from 2026-07-28. It is not current
implementation authority. The live CSV contract is
`docs/import-principles.md`. The portable product is
`packages/csv-workspace`. HC and Vendor are thin hosts of that workspace.
`packages/modules/source-import` retains intake and preview leaves only; it
is not the portable product, and `installSourceImport` is not a current
boundary. The compiler, session, and Vendor placeholder-tab architecture
described here were removed; do not rebuild them from this document. Retain
this file as evidence of the pre-workspace Vendor CSV path, not as a
contract for a second importer.

Date: 2026-07-28.

Scope: side-by-side comparison of the HC and Vendor CSV import
implementations as they existed on 2026-07-28, with candidate reusable
seams and explicit app-owned boundaries from that date.

Companion:
[CSV Import Integration Postmortem](csv-import-integration-postmortem.md).

## Purpose

HC and Vendor are now two real consumers of the import substrate. That is
enough evidence to compare their integration glue, but not enough to assume all
similar-looking code is domain-invariant.

This document answers four questions:

1. What do both apps already reuse?
2. What integration work does each app still own?
3. Which repeated mechanics are credible candidates for a narrower shared
   contract?
4. Which behavior must remain app-owned even if both apps implement it?

The governing rule remains:

> Graduate a shared seam only when the second consumer proves the same
> domain-invariant contract. Similar file names or control flow are not proof.

## Current Layering

```text
                       shared substrate
        ┌─────────────────────────────────────────┐
        │ CSV parser and profiler                 │
        │ import classification and coercion      │
        │ source-import workflow and preview UI   │
        │ editable-grid reviewed-write snapshots  │
        │ generated kernel wire/apply contracts   │
        │ Rust/Postgres kernel                     │
        └─────────────────────────────────────────┘
                    ▲                       ▲
                    │                       │
          HC app composition      Vendor app composition
             and semantics           and semantics
```

The shared substrate was intentionally write-target-agnostic at the time of
this comparison. The current shared compiler now binds an accepted plan to the
active schema and domain declarations; apps still own authenticated transport,
acceptance policy, and composition.

## Side-By-Side Capability Matrix

| Concern                   | Shared substrate                                                                                                                                  | HC implementation                                                                                                             | Vendor implementation                                                                                             | Assessment                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| File intake               | `SourceArtifactDropZone`, `SourceImportSurface`                                                                                                   | HC artifact adapter and composer copy                                                                                         | `VendorCsvImportClient` and generic CSV-profile bridge                                                            | Mechanics are shared; app copy and resource limits remain inputs                                                                  |
| CSV parsing               | `packages/engines/csv-parser`                                                                                                                     | HC artifact/runtime integration                                                                                               | Vendor compiler/runtime integration                                                                               | Already shared                                                                                                                    |
| Column profiling          | CSV profiler and `csvProfileToSourceArtifactInspection`                                                                                           | HC builds agent evidence and tool context                                                                                     | Vendor builds bounded schema-facing evidence                                                                      | Evidence envelope construction is a candidate seam                                                                                |
| Active schema binding     | Generated schema and wire contracts                                                                                                               | HC generated client, schema, field/model catalogs                                                                             | Vendor generated client plus import workflow catalog                                                              | Catalog projection pattern is repeated; allowed fields remain app-owned                                                           |
| Mapping plan              | `packages/agents/csv` owns the strict generic mapping, derivation, and operation wire                                                             | HC binds the generic plan to HC policy facts and compiler support limits                                                      | Vendor mapping plan remains a stub pending migration                                                              | Shared structural semantics are package-owned; domain policy remains app-owned                                                    |
| Plan parsing              | `packages/agents/csv` owns strict structural decoding for the generic accepted plan                                                               | HC adds domain validation after package parsing                                                                               | Vendor retains its current stub parser                                                                            | One shared decoder serves the one adopted generic wire; no parser callback framework                                              |
| Model assistance          | Agent Foundation execution plus `packages/agents/csv` planning loop, static tool contracts, and prompt scaffold                                   | HC injects domain guidance, tenant-bound tool implementations, and semantic inspection                                        | Vendor mapping prompt/runtime remains a stub pending migration                                                    | Shared mechanics stay package-owned; apps bind authenticated infrastructure and domain inputs rather than reimplementing the loop |
| Clarification             | `packages/agents/csv` owns plan coherence and projection onto Foundation clarification I/O; `useSourceImportSession` owns suspension/UI mechanics | HC supplies domain language and semantic question policy                                                                      | Vendor has not migrated to the shared protocol                                                                    | One clarification protocol; apps do not disable or redefine its mechanics                                                         |
| Deterministic compilation | Coercion, relation helpers, and import classification                                                                                             | HC compiler creates HC model previews and related records with preselected permanent UUIDs                                    | Vendor compiler creates Vendors and spend transactions                                                            | Historical state: compiler orchestration was still app-owned; superseded by the shared compiler recorded in `docs/import-principles.md` |
| Identity                  | Generic resolver executes domain-declared ordered policies                                                                                        | HC imports domain-owned policies unchanged; matching uses authored fields and permanent UUIDs, never persisted `external_key` | Name-derived Vendor external key; explicit CSV transaction source id/reference; transaction external key disabled | Entity identity order belongs to domain libraries; apps own source interpretation, acceptance, review, and composition            |
| Relation policy           | Generic coercion interface                                                                                                                        | HC lookup and relation semantics                                                                                              | Vendor creation/linkage plus unresolved chart-account behavior                                                    | Must remain app-owned                                                                                                             |
| Dates and money           | Generic field coercion primitives                                                                                                                 | HC date/money policy and clarification behavior                                                                               | Vendor transaction-date, sign, and currency policy                                                                | Primitive parsers may be shared; interpretation remains app-owned                                                                 |
| Existing-record snapshot  | Generic classification accepts evidence                                                                                                           | HC loads the records and lookups required by its compiler                                                                     | No canonical existing-record snapshot in Vendor V0; same-file maps only coalesce the current artifact             | Not a two-consumer seam yet                                                                                                       |
| Preview validation        | `WriteBoundImportPreview` validation                                                                                                              | HC plan-ready preview path                                                                                                    | Vendor compiler emits Vendor and transaction previews                                                             | Already shared                                                                                                                    |
| Preview rendering/editing | `PreviewSavePanel`, editable grid                                                                                                                 | HC-specific composer and preview presentation                                                                                 | `SourceImportSurface` with Vendor-specific composition                                                            | Shared module is working as intended                                                                                              |
| Save composition          | Editable-grid exposes locked reviewed-write snapshots                                                                                             | HC combines every model into one mainline `ApplyChangeSet` and publishes it atomically                                        | Vendor uses source-import Save and Vendor kernel client                                                           | Atomicity and envelope shape remain explicit product contracts; shared modules provide mechanics only                             |
| Write authorization       | Kernel apply contract                                                                                                                             | HC Rust model/change-type/provenance validation                                                                               | Vendor Rust permits exactly the two import model/change-type pairs                                                | Declaration/conformance mechanism is a candidate; policy values remain app-owned                                                  |
| Actor/provenance          | Generic change-set and agent-run contracts                                                                                                        | HC start/status/session routes                                                                                                | Vendor ordinary human-reviewed apply path                                                                         | Lifecycle-specific; do not collapse agent and human provenance                                                                    |
| Session persistence       | No generic owner                                                                                                                                  | HC URL-hydrated session and Rust session routes                                                                               | None for V0 stateless reviewed Save                                                                               | Not a common seam yet                                                                                                             |
| Durable preview/commit    | Dev Rust importer demonstrates the stronger lifecycle                                                                                             | HC persists import sessions and derives completion from the one committed mainline change set                                 | Explicitly not promised by Vendor V0                                                                              | Do not add HC durability semantics to generic source-import without a selected second consumer                                    |
| Authentication            | Route-zone and app authentication primitives                                                                                                      | HC route and Rust-client binding                                                                                              | Vendor authenticated mapping route and kernel client                                                              | Request-binding helpers may be shared; scope policy remains app-owned                                                             |
| Request/resource limits   | Runtime and HTTP primitives                                                                                                                       | HC-specific row, text, and evidence bounds plus one overall agent deadline; no aggregate CSV output-token/step budget         | Vendor-specific but HC-parity V0 envelope                                                                         | Typed artifact-bound helpers are candidates; model resource ceilings require product evidence                                     |
| Terminal evidence         | Kernel agent-run ledger                                                                                                                           | HC start and terminal-status flow                                                                                             | Not required for Vendor human-reviewed Save                                                                       | Lifecycle-dependent; not a universal app adapter requirement                                                                      |
| Downstream workflow       | None                                                                                                                                              | HC-specific post-import experience                                                                                            | Tenant-wide Vendor Review Queue                                                                                   | Must remain app-owned                                                                                                             |
| Product copy              | UI primitives only                                                                                                                                | HC language and model labels                                                                                                  | Vendor spend and Review Queue language                                                                            | Must remain app-owned                                                                                                             |

## Concrete Implementations

### Shared substrate

The existing shared boundary consists primarily of:

- `packages/engines/csv-parser`;
- `packages/engines/import-classification`;
- `packages/modules/source-import`; and
- `packages/modules/editable-grid`.

It correctly owns domain-invariant mechanics:

- artifact selection and hashing;
- parsing and profiling;
- clarification lifecycle;
- typed preview validation;
- issue display;
- editable preview state;
- locked reviewed-write snapshots; and
- generic kernel apply composition.

### HC

HC supplies a full agent-assisted composition through:

- `apps/hc/agent/hc-csv-import/contract.ts`;
- `apps/hc/agent/hc-csv-import/runtime.ts`;
- `apps/hc/agent/hc-csv-import/tools.ts`;
- `apps/hc/agent/hc-csv-import/prompt.ts`;
- `apps/hc/agent/hc-csv-import/run-route.ts`;
- `apps/hc/frontend/src/data-import/useHcCsvImportRun.ts`;
- `apps/hc/frontend/src/data-import/DataImportComposer.tsx`;
- the HC Rust session and validation routes.

HC is the richer orchestration reference. It includes persisted run/session
behavior, app-specific questions and tools, and HC model semantics.

### Vendor

Vendor supplies a narrower stateless reviewed-Save composition through:

- `apps/vendor/schema/import-workflow-catalog.ts`;
- `apps/vendor/schema/vendor-import-policy.json`;
- `apps/vendor/import-runtime/contract.ts`;
- `apps/vendor/import-runtime/evidence.ts`;
- `apps/vendor/import-runtime/runtime.ts`;
- `apps/vendor/import-runtime/compiler.ts`;
- `apps/vendor/app/vendor/api/import/map/route.ts`;
- `apps/vendor/frontend/src/import/VendorCsvImportClient.tsx`;
- `apps/vendor/frontend/src/import/vendor-kernel-client.ts`; and
- the Vendor Rust browser-apply policy.

Vendor intentionally omits persisted import sessions and durable preview
receipts. The mapping model proposes column targets, deterministic code builds
the preview, and a human reviews and Saves the current staged rows.

## Candidate Shared Seams

These candidates are suggested by the HC and Vendor implementations. Each still
requires an exact-diff duplication audit, positive and negative tests, and a
consumer migration before selection.

### 1. Typed app adapter for source-import

A narrow adapter could make the existing requirements explicit:

```ts
type SourceImportAppAdapter<TPlan, TCatalog, TArtifact, TPreview> = {
  catalog: TCatalog;
  inspectArtifact(artifact: TArtifact): Promise<SourceArtifactInspection>;
  runMapping(input: SourceImportMappingInput): Promise<TPlan>;
  validatePlan(plan: TPlan): readonly SourceImportIssue[];
  compile(input: SourceImportCompileInput<TPlan, TCatalog>): Promise<TPreview>;
  validatePreview(preview: TPreview): readonly SourceImportIssue[];
  limits: SourceImportLimits;
};
```

This is pseudocode with illustrative, nonexistent type names, not a selected or
landed API. A real contract must avoid:

- assuming every app uses an agent;
- assuming every app persists sessions;
- exposing kernel DTO mirrors outside generated contracts;
- encoding HC action vocabulary; and
- moving target construction or relation policy into the module.

The value is explicit integration requirements and type-driven composition, not
less app ownership.

### 2. Generated catalog projection

Both apps must narrow an active generated schema into importable models and
fields while distinguishing:

- model-mappable fields;
- compiler-owned fields;
- server/integration-owned fields;
- required targets; and
- approved change types.

A generator or neutral helper could produce the structural catalog and verify
that referenced model, field, and change-type IDs exist.

The app must still author the policy values. Generated structure must not infer
that a field is safe for model mapping merely because its wire type is
compatible.

Required proof:

- an allowed field/model/change-type combination passes;
- unsupported and server-owned fields fail;
- a stale generated catalog fails against the active schema; and
- both root and subpath consumers remain within the architecture dependency
  matrix.

### 3. Mapping evidence builder

HC and Vendor both transform CSV profiles and schema catalogs into bounded
model-facing evidence.

A reusable evidence builder could own:

- stable column ordering;
- bounded representative samples;
- total byte accounting;
- truncation markers;
- exclusion of invalid rows from inference;
- safe schema-field descriptions; and
- deterministic serialization.

Apps would provide:

- allowed target fields;
- sensitive-field policy;
- sample and byte budgets;
- domain labels; and
- any allowed derivation descriptors.

The builder must not own prompts, tool descriptions, or mapping decisions.

### 4. Structured-output runtime envelope

Both runtimes need similar non-semantic protections:

- package-owned bounded attempt mechanics where product behavior justifies them;
- one overall wall-time deadline and caller cancellation;
- abort propagation;
- provider diagnostic normalization;
- structured-output parsing;
- host/domain inspection that classifies accepted, repairable, and rejected results; and
- safe failure categories.

These mechanics belong to the reusable agent package; Foundation supplies only
the lower-level execution controls. Agent/domain-owned inputs remain:

- output schema;
- prompt;
- tools;
- repair instructions;
- clarification policy; and
- what constitutes a semantically valid plan.

The app composes the package with authenticated, tenant-scoped implementations
and maps the package result into its route/UI contract. Semantic validation and
the inspection disposition belong to the injected inspector/domain authority;
the current HC adapter's app placement does not make app composition their
target owner.

Missing provider usage metadata must not invalidate otherwise valid output.
The shared helper should represent unavailable usage explicitly rather than
smuggling it through `NaN` or another invalid numeric sentinel.

### 5. Plan/compile parity helpers

Both apps risk validating an accepted plan with one implementation and
compiling rows with another.

Candidates include shared primitives for:

- date parsing and two-digit-year normalization;
- ISO currency normalization;
- money parsing;
- source-column lookup;
- unique-target validation;
- declared derivation evaluation; and
- relation-coercion catalog construction.

The reusable unit should be the exact deterministic operation, not the app
policy that selects it. Every helper needs parity tests showing that plan
validation and row compilation interpret the same input identically.

### 6. Reviewed-write snapshot

Both apps ultimately convert editable preview entries into kernel writes. The
shared editable-grid boundary can expose a locked reviewed-write snapshot while
leaving each product to select its apply envelope.

A neutral snapshot contract may standardize:

- validation and stable write serialization;
- cancellation behavior;
- repeated-click protection; and
- commit/cancel callbacks after the owning apply operation settles.

It must not choose partitioned versus atomic Save or imply durable import
semantics. HC deliberately owns one heterogeneous mainline envelope for the
complete reviewed upload; Vendor retains its selected composition. Shared
snapshot mechanics do not make those product contracts universal.

### 7. Frontend/Rust write-policy conformance

The compiler catalog and Rust apply policy currently express related facts:
which change type may target which model and which fields it may touch.

The smallest reliable enforcement should make disagreement fail
deterministically. Options, in preferred order:

1. generate both frontend catalog and Rust declaration from one app-owned
   authority;
2. expose a typed Rust policy artifact consumed by generation; or
3. add a focused cross-file checker if construction cannot express the rule.

Required proof:

- every allowed model/change-type pair passes preview and Rust policy;
- a swapped or unknown pair fails;
- a compiler-owned or server-owned field cannot be model-mapped; and
- removing an active change type invalidates the catalog.

This mechanism would be reusable; the actual Vendor and HC policy values would
remain app-owned.

### 8. Resource-limit configuration and enforcement

Both apps bound rows, columns, source text, serialized artifacts, samples, and
model evidence. Each runtime owns one overall wall-time deadline and any
product-justified rapid-retry stop. Model token ceilings are not a shared CSV
requirement and need separate product evidence.

A typed limits contract could be shared if it:

- applies limits at the owning boundary rather than only in UI copy;
- distinguishes browser, route, model, compiler, and persisted-artifact limits;
- reports stable safe error categories; and
- supports app-specific values.

The package should not silently choose one global resource envelope.

## Boundaries That Must Remain App-Owned

The following are not graduation candidates merely because both apps implement
them:

### Mapping vocabulary and target policy

HC actions and fields do not generalize to Vendor names, transactions, or chart
accounts. Each app decides what a source column is allowed to mean.

### Prompt, tools, and clarification semantics

Agent behavior is product behavior. Generic runtime helpers may execute tools
and suspend for answers, but the app owns the tools, questions, evidence, and
acceptance criteria.

### Identity and re-import policy

Domain libraries own each entity's explicit ordered identity policy so Employee
identity is the same regardless of which app imports it. The app imports that
policy unchanged and owns source interpretation, orchestration, duplicate
handling, and review behavior. HC cross-run matching uses authored policy fields
and matched record UUIDs; it does not manufacture or consult a persistent
`external_key`. Vendor's current source-specific behavior remains separate and
does not define a universal identity contract.

### Relation and lookup policy

Whether to create a related record, block, ask a question, preserve unresolved
evidence, or defer to a Review Queue is app semantics.

### Deterministic target construction

At the time of this comparison, generic helpers only coerced or classified
values and app compilers constructed targets. This seam has since graduated:
the shared compiler constructs records from the accepted plan, active schema,
and domain identity/reconciliation declarations, while app acceptance policy
still decides which plans may reach it.

### Persisted write authorization

The kernel remains generic, while the app's Rust boundary decides which browser
or agent writes are legal for its models and change types.

### Lifecycle choice

An app chooses interactive reviewed Save or a durable preview/commit lifecycle.
The generic module must not advertise durability guarantees supplied by neither
the host nor the kernel call chain.

### Downstream product workflow and copy

HC post-import behavior and the Vendor Review Queue solve different jobs.
Navigation, success language, review policy, and recovery actions stay with the
app.

## Proposed Integration Contract

Before implementing CSV import in another app, require a short app-owned
contract with these sections:

1. **Lifecycle:** reviewed Save or durable preview/commit.
2. **Schema authority:** generated schema revision and import catalog owner.
3. **Targets:** permitted models, fields, and change types.
4. **Mapping:** plan DTO authority, allowed derivations, and clarification
   policy.
5. **Identity:** imported domain policy, authored source evidence, duplicates,
   and re-import behavior.
6. **Relations:** create, resolve, block, or defer behavior.
7. **Compiler:** deterministic target records and row-level blockers.
8. **Transport:** authenticated routes, bounded request/evidence envelopes, and
   safe diagnostics.
9. **Save policy:** actor, provenance, idempotency, atomicity/envelope shape,
   and app Rust authorization.
10. **Recovery:** retry, replace file, stale state, partial failure, and
    downstream handoff.
11. **Proof:** sanitized fixtures, negative cases, scale case, visual proof,
    persisted write test, and downstream workflow test.

This contract should exist before production UI work. It turns hidden glue into
reviewable inputs without pretending those inputs are generic.

## Conformance Suite Proposal

A reusable conformance harness should accept an app adapter plus sanitized
fixtures and prove:

### Positive cases

- a supported file is parsed and profiled;
- an accepted mapping references only declared columns and targets;
- plan validation and compilation agree;
- a valid preview passes the generated catalog;
- Save emits only approved model/change-type pairs;
- repeated unchanged submission follows the app's declared retry-safe
  idempotency behavior; and
- the app's declared downstream handoff is reachable.

### Negative cases

- oversized or over-column artifacts fail at the correct boundary;
- unknown, duplicate, mapped-and-ignored, and server-owned targets fail;
- invalid rows do not influence model evidence;
- missing or ambiguous identity blocks rather than merges records;
- unresolved relations follow the declared app policy;
- stale schema/catalog combinations fail closed;
- malformed provider output cannot reach compilation;
- missing authentication cannot load schema or invoke the model; and
- frontend preview permission cannot exceed Rust write authorization.

The harness should prove the contract. It should not snapshot every app's copy
or require identical UI composition.

## Decision Gates

Before introducing a shared adapter or helper:

1. identify the exact repeated code in HC and Vendor;
2. state the domain-invariant behavior in neutral vocabulary;
3. prove both current consumers pass;
4. prove a representative forbidden app policy cannot leak through;
5. migrate both consumers atomically or retain the existing enforcement until
   both are migrated; and
6. update `docs/import-principles.md`, `docs/frontend-architecture.md`, and the
   relevant enforcement matrix in the same change.

If the proposed contract needs HC model IDs, Vendor field IDs, app-specific
prompts, or provider names, it is not the shared seam.

## Recommended Next Slice

Do not begin with a universal adapter implementation.

Begin with a read-only duplication audit covering:

- schema-to-import-catalog projection;
- bounded mapping evidence construction;
- structured-output runtime guards;
- plan/compile parity helpers;
- reviewed-Save retry behavior and aggregation; and
- frontend/Rust model/change-type declarations.

For each area, record exact duplicated functions, differences, ownership, and
the smallest neutral contract. Select only candidates where both consumers can
adopt the same contract without compatibility shims or app vocabulary in the
shared package.

The likely highest-value first implementation is frontend/Rust write-policy
conformance because disagreement creates a concrete correctness and security
failure. Mapping evidence and structured-output guards are promising follow-up
candidates. Persisted session lifecycle is not ready to graduate because
Vendor intentionally does not implement it.
