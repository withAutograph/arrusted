# Known Footguns

Substrate areas where implementation revealed subtle edge cases. Each entry names the area, the specific edge case, and what to watch for in future changes. These are not permission to add compatibility layers or duplicate authorities.

## Shared Vite Configuration Loading

Vite Plus 0.2.2 transpiles workspace `vite.config.ts` files but loads the
externalized `@autograph/vite-config` workspace entrypoint as JavaScript. Keep
`packages/vite-config/index.ts` as the typed source of truth and expose its
generated `index.js` through the package's runtime export. TypeScript consumers
continue to resolve the source through the `types` condition. This preserves
one shared configuration implementation without per-workspace copies.

The `check:vite-config-runtime-source` HK step regenerates the runtime source in
memory, rejects a stale checked-in artifact, and parses it with the repository's
Node runtime. The format and lint lanes then provide integration coverage by
loading each workspace config selected by `workspace_indicator`.

Trigger to revisit: Vite Plus loads external TypeScript dependencies through
its TypeScript transform and no longer requires a JavaScript runtime export.

### Knowledge Duplication — trusted API authentication has two language implementations

The gateway/static-zone TypeScript path signs the trusted API request context,
while `packages/rust-auth` verifies it. Both intentionally implement the same
versionless field order, optional-field rules, UTF-8 byte-length framing,
base64url encoding, and HMAC-SHA256 algorithm. They are separate implementations
today, so a one-sided protocol edit can compile and pass language-local tests
while breaking every gateway-to-Rust API request.

Treat the current payload as frozen. Any change to its fields, order,
normalization, framing, digest, or header names must first add canonical
cross-language fixtures (including Unicode and absent optional fields) consumed
by both suites and one integration proof that signs in TypeScript and verifies
in Rust. Do not add a compatibility decoder or negotiate multiple payload
versions.

Trigger to revisit: the trusted request context changes for any reason, a new
language needs to consume it, or a production authentication failure indicates
wire drift. At that point generate the shared field schema/order from one
versioned protocol definition.

## Draft Relation Resolution

Draft relation resolution considers mainline rows plus rows created in the same draft. Lifecycle rows win same-day visibility before the draft-stage tiebreak, matching ordinary mainline reads.

### Watch: in-import dependency ordering in compilers

V0 does not topologically sort arbitrary relation dependencies. Direct-mainline apply resolves or reserves its complete planned subject set before physical version insertion, so a visible, non-tombstoned planned target may appear after its source in the request. Draft save deliberately retains envelope-order visibility: the target version must appear before the source, and reserving only its record row is insufficient. App CSV compilers that emit target writes before source writes remain safe in every mode. A future compiler that produces drafts must retain the same target-before-source discipline or receive `RecordTargetMissing`.

## Revert Semantics

Revert is one-way and audit-only. Every additional invariant is a careful trade-off.

### Watch: tip-conflict uses effective-time, not system-time

The tip-conflict check rejects when later mainline rows exist at later `effective_start`, or same-day with lifecycle rows. It does not reject when later applied rows exist at earlier `effective_start` values, meaning a later backdated write can remain visible after reverting an earlier-applied target.

This is the documented behavior: "tip" means effective time, not system time. It is worth knowing because the post-revert visible state may surprise a user who expected "restore the world to what it was before X."

Trigger to revisit: a flow proves users expect strict pre-change-set restoration semantics. The fix path would use `applied_order > target.applied_order` instead of effective-time tip checks.

### Watch: source_ref text join for revert audit

PR 8's history reads annotate reverted rows by joining `change_set` on `source_kind = 'revert'` and `source_ref = version.change_set_id::text`. The text-cast comparison is the cost of the audit-only revert design: there is no `revert_action_change_set_id` column on version rows.

This works, but the join can become a query-performance hotspot if `change_set` grows large. Add an index on `source_ref` if profiling shows hot revert lookups. A malformed manual SQL insert with `source_kind = 'revert'` and non-numeric `source_ref` would also surface as drift when resolving revert diffs; kernel-created revert rows are well-formed.

## Field Value Write Contract

Field writes overlay the prior version snapshot: an omitted field inherits, a
supplied value overwrites, and an id in `clear_fields` / `clear_custom_fields`
removes the value (see the row-version rules in `docs/contracts.md`). Set and
clear ids must be disjoint, and required declared fields cannot be cleared.
`packages/schema-compiler/tests/sql_runtime_extensions.rs` proves both clears
and the required-field rejection against generated SQL.

### Watch: an emptied grid cell is a clear, not an empty value

`FieldValue` has no null variant; a clear is a separate write list. The shared
grid stages a clear as a `null` pending value for any optional field, declared
or custom: emptying a cell (Delete, a picker's Clear, or committing an empty
editor) becomes `clear_fields` or `clear_custom_fields` at Save, and clearing a
cell whose saved value is already empty is no change. An emptied optional text
cell is therefore cleared rather than saved as `""`. Required fields refuse the
clear in the cell ("This field can't be cleared.") and in `stageBulkUpdate`.

### Watch: tenant schema operations retire enum options; they do not delete them

Enum options carry `active | retired` lifecycle (`docs/contracts.md`, Logical
Schema and Enum Compilation Target). The tenant schema operations
(`create_enum_option`, `update_enum_option`, `retire_enum_option`,
`restore_enum_option`) have no delete, for declared and custom enums alike. A
retired option is hidden from new
selection and matching, and writes reject it, but stored values keep its id
and still resolve its label, with audit reads using the event's pinned schema
revision. Option ids stay reserved after retirement, so a new option cannot
reuse one.

Practical consequence: editing an option's **label** relabels every record
that holds it; retiring it is the only way to take it out of use. A UI that
offers options for new values must filter out retired ones while still
labelling stored values that use them.

This covers options managed through those operations only. An option set
replaced some other way (for example a custom enum option set rewritten
outside them, see below) can still drop an option, and stored values that
use it then lose their label.

### Watch: declared enum option sets are app-owned + customer-additive-only

A declared enum field's `option_set` is app-owned. Runtime tenant edits are
**additive only**: a tenant may APPEND its own options (stored in
`schema_revision.customer_overlay` as `declared_enum_option_additions`), but
**cannot remove, rename, or re-id** any app-provided base option — the
write endpoint rejects a declared commit that drops/renames/re-ids a base
option. The effective option_set composes as app base options (immutable,
original order) followed by tenant additions. Because base options are never
overridden, app-shipped new base options always flow through to overlaid
tenants (no base drift), and there is no reset problem — a tenant removes only
its own additions. App option ids stay invariant, so app logic and agents that
key on declared option ids (e.g. `status == "terminated"` driving offboarding)
stay correct. Custom enums (whole custom fields) are fully tenant-owned by
contrast (full option_set edit + orphan→null). This is the deliberate resolution
of "should tenants edit core fields": no for app-provided options, yes via
addition or a custom field.

Trigger to revisit: a tenant genuinely needs to suppress or relabel an
app-provided declared option (not just add one) → the safe extension is a
presentational label/visibility overlay that is **id-stable** (never removes or
re-ids the base option), so app logic keyed on the id still holds; never allow
removing or re-id-ing a base option.

### Watch: declared enum overlays can conflict with later app schema evolution

Declared enum additions are composed onto the current app-owned base schema at
materialization time. That keeps runtime additions out of app code, but it also
means future app schema changes can fail loud for a tenant with an overlay:

- If a tenant adds option `contractor` and a later app release adds base option
  `contractor`, the effective set has a duplicate id and validation rejects it.
- If a later app release removes or renames a declared enum field that has tenant
  additions, overlay composition can no longer find the target and materialization
  rejects it.

This is acceptable for V0 while the app is greenfield and tenant overlays are
operator-controlled. The failure is intentional: do not silently drop tenant
schema edits or pick a winner. Before real tenant overlays become common, add an
operator reconciliation path that can rename/migrate additions before applying an
app schema change.

Trigger to revisit: app-managed enum option sets begin changing in production, or
tenants can author additions without direct operator coordination.

### Watch: enum options are attribute-free, and alias uniqueness is enforced per set

`EnumOption` is `{ id, label, aliases }` only — no per-option metadata (color,
default/initial flag, description, `is_active`/`is_terminal`, allowed
transitions). Whether a concept is a model or a field-local enum is an explicit
domain-authoring decision, not something the kernel or a reference-count formula
infers. A concept that needs independent identity, history, relations,
customer-managed lifecycle, or its own attributes should generally be authored
as a model. Relaxing the enum shape later (for example, adding a per-option
attribute) would be a bounded substrate change — extend the `EnumOption` struct +
the `option_set` wire shape + a migration — not a redesign.

Aliases are import-match keys (fuzzy source-value → canonical option). The enum
write endpoint **rejects a commit where any match key appears on more than one
option in the effective set** (declared base+additions, or custom), including an
alias or label that collides with another option's canonical `id`, `label`, or
alias. Match keys use the same normalization as enum import matching: trim,
lowercase, and collapse runs of whitespace / `_` / `-` into one space. A source
value must map to at most one option, so import matching can never be ambiguous
across options in the same set (same class as the B3 lookup name/alias
ambiguity).

Trigger to revisit: a product flow needs per-option attributes (extend the
`EnumOption` shape), a default/initial option, or
relabel-without-rename of an app option (id-stable presentational overlay).

### Watch: enum authoring V0 limitations (id/label drift, authz, concurrency)

Deferred, eyes-open V0 limitations of runtime enum option-set authoring:

- **id/label drift after rename.** A new option's id is minted from its original
  label (`slugifyOptionId` preview → kernel `require_identifier` authoritative).
  Renaming the label later leaves the id unchanged, so id ("pending") can diverge
  from label ("Awaiting review"). Acceptable because ids are opaque/internal, not
  user-facing.
- **No reset and no relabel of app options** (see additive-only entry above).
- **Authz is not modeled at the substrate.** The write-boundary governs _how_
  (confirmed schema-revision write, never prompt-only), not _who_. The endpoint
  should be admin-gated by app policy; a substrate authz contract is deferred.
- **Concurrency is optimistic, full-set.** Each commit carries a
  `baselineRevisionId` stale-check; a concurrent edit makes the second commit
  stale-reject (reload), with no field-level merge. Lost-work-on-conflict is the
  accepted V0 cost.

Trigger to fix: any of these becomes a user-visible problem (a saved drifted id
confuses an operator; multi-admin concurrent enum edits become normal; tenant
authz on schema authoring is needed).

## SQL Read Surface Safety

The layered defense (read-only role, RLS, temp views, transaction_read_only, plan-based catalog rejection, parameterized prepare, and cost cap) holds when all layers are intact. Each layer matters.

### Watch: SQL workbench owns current-session temp views

`pg_temp` views are session-scoped, not transaction-scoped. `query_visible_sql`
drops existing temp views in the current session before creating the request's
tenant-filtered views and drops the request views again after either success or
rejection. Stale views therefore cannot shadow the current query schema, and
every internal kernel transaction also drops all current-session temp views
before resolving catalog or model relations. Failed or interrupted workbench
cleanup therefore cannot make query-only record/version projections shadow
canonical reads, history, apply, or revert operations that later reuse the same
connection.

The SQL workbench therefore owns the connection's temp-view namespace while it
runs, and kernel calls own that namespace when they begin. This is acceptable
for V0 because user SQL is read-only and cannot create temp views. Trigger to
revisit: a supported caller needs unrelated temporary views to survive a
kernel/workbench call on the same connection; that requires a narrower
ownership registry rather than weakening the cleanup boundary.

### Watch: `quote_literal` is the only escape used for tenant id interpolation in temp view definitions

`prepare_query_temp_views` interpolates tenant ids into temp view definitions with `quote_literal`. `quote_literal` escapes single quotes by doubling them. This is safe assuming `standard_conforming_strings = on`, the Postgres default. If a deployment ever runs with `standard_conforming_strings = off`, backslash escape sequences become active and a tenant id containing backslashes could escape the quoted string.

Trigger to revisit: Postgres deployments with non-default `standard_conforming_strings`. Worth a startup assertion or a comment near `quote_literal` documenting the assumption.

### Watch: `set_config` keyword check is substring-only

`reject_forbidden_query_functions` checks for `set_config` by substring. False-positive risk: a user query containing the literal string `'set_config audit'` would be rejected. False-negative risk is low because the read-only role, transaction_read_only, and RLS layers still catch tenant-scope manipulation attempts even if this check missed them.

Trigger to revisit: false positives surface in normal analytical SQL. Tighten to a parser-backed function-name check or a narrower regex such as `\bset_config\s*\(`.

### Watch: catalog rejection via `EXPLAIN (FORMAT JSON)` plan walking

`plan_references_catalog` walks the JSON plan tree looking for catalog schemas or `pg_` relation names. This is heuristic; Postgres plan output shape can change across versions. If a plan references a catalog table through a shape the walker does not recognize, the typed `QueryRejected` may not surface, though the role/grant layer should still prevent actual access.

Trigger to revisit: Postgres major version upgrades or SQL surface expansion. Re-test catalog rejection cases after each upgrade.

## Hosted Integration Receivers

Ampersand is the integration system of record. Autograph should treat webhook
deliveries as signed external write requests that compile into ordinary kernel
apply calls.

### Watch: webhook verification needs the raw body

Ampersand webhook destinations use Svix signatures. Verify the signature over
the raw request body before parsing JSON. A route that parses the body first and
then verifies a reconstructed string can reject valid deliveries or accept a
payload that was not the signed byte sequence.

Trigger to fix: any framework route middleware consumes the request body before
the app-owned integration ingress verifies the signed raw bytes.

### Watch: URL result payloads expire

Ampersand read deliveries may point at a short-lived result URL. Fetch that URL
server-side inside the verified webhook handling path, then process the payload.
Do not enqueue the URL itself for later workers; by the time the worker runs,
the URL may have expired and the original signed delivery context is gone.

Trigger to fix: integration processing moves to an async worker. The queued
unit must be the downloaded payload plus verified metadata, not the download
URL alone.

### Watch: `mappedFields` is the app-facing mapping contract

Ampersand owns object/field mapping and delivers mapped values under
`mappedFields`. Re-creating mapping JSON, selected-field manifests, provider
schema manifests, or accepted integration plans in Autograph duplicates the
hosted provider abstraction and reintroduces a second source of truth.

Trigger to fix: any new table or app state stores Ampersand installation config,
field mappings, selected fields, provider schemas, operation logs, or
notification envelopes.

### Watch: the shared integration package is only an external-library wrapper

`packages/integrations` wraps Ampersand and future external integration
libraries for reuse. It must not import apps, app-generated clients,
kernel-client, kernel DTOs, or `ApplyChangeSet`, and it must not contain
provider-to-app compilers such as QuickBooks-to-vendor mapping. App semantics
belong in app-owned integration recipes; verified ingestion, authority checks,
and provider-specific policy belong at the app boundary before core kernel
apply. A reusable `packages/integration-compiler` crate may compile
already-verified recipe input to generic kernel write contracts, but it must not
depend on provider SDKs, import app crates, hardcode QuickBooks/vendor
semantics, reference local integration tables, or encode provider/source refs as
model `external_key`. Rust app code may be route glue, schema materialization,
app policy, or kernel apply bridge, but provider ingress must not move there.

Trigger to fix: a package boundary scanner allows `packages/integrations` to
import app or kernel layers, package code starts exporting app-specific provider
compilers, `packages/integration-compiler` accepts provider SDK/app dependencies
or app/provider literals, app Rust code starts owning Ampersand/Svix parsing, or
core kernel code starts owning Ampersand, QuickBooks, provider webhook, or
integration recipe surfaces.

### Watch: provider ids are not `external_key`

`external_key` is within-batch authoring plumbing. It is not provider identity
and cannot model multiple providers or multiple installations per canonical
record. Hashing or prefixing a provider source ref does not make it safe. Do
not add a generic kernel `integration_keys` capability for Ampersand V0.
Automated update/delete from an integration needs deterministic app-recipe
matching from app schema data plus verified Ampersand delivery context. If the
product needs a provider id as durable data, model it as an app-schema field for
that app.

Trigger to fix: a compiler writes a QuickBooks id, Ampersand installation id,
hashed source ref, or other provider/source id into `RecordKey::ExternalKey` or
`external_key`, or update/delete logic mutates a canonical record without a
deterministic app-owned match.

## Agent-led CSV workspace

### Watch: unfinished work is deliberately transient

The current workspace keeps one draft and its bounded conversation in browser
memory. Refreshing before Save loses them. This is intentional: do not add a
durable import-session or plan store as a convenience fix. Revisit only when
real usage demonstrates that long-running unfinished work must survive refresh,
then design that product explicitly rather than extending the pending-Save
receipt.

### Watch: pending Save recovery depends on browser storage

Immediately before Save, the browser stores the exact idempotency key, payload,
authenticated app/customer/actor/date context, reviewed schema revision, and
filename. Editing and new imports are blocked until the same request is retried
or the kernel definitively reports `not_applied`. A transport or post-apply
receipt failure retains the request because the canonical apply may already
have succeeded.

Cleared, unavailable, or quota-exhausted browser storage prevents recovery and
therefore prevents Save from starting. Do not weaken this by regenerating a key
or reconstructing a payload. If stronger recovery is required, it needs an
explicitly authorized durable receipt design, not an unfinished-session store.

### Watch: current bounds are not large-file support

The shared HTTP handler rejects bodies above 3 MiB. Agent source/draft reads are
paged, conversation is bounded, and current record populations are loaded into
the server service. The optional JavaScript computation runtime also has fixed
time, heap, stack, and input/output limits. These guards make the current flow
bounded; they do not prove large-file or horizontal scalability.

Trigger to revisit: measured installed use reaches these limits. Preserve the
single-draft and one-atomic-Save semantics while moving bulk source/reference
transport behind an earned bounded interface.

### Watch: workspace matching and writes have separate authorities

Ordered identity policy comes from `packages/domain-libs/`. Exact identity resolution
and allocation happen in workspace tools, while models without a policy remain
searchable reference context only. Aliases are ordinary policy-declared fields;
there is no confirmation protocol or hidden alias store. The kernel and app
write guards still decide whether the final envelope is legal.

The server loads visible records for agent turns and validates a draft before
Save, but concurrent data can change before apply. Canonical apply is the final
transactional guard and failures must remain loud. Do not add a second compiler,
a session lock, generated `external_key` identity, or host-side matching to
mask a race.

### Watch: import history is canonical activity, not workspace state

Successful saves carry ordinary human attribution with
`source_ref = "csv:<filename>"`. Recent import rows filter canonical activity
and load canonical change-set diffs. They do not prove that an unfinished draft,
agent transcript, source bytes, or model reasoning was retained. Add separate
provenance only if a concrete audit requirement earns it.

### Watch: currency support is global tender-code validation, not tenant policy

The HC CSV agent and kernel apply path validate currency values against the shared
ISO 4217 tender-currency predicate used for `iso_currency` and `money_rate.currency`.
That prevents ad hoc importer allowlists and excludes ISO special-purpose codes such as
testing, no-currency, funds, metals, and units of account (`XTS`, `XXX`, `XAU`,
`XDR`, etc.), but it is not the final product policy for which currencies a
specific customer can use.

Today the tenant/app layer has no persisted "enabled currencies" catalog, and
the Rust apply edge stores money-rate currency as a typed string component
rather than enforcing a tenant-specific allowlist. That is intentional for the
current import loop: canonical tender-code validation catches malformed values
such as `DOLLARS` and special-purpose ISO codes, while normal currencies such as
`JPY`, `AUD`, or `CHF` do not get blocked by an HC-only default list.

Trigger to fix: a customer needs tenant-specific currency enablement,
currency-conversion policy, or auditability around unsupported compensation
currencies.

## HC Baseline Schema

The HC app uses headcount vocabulary for `employee`, `position`, and
`org_assignment`, with `org_assignment` carrying both occupancy and reporting
placement.

### Guard: HC assignment row shape is owned by canonical schema constraints

The active HC artifact declares `org_assignment_has_subject` (at least one of
`employee` / `position`) and `org_assignment_has_at_most_one_manager` (at most one
of `reports_to_employee` / `reports_to_position`). Null manager targets are valid
for top/root assignments. Generated SQL evaluates those schema constraints on
the resulting record during dry-run and apply; HC authenticates the request and
retains its application write policy.

The CSV workspace delegates row-shape validation to that same canonical path.
There is no CSV reconciliation compiler or HC snapshot validator to update in
parallel. Canonical idempotency handles an exact committed request before
current-state validation, so an intervening edit must not invalidate a Save
retry. The HC database regressions cover invalid creates/partial updates and
replay after an intervening change.

### Guard: one active HC assignment per subject is a schema constraint

Product decision (2026-10-13): an employee or a position has at most one active
`org_assignment` on any date. HC declares this as the authoritative
`org_assignment_one_active_per_subject` constraint, a
`non_overlapping_intervals` expression over `start_date`/`end_date` with the
subject sets `[employee]` and `[position]`. These mirror
`org_assignment_import_reconciliation_policy`; the HC schema-artifact test fails
if either side drifts. Both dates are inclusive business dates, matching the
field atlas and Explore's active-row rule: an assignment is active on D when
`start_date <= D` and `end_date` is absent or `>= D`. A successor may start on
the day after the previous `end_date`; starting on that `end_date` overlaps.

The rule compares each record's live mainline snapshot, the same scope as
`is_unique`: it does not reconstruct every historical as-of state, and
tombstoned records no longer reserve their interval. Generated mainline apply
and dry-run, draft approval, revert, installer readiness, and app-base and
tenant-overlay activation enforce it; there is no importer-only or UI-only
validator to keep in parallel. Writes must run under READ COMMITTED, the
generated-runtime default; other isolation levels fail closed. A release that adds the rule cannot activate over existing
overlapping live rows. Correct them through ordinary audited writes first.

### Watch: HC change-type inference is app-local

HC currently resolves touched position fields to change types in
`apps/hc/frontend/src/schema/change-types-core.ts`. The helper is pure and
schema-shaped, but it is still an app-local policy adapter: HC defines the
change-type catalog and the catch-all behavior. Do not promote this helper to a
shared engine or kernel contract until a second app/model needs the same
inference semantics, or until change-type metadata becomes part of a generic
read/write organization contract.

Trigger to fix: a second app/model implements touched-field change-type
inference, or kernel/library code needs to reason about change-type metadata
outside the HC app.

### Watch: derived position fields are deferred

The headcount schema template includes derived cost/comp fields such as
`total_cash`, `total_comp`, `annualized_cost`, and variance fields. The HC app
does not instantiate those fields yet. Derivation is now kernel-owned: re-add
them as read-only derived fields (app `derived_fields` or tenant derived custom
fields), never as stored values written by the app.

Trigger to fix: the first product surface that displays derived comp/cost
fields brings them back as read-only derived fields. Any stored or
materialized copy of a derived value is a separate decision.

## Composition Runtime APIs And Specs

Spec-driven compositions in `packages/design-systems/core/compositions/` accept
JSON-serializable specs only when the surface is saved, shared, generated, or
rendered by a non-app caller (e.g. agent-rendered surfaces). Cells, columns,
and other config values in those specs can hold serializable values, not
arbitrary React nodes such as inline buttons.

Interactive compositions used inside app/module-owned code may have a runtime
props API instead. `DataSurface` is the precedent: it accepts React nodes,
callbacks, editor components, and row action renderers at runtime, while
substrate workflow lives in the wrapping module. A composition still cannot
fetch from the substrate, own tenant context, perform kernel apply, or persist
view state outside a typed spec — modules own workflow state; compositions own
reusable UI structure and interaction state.

## Hand-Typed Wire DTOs

Hand-typed TypeScript mirrors of kernel wire shapes drift silently in shape AND in field names. Two concrete in-tree precedents:

- the deleted `packages/engines/row-version-transforms` prototype duplicated generated `FieldValue` handling in a dormant hand-written transform, preserving a second wire-shape interpretation without a consumer or parity test
- the prior `apps/dev/frontend` (since deleted in the AG Grid pivot) hand-typed `DraftSummary` with a non-existent `created_order` field — the UI was silently rendering nothing for that field until codegen widening exposed and removed the phantom assumption

App and library code consume generic substrate wire shapes from `packages/contracts/`, whose reusable DTOs are generated by `packages/contracts/typegen` into `packages/contracts/wire.generated.ts`. Product API servers emit app-narrowed generated client shapes that the owning Rust binary embeds via `include_str!` for ad-hoc test harnesses or TypeScript consumers.

Remaining risk: `packages/contracts/typegen` is an explicit emitter, not automatic Rust/Serde type reflection. P0b's emitter asserts public contract struct fields and enum variants so add/remove drift fails at Rust compile time, and `--check` compares the committed generated file on disk to a fresh emit. But Serde attribute changes are still hand-encoded: `rename`, `rename_all`, `default`, `Option` nullability, and the TypeScript representation of new `#[serde(tag = "type", content = "value")]` enum variants can silently desync the wire TS unless the emitter and fixture coverage are updated in the same PR.

The B1 guard is implemented: shared fixtures round-trip through the Rust
contracts in `packages/kernel/tests/wire_roundtrip.rs` and type-check against the
generated TypeScript contracts in
`apps/hc/schema/__tests__/wire-roundtrip.test.ts`.

Trigger to fix: any hand-typed wire DTO appearing outside generated output
during code review, or any contract change touching renamed/defaulted fields,
`Option` shape, or tagged `FieldValue`/`CustomFieldValue` variants without
extending those fixtures and both checks in the same PR. Do not rely on
compile-only shape assertions for Serde semantics.

## Agent Run Ledger

The agent run ledger is an audit/provenance substrate, not a client data write
path. It intentionally stores broad JSONB evidence envelopes while the first
agent consumers are still proving which evidence shapes matter.

### Watch: free-form JSONB evidence fields

`AgentRunLedgerEntry` currently types `source_artifacts`, `alignment_decisions`,
`model_calls`, `tool_calls`, `token_usage`, `validation_failures`,
`final_outputs`, and `approval_boundaries` as `serde_json::Value`, emitted to
TypeScript as `unknown`. That is acceptable for V0 audit capture, but any UI or
workflow that reasons over those fields must introduce a typed app/module
contract instead of hand-typing local mirrors.

Trigger to fix: a consumer filters, renders, replays, or validates a specific
agent evidence field. Add a typed envelope to the generated contracts or the
owning app/module contract in the same PR.

### Watch: AI SDK runtime budget semantics

The TypeScript AI SDK HC route is a provider-backed runtime primitive, not
durable orchestration. The AI SDK owns the model/tool loop and step accounting
for this slice, while Autograph still owns provider configuration, required-tool
validation, wall-clock cancellation, retry policy, durable pause/resume, and
post-run accounting. Tool and structured-output failures must be treated as run
outcomes with explicit metadata, not as proof that durable cancellation or
resume semantics exist.

Trigger to fix: an agent flow becomes user-critical, has costly tools, or needs
strict cancellation/spend guarantees. Add an adversarial runtime test harness or
move the flow to a durable orchestrator with explicit cancellation semantics.

### Watch: idempotent replay comparison drift

`record_agent_run` enforces idempotent replay by comparing the incoming
`AgentRunLedgerEntry` to the previously persisted row. That comparison is
field-by-field so it can ignore storage-owned columns like `id`, `created_at`,
and the active schema revision used when a caller omits `schema_revision_id`.

Trigger to fix: a new field is added to `AgentRunLedgerEntry`. The same PR must
update the persisted row comparison and add a replay conflict test for the new
field.

### Watch: the ledger has no reader — kernel-verdict eval mining is unowned

The ledger now captures everything §7 promised (terminal statuses via
`update_agent_run_status`, verdicts and rejections in `final_outputs`,
tool calls, token usage). HC query/mutation records proposal, query-only,
clarification, exhausted, runtime-error, and cancelled turns instead of
leaving answer-only turns invisible. No surface, job, or ritual reads it. The
"kernel verdicts as free evals" property is only real if someone mines
accept/reject rates and rejection reasons; today the evidence accumulates
unread. Note also that `status` is a lossy denominator for mining (the
`completed` marker is best-effort — a successful run with a failed marker
POST stays `recorded`); join on `final_outputs` until a reconciler exists.

Deliberately left unowned for now (product decision, 2026-07-06): no
dashboard, no digest — being intentional later rather than building a
reader speculatively.

Trigger to fix: before tuning prompts/tools based on intuition instead of
ledger evidence, or when agent runs become a normal daily workflow — start
with the cheapest reader (a periodic digest of run counts, terminal-status
mix, and top rejection reasons), not a dashboard.

### Watch: retention and archive policy

`agent_run` can grow faster than `change_set` because model calls, tool calls,
source artifacts, and final outputs are stored as JSONB evidence. There is no
TTL, archive, or compaction policy in PR1.

HC query/mutation evidence can duplicate full record values in `tool_calls` and
`final_outputs`. Those payloads are in-tenant and in the same database, but they
carry record-level sensitivity under a different lifecycle: evidence may outlive
record edits, deletes, or future field-level redaction. V0 deploy-gate policy
(2026-07-09): the HC query/mutation route does not retain raw tool args,
tool results, or assistant text in `agent_run`; it stores only redacted
tool-name/status metadata, token/model metadata, terminal status, proposal id,
write count, and bounded failure/budget evidence. Raw transcript retention
requires a separate product/security decision.

Trigger to fix: agent runs become a normal product workflow, evidence payloads
grow large enough to affect backups/query latency, compliance requirements need
a retention window, or HC agent routes approach deploy beyond local/demo use.

## Editable Grid Host (AG Grid)

The editable row-version grid is hosted on AG Grid Enterprise inside
`packages/modules/editable-grid/`. The earlier custom TanStack-based grid
glue was wiped after generating 30+ jankiness bugs across four review
rounds — we were re-deriving AG Grid's defaults from first principles.
The pivot validated cleanly (see `docs/frontend-architecture.md` "Editable
Row-Version Grid Module" for the contract).

### Watch: license version drift

The AG Grid Enterprise license is keyed against a release date cutoff. The
spike pinned `33.3.0` because `33.3.2` released after the license cutoff
(17 May 2025) and triggered the `Incompatible Software Version` trial-mode
banner. Future minor-version bumps need to verify the release date is
still covered or the license needs renewal.

Community is the default and needs no key. See
[AG Grid and AG Charts Enterprise](ag-enterprise.md) to turn Enterprise on.

### Watch: bootstrap encapsulation must stay airtight

`bootstrapAgGrid({licenseKey})` from the editable-grid module is the ONLY
place AG Grid setup happens. Apps never import `ag-grid-*` directly; the
scanner enforces this. If a new app or feature legitimately needs to set
license / register modules / configure global settings, the right answer
is widen `bootstrapAgGrid` (or add a sibling `configureAgGrid` export),
not chip away at the scanner exception. The exception is the surface area
for the bug class we wiped the original glue to fix (mounted ≠ storybook,
parse/serialize uniformity, dispatcher reimplementation).

### Watch: AG Grid v33 `reactiveCustomComponents` proxy race vs synchronous stopEditing

When a custom React `cellEditor` adapter calls `props.api.stopEditing(false)`
synchronously inside the leaf's commit handler (e.g. on Enter), AG Grid's
internal cell-bound keyboard listener has ALREADY fired its
`takeValueFromCellEditor` path and read `proxy.value` while still at the
initial value (the leaf hasn't dispatched onCommit → onValueChange yet).
The grid sees `newValue === oldValue`, skips `setDataValue`, and flips
`cellCtrl.editing = false`. The subsequent stopEditing call early-returns
because the grid is no longer in edit mode.

Symptom: the editor closes but the cell value never updates and the
buffer never dirties — looks like a silent no-op.

Workaround used by `packages/modules/editable-grid/cell-editors/`: adapters
call `props.node.setDataValue(props.column, next, "edit")` directly (the
same call AG Grid's own internals use after `takeValueFromCellEditor`,
which bypasses the editing-state gate), then `props.api.stopEditing(true)`
to close with cancel semantics so AG Grid won't double-commit.

Also worth knowing: `params.stopEditing(arg)` (the `ICellEditorParams`
version) ALWAYS commits — `arg` is `suppressNavigateAfterEdit`, NOT
`cancel`. To actually cancel, use `props.api.stopEditing(true)`. The
signature collision is a real footgun — TypeScript shows both as
`stopEditing(boolean)`. If a custom editor regresses to the no-op-commit
behavior, this is the first thing to check.

### Watch: editable-grid row data is baseline, not pending-write storage

The editable-grid hook must not mutate `params.data.values[fieldId]` to make
AG Grid repaint. Visible rows are the immutable baseline; the record-level
edit buffer is the pending-write source of truth, and cells project
`buffer.getEdit(addr) ?? row.values[fieldId]`. Revert paths delete pending
values and refresh projected cells; they do not restore a shadow prior store.

This invariant prevents the old diverge-from-canonical bug where a reverted
cell kept painting an unsaved value because row data had become a second write
buffer. Regression tests in
`packages/modules/editable-grid/__tests__/landmines.test.tsx` (the
"row-level buffer projects over immutable row.values" describe block) are the
backstop — keep them green when touching setters, value getters, or revert
paths.

### Watch: Map iteration-order contract in edit-buffer + editable-grid resolution rules

`changeTypeIdForRow`, `bulkGroupIdForRow`, and the save partitioner rely on
`buffer.entries()` walking the underlying store in INSERTION-ORDERED fashion.
The "first-non-null adopt" rule for explicit `meta.changeTypeId` /
`meta.bulkGroupId` is well-defined only if the iteration order is the order the
user staged the edits.

ECMAScript guarantees insertion-ordered iteration for `Map` — and the
edit-buffer engine uses a native `Map` as its store
(`packages/engines/edit-buffer/index.ts` `wrap(new Map())`). If a future
engine implementation swaps the store for a different keyed container
(e.g. a hash-only structure, or a sorted-by-key map for some other
reason), all three resolution rules silently become non-deterministic.

Trigger to revisit: changing the edit-buffer store away from a native
`Map`. The fix path is either to keep `Map` semantics or to update all
three resolution rules to take an explicit insertion-order tiebreaker.

### Watch: `domain_words_from_app_schemas` substring-match defect

The deleted vocabulary scanner derived forbidden domain words from app schema
sources and substring-matched shared package files, producing false positives
like `position` (CSS property), `manager` (variable name in Sheet primitive),
`demo` (test fixture customer_id), or `hr` matching `throw`. Do not recreate
that brittle vocabulary or allowlist mechanism. Focused validators should use
structural ownership evidence such as resolved imports and package metadata.

Trigger to revisit: a focused structural validator cannot express a required
ownership rule. Extend the natural owner with positive and negative fixtures;
do not add repository-wide word scans.

### Watch: package subpath imports can bypass layer scanners

Workspace package imports need to classify both the root package name and any
subpath under it. Matching only exact package names lets imports such as
`@domain-libs/employee/__tests__/index.test` or `@autograph/hc/src/schema`
resolve to no scanner layer, which can bypass target-side bans and upward
import checks even when `@domain-libs/employee` or `@autograph/hc`
would be caught.

`mise run check:workspace-imports` maps `package-name/...` back to the owning
workspace package. Future package-name rules belong in that focused validator
with root-package and package-subpath tests.

### Watch: the agent boundary lint is a name-blocklist tripwire, not class analysis

The "no correctness above the kernel" lint (`docs/agent-foundation.md` §7) works
by flagging known validator names/patterns, not by classifying what code
actually does. A restated kernel check written under a fresh name passes clean.
Lint-green therefore means "no known pattern matched," NOT "no validation
mirror exists" — reviews of agent/compile paths must still read the code (the
M3 compile review caught date-regex/field-exists/change-type-target mirrors the
lint missed). Durable execution owner: AF `ad.8.13` — either harden toward class/scope
analysis or keep tripwire status deliberately.

Trigger to revisit: the second time a review catches a validation mirror the
lint passed, harden the lint rather than extending the blocklist one name at a
time.

## Shared-Origin Route-Zone Browser Trust

### Watch: Vercel Services configuration validation uses a digest-pinned schema

The Services checker validates each tracked `vercel.json`, and the independent-
app provisioner validates its proposed configuration, with exact-pinned Ajv
against a checked-in snapshot of Vercel's official project schema. The loader
verifies the snapshot's SHA-256 digest before compilation, and tests prove both
the retained configurations and a representative byte-level schema mutation.
There is no route-zone generator or generated deployment schema; the four
tracked Services configurations are the deployment inputs. Ordinary app
development and builds do not load this provider-only validation path.

Trigger to revisit: Vercel publishes a versioned offline validator or versioned
schema artifact. Replace the snapshot only when the new source preserves the
existing Services-config positive/negative matrix and digest-tamper proof.

### Watch: a Production proof failure is phase evidence, not a patch request

The Production proof composes independent control-plane, session, Gateway,
product-policy, ownership, denial, and recovery gates. A failure in a later gate
can occur after every earlier boundary has already succeeded. In particular, a
recognized synthetic session with correct tenant and application assignments
can still receive an app-owned HTTP 403 when its organization role is only
`member`; a read-only proof can also fail because a current provider binding is
unready, unreadable, ambiguous, or moved during the run. Neither result
justifies host normalization, broader trusted origins, retry expansion,
deployment selection, or a provider receipt patch.

Start from the fixed failure class and the first disproved invariant. Run the
sequence in
[Maintaining the Vercel Production proof](guides/maintaining-vercel-production-proof.md),
and require bounded runtime evidence before opening one contract-scoped PR.
Only the bounded read policy retries eligible transient reads. A recognition,
route-access, ownership, direct-denial, cleanup, or unclassified failure stays
failed closed. Repository proof never reconciles or mutates the Gateway.

Trigger to revisit: Vercel changes the observed promotion or alias-job response
contract, Better Auth changes its secure session-cookie contract, or an app
changes the QA actor's minimum role. Update fixtures, the security contract, and
the maintenance guide atomically before another Production mutation.

### Watch: inline scripts remain inside the reviewed-UI trust zone

The public gateway applies a non-widenable production CSP floor to Shell and
every route-owned zone. It blocks remote executable/resource origins,
`unsafe-eval`, and undeclared network origins. The ordinary local HMR daemon
adds an explicit `NODE_ENV=development` `unsafe-eval` allowance only to Next
zone policies for React/Turbopack; Vite zones and Browser QA retain the strict
floor. Deterministic source checks separately reject
runtime remote imports, raw HTML sinks, script-element construction, and
external stylesheets across app frontends. The CSP floor intentionally retains
`script-src 'unsafe-inline'` and `style-src 'unsafe-inline'` because per-request
nonces force dynamic rendering and currently conflict with the Cache
Components/PPR optimizations used by the native Next zones. That allowance
means a future markup-injection bug could have greater impact than it would
under a strict nonce- or hash-based policy.

`img-src data:` is a separate, fixed allowance for AG Grid's bundled SVG masks.
It is not app-declarable and does not extend script, style, connect, or frame
policy. Browser proof exercises the live HC grid so a blocked icon strategy
cannot hide behind Vendor-only coverage.

This is defense-in-depth, not application isolation. Shell and every reviewed
route-owned application share the public gateway origin and its browser
privileges even though they build and render independently. Never
restore same-origin remote HTML, head scripts, CSS, or ESM. If independently
controlled UI becomes a requirement, use a separately originated sandboxed
iframe or a constrained declarative renderer.

Trigger to revisit: Next supports strict CSP without disabling Cache
Components/PPR, or an injection finding changes the risk tradeoff. Move to a
nonce/hash-based policy then; do not loosen the generated origin allowlist as a
substitute.

## App Shell Pullouts (Option L)

The HC app shell's section-scoped pullout pane (today: Approvals) sits
alongside the page surface in a stable CSS grid. Toggling the pullout
must not remount the page (`apps/hc/frontend/src/shell/AppShell.tsx`
keeps `<main>` at the same tree position regardless of pullout state).
Two subtle behaviors fall out of that design.

### Watch: pullout data is cross-mounted from the visible page

`ApprovalsPullout` owns its own `useRecordReads` for positions +
lookups, mounted in parallel with whatever page is visible. Mutations
fired from inside the pullout (discard / publish / revert) refresh
the pullout's records but DO NOT refresh the visible page's data
(e.g., the Positions AG Grid will still show the pre-revert effective
date until the user navigates away and back, or until a section-wide
asOf change re-fetches).

Future pullouts that mutate records share this constraint. The fix is
to lift the section's `useRecordReads` calls into a shared provider
(probably alongside `AsOfProvider`) so the pullout and the visible
page consume the same instance; refresh once, both surfaces update.
Don't add a per-pullout invalidation channel — that's a worse shape
than shared reads.

### Watch: org-chart canvas does not re-fit when its container resizes

`@modules/org-chart`'s canvas computes its initial fit-to-content
once, then keeps its viewport. Opening a pullout narrows the surface
column from `1fr` to `1fr - 360px`, and the leftmost nodes can clip
beyond the canvas's left edge until the user pans manually.

Trigger to fix: a second pullout type lands (so opening the
right-side pane becomes more common), OR a panel-resize affordance
is added. The shape is a `ResizeObserver` on the canvas container
that re-runs fit-to-content when the container width changes
materially. Don't bolt this onto the pullout-toggle path in
AppShell — it belongs in the canvas module and applies to every
container resize, not just the pullout one.

### Watch: Approvals ships as TWO surfaces (page + pullout) with parallel controllers

The full `DraftReviewSurface`-driven page lives at `#/approvals`
(`apps/hc/frontend/src/pages/ApprovalsPage.tsx`); the queue lives in
the topnav pullout (`apps/hc/frontend/src/pages/ApprovalsPullout.tsx`).
Both mount their own `useDraftReview` controller AND their own
`useRecordReads` for positions/lookups. The two surfaces serve
different intents — page = table-style review workspace, pullout =
peripheral queue + inline action — and that's deliberate, but it has
two real consequences:

1. **Approvals-on-Approvals divergence.** When the user opens the
   pullout while on `#/approvals`, both surfaces would render the
   same data from independent controllers, and an action fired on one
   (page Publish, pullout Discard) updates ONLY that controller until
   the other refetches. To avoid this entirely, `App.tsx` SUPPRESSES
   the pullout descriptor when `route === "approvals"` — the toggle
   disappears in the topnav while on the page. That's the V0 policy.
2. **Pullout↔visible-page divergence (cross-mount staleness).** When
   the pullout is open over Positions or Org chart, mutations from
   the pullout update only the pullout's reads. The visible page
   keeps its stale view until something forces a refetch. Same
   underlying problem as #1 in a different surface pair.

Trigger to escalate: when the divergence in #2 becomes user-visible
(complaints, support tickets, telemetry showing repeat-discards), lift
the section-scoped reads (positions/lookups + the draft-review
controller) into shared providers parallel to `AsOfContext`. Don't add
per-controller invalidation channels — sharing read instances is the
better shape. The suppression in #1 is a stopgap; the real fix when
needed is also a shared controller, after which the toggle can come
back on `#/approvals` (the page and pullout will read from the same
source of truth).

Do not delete `ApprovalsPage.tsx` preemptively — the two surfaces
have intentionally divergent shapes (queue ↔ table) and sharing one
component for both ends up serving neither well.

## Custom Fields Surface Coverage

The kernel custom-fields substrate (`ad.5.8`) shipped. A shared, UI-neutral engine
owns the adapter that projects active custom-field definitions into a grid schema
and splits edited values back into `RowVersionWrite.custom_fields` before Save.
The shared editable grid applies that adapter itself, so every grid consumer
(source import, the CSV workspace, HC Positions) shows active custom fields, and
the draft-review/Approvals diff renders `CustomFieldDiff` beside declared-field
changes. Custom fields are a single sanctioned dynamic seam, so a new surface
that bypasses these shared pieces is easy to miss — nothing errors, the field
just does not appear.

### Watch: new surfaces must go through the shared custom-field seam

Any new record surface must reuse the shared grid or the custom-field projection
engine and keep writing through `RowVersionWrite.custom_fields` /
`clear_custom_fields`; it must not add another value store or write shape.
Every custom field type has a grid editor and is offered by the Add field form.
Date-and-time values are edited, pasted and shown in UTC: pasted text without
an offset is read as UTC, and a bare date is rejected rather than read as
midnight. A pasted list of text splits on commas and line breaks and drops
repeats, so an item containing a comma does not survive copy and paste.
Explore remains read-only.

### Watch: the custom-field retype invariant is documentation, not an enforced guard

The invariant that a `field_id` is permanently reserved per model and never
retyped (ad.5.3 / PR #150 ruling) is enforced within a single schema revision's
validation, but there is no cross-revision guard: nothing today rejects a
schema-revision transition that re-declares an existing `field_id` with a
different `field_type`/target. This is unenforceable until a schema-revision
transition/mutation path exists — which is exactly when it will bite, because
stored `custom_fields` values are interpreted through the field definition.
Backlog: `ad.5.7`.

Trigger to fix: the first schema-revision transition/mutation path lands; the
guard must land in the same PR, not after.

### Watch: custom fields cannot be named in records-by-model projections

HC `/api/records-by-model` field projections accept declared field ids only.
The read returns every record's custom values whatever the projection, so
Explore's graph and search loads keep a declared-field projection and leave
custom field ids out of it; only a caller that needs every declared field
drops the projection. `kernel_data_query` `select` does accept active custom
field ids. Explore treats lookup and entity custom fields the same way: on the
record page, in the model table, as graph edges and in history. Explore shows
custom values read-only; they are edited in the grids and, for lookups, in
lookup administration.

Trigger to fix: custom-value read size or latency becomes a problem on a
model with many custom fields; then let records-by-model projections name
active custom fields.

### Watch: search never matches custom values

Explore search and the link pickers match names, aliases and references only,
by owner decision: one search rule everywhere. To find records by a custom
value, filter that column in a grid (every grid column, custom fields
included, has a column filter). Matching custom text values is not planned;
it would need the generated SQL search clause to read `custom_fields`, which
means a new schema release for every app.

### Watch: a retired custom field's changes drop out of record history

The server's history read filters out retired custom-field definitions, so
past changes to a retired custom field no longer appear in a record's history.
Accepted by owner decision; not planned.

### Watch: record history does not say who made a change

Explore history shows how each change was made (Edit, Import, Agent, Seed
data) and its notes, never the actor. `/api/history` returns an opaque
`actor_id`, but HC has no actor-to-name read: names live in the auth service's
users table, behind the auth boundary. Deferred by owner decision.

Trigger to build: the first multi-person pilot, when a reviewer cannot tell who
made a change. Smallest shape: one scoped lookup of the distinct actor ids in a
history view, with the name beside the source label. Decide first: names or
emails, current names or names at the time, who may see them, and how
system, agent and import actors appear.

## SQL Compiler Coverage

### Guard: app-selected schema parity can hide uncompiled domain vocabulary

HC and Vendor currently select only a fraction of `domain-libs`. A compiler can
therefore reproduce both checked-in app schemas while silently dropping
properties or entire models that no current app selects. The known high-risk
examples are inverse collections, field notes, validation rules, prose-derived
values, no-op managed-field markers, and seed metadata.

The SQL-compiled kernel uses a source-ledger coverage gate over every domain
block and authored property. Every source path must map to normalized schema,
generated SQL, seed output, generated client metadata, or a structured compiler
rejection. App artifact parity is necessary but not sufficient, and an unknown
property must fail compilation rather than disappear from generated output.
