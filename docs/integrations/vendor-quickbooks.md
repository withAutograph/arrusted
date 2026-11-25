# Vendor QuickBooks Integration

Status: development sandbox vendor/AP import, signed inline delivery, exact
replay, and production environment verification are proved; URL-backed and
production signed-delivery gates remain open.

## Scope

Build the first vendor app integration through Ampersand QuickBooks. Do not
build direct QuickBooks OAuth, direct QuickBooks API clients, provider retry
logic, local provider schema storage, or local integration tables.

V0 is read/import-first. QuickBooks writeback, generic provider marketplace UI,
and direct proxy flows are out of scope.

## Current Implementation Status

Date: 2026-07-20.

The checked QuickBooks contract reads `vendor`, `bill`, and `vendorCredit` and
applies them unconditionally through the common trusted-app contract. Vendor
matching is scoped to the same installation source reference. QuickBooks uses
exact slot-scoped groups, and the authenticated maintenance rebaseline emits an
ordinary app change set that tombstones only old-installation source
transactions. No legacy group alias, dual-group mode, or source-identity bridge
is retained.

The development project now has live signed sandbox proof for vendor and bill
inline reads, exact replay idempotency, persisted canonical rows, and installed
connection health. Live rollout gates remain closed for a URL-backed delivery,
the real maintenance-window cutover, and a signed production customer delivery.
The checked production manifest is deployed and verified, but configuration
proof does not replace customer delivery proof.

Implementation evidence:

| Area | Landed evidence | Current gate |
| ---- | --------------- | ------------ |
| Readiness/docs | PR #227 and PR #223/PR #263 documented the Ampersand direction, U0 no-go, and enforced boundaries. | U0 remains no-go for live enablement until live fixtures and authority fields are captured. |
| Shared wrapper | PR #231 added `packages/integrations` around Ampersand prebuilt React components. | Package must remain wrapper-only. |
| Manifest/config | The checked production/sandbox manifests and app recipe cover vendor, bill, and vendorCredit with generic destination signing-secret names. Nested QuickBooks fields use Ampersand bracket JSONPath. The corrected production manifest deployed from merge `38fbd7bc` and the production verifier passed. | URL-backed and signed production delivery proof remain open. |
| Vendor app | PR #236 and PR #240 added vendor schema, backend apply bridge, records/home, and app registration. | Browser/generic apply cannot forge integration provenance. |
| Install UI | PR #245 and PR #251 added the Ampersand install UI and token auth path. | Requires authenticated customer/actor context for real installs. |
| Apply recipe/compiler | PR #238 and PR #264 added the QuickBooks apply recipe and generic `packages/integration-compiler`. | Compiler stays generic; app recipe owns provider semantics. |
| Webhooks/authority | Signed development vendor and bill deliveries passed Svix, Platform API authority, recipe compilation, and trusted apply through Hookdeck. | Signed production-route proof remains required. |
| Source-reference replay | An exact Hookdeck retry returned the same change set with `replayed=true`. Stable installation/object/source references and version identity make repeat deliveries deterministic. | Subscribe mutation paths remain disabled. |
| Maintenance | The slot-scoped rebaseline route locks the old installation and applies transaction tombstones atomically; exact request replay returns the same change set. | Execute and record the controlled live maintenance window before deleting the old installation. |
| Health/proof | The authenticated local app showed the selected QuickBooks installation healthy and 26 current vendor records after live reads. | URL-backed and production customer smoke remain required. |

### Live Development Evidence: 2026-07-20

The distinct Ampersand development project verified successfully with provider
`quickbooksSandbox`, the checked three-object manifest, both Hookdeck
destinations, 12 notification routes, the exact accounting-only provider scope,
and the configured JWT key. The connected QuickBooks sandbox installation
`6104714b-b940-47a8-818e-23e4a7f2aaec` is scoped to group
`dev:quickbooks:8d7a8769-3c39-460d-ae98-991b74ed70c5` and sandbox company
`9341457416341604`.

Fresh triggered operations produced:

| Object | Operation | Records | Hookdeck result |
| ------ | --------- | ------- | --------------- |
| `vendor` | `019f811c-78f1-7bfa-ab07-de3918be9acb` | 26 | Event `evt_oIDQa9P0TQ46whfl12`, signed inline delivery, HTTP 200, existing change set `10` returned with `replayed=true`. |
| `bill` | `019f811c-7c78-75f9-9b68-35812a31f75e` | 15 | Event `evt_FEafMHcsRIh9tpVP0q`, signed inline delivery, HTTP 200, new change set `11`. An immediate exact-event retry returned HTTP 200, the same change set, and `replayed=true`. |
| `vendorCredit` | `019f811c-8090-767d-9f0d-5d32a13cf7b6` | 0 | Successful zero-record operation; no non-empty apply was expected. |

Hookdeck preserved `svix-id`, `svix-signature`, and `svix-timestamp` on both
non-empty deliveries. The vendor database contains 26 vendor versions from the
proved vendor change set and 15 bill versions from the bill change set. Every
bill has non-null vendor, amount, currency, transaction date, and source update
time, and all 15 vendor relations resolve to visible canonical vendor rows. The
authenticated app health surface reported the selected installation healthy;
the records surface reported 26 current vendor records.

The same run exposed and corrected a manifest defect: Ampersand nested field
mappings require bracket JSONPath. Dot paths omitted `VendorRef`, `CurrencyRef`,
and `MetaData.LastUpdatedTime` from live mapped fields. The corrected sandbox
manifest was deployed and the development verifier plus signed bill apply
proved the fix.

This sandbox data set emitted `resultInfo.type=inline` for both non-empty reads.
Ampersand [documents URL mode](https://docs.withampersand.com/destinations/webhooks)
only when one provider record exceeds 300 KB; the trigger-read API has no option
to force the delivery shape. The connected
QuickBooks sandbox has no record near that threshold, so a live URL-backed
delivery cannot currently be induced through this provider fixture. Unit and
contract tests cover the constrained URL downloader, but test proof does not
close the live URL gate. Closing it requires either an Ampersand-supported test
fixture/override or a naturally oversized provider record; this is an external
testability blocker, not a reason to weaken download validation.

## Files And Ownership

`packages/integrations` provides only the reusable Ampersand wrapper used by the
vendor app UI and token request shape. QuickBooks app semantics, Platform API
clients, provider capability catalogs, and manifest/config helpers do not live
in the package.

Expected package areas:

- `packages/integrations/ampersand/react.tsx`
- `packages/integrations/ampersand/provider.tsx`
- `packages/integrations/ampersand/token.ts`
- `packages/integrations/ampersand/styles.css`

Expected vendor app/backend areas:

- `apps/vendor/integrations/ampersand/quickbooks/amp.yaml`
- `apps/vendor/integrations/ampersand/quickbooks/README.md`
- `apps/vendor/integrations/ampersand/quickbooks/config.ts`
- `apps/vendor/integrations/ampersand/quickbooks/field-mapping.ts`
- `apps/vendor/integrations/ampersand/quickbooks/apply-recipe-contract.ts`
- `apps/vendor/integrations/ampersand/quickbooks/apply-recipe.ts`
- `apps/vendor/integrations/ampersand/quickbooks/apply-recipe.json`
- `apps/vendor/integrations/ampersand/quickbooks/ingest.ts`
- `apps/vendor/integrations/ampersand/quickbooks/notifications.ts`
- `apps/vendor/integrations/ampersand/quickbooks/rust-bridge.ts`

The vendor app imports `@autograph/integrations` and supplies customer scope,
actor id, app route mounts, and app-owned manifest/config choices. Provider
object choices, QuickBooks field semantics, and source-reference policy stay in
the vendor app's integration recipe. Webhook verification, Ampersand envelope
parsing, Platform API authority checks, recipe-driven normalization, and
`ApplyChangeSet` compilation stay in vendor app TypeScript integration code
outside core kernel apply. Durable writes go through the vendor app backend apply
path into kernel apply. Rust in the vendor app is for schema materialization,
route authorization, and the kernel apply bridge; do not implement QuickBooks or
Ampersand provider ingress/compiler logic in Rust without a separate explicit
plan and scanner update.

## Manifest Shape

The Ampersand manifest defines a QuickBooks integration under `apps/vendor`
using Ampersand's `specVersion` and `integrations` shape. The first manifest
should use read actions only for objects the vendor app can immediately compile
into its schema. QuickBooks subscribe actions stay absent from V0 until support
and a real subscribe fixture are proved.

Before implementation, run a readiness gate and record the result here:

- which candidate QuickBooks objects Ampersand supports for the development
  project
- which object/field combinations have representative sandbox payload fixtures
- whether the sandbox produced inline results, URL results, subscribe events, or
  a documented deferral
- which notification topics are enabled for V0
- which installation and operation Platform API fields are available for
  authority checks

Candidate QuickBooks objects:

- vendor
- bill
- bill payment
- account
- purchase
- purchase order
- vendor credit
- class
- department
- budget, if available in the connected QuickBooks plan and supported by
  Ampersand

## U0 Readiness Gate Result

Date: 2026-07-02.

Result at U0: **No-go for package, app runtime, kernel direct-apply
implementation, or manifest expansion beyond the minimal app-owned
contract.** U6 supersedes the runtime portion of this historical result:
deployed integrations now apply every accepted delivery without a toggle. The
public Ampersand and Intuit documentation prove that the
QuickBooks connector is a plausible V0 read path for the candidate object
set, but this workspace does not have Ampersand or QuickBooks sandbox
credentials. No live development project, sandbox installation, operation,
or signed delivery was available to capture.

A-109's U3 manifest remains a constrained app-owned contract artifact:
production `amp.yaml` uses provider `quickbooks`, sandbox
`amp.sandbox.yaml` uses provider `quickbooksSandbox`, both manifests
include only the `vendor` read object, and reference, transaction,
aggregate, write, and subscribe objects stay absent. Implementation units
after U0 landed as gated runtime code. U6 removes the inline and URL apply
gates; manifest expansion and production installation rollout remain subject
to the live sandbox gates at the end of this section.

Evidence sources:

- [Ampersand QuickBooks provider guide](https://docs.withampersand.com/provider-guides/quickbooks):
  production provider `quickbooks`, sandbox provider `quickbooksSandbox`,
  read/write/proxy actions, and QuickBooks object support.
- [Ampersand read actions](https://docs.withampersand.com/read-actions):
  object-level destinations, schedules as frequent as every 10 minutes,
  optional backfill, and asynchronous triggered reads.
- [Ampersand webhook destinations](https://docs.withampersand.com/destinations/webhooks):
  read/subscribe webhook envelope, inline results, URL results,
  `resultInfo.downloadUrl` expiry after 15 minutes, 300 KB webhook payload
  threshold, default message frequency, and Svix signature verification.
- [Ampersand subscribe actions](https://docs.withampersand.com/subscribe-actions):
  subscribe is provider-specific, uses destination names and inherited read
  fields/mapping, and emits create/update/delete event metadata when supported.
- [Ampersand notifications](https://docs.withampersand.com/notifications/overview)
  and [notification payloads](https://docs.withampersand.com/notifications/notification-payloads):
  topic-routed lifecycle, read, connection, and destination notifications.
- Ampersand Platform API references for
  [installation](https://docs.withampersand.com/reference/installation/get-an-installation),
  [operation](https://docs.withampersand.com/reference/operation/get-an-operation),
  and
  [integration](https://docs.withampersand.com/reference/integration/get-an-integration-by-id-or-name)
  authority checks.
- Intuit SDK/API reference pages for field shape spot checks:
  [Vendor](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/cc868ac6-79b2-d83b-6072-2d484c3e05b6.htm),
  [Bill](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/08b663fd-794a-fb45-eba9-642b5dc606c3.htm),
  [Account](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/3bb29a12-13fc-0e5b-5511-8d08dbac5cfc.htm),
  [Purchase Order](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/4cc4fa34-a7cc-1731-9ea9-14c7dc4607d6.htm),
  [Purchase](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/00fa13c7-5af6-952f-853a-f3ae84f21ecf.htm),
  [Budget](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/1f06b366-6610-5e40-279e-2f7bc2e01642.htm),
  [Class](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/780d0f47-fcc8-f725-a8eb-6f34a8cab7aa.htm),
  and
  [Department](https://static.developer.intuit.com/sdkdocs/qbv3doc/ippdotnetdevkitv3/html/d658b447-b3f9-26f1-3a65-e213cfe3c379.htm).

### Object Coverage

The Ampersand QuickBooks guide lists every candidate object below as supported
for read and write through both `quickbooks` and `quickbooksSandbox`. V0 still
must keep the manifest narrower than provider support: only objects with app
schema targets, relation closure, sandbox fixtures, and deterministic recipe
policy may compile.

| QuickBooks object | Ampersand support                                                                                            | Current app-schema target                                                                  | Required source evidence                                                                                                                            | U0 decision                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor`          | Supported for read/write                                                                                     | `vendor` in `packages/domain-libs/catalog.json`                                            | `Id`, display/legal name fields, active/status signal, metadata/update time, optional contact/balance fields, source ref for deterministic matching | Candidate for first live sandbox fixture. A sanitized inline read fixture exists at `docs/integrations/fixtures/ampersand-quickbooks-read-inline-vendor.json`, but it is not a live sandbox capture. |
| `account`         | Supported for read/write                                                                                     | Source-populated `chart_account`                                                           | `Id`, `Name`, `AccountType`, `AccountSubType`, `Classification`, parent/sub-account fields                                                          | Schema-ready as customer chart-of-accounts vocabulary; direct mapping remains deferred until a live fixture proves provider identity and hierarchy behavior.                                        |
| `class`           | Supported for read/write                                                                                     | Possible relation/lookup evidence; exact app target undecided                              | `Id`, `Name`, `FullyQualifiedName`, `Active`, `ParentRef`, `SubClass`                                                                               | Defer until evidence shows whether QuickBooks class maps to `department`, another customer dimension, or no V0 field.                                                                               |
| `department`      | Supported for read/write                                                                                     | Possible `department` relation dependency                                                  | `Id`, `Name`, `FullyQualifiedName`, `Active`, `ParentRef`, `SubDepartment`                                                                          | Candidate dependency only after U4 schema closure proves how QuickBooks departments align with app departments.                                                                                      |
| `bill`            | Supported for read/write                                                                                     | Provider-neutral `vendor_spend_transaction` parent row                                     | `Id`, `DocNumber`, `VendorRef`, `TxnDate`, `DueDate`, `TotalAmt`, `Balance`, `CurrencyRef`, `MetaData`                                  | U13 maps kind `bill`, positive total/open amount, and the canonical vendor relation before any aggregate.                                                                                              |
| `billPayment`     | Supported for read/write                                                                                     | No payment source model in `packages/domain-libs/catalog.json`                             | `Id`, `VendorRef`, `TxnDate`, payment type/account references, `Line.LinkedTxn`, `TotalAmt`, `CurrencyRef`, `MetaData`                              | Deferred from direct apply until bill/payment source models and matching policy exist.                                                                                                               |
| `purchase`        | Supported for read/write                                                                                     | No transaction source model in `packages/domain-libs/catalog.json`                         | `Id`, `AccountRef`, `EntityRef`, `PaymentType`, `TxnDate`, `Line`, `DepartmentRef`, `TotalAmt`, `CurrencyRef`, `MetaData`                           | Deferred from direct apply. Purchases can become evidence only after U4/U7 add canonical source rows.                                                                                                |
| `purchaseOrder`   | Supported for read/write                                                                                     | No purchase-order source model in `packages/domain-libs/catalog.json`                      | `Id`, `DocNumber`, `VendorRef`, `TxnDate`, `DueDate`, `ExpectedDate`, `Line`, `DepartmentRef`, `TotalAmt`, `CurrencyRef`, `MetaData`                | Deferred from direct apply until purchase-order source rows and update/close policy exist.                                                                                                           |
| `vendorCredit`    | Supported for read/write                                                                                     | Provider-neutral `vendor_spend_transaction` parent row                                     | `Id`, `DocNumber`, `VendorRef`, `TxnDate`, `TotalAmt`, `CurrencyRef`, `MetaData`                                                        | U13 maps kind `credit`, normalizes the signed amount negative, and preserves the canonical vendor relation.                                                                                            |
| `budget`          | Supported for read/write by Ampersand docs; Intuit budget availability depends on the connected company plan | No direct model; vendor budgets are authored from planning-component periods               | `Id`, `Name`, `StartDate`, `EndDate`, `BudgetType`, `BudgetEntryType`, `Active`, `BudgetDetail` entries and dimensions                              | Deferred until a live QuickBooks sandbox proves whether source budget dimensions can map honestly to vendor planning components.                                                                    |

Deferred QuickBooks objects for V0: every non-candidate object in the Ampersand
QuickBooks guide, all read-only tax/exchange-rate/customer-type objects, and
write-only inventory adjustment/tax service objects. `attachable` is also
deferred because V0 has no raw attachment retention or document ingestion
policy.

### Delivery Mode

V0 delivery should use two Ampersand webhook destinations configured in the
Ampersand project:

- `vendorQuickBooksWebhook` for read deliveries. Route all V0 read objects to
  this destination unless U6 proves per-object destinations are operationally
  safer.
- `vendorQuickBooksNotifications` for Ampersand lifecycle/status
  notifications.

Each shared project destination needs its own Svix signing secret in server
config: `AMPERSAND_READ_WEBHOOK_SIGNING_SECRET` and
`AMPERSAND_NOTIFICATION_WEBHOOK_SIGNING_SECRET`. Do not reuse one
secret across two destination names. If U6 collapses read deliveries and
notifications into one physical Ampersand destination, document the single
destination name and use one signing secret for that route instead.

Read delivery shape is proved from Ampersand's webhook schema and pinned by the
sanitized fixture at
`docs/integrations/fixtures/ampersand-quickbooks-read-inline-vendor.json`.
Required signed envelope fields before compile are `action`, `projectId`,
`provider`, `groupRef`, `installationId`, `installationUpdateTime`,
`objectName`, `operationId`, `operationTime`, `readType`, and `resultInfo`.
Inline envelopes must include `result[].raw` and
`result[].mappedFields`. URL envelopes must include `resultInfo.downloadUrl`;
the downloaded payload must parse to the same `result[].raw` /
`result[].mappedFields` shape before compile or apply. `rawObjectName`,
`workspace`, `consumerRef`, and `consumerName` are useful provenance when
present but are not tenant authority.

The fixture intentionally keeps QuickBooks `Balance` only in `raw`.
It must not map `Balance` into `vendor.committed_spend`; QuickBooks vendor
balance is the current AP/open balance, not an annual commercial commitment.
The fixture includes `source_record_id` in `mappedFields`. U7 source refs for
mapped provider fields must be built from `mappedFields.<mapToName>` in the
app-owned recipe, paired with envelope context such as `installationId` when
needed. `raw` provider data is a transient recipe input; it
must not be persisted or logged, become model external keys, or replace
mapped-field source identity.
The app-owned recipe separately declares provider version metadata for read
idempotency. For QuickBooks vendor reads, `raw.SyncToken` and
`raw.MetaData.LastUpdatedTime` participate in the `change_set.source_ref`
record-set identity while the stable mapped source reference remains the model
matching key.

Ampersand read delivery has two result modes:

- `resultInfo.type = inline`: `result` is delivered in the webhook body.
- `resultInfo.type = url`: the webhook omits `result`, includes
  `resultInfo.downloadUrl`, and the signed URL expires after 15 minutes.

U6 implements both modes with unconditional apply for deployed integrations. URL payloads must
be downloaded server-side in the verified webhook path, not enqueued as signed
URLs. Ampersand documents URL mode when a single record exceeds 300 KB and large
result sets as multiple webhooks, with a default limit of at most 1000 webhook
messages per second across destinations. Read schedules may be as frequent as
every 10 minutes; triggered reads are asynchronous. U6 must not key replay or
idempotency on `operationId` alone; replay proof uses a
provider/Ampersand message identity for split inline deliveries or a
deterministic record-level identity available before any URL payload download,
such as installation/object/source ref plus provider update/version metadata.
Payload hash may be stored after payload access for provenance and
duplicate/conflict checks. Non-empty URL deliveries must still download and
compile before accepting an existing change_set replay result so trusted apply
can validate source-record and payload provenance.

Subscribe delivery is **deferred** for QuickBooks V0. Ampersand's general
subscribe docs require provider-specific support, but the QuickBooks provider
guide lists read, write, and proxy actions only. No QuickBooks subscribe action,
subscribe fixture, or subscribe event route may be enabled until the QuickBooks
guide or a live Ampersand project proves support and a real subscribe delivery
fixture is captured. Lifecycle/status notification routes remain required for
the V0 read path.

V0 notification topics to configure:

- `installation.created`
- `installation.updated`
- `installation.deleted`
- `read.backfill.done`
- `read.schedule.paused`
- `read.triggered.done`
- `read.triggered.error`
- `connection.created`
- `connection.refreshed`
- `connection.deleted`
- `connection.error`
- `destination.webhook.disabled`

Do not enable `write.async.done` for V0 because QuickBooks writeback is out of
scope. Do not enable `subscribe.create.error` unless subscribe support is later
proved and a subscribe action is added to the manifest.

### Platform API Authority Fields

The webhook envelope can prove delivery identity, but authority checks must use
Ampersand Platform APIs before any kernel write:

| Check                                   | Platform/API source                    | Required fields                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project and provider                    | Delivery envelope plus integration API | Envelope `projectId` and `provider`; integration `id`, `projectId`, `provider`, `name`, latest revision content                                                                                       |
| Installation/customer authority         | Get installation                       | `id`, `projectId`, `integrationId`, `healthStatus`, `connection.status`, `group.groupRef`, `group.projectId`, `config.id`, `config.revisionId`, `config.content`, `lastOperationStatus`, `updateTime` |
| Operation authority for read deliveries | Get operation                          | `id`, `projectId`, `integrationId`, `installationId`, `configId`, `actionType`, `status`, `metadata`, `createTime`                                                                                    |
| Config freshness                        | Installation and operation             | Installation `config.id` and `installationUpdateTime`; operation `configId` when an `operationId` is present                                                                                          |
| Action type                             | Envelope and operation                 | Envelope `action`; operation `actionType` must match when operation lookup is available                                                                                                               |
| Group/customer scope                    | Delivery envelope plus installation    | Signed webhook body `groupRef`; installation `group.groupRef`; app route's expected app customer scope                                                                                           |

Reject before apply when project, provider, installation, group/customer scope,
action type, operation identity, config freshness, or health/status does not
match the app route configuration and Ampersand Platform API state.

### Live Go Gates

Before manifest expansion or production customer traffic:

- Capture a live QuickBooks sandbox read delivery for `vendor` through
  `quickbooksSandbox` and add it beside the sanitized fixture. Mark sanitized
  examples separately from live captures.
- For every object U7 will compile, capture one representative sandbox fixture
  or explicitly defer the object in this section and in the first `amp.yaml`.
- Trigger or observe at least one `resultInfo.type = url` delivery caused by a
  single record over 300 KB and prove the constrained download path.
- Trigger or observe a multi-message inline read delivery for one operation,
  including any large-result or total-payload experiment that produces multiple
  webhooks, or prove the webhook envelope contains enough per-message/chunk
  identity for U6 idempotency.
- Confirm the live Ampersand development project exposes the installation,
  integration, operation, group, provider, health/status, config, and action
  fields listed above.
- Run the production signed-delivery smoke against
  `https://apps.autograph.so/vendor/api/integrations/ampersand/webhook` and
  record the deployment id, delivery type, and outcome here.
- Keep subscribe disabled unless the QuickBooks connector gains documented or
  live-proven subscribe support and a subscribe fixture is captured.

Only include objects that are covered by the vendor app schema and a tested
compiler path. The manifest is allowed to be smaller than the long-term object
list.

The vendor schema must include an explicit closure for selected integration
fields: target models, relation/lookup dependencies, any source refs the app
recipe needs for deterministic matching, and deferred fields. Do not assume
the `vendor` record alone is the complete app schema slice.

Do not map QuickBooks transaction deliveries directly into rolled-up vendor
spend totals unless the vendor app schema also stores the contributing
transaction rows as canonical app data. Without those source rows, out-of-order
deliveries, voids, and updates cannot recompute a trustworthy aggregate. Defer
aggregate writes until the schema and recipe include the source transaction
models needed to rebuild them.

## Apply Behavior

The vendor app integration compiler consumes Ampersand `mappedFields` as the
app-facing payload and applies the vendor app's QuickBooks recipe. Source refs
for mapped provider fields come from `mappedFields.<mapToName>`; the compiler
may read `raw` provider data only for deliberately unmapped envelope
or provider metadata. The kernel receives only the resulting ordinary
`ApplyChangeSet` write envelope.

Create/update behavior:

- Direct apply is unconditional for every deployed integration after signature,
  authority, resource, recipe, matching, idempotency, scope, and trusted-apply
  verification. Inline and constrained URL-backed deliveries accept no runtime
  toggle. Live-readiness gates control installation rollout rather than apply
  behavior.
- Compile normalized QuickBooks deliveries into ordinary `ApplyChangeSet`
  input.
- Submit compiled writes through the vendor app apply endpoint or persistence
  bridge; do not persist canonical app data directly from TypeScript package
  code.
- Use `change_set.source_kind = 'integration'` only inside the trusted vendor
  app integration ingress path. Browser or generic app writes must not be able
  to forge integration provenance.
- Derive replay idempotency keys from verified Ampersand envelope identity before
  any URL payload download. Source refs can include envelope identity and, after
  payload retrieval, source record refs. Payload hashes are provenance/conflict
  checks; non-empty URL deliveries still download and compile before replay
  success is returned so trusted apply can verify persisted payload provenance.
- A valid read delivery that declares zero records is acknowledged as a
  structured successful no-op. It must not download a URL payload, call trusted
  apply, open a kernel `change_set`, or return an error that would cause
  webhook retries.
- Validate delivery project, installation identity, signed `groupRef` customer
  scope, and app write policy before kernel apply. Environment is inferred from
  the configured Ampersand project/destination.
- Confirm installation and operation authority with Ampersand Platform API data
  before apply, and reject wrong project, wrong provider, wrong group, stale
  config, deleted/uninstalled installation, or missing required delivery
  identity. Operation id is required only for delivery shapes that include one.
- Reject automated update/delete when the app recipe cannot deterministically
  match the target canonical record from app schema data and Ampersand delivery
  context.
- Treat repeat QuickBooks source rows as update attempts once the app has
  resolved their source reference to an existing vendor record. The V0 recipe
  enables `permissions.update` only for deterministic read-repeat source
  matches. Compiled QuickBooks writes still must not emit caller-supplied
  `record_id`; the trusted vendor backend is the only component that may set the
  kernel `record_id` after source-reference lookup, provider-clear checks, and
  authority validation pass. Persist the stable QuickBooks source reference only
  as app-owned source identity, such as version-row provenance or a future
  app-owned side table/field, not as model `external_key`.
- The current trusted vendor apply route rejects any caller-supplied
  `record_key`. Runtime delete enablement still needs a separate app-owned
  trusted-delete policy that carries recipe/version proof into apply; until then,
  delete/tombstone writes are not accepted by the live trusted route.
- Reject updates that clear a provider value when the app recipe has no explicit
  clear-field workflow for that target field. V0 `ApplyChangeSet` can set or
  replace supplied values, but it cannot express clearing a field; do not silently
  leave stale application values after QuickBooks sends `null` or omits a previously
  mapped value.
- For creates, omit optional mapped fields that are absent from the provider
  payload. For updates, absence of an optional mapped field listed in
  `cleared_fields` is a provider clear and must be rejected until the recipe
  owns an explicit clear workflow. Explicit `null` for a listed field is always
  rejected.
- Do not use `external_key` as a QuickBooks id.
- Do not persist Ampersand installation config, mapping config, selected fields,
  operation logs, or notification envelopes locally.
- For URL result payloads, require HTTPS, enforce expected host/IP constraints,
  reject private-network redirects, bound response size and timeouts, require
  JSON, and redact signed URLs from logs.

### Source Reference Matching

The QuickBooks vendor recipe persists provider source identity as app-owned
write provenance, not as kernel model identity. Each compiled row-version write
must include:

- `provenance.source_record_ref`: stable source reference built from
  installation id, object name, and mapped QuickBooks source record id.
- `provenance.payload_hash`: payload fingerprint used only to detect conflicts
  on exact replay identities.
- `provenance.mapped_field_ids`: target fields covered by the recipe so later
  matched deliveries can fail closed when QuickBooks omits a previously visible
  value.

The TypeScript compiler must not set `record_key` for QuickBooks deliveries.
The trusted vendor app backend rejects any caller-supplied kernel `record_key`,
locks by `(app_id, customer_id, model_id, source_record_ref)`, and performs one
mainline provenance lookup for matching:

- no prior row for the source ref: keep the write keyless and create a new
  canonical vendor row;
- exactly one prior row: lock that kernel row, verify provider-clear and
  same-day replay policy in the same transaction, then resolve the write to that
  row's kernel `record_id` before calling kernel apply;
- multiple prior rows: reject as ambiguous before kernel apply.

Repeat deliveries for the same QuickBooks source row are deterministic:

- exact envelope replays return the existing successful `change_set` only when
  persisted `source_record_ref` and `payload_hash` match;
- same-source, same-effective-date repeats with identical values return the
  existing same-day `change_set`;
- same-source, same-effective-date deliveries with changed values fail closed;
- same-source deliveries with a later effective date may update the matched
  canonical row after the source ref resolves uniquely and no provider-clear
  condition is detected.

Provider clears, delete/tombstone writes, stale/deleted/uninstalled
installation authority, missing source refs, missing payload hashes, missing
mapped field metadata, and ambiguous source refs are rejected before kernel
apply. Do not enable QuickBooks subscribe/delete or uninstall-driven mutation
until a separate recipe, authority proof, and tests define those paths.

## UI

The vendor integrations page uses the shared Ampersand wrapper from
`@autograph/integrations/ampersand/react`. It renders Ampersand's prebuilt
`InstallIntegration` flow for QuickBooks and reads authenticated installations through
Ampersand UI/headless state or app-owned server helpers that call Ampersand
Platform APIs.

The page may show Autograph-side processing state from recent
integration-sourced `change_set` rows. It must not invent local installation or
sync-status tables.

The install UI must cover loading, empty and multi-install results, missing
config/disabled, unauthorized, session fetch failure, install in progress,
installed, update available, update
completed, cancelled/interrupted, and component error states. It must support
keyboard navigation, focus return, accessible status/error announcements, and a
mobile breakpoint.

Health status precedence is:

1. unauthorized or misconfigured application route
2. invalid or missing Ampersand destination
3. unhealthy or disconnected Ampersand installation
4. Ampersand operation in progress
5. latest Ampersand operation failed
6. stale or no recent successful sync
7. healthy

V0 does not expose Autograph reprocess controls for failed applies: failed kernel
apply rolls back before an integration-sourced `change_set` is observable. Do
not promise UI reprocess for signature/authority rejects, failed applies, or
other failed pre-apply deliveries unless a separate delivery-outcome store is
designed.

## Sandbox Smoke

Before production work, prove the development path with a QuickBooks sandbox:

1. Start local daemons with `mise run start`.
2. Run `mise run setup:vercel-env` before starting the callback bridge so the
   process reads the authoritative generic shared signing-secret values.
3. If the shared development `quickbooksSandbox` provider app is missing or
   intentionally being rotated, store
   `AMPERSAND_DEVELOPMENT_QUICKBOOKS_CLIENT_ID`,
   `AMPERSAND_DEVELOPMENT_QUICKBOOKS_CLIENT_SECRET`, and only an
   accounting-only `AMPERSAND_DEVELOPMENT_QUICKBOOKS_SCOPES` value when a scope
   assertion is needed in the local fnox `local` profile, then run
   `mise //apps/vendor:ampersand:sync-provider-app -- development`.
   Normal local callback setup skips this provider-app mutation.
4. Start the Hookdeck-backed callback bridge with
   `mise //apps/vendor:ampersand:local-callback`.
5. Run `mise //apps/vendor:ampersand:setup-dev` against the existing distinct read and
   notification destinations.
   To combine the explicit provider-app mutation with this setup command, add
   `PLATFORM_AMPERSAND_SYNC_PROVIDER_APP=true`; otherwise the setup task only
   deploys the sandbox manifest, preserves destination URLs, and wires routes.
6. Confirm the final `ampersand:setup-dev` verification passes. To rerun
   verification separately, set
   `PLATFORM_AMPERSAND_DEVELOPMENT_READ_HOOKDECK_URL` and
   `PLATFORM_AMPERSAND_DEVELOPMENT_NOTIFICATIONS_HOOKDECK_URL` to the exact
   Hookdeck callback URLs before running `mise //apps/vendor:ampersand:verify -- development`.
7. Connect a QuickBooks sandbox company through `InstallIntegration`.
8. Trigger the first read/backfill.
9. Verify the webhook receiver rejects missing or invalid Svix signatures.
10. Verify both inline and URL-backed reads apply without a direct-apply flag
    after the production rollout gate records signed delivery, authorization,
    sandbox fixture, and URL-result proof.
11. Verify an accepted delivery creates or updates vendor app row-version data.
12. Verify the app apply endpoint rejects scope or installation mismatches before
   kernel apply.
13. Replay the same delivery and verify existing `change_set` idempotency
    returns the equivalent result.
14. Verify URL result payloads are downloaded server-side before processing.
15. Verify URL result payloads reject non-HTTPS, private-network redirects,
    oversized responses, non-JSON responses, and signed URL logging.
16. Verify connection and operation status are visible from Ampersand UI/API.

The development setup task deploys `amp.sandbox.yaml` to the development
project as a temporary `amp.yaml`, configures `vendorQuickBooksWebhook` and
`vendorQuickBooksNotifications` to the Hookdeck callback base URL, syncs V0
notification routes, and verifies that the live integration uses
`quickbooksSandbox`.

GitHub Actions now performs manifest deployment for the same environment split:
pull requests deploy the QuickBooks sandbox manifest to the development
Ampersand project only when
`apps/vendor/integrations/ampersand/quickbooks/amp.sandbox.yaml` changes.
Development QuickBooks deploys serialize through one shared concurrency group
and refuse the configured production project id before staging the sandbox
manifest. Pushes to `main`
serialize in one deploy group and deploy enabled production Ampersand manifests
only when their checked production manifest changed since that integration's
last recorded production deploy SHA. The current production matrix deploys
vendor QuickBooks and carries vendor Ramp as gated until Ramp rollout evidence
is green. Successful production deploys move per-integration tags such as
`ampersand-production-deployed-vendor-quickbooks`, allowing a later surviving
`main` run to detect manifest changes even if GitHub replaces an earlier
pending run. Missing deployed-SHA tags force a production deploy for enabled
integrations. The workflow installs a pinned Ampersand CLI release with
checksum verification and runs `amp deploy` directly with repository secrets
`AMP_DEV_API_KEY`, `AMP_DEV_PROJECT_ID`, `AMP_PROD_API_KEY`, and
`AMP_PROD_PROJECT_ID`. It deploys manifests only; provider apps, destinations,
notification routes, and signing secrets remain operator-managed through the
`mise //apps/vendor:ampersand:*` tasks.

If Vercel's production copies of the two webhook signing secrets are missing or
stale, dispatch `Recover (Ampersand Production Webhooks)` from `main`. The
workflow reads both authoritative destination secrets from the production
Ampersand project using `AMP_PROD_API_KEY` and `AMP_PROD_PROJECT_ID`, upserts
only `AMPERSAND_READ_WEBHOOK_SIGNING_SECRET` and
`AMPERSAND_NOTIFICATION_WEBHOOK_SIGNING_SECRET` as encrypted Production values
on the retained root `apps` project. Native Vercel Git delivery remains the
sole deployer and activator: recovery does not deploy, promote, alias, select,
or redeploy a Vercel deployment. It fails before any Vercel mutation unless
both secrets are available and never prints API response bodies or secret
values.

The expected local callback paths are:

- `https://<hookdeck-source>/vendor/api/integrations/ampersand/webhook`
- `https://<hookdeck-source>/vendor/api/integrations/ampersand/notifications`

The local callback server invokes the same app-owned TypeScript handlers used by
the deployed Vercel API routes and forwards accepted writes to the local vendor
Rust API through the trusted apply bridge.

## Production Rollout Checks

Ampersand is approved for production customer data. Production customer
connections still require operational setup for:

- confirmation that raw provider payloads and secrets remain unpersisted and unlogged
- development/production Ampersand environment split
- QuickBooks provider app ownership and redirect configuration
- webhook destination security and secret rotation

Production setup evidence captured on 2026-07-03, refreshed on 2026-07-07, and
reconciled with the current project split on 2026-07-14:

- Ampersand production project `1bb05b88-308f-4286-b439-0d2be2ab9762`
  has the QuickBooks provider app. Project
  `87b973fd-0174-4e35-9045-6c68e659db9e`, used for the July 7 production
  verification, is now **Autograph Development** and uses `quickbooksSandbox`;
  do not treat its historical proof as production proof.
  Reuse and verify the current production project unless
  `mise //apps/vendor:ampersand:verify -- production` proves it is absent or
  misconfigured; do not create a duplicate production project speculatively.
  Verification checks the deployed read manifest, expected destination URLs or
  fallback callback paths, notification routes, and configured JWT key. When the
  expected production Hookdeck URLs are configured, those full URLs are the
  source of truth and Hookdeck source path prefixes are valid. After any route
  or host change, explicitly compare the Ampersand destination `metadata.url`
  values against the production Hookdeck URLs below.
  `mise //apps/vendor:ampersand:sync-destinations -- production` consumes those two exact,
  environment-scoped URLs and cannot derive them from a shared base. Rollout
  evidence must still record the actual
  production host URLs and signed delivery smoke.
- `vendorQuickBooksWebhook` is configured to the production Hookdeck read
  source (record its source/connection identifiers as metadata, not its ingress
  URL), forwarding without body or signature mutation to
  `https://apps.autograph.so/vendor/api/integrations/ampersand/webhook`.
- The read webhook destination is configured in Ampersand, but delivery is not
  production-ready until a signed delivery smoke passes against the current
  application receiver route.
- `vendorQuickBooksNotifications` is configured to the production Hookdeck
  notification source (record its source/connection identifiers as metadata,
  not its ingress URL), forwarding without body or signature mutation to
  `https://apps.autograph.so/vendor/api/integrations/ampersand/notifications`.
- The current production project has active RS256 JWT keys. The 2026-07-20
  verifier confirmed Vercel's configured key id exists in this project.
- Merge `38fbd7bc` deployed the corrected production manifest through GitHub
  Actions run `29777026058`. The verifier then passed the `quickbooks`
  provider, integration id, both destinations and signing-secret presence, the
  notification topic and all 12 routes, exact read-only provider-app scopes,
  and the configured JWT key. This closes current production configuration
  verification; it does not prove token issuance or a signed customer delivery.
- Vercel-wrapped integration-keyed install GET/POST and health GET requests are
  authenticated setup routes. The install POST mints the short-lived Ampersand
  token; the legacy `/api/integrations/ampersand/token` route remains removed.
  Anonymous setup requests must return `auth_required`; after Better Auth
  authorizes integration management, the wrapper mints the trusted app context
  without accepting client-supplied auth headers.
- The wrapper must delegate setup-route detection to the vendor app server's
  single source of truth. Do not duplicate the setup route allowlist in the
  Vercel discovery shim.
- Earlier proof-wiring used `consumer_ref=vendor-ui` and `group_ref=demo`;
  production customer authorization remains separate from this setup record.

Historical July 7 proof on project
`87b973fd-0174-4e35-9045-6c68e659db9e` included the deployed manifest, 12 V0
notification event routes, the topic destination route, required Vercel
environment variables, and Vercel deployment
`dpl_F5cMdfWcgixAWwkGfyY1E85Pi4xW`. That proof is retained for audit context
only and must not be used to approve the current production project.

2026-07-07 production auth finding:

- Live production `https://apps.autograph.so/vendor/integrations` served the
  page shell, but its setup API calls still returned `401 auth_required`.
- Direct smoke confirmed `GET
  https://apps.autograph.so/vendor/api/integrations/ampersand/install-config`
  and `GET
  https://apps.autograph.so/vendor/api/integrations/ampersand/health` returned
  `auth_required` before the hotfix deployed.
- Root cause: production `main` left the Vercel-wrapped setup routes unsigned
  even though the vendor app server requires trusted integration-manager auth.
  CI passed because the Vercel wrapper tests asserted the unsigned behavior.
- PR #305 changes the Vercel wrapper to attach the same server-managed
  integration-manager context used by local vendor serve, while keeping
  webhook, notification, trusted apply, and ordinary app API routes unsigned.
- PR #305 also resolves the route drift risk by making the Vercel wrapper call
  the vendor app server's setup-route predicate instead of duplicating the path
  list.
- The PR preview deployment was Vercel SSO-protected, so it could not be used
  as the final unauthenticated public smoke for this route.
- After PR #305 merged and deployed, the then-current server-managed production
  `install-config`, `health`, and `token` curls returned HTTP 200 on 2026-07-07.
  `install-config` returned `status=ready`,
  `project_id=87b973fd-0174-4e35-9045-6c68e659db9e`,
  `integration=vendor-quickbooks`, `consumer_ref=vendor-ui`, and
  `group_ref=demo`; `health` returned `status=ready` for the QuickBooks vendor
  import and `vendorQuickBooksWebhook`; `token` returned a JWT response with
  `consumer_ref=vendor-ui` and `group_ref=demo`.

That July 7 anonymous setup behavior is historical and is not the current auth
contract. On 2026-07-20, authenticated production UI access loaded the
QuickBooks setup surface without an auth error and showed zero production
installations; anonymous setup API requests correctly returned
`401 auth_required`.

2026-07-20 production configuration refresh:

- Vercel Production has variables configured for the production Ampersand
  project, API key, QuickBooks integration id, JWT key id/private key, separate
  read and notification signing secrets, payload-host allowlist, trusted auth
  secret, and both production Hookdeck source URLs. The production project and
  configured JWT key id passed alignment verification after the manifest
  deploy; the verifier does not prove the private-key pair. Token issuance
  remains a separate authenticated runtime check. `AMPERSAND_ENVIRONMENT=production`
  and both QuickBooks direct-apply flags remain `false`.
- The malformed Vercel production Hookdeck project identifier was corrected to
  the existing **Autograph Ampersand Production** project
  `tm_wTlMQ78s9nFg`. Its read source `src_9jyo6be2rnkb6i` routes through
  connection `web_l6NguA0b4SQg`; its notification source
  `src_dqwppl3pi05jtp` routes through connection `web_AOcU0mOn3JC2`. Both
  connections were unpaused with no ruleset or transformations and targeted the
  two expected production Autograph callback routes.
- Two earlier production verification attempts stopped before integration
  inspection because Ampersand returned HTTP 500
  `Error fetching API key details` (request ids
  `4180ec3f-9a81-4234-ae53-7d8804ed5f00#258995` and
  `5db33f0a-7f78-4934-b317-92c8bf15c961#8645`). A later retry reached the
  project, exposed the stale nested-field manifest mapping, and passed after
  merge `38fbd7bc` deployed the correction. The API-key-details failure is no
  longer the current blocker.
- Production still has no connected QuickBooks company, so no signed production
  read delivery has been captured. Keep direct apply disabled until that smoke
  and customer authorization are recorded.

Post-merge reconciliation: the first `main` CI run for `38fbd7bc` found a stale
compiler test fixture. Repair issue A-208 landed in PR #480 as `b6a7c261`; the
containing `main` CI run `29778859442` passed every lane. This is build evidence,
not production customer-delivery evidence.

Do not record secret values in repo docs or issue comments. Treat project ids,
destination URLs, key ids, and deployment ids as operational evidence that must
be refreshed after rotation or redeploy.

Production mutations are intentionally explicit:

```sh
PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true mise //apps/vendor:ampersand:deploy -- production
PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true mise //apps/vendor:ampersand:sync-notifications -- production
PLATFORM_AMPERSAND_PRODUCTION_READ_HOOKDECK_URL=https://<hookdeck-read-source>/vendor/api/integrations/ampersand/webhook \
PLATFORM_AMPERSAND_PRODUCTION_NOTIFICATIONS_HOOKDECK_URL=https://<hookdeck-notifications-source>/vendor/api/integrations/ampersand/notifications \
  mise //apps/vendor:ampersand:verify -- production
```

For production destination URL changes, set the two environment-scoped
Hookdeck source URLs and run `mise //apps/vendor:ampersand:sync-destinations -- production`. The
task updates each destination from its exact URL and rejects missing or stale
callback paths.

Do not test QuickBooks sandbox companies against the production
`quickbooks` provider. Sandbox companies must connect through the development
Ampersand project and its `quickbooksSandbox` provider app. Production
`quickbooks` is for real QuickBooks production companies.

Every deployed QuickBooks read applies unconditionally after the common
fail-closed checks. Operationally faulty installations or objects are paused
through Ampersand rather than through an app allowlist.

## Maintenance Rebaseline

QuickBooks replacement installations use exactly one slot-scoped group ref:
`<customer_id>:quickbooks:<uuid>`. Plain customer refs and older ad hoc suffixes
fail at signed ingress; there is no alias or source-identity bridge.

During a controlled replacement, pause the old QuickBooks installation's
`vendor`, `bill`, and `vendorCredit` reads before changing canonical data. Once
the replacement installation is connected under its slot-scoped group, keep
its backfill paused until the old reads have drained. Choose the next UTC date
after that drain as the maintenance effective date; the controlled window must
span that UTC boundary so every old row predates the tombstone. After the
boundary, call the authenticated vendor-app endpoint
`POST /api/integrations/quickbooks/rebaseline` with the old/new installation
ids, new group ref, and UTC effective date. The endpoint emits one ordinary
mainline app change set whose tombstones remove only visible
`vendor_spend_transaction` rows attributed to the old installation. Replaying
the same request returns the same change set. It does not affect another
provider or installation.

The endpoint verifies through the Ampersand Platform API that the exact new
installation is healthy under the exact requested slot before deleting data.
It rejects empty old-installation sets, and the effective date must be later
than every selected old row. If a same-date old row appears, the request fails
closed and the old installation stays paused; select a later UTC boundary
instead of backfilling into a duplicate-visible window. Maintenance and trusted
ingress share an installation-scoped database lock. An ingress already holding
the lock commits before maintenance selects its tombstone set, while queued or
later deliveries fail closed after the maintenance change set commits.

Only after the tombstone change set succeeds, full-backfill `vendor`, `bill`, and
`vendorCredit` on the new installation, in that order. Bill and vendor-credit
apply fails closed unless each required `VendorRef` resolves to the canonical
vendor source reference from the same installation. Replay that backfill to
prove delivery idempotency, verify representative visible rows and health, and
only then delete the old Ampersand installation. Never keep both group refs
active.
