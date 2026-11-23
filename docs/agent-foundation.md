# Agent Foundation

> **Single source of truth for the platform's agent architecture.** This document consolidates
> the foundation contract, HC implementation status, and reusable app boundary. It is a
> **clean-slate** architecture: no runtime fallbacks or preservation of drifted past
> implementations. Additive wire readers may retain explicitly documented dormant values for
> rolling-deployment compatibility. Live execution state belongs in Agent Fixes and Field
> Report; this document retains the durable architecture and current-main deviations.

---

## 0. North Star

Platform agents are **library-assisted app capabilities, not a second application lifecycle.**
The kernel is the **single write authority AND the single correctness
validator**: agents *propose* changes; the kernel *validates* them on the exact same code path
that applies them (**validate == apply**); **correctness lives only in the kernel.** A **thin,
opinionated** generic substrate provides identity/profiles, deadline/cancellation primitives, and
static runtime tool contracts. Reusable libraries may provide domain-agnostic static tools and
lifecycle/prompt scaffolding; apps select, configure, and compose those pieces while owning
domain policy, app-specific prompts/tools, semantic acceptance and repair decisions, auth/routes,
copy, and host authority. The agent **grounds in the user's current view but has full query access
to the whole app.**

Verified against Jan–Jun 2026 engineering practice: this *is* the industry-consensus
architecture (kernel-as-deterministic-gate, thin opinionated harness, just-in-time query,
propose/validate/apply, bulk with a single-threaded writer). Anthropic and Cursor **build**
exactly this way even as framework vendors **sell** otherwise. **Our job is to not drift off
it** — drift is what produced four failed attempts at the query/mutation agent.

The v1 `AgentPhase` reader retains dormant `out_of_budget` support so a newer
frontend can safely consume events from an older runtime during a rolling
deployment. Current runtimes do not emit that phase.

---

## 1. The Layered Model

Four layers; each owns **exactly one** concern.

| Layer | Owns | Must NOT |
|---|---|---|
| **Kernel** (current Rust/PostgreSQL path; target generated PostgreSQL API) | Single write authority + single correctness validator; `ApplyChangeSet` row-version writes; effective-dated change-events; relation resolution; drafts/approvals; idempotency; provenance. **validate == apply.** Each operation moves to generated SQL only after parity and caller cutover. | — |
| **Generic substrate** (`packages/agent-foundation`) | Agent identity/profile settings; deadline/cancellation primitives; provider usage facts; per-invocation tool-loop fuses; static `AgentToolDefinition` / `AgentRuntimeTool` contracts. Proposal-envelope types land with the first concrete compile/propose consumer, not ahead of it. | Contain **any** correctness/validation logic, select arbitrary product ceilings, own product-semantic orchestration, dynamically register tools, or map host evidence into a ledger DTO. |
| **Reusable libraries + app composition** | Libraries may own domain-agnostic static tools, mechanical lifecycle/prompt scaffolding, and deterministic compilers parameterized by active schema and domain declarations. Apps select and directly compose those exports, and own app policy, app-specific prompts/tools, semantic acceptance/repair decisions, auth/routes/copy, and host-specific `AgentRunLedgerEntry` mapping. | Restate kernel validation or move host/product authority into reusable scaffolding. |
| **Prompt** (thin) | Soft intent — *what* job, preferences, when to ask. | Enforce anything (prompt-as-safety is forbidden). |

### The boundary rule (load-bearing)
**Correctness lives only in the kernel.** Anything above the kernel that *restates* a
correctness check is a **defect** — this is the "doom loop": four PR-C attempts re-implemented
kernel validation (FieldValue shape, change-type rules, field existence) in the tool/route and
each drift was a new bot finding. The agent side does **shape checks only** (does it decode
into the generated contract); everything semantic is the kernel's verdict. Enforced by a
boundary lint (§7).

---

## 2. Invariants (hard rules)

1. **Single write path.** Every mutation — human or agent — compiles to `ApplyChangeSet`. No parallel write path; a tool performs **no direct write or privileged apply** — both writes *and* validation go through the same server/kernel boundary as the apply dry-run (validation is the no-write half of that one path).
2. **validate == apply.** The validation an agent's proposal passes is the *same* code the real apply runs. The "validate" affordance is a no-write dry-run of the apply validator, nothing more.
3. **Correctness only in the kernel.** No FieldValue/relation/change-type/field-existence validation outside the kernel.
4. **Propose-only; human disposes.** Agent edits stage into the *same* edit buffer human edits use; the agent cannot bypass Save.
5. **Bulk is first-class.** The proposal envelope is a *set* of writes applied atomically; single-edit is the N=1 case.
6. **Anchor + full query.** Grounding = the current view (a cheap relevance *hint*) **plus** full tenant-scoped query access to the whole app. The view is **never** a sandbox boundary.
7. **Effective-date is universal** (see §5).
8. **Provenance mandatory.** Autonomous agent writes carry `source_kind='agent'` + host-authoritative `source_ref=<run_id>`; the host records that run in the ledger before dry-run/apply. Agent-assisted CSV drafts are disposed by a human Save and therefore use ordinary human attribution plus `source_ref='csv:<filename>'`. Staged agent work in a canvas work session is likewise human-disposed: the human's Save writes it with `source_kind='work_session'` and carries no agent run id; the staging agent and turn remain session-level provenance. A proposal envelope never carries provenance authority. Run-ledger is audit-only and cannot mutate domain records.
9. **Reads tenant-scoped + read-only.** Untrusted artifacts (CSV cells, pastes, third-party data) are *data*, never instructions.
10. **Run pinned to a schema revision** — a *kernel* backstop (`StaleSchemaRevision`), **not** an agent-facing ceremony. The host supplies schema context; the CSV browser retains the reviewed revision only as part of an exact pending-Save retry, never as model authority.
11. **Static value contract.** `FieldValue` variants come from the generated contract (static), not runtime-derived per call. `custom_fields` is the single sanctioned dynamic seam.
12. **Change-types name intent, not constraints** (see §4).

---

## 2a. Current-main implementation status

**§2 describes the target architecture. This table records what is actually built versus deferred on
current `main`, so the target is not mistaken for implementation fact. Live PR and scheduling state is
deliberately excluded.**

| # | Invariant | Status | Deviation / note |
|---|---|---|---|
| 1 | Single write path | ✅ implemented | agent stages via the same `stageBulkUpdate`; the single kernel write is the grid Save |
| 2 | validate == apply | ✅ implemented | shared `run_change_set` core (#215) |
| 3 | Correctness only in kernel | ✅ on current agent paths | CSV workspace proposal checks and app guards may reject work earlier, but canonical dry-run/apply remains the correctness authority. |
| 4 | Propose-only; human disposes | ✅ implemented | stages into the human edit buffer; human Saves |
| 5 | Bulk applied in **one envelope** | ⚠️ partial across product paths | HC and Vendor CSV workspace Save submits the complete reviewed draft as one mainline `ApplyChangeSet`, so persisted apply is all-or-nothing. Agent-proposed edits staged into the ordinary non-import editable grid still use that workflow's partitioned Save path. |
| 6 | Anchor + full query; view never a boundary | ✅ implemented for read/query | `lookup_hc_records`, `get_hc_record_details`, and `analyze_hc_sql` query saved app data beyond the grid anchor, and `selectedRecordIds` is structurally answerable via `lookup_hc_records` `record_id` criteria. The run request now carries only a mounted-record id manifest; proposal staging resolves values from server-fetched saved records for those ids. `get_hc_record_details` is the one-record depth tool: current labeled values, relation labels, and bounded saved history. Cross-model edit staging remains deferred. |
| 7 | Effective-date universal | ✅ implemented for kernel writes and agent proposal paths | CSV workspace date is chosen before the run, frozen by the authenticated host, and shown read-only during review. |
| 8 | Provenance host-authoritative | ✅ implemented for the HC query/mutation route | not model-spoofable ✅; the route server-mints `runId` and rejects client ids ✅; runs are recorded before dry-run ✅; exhausted-repair/runtime-error runs mark the ledger terminal ✅; tenant binding uses Better Auth `requireTenantScope` with an explicit non-empty `customerId` claim and server-pinned `appId='hc'` ✅ |
| 9 | Reads tenant-scoped + read-only | ✅ implemented | query and mutation routes use tenant-scoped server calls |
| 10 | Run pinned to schema revision | ✅ implemented | The run route resolves the active schema + `schema_revision_id` server-side and records agent runs against that revision. Stale resume/apply failures use the kernel backstop; the browser does not pass schema versions. |
| 11 | Static value contract | ✅ implemented | |
| 12 | Change-types = intent | ✅ implemented | advisory only |

Also: **§7 kernel-verdicts-as-free-evals** remains partial. Happy-path and terminal runs are
recorded, while persisted repair-verdict chains remain deferred. **§9 compaction /
tool-result-clearing** is also deferred: history is passed as structured messages, but standardized
compaction is not built.

### Execution ownership

This document does not maintain a second agent backlog. Agent Fixes owns durable work items;
Field Report owns active outcome, milestone, PR, and review state. Current code and
the status table above decide what is built. The canonical sections below decide architecture
and product boundaries. If a live work item conflicts with either, reconcile it against current
code and this document instead of copying its status into docs.

Known current-main gaps remain visible where they constrain the architecture: final persistence
of agent-proposed non-import editable-grid changes is not yet one combined envelope; CSV draft
and conversation state are intentionally transient; repair-verdict chains and standardized
compaction are not persisted; and the org-chart staging adapter has not been earned. HC and
Vendor CSV workspace Save use one combined mainline envelope through their concrete authenticated
adapters.
Sequencing and PR state belong only to the durable work system.

---

## 3. The Generic Agent Contract (replicable across apps/domains)

Every app stands on the same substrate: a kernel (`ApplyChangeSet` +
`validate_apply_against_schema`), a schema, a read surface, drafts/approvals. The kernel is
**confirmed app-agnostic** (generic `source_kind`/`source_ref`, static `FieldValue`,
schema-validation with zero domain vocabulary). **Because the kernel is the authoritative
validator, the agent never has to be the correctness authority — for any domain.** The agent
can hallucinate freely; an invalid write simply fails `validate_apply_against_schema` or never
reaches the kernel (human Save gates it). That is the whole generalization.

**The minimal opinionated generic contract** (the same for HC, cap-table, CRM, ledger…):

```
propose(envelope) → kernel-validate (no-write) → stage-like-human-edit → human Save → ApplyChangeSet
   + read/query tools (live, tenant-scoped, schema-introspecting, FULL query)
   + run-ledger provenance
```

**Execution controls are mechanical, not semantic.** The single-attempt primitives accept an
`AbortSignal` and report provider usage facts. `AgentExecutionDeadline` owns one absolute wall
deadline, caller cancellation, first-cause precedence, and disposal. Foundation does not keep
aggregate output-token, tool-call, or step ledgers or shrink later attempts based on earlier usage.
Each invocation gets the same provider settings. A profile's `maxSteps` is only a per-invocation AI
SDK tool-loop fuse and refreshes when an app deliberately starts a semantic repair. Reusable
agent packages may retain bounded semantic-attempt mechanics where repeated
deterministic-invalid replacements would otherwise create a rapid provider-retry loop. The
inspecting domain/host authority classifies each result as accepted, repairable, or rejected; the
package must not retry every semantic failure by default. That classification is product behavior,
not a Foundation safety invariant. The inspecting domain authority owns semantic
validation/repair policy and accepted-result precedence; the app owns current composition and
response mapping.

**Tool outcome normalization is mechanical.** Foundation pairs each actual SDK tool call with its
result or thrown error by call id within that SDK step and exposes one call-centric success/error
outcome. Orphan evidence without a corresponding call is not an outcome. Hosts remain responsible
for interpreting successful tool outputs as domain results, repair signals, or UI state.

**The generic envelope** (app-agnostic, bulk-first):
```
{ id, grounding, writes: [ { model, record_key, field, value, effective_date, change_type_id? } ... ] }
```
- `grounding` is required by strict tool schema shape; pass `null` when there is no anchor/evidence payload.
- `writes` is a **set** (bulk default). `value` is the static `FieldValue`. `effective_date` is a **first-class** member (§5). `change_type_id` is intent metadata (§4).
- `grounding` = { anchor (opaque view reference) + optional scoped read criterion } — a hint, not a scope.

### Reuse the SHAPE / leave DOMAIN and host authority to apps

| Reusable mechanical shape | App / host seam |
|---|---|
| deadline/cancellation primitives and per-invocation tool-loop fuse; optional domain-agnostic lifecycle and prompt scaffolding | select/configure the scaffold; app-specific prompts/copy; semantic acceptance/repair decisions |
| static tool contracts and directly imported package-exported generic tools | tool selection/composition; app-specific tools; schema catalog; matching/relation/normalization policy |
| propose → validate → stage → save; no direct writes | auth/routes and host authority |
| generated-contract decode + kernel validation contract | domain acceptance policy and result precedence |
| same edit-buffer + Save + `ApplyChangeSet`; deterministic compiler mechanics (proposal → staged rows) | active schema, domain declarations, and app acceptance policy supplied to the compiler |
| generated ledger DTO + kernel recording contract | host evidence mapping; `source_kind='agent'` + authoritative `source_ref` |
| tenant-scoped read-only query tools | preview surface (grid / org-chart / dashboard — same persistence path) |
| bulk envelope incl. effective_date | profile instances + identity names (planner, drafter) |
| one consequence-scaled approval gate (§9) | which `source_kind` strings non-agent flows use |

**Stage adapter is a contract, not a component.** "Proposal → app-staging-buffer" is the seam;
the editable grid is *one* implementation. Org-chart, dashboards, future apps plug their own
staging in behind the same contract and the same Save/`ApplyChangeSet` path.

---

## 4. Change-Types: intent, not enforcement

**Decided:** change-types name **intent** (what *kind* of change this is) — for audit,
form-shaping, and a *future* review-agent — and are **not** a gating constraint.

- **No required-field enforcement. No `touches` enforcement.** The **enforcement** is what's cut — *not* the fields. (Verified: the kernel never enforced `required`/`touches` on writes — `validate_apply_against_schema` only checks the change-type *definition's* fields exist; the only enforcement ever lived in the now-deleted agent code.)
- **Keep the fields as inert descriptive metadata.** `ChangeType` on `main` carries `touches: Vec<FieldId>` + `required: Vec<FieldId>`. They stay as descriptive metadata only; nothing validates a *write* against them. (The change-type-id-membership / `target_model` referential checks may remain.) **Do not cut the fields from the struct** — cross-cutting churn (contract + clients + seed) with no reason behind it yet.
- **One sanctioned deterministic reader.** The approvals UI MAY surface a **non-blocking** "required fields xyz missing" hint, computed deterministically from `required` — a validator that *informs*, never gates. That is the only place `required` is read, and it stays advisory.
- **Future (deferred, §11):** a soft **"sanity-check / review-agent"** that renders an *advisory verdict* on whether the changes filed under a change-type look sensible — never blocking. For now this is **documentation / intent only**; it ships no enforcement machinery.

This captures most of the value of change-type semantics (legible intent, reviewable grouping)
without the enforcement that caused the doom loop.

---

## 5. Effective-Date: universal, first-class

`effective_date` is a **core edge of the kernel/data model**, not an app-specific concept.
Virtually every platform use case — systems of record and planning apps — adopts it, and the
apps we choose will *gravitate* to use cases that exploit it (it's one of the architecture's
real advantages). Therefore:

- `effective_date` is a **first-class member of the generic proposal envelope** (§3), the same
  for every app.
- It is **not** an HC-only dimension and is **not** pushed to an app extension. (This corrects
  an earlier draft conclusion.)
- Effective-date *interpretation* remains app policy. Deterministic code always
  supplies a complete baseline; an optional agent may propose a contextual
  refinement with evidence, and the user can accept, edit, or reset it. The
  generic substrate does not declare that a source `start_date`, `end_date`, or
  any other lifecycle field is universally the effective date. See
  `import-principles.md` for the import-specific review contract.

---

## 6. Foundation Slices (revised from the old plan)

- **Identity & execution profiles — KEEP** (thin; generic; app-instantiated).
- **Structured-output validation — REVISE** to "the proposal **decodes into the generated
  contract**, then the kernel validates." Drop the change-type validator and the
  schema-revision framing. Reusable libraries may provide mechanical attempt/repair scaffolding,
  but the app owns semantic acceptance/repair decisions. Foundation provides deadline,
  cancellation, usage, and static runtime contracts, not product-semantic orchestration.
- **Runtime tool contracts — KEEP**: `AgentToolDefinition` and `AgentRuntimeTool` define the
  static shape. Reusable packages may export domain-agnostic tools under their own boundaries;
  apps directly import, select, configure, and compose those with app-specific tools. There is no
  by-id or dynamic runtime registry.
- **Run ledger — KEEP** (audit/provenance only; kernel-persisted). Each host maps its evidence
  directly into the generated `AgentRunLedgerEntry` DTO before recording it. The ledger doubles
  as our **free eval signal** (§9).
- **Human alignment state — DE-SCOPE** to a typed **clarification I/O** contract only. No
  parallel reconciliation engine; agent edits stage like human edits. Protocol types live in
  the foundation; rendering lives in the app.
- **Composition-spec boundary — KEEP / defer** (reuse the existing composition contract; no
  second pipeline; build when a JIT/spec consumer earns it).
- **Safety defaults — REVISE**: keep untrusted-input, read-only SQL, "all writes compile through
  `ApplyChangeSet`", profile-attached grants. **Drop** the agent-facing schema-revision rule
  (it's a kernel backstop) and "write-surface re-validates" as a *correctness* layer.
- **Deferred capabilities — KEEP** (named triggers; §11).

---

## 7. Guards / Boundaries / Tests (regression prevention)

Encode deterministic boundaries and focused tripwires so regressions fail as early as possible:

- **Boundary lint (defense in depth):** the agent/app layers must not restate kernel validation —
  flag known per-`FieldValue`-variant validators, change-type constraint checks, field-existence
  re-derivations, or re-listed value-type enums on the agent side. Correctness imports/logic
  above the kernel = a failed check. The lint is a name/shape tripwire, not class analysis; a
  green scan does not replace code review or kernel parity proof. The kernel boundary is the
  authority because duplicated guardrails drift.
- **No-parallel-write-path scanner (extend):** assert the agent apply path routes through the
  same `ApplyChangeSet`/Save as the UI.
- **Contract tests:** `validate == apply` (the validate-route is the real apply transaction
  rolled back, and a real apply returns the same verdict on the same envelope); bulk validation
  envelope (N writes, one transaction, atomic fail);
  propose-only (the agent path performs no direct write); tenant-scope (a read tool cannot
  return out-of-scope models/records); no-correctness-in-tool (the tool surfaces the kernel
  verdict verbatim, adds none); `effective_date` present on every envelope write.
- **Kernel verdicts as evals:** log accept/reject + reasons per tool. Because validate == apply,
  this is an eval harness we already have — mine it before building a formal one.
  Until a status reconciler exists, evaluation mining should join on recorded `final_outputs`
  rather than run status; terminal status updates are best-effort lifecycle markers and can be
  a lossy denominator.

---

## 8. Use Cases (two flavors of the same foundation)

### 8a. CSV Workspace Agent — *first flavor* (inspect → propose draft → review → save)

Upload → agent tools inspect source, schema, current draft, saved records, and ordered domain
identity policy → agent proposes a typed draft → human reviews or edits the real grid and may
request another refinement → canonical dry-run → one explicit human Save through a single
mainline `ApplyChangeSet`. Source cells are untrusted data. The agent is essential to preparation
and cannot publish.

`packages/csv-workspace` is the public browser/server boundary. It owns the bounded tool loop,
one transient draft, capture of current grid edits, and optional bounded pure-JavaScript
preparation that emits the same proposal shape. There is no mapping-plan DSL, durable unfinished
session/resume lifecycle, or alias-confirmation machine. Exact identity resolution is tool-owned
and ordered policy comes from `packages/domain-libs/`; models without a policy remain searchable reference
context. HC and Vendor supply authenticated adapters, frozen scope/date/schema context, app write
guards, domain instructions and canonical kernel transport.

Only a pending Save survives refresh. Its exact key, payload, authenticated context, date, schema
revision, and filename are retained for same-request replay; other work is blocked until it is
resolved. A successful import is ordinary human activity with `source_ref = "csv:<filename>"`,
and history reads canonical activity and diff APIs. `packages/modules/source-import` retains UI
intake/preview leaves only. The removed `packages/agents/csv`, `packages/csv-import-host`, and
`packages/engines/csv-derivation` packages have no current authority. Identity
matching is `resolveImportIdentity`; there is no upstream identity-graph
classifier. Separate universal kernel durable-import APIs remain valid
substrate and are not this workspace's state model. See `import-principles.md`.

### 8b. HC Query & Mutation Agent — *second flavor* (propose edits → kernel-validate → stage → save)
The user asks a question or requests an edit anchored to the current view; the agent grounds in
the view **and** queries the broader app; it emits a **bulk proposal envelope**; the kernel
validates through `POST /api/apply/atomic-dry-run` (the real apply transaction rolled back) and
surfaces issues to the repair loop; valid proposals compile into the same record-level
`PendingWrite` buffer manual edits use; human reviews and Saves; drafts land in Approvals with
`source_kind='agent'`.

For the editable-grid consumer, the buffer source of truth is record-level: one pending record,
one effective date, `values: Record<FieldId, FieldValue>`, one row-level `changeTypeId`, and
last-touched `sourceKind/sourceRef`. Cell UI is only a projection over that pending record:
dirty glyphs, per-cell revert, and validation markers are UI affordances, not cell-level
provenance or a second write shape. The generic compile that turns proposal writes into
pending records lives in the module that owns staging (`packages/modules/editable-grid`); HC
supplies schema, visible records, query tools, and the app-owned propose tool. **Consumer 1 =
editable grid** (cheapest); **Consumer 2 = org chart** (same persistence path, different
preview). The editable-grid consumer is implemented; the org-chart adapter remains deferred.

---

## 9. 2026 Best-Practices Alignment

- **Deterministic gate, not LLM judgment.** The kernel *is* the gate; make "no correctness
  outside the kernel" a defect class. *(Anthropic, Cursor, Cognition, Braintrust — 2026.)*
- **Thin opinionated harness, adapter-isolated.** Depend on the AI SDK as a lower layer; do
  **not** adopt a framework (eve/LangGraph) as the lifecycle — that's how Anthropic/Cursor
  build. "Thin" = small surface, **not** unopinionated.
- **Anchor cheap + query broad.** Ship query tools + a thin view anchor; never pre-stuff
  context. Adopt standardized compaction/tool-result-clearing for long bulk sessions.
- **Bulk proposal + single-threaded writer + one approval gate.** Fan-out reads/planning freely;
  emit one atomic proposal; gate by **blast radius**, not per-tool, **not** an LLM "is this
  safe" judge. validate == apply makes the review diff *exact* (a property other stacks fake).
- **Observability now; evals + memory later.** Trace every proposal → kernel-verdict → apply +
  tool calls/errors (2026 table-stakes). Defer formal offline evals, online judges, and rich
  agent memory (least-mature in 2026; our anchor+full-query already substitutes retrieval for
  memory).

---

## 10. Agent UX Directions (current and deferred surface directions)

Carried forward, condensed; not committed scope until a surface earns it.

- **Surface taxonomy.** Primary = **contextual conversation** anchored to a record/cell/chart
  selection (Cursor-style context-tagging: ambient view auto-grounds + `@`-mention named
  entities; the agent still full-queries). Global chat is the fallback. Watchers, JIT mini-app
  dashboards, voice are later. **Bulk is first-class in every surface.**
- **Agent edits stage like human edits** — no separate proposal/approval pipeline; the edit
  buffer + Save + Approvals *is* the action boundary; provenance marker only.
- **Conversations & artifacts** persist independently (conversations resumable; artifacts in a
  content-addressed store) — not load-bearing for correctness (truth is re-read live).
- **Presets, make-this-a-rule, active-learnings, pasted-artifact extraction** — deferred,
  trigger-gated.
- **Justification field** (agent's reasoning per proposal, shown in review/approvals) —
  deferred.

---

## 11. Deferred Capabilities (named triggers)

Do not pre-build; document the trigger + likely path (cherry-pick Vercel primitives, never a
framework lifecycle):

- **Change-type review-agent** — soft advisory verdict on a change-type's changes. *Trigger:* a
  real need for change-quality signal. *Now:* intent/docs only (§4).
- **Durable workflow** (Vercel Workflow SDK) — *trigger:* a run must survive process death /
  resume across days. Autograph owns pause/resume/ledger/cancellation; the kernel owns committed
  state (a durable session store is pre-kernel staging, **not** a parallel write path).
- **Code sandbox** (Vercel Sandbox; E2B fallback) — *trigger:* the agent must run
  model-generated code against an artifact (JIT analysis/transforms). DB-air-gapped:
  read-via-tools → compute → stage-back; never holds a write handle.
- **Evals** (file-based suites / Braintrust/Promptfoo) — *trigger:* agent behavior becomes a
  regression surface. (Kernel verdicts cover the deterministic floor meanwhile.)
- **Memory / RAG** — *trigger:* domain records + history + run-ledger prove insufficient.

---

## 12. Implementation discipline

The original foundation and HC query/mutation sequence has landed and is no longer an execution
plan. New agent slices start from current `main`, preserve the kernel authority and single write
path in §§1–3, and add deterministic boundary proof with the implementation. Do not stack work on
historical branches or revive superseded runtime shapes.

Durable Agent Fixes and Field Report state determines sequencing. Deferred consumers and
capabilities in §§10–11 remain trigger-gated; neither this document nor an old PR status is
authorization to build them.
