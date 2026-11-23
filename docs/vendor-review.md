# Vendor Review Queue

Status: active Vendor product contract; schema-gap audit and first-slice product
decisions approved.

Date: 2026-07-22.

This document reconciles the Review Queue developed in Portfolio donor PRs
#437 and #478 with the active Vendor app and schema on `main`. It is the
canonical input for the first Vendor product milestone. The decisions below
were approved before implementation began.

## Outcome

The Vendor app should give a reviewer one place to resolve questions about
canonical vendor-spend evidence. Review is a Vendor product workflow, not a
second Portfolio runtime and not generic kernel behavior.

The first accepted experience includes a review hub and these question types:

- vendor identity and possible duplicates;
- recurring versus one-time cadence;
- vendor type or spend category, after the authority decision below;
- incoming-only entities; and
- recurring transaction exceptions.

Every queue uses server-owned projections over `vendor` and
`vendor_spend_transaction`. Browser code receives generated, queue-specific
DTOs and submits narrow decisions. It does not reconstruct cross-model evidence
or author generic kernel writes.

## Non-negotiable interaction contract

The corrected behavior from PR #478 is retained:

- **Skip is navigation only.** It moves to another open item without writing a
  decision, hiding the item, or marking it Done.
- Only an explicit decision that succeeds on the server creates durable state
  and a local Done result.
- A page permits one mutation at a time. While it is writing, its rail,
  selection, skip, confirm, and competing batch actions are disabled.
- Stale loads and mutation responses from an old as-of date or superseded
  request cannot replace current state.
- A successful decision remains visible as Done in the loaded session snapshot
  and auto-advances to the next open item.
- The server re-derives the current question before writing and rejects stale or
  fabricated item identities and choices.
- Queue counts come from the same server projections as the queue pages. The
  donor's mixed client/server count calculations are not retained.

## Active Vendor foundation

Mainline already owns the normalized foundation:

| Authority | Existing canonical data used by review |
| --- | --- |
| `vendor` | record UUID, name, known aliases, status, type, department, owner, legal entity, default chart account |
| `vendor_spend_transaction` | record UUID, stable source reference and id, integration platform, source connection, provider, payload hash, transaction kind, vendor and chart-account relations, counterparty, document number, amount, currency, status, transaction and accounting dates, service dates, settlement date, source update time |
| `vendor_settings` | reporting currency |
| Kernel history | change-set identity, actor, source, idempotency, notes, status, activity, diffs, drafts, and row-version history |
| Connected integrations | Ramp, QuickBooks, and Xero app-owned recipes writing the same Vendor records |

The existing Vendor server exposes a one-model visible-record read and a
Vendor-metadata-only browser apply. It has no cross-model Review Queue
projection or narrow review mutation today. Its generated client includes no
Review Queue DTOs.

## Donor field reconciliation

The donor UI's old wire model must be rebuilt against Vendor data, not wrapped
in a compatibility translator.

| Donor datum | Vendor disposition |
| --- | --- |
| `vendor.ref` | Use the record UUID as durable identity and the name for display. Do not add a mutable UI ref solely for parity. |
| vendor name, aliases, status, legal entity, department | Reuse the existing Vendor fields. |
| donor `vendor.type` | Not automatically compatible. Donor and Vendor option sets and meanings differ; see Category authority. |
| committed spend, annualized cost, vendor end state, run rate | Read projections or future planning state. Do not add these stored Vendor fields. |
| P&L category and vendor budget | Not Review Queue state. Accounting categorization is chart-account based; forecasting and budgets remain separate. |
| transaction ref/source/id/hash | Use `source_record_ref`, `provider`, `source_record_id`, and `payload_hash`. |
| transaction vendor/date/amount/currency | Reuse the existing relation and fields. |
| `reporting_amount_usd` | Project same-currency values from `amount`, `currency_code`, and reporting currency. Do not store it. Do not sum mixed currencies without an FX authority. |
| `description` | No exact field. Use counterparty, document number, provider, status, and dates for the first queue unless source memo text is separately approved. |
| `source_category` | No exact field. `chart_account` is authoritative accounting evidence but is not the same as a provider category label. |
| `classification` | Do not copy blindly. Review eligibility and connected-source reconciliation need an explicit Vendor projection policy. CSV rows excluded before commit do not require a canonical exclusion field. |
| `cadence` | Genuine missing Review Queue state; persistence grain must be approved below. |
| raw source payload | Never add. Keep raw integration/CSV payloads transient and retain only approved source facts, hashes, and bounded provenance. |
| `analysis_dismissal` | Genuine missing resolution state, but the donor shape is insufficient because materially different outcomes can have identical stored values. |

## Queue data contract

### Review hub

The hub reads the five queue projections plus bounded current-state receipt
data. It derives display-only counts, coverage, ordering, and progress from
those responses. Browser visit time and open/expanded state remain local UI
state.

The donor's hub has known count inconsistencies: incoming-only labels and
dollars mix safe and ambiguous partitions, while the server count includes only
one partition; identity labels can include incoming-only lookalikes while its
server count includes only duplicate clusters. Vendor must define each card as
one exact server result and use the same result for count, dollars, label, and
navigation.

Scan automation and auto-apply receipts are not prerequisites for the first
durable manual Review Queue. If a scan control ships, it must invoke real
server-owned work and describe only work that actually ran.

### Identity and duplicates

Existing facts:

- Vendor record UUID, name, aliases, status, and legal entity.
- Linked transaction record UUID, amount, currency, date, provider,
  counterparty, document number, and source identity.

Server projections:

- conservative normalized-name match reasons;
- connected duplicate clusters with a versioned key over sorted Vendor UUIDs;
- member evidence counts and currency-aware totals;
- a recommended canonical Vendor using documented, stable tie breaks; and
- bounded transaction evidence.

Durable decisions:

- `keep_separate` records an explicit resolution for every matched pair in the
  reviewed cluster;
- `merge` records the canonical identity decision and makes current and future
  analytics resolve the dropped identities to the selected canonical Vendor.

The donor's current-row relation rewrite is not sufficient by itself. A later
QuickBooks, Ramp, Xero, or CSV update can attach evidence to the source Vendor
again and recreate the duplicate. Before implementation, identity resolution
must choose a durable canonical mapping or explicitly accept current-data-only
consolidation. The recommended product behavior is a durable app-owned mapping;
source Vendor rows remain available for provider matching and audit.

#### Identity first-slice projection policy

The first identity queue uses the following exact, deterministic policy:

- A Vendor is eligible only when it is a visible root identity with a
  non-empty name and at least one visible transaction dated on or before the
  requested `as_of` date whose amount is positive, whose Vendor relation
  resolves through the durable identity mapping, and whose trimmed currency
  code is non-empty. Negative and zero amounts are not identity-ranking
  evidence. Transaction status and provider do not change eligibility in this
  first slice; they remain display evidence only.
- Candidate names include the Vendor name and `known_aliases`. Matching applies
  Unicode NFKC normalization, retains letters, numbers, and combining marks,
  removes other characters, and lowercases the remainder. A pair
  matches only when normalized values are identical, when a prefix of at least
  four characters differs by no more than three trailing characters, or when
  values of at least five characters have Levenshtein distance one. Connected
  matching pairs form one cluster. The server indexes exact values, eligible
  prefixes, and one-edit signatures before applying the authoritative matcher,
  then walks an adjacency index to avoid scanning every Vendor pair and
  repeatedly scanning every retained edge. Candidate generation fails with the
  typed `identity_review_candidate_limit_exceeded` service-capacity response
  after 100,000 pair attempts; it never silently truncates a queue. An exact pair previously marked
  `keep_separate` contributes no edge.
- The queue orders clusters by eligible transaction count descending, then by
  the versioned cluster key ascending. Evidence shows the newest eligible
  transactions first, then transaction UUID ascending, and is capped at 50
  rows with an explicit truncation flag.
- The recommended canonical Vendor has the greatest eligible transaction
  count. A tied amount is considered only when every member has evidence in
  exactly the same single currency; otherwise mixed-currency amounts never
  break a tie. Remaining ties use exact Vendor display name ascending and then
  Vendor UUID ascending.
- Totals are exact decimals grouped by trimmed source currency. The queue never
  converts currencies or labels a mixed-currency total as USD.
- Reads may use an explicit historical `as_of` date, but a decision is accepted
  only for today's UTC snapshot. All Vendor browser writes, trusted integration
  writes, integration-maintenance writes, and identity decisions share one
  tenant-scoped transaction lock, so the server re-derives the question while
  conflicting Vendor facts cannot change underneath it.
- A same-request retry returns the currently active decision receipt. If that
  decision is later reverted, the question becomes pending again and the same
  choice creates a fresh ordinary change set with a new deterministic attempt
  identity; a historical reverted receipt is never treated as an active replay.

### Recurring cadence

Existing facts:

- Vendor relation, transaction date, amount/currency, transaction kind,
  provider/source identity, and status.

Server projections:

- eligible charge series;
- first and last charge dates, charge count, bounded recent evidence, and
  truncation state;
- observed gaps, median gap, and gap regularity;
- proposed cadence and confidence when a real proposal authority exists;
- recurring/one-time ambiguity and active-versus-historical-ending priority;
  and
- the exact current targets affected by confirmation.

Durable decisions:

- `annual`, `quarterly`, `monthly`, `bi_weekly`, or `one_time`;
- pending or unresolved work survives reload without inventing a default;
- active versus ended remains derived from cadence, latest eligible charge,
  and as-of date.

The donor stores cadence on every transaction. That is the smallest parity
addition, but the connected-integration product introduces a decision the
donor did not solve: Ramp and an ERP may describe the same economic event.
Cadence series grain and reconciliation must be explicit before persisting or
projecting a vendor-wide pattern. Options include per-transaction cadence as in
the donor or a separate Vendor-owned series/pattern record. This is a product
and data-contract checkpoint, not a kernel gap.

Agent scans and auto-approval are follow-up automation. The first manual queue
may use deterministic server-derived candidates and fixtures; it must not add
another local sidecar or depend on the broken Portfolio import planner.

### Vendor type or spend category

Existing facts:

- `vendor.type`, department, owner, and default chart account;
- transaction chart account, provider, counterparty, document number, amount,
  currency, and date.

The donor screen called this **Category** but wrote `vendor.type` with
`software`, `consulting`, `recruiting`, `marketing`, `facilities`, and `other`.
Main defines `vendor.type` as a management lens with `software`,
`professional_services`, `contractor`, `supplier`, `facilities`, and `other`.

**Decided and shipped: this queue is Vendor type.** It uses the Vendor `type`
option set from the active schema and writes only `vendor.type`, through a
narrow server route. `type` is a field on the vendor, so the unit the model is
asked about, the unit that gets written, and the unit a reader sees are the same
row -- which is what removes the fan-out-and-say-so step that typing spend per
charge would have needed.

What the shipped slice does:

- the queue projection returns untyped vendors busiest-first, bounded at 500,
  and carries `open_item_count` so a truncated page is told rather than read as
  a smaller backlog;
- the scan asks the model once per vendor and writes only answers at or above
  0.9 confidence, never `other` however confident the model is, and never a type
  outside the queue's candidate set;
- every automatic write records the model, the agent profile, the confidence,
  and the rationale in its provenance, and hand decisions record that a person
  made them; and
- the apply route enforces the confidence floor and the provenance requirement
  itself, because a confidence nobody checked is decoration.

Source/provider category labels are optional evidence and are not equivalent to
chart accounts.

### Missing transaction chart account

**Dropped.** This was scoped as the first accounting-category slice -- one queue
question per transaction with no `chart_account` -- and it is not being built.
Chart accounting is a different question from the one this product answers:
vendor type is what the spend views segment by, and it is answerable from
evidence the tenant already has. A per-transaction chart-account queue would ask
a person to do their accountant's job inside a spend tool.

`chart_account` and `vendor.default_chart_account` remain in the schema and
remain populated by import. Nothing reviews them, and no queue asks about them.

### Incoming-only entities

Existing facts:

- Vendor identity and Vendor-linked negative, zero, and positive transactions
  with dates, currencies, providers, and source evidence.

Server projections:

- vendors with at least one eligible negative amount and no eligible positive
  amount in the window;
- safe candidates with no name overlap against a spending Vendor;
- ambiguous candidates whose normalized name overlaps a spending Vendor;
- currency-aware incoming totals, counts, first/last dates, and bounded
  evidence.

Durable decisions:

- `exclude` and `keep_vendor` must remain materially distinguishable in current
  Vendor state;
- safe batch exclusion re-derives the exact safe set and returns per-item
  success/failure without marking failures Done.

The donor records both outcomes as the same `analysis_dismissal` values and
recovers intent only from ledger metadata. Vendor must not reproduce that
ambiguity. Product approval must also decide whether `keep_vendor` makes the
negative evidence participate in net spend or merely suppresses the question
until positive evidence arrives. The recommended behavior is that `exclude`
removes the subject from eligible Vendor analytics while `keep_vendor` retains
it as vendor credit evidence.

### Recurring transaction exceptions

Existing facts:

- accepted cadence plus adjacent eligible transaction dates and amounts.

Server projections:

- charges inside the documented fraction of an expected recurring cycle;
- transaction and Vendor identity, current and previous date, gap, expected
  gap, amount/currency, and bounded evidence.

Durable decisions:

- `expected` records an explicit resolution keyed by transaction UUID so the
  same finding stays resolved;
- **Flag in Transactions** is navigation, not a completed decision, unless a
  real flag workflow is separately added.

The donor exception modal derives this queue in the browser and uses a
browser-authored generic apply. Vendor should instead expose a server-owned
queue and narrow decision endpoint. If Flag remains navigation, it should deep
link to the exact transaction and must not show Done.

## Minimum app-owned additions

No kernel, generic source-import, or generic integration-substrate change has
been identified by this audit.

The minimum contract consists of:

1. Generated Vendor DTOs for one hub projection, each queue projection, and
   each narrow decision request/response.
2. Vendor server read operations that load and validate the required current
   records, derive bounded evidence, and keep card counts identical to queue
   contents.
3. Vendor server mutation operations that re-derive the item, own scope/actor/
   source/idempotency/provenance, serialize conflicting writes, and apply
   ordinary row-version changes.
4. An explicit Vendor-owned review-resolution model for decisions that do not
   otherwise change authoritative domain state. Its minimum information is a
   stable unique resolution key, review kind, stable subject key, explicit
   decision, resolution date, and reviewer. Allowed kind/decision pairs are
   app-validated.
5. App-owned change types for Vendor type review, spend-transaction review,
   and review-resolution creation/update.
6. Approved cadence persistence. If donor parity is selected, add transaction
   cadence with `annual`, `quarterly`, `monthly`, `bi_weekly`, `one_time`, and
   `unconfirmed`. If a source-series model is selected, document its grain and
   identity instead and do not add both representations.
7. A durable `vendor_identity_mapping` from each source Vendor to its canonical
   Vendor. The kernel model `external_key` is the stable unique mapping key;
   app projections follow the mapping while provider-owned transaction
   relations and their audit history remain unchanged.

Authoritative field mutations do not require duplicate resolution rows merely
for convenience:

- Vendor type acceptance writes `vendor.type`.
- Cadence confirmation writes the approved cadence authority.
- Identity merge writes/records the approved canonical identity authority.
- Keep-separate, incoming-only, and exception-expected outcomes use explicit
  review resolution because they otherwise have no authoritative field change.

## Currency and eligibility guardrails

- Exact decimals remain strings on queue wires unless a chart component needs
  a separately bounded numeric series.
- Queue totals are currency-aware. Mixed currencies are grouped or reported as
  unavailable; they are never silently labeled USD or summed without FX.
- Review evidence eligibility is app policy and must be documented before a
  queue uses amounts for priority or recommendation.
- Card and ERP evidence must not be assumed independent when both may represent
  the same economic event. Recurrence and actual-spend claims wait for an
  explicit reconciliation policy.
- Review projections may show source evidence without calling it authoritative
  actual spend.

## UI preservation ledger

Port the latest #478 behavior with real Vendor consumers, focused tests, and
stories. For the identity-only checkpoint, the accepted shared primitives are:

- `DecisionOptionCard`;
- `KpiCard`, `KpiCardGrid`, and `KpiPill`;
- `Listbox`;
- `PageHeader`;
- `Tag`.

`KpiAction`, `RingGauge`, `StatusStrip`, and `SparklineComposition` remain in
the preservation ledger for later accepted consumers; they are not added as
unused APIs in this checkpoint.

Reuse existing mainline Button, FieldFrame/Select, StatusPill, Modal, Tooltip,
DataTable composition, toast primitives, and existing icons. Port only missing
icons and tokens consumed by the accepted queue surface.

Keep the queue shell, controller semantics, pages, and evidence compositions
app-local under `apps/vendor`. Replace hash routes with Vendor-owned Next routes
such as `/review-queue/identity`; retain `/integrations` in navigation.

Do not ship broad unused donor APIs. `TableKit`, Feedback variants, dashboard
primitives, AG Charts, AppShell, and later analytics components move only with
their first accepted consumer. Forecasting mockups remain separate and are not
modified by this work.

## Approved product decisions

1. The donor Category queue becomes **Vendor type** and uses main's existing
   options.
2. Cadence is initially recorded per transaction. Currency and connected-source
   reconciliation guardrails remain mandatory before vendor-wide claims.
3. Identity merge creates a durable canonical mapping; it does not rewrite the
   provider-owned transaction snapshot.
4. `keep_vendor` includes negative evidence in net Vendor analytics;
   `exclude` is the distinct analytics exclusion.
5. **Flag in Transactions** remains exact navigation, not a durable decision.
6. Counterparty, document, provider, and status evidence is sufficient for the
   first product PR.

The first implementation checkpoint is the Review hub plus identity/duplicate
review only. The remaining approved queues follow after that surface compiles,
passes its focused tests, and is reviewed.
