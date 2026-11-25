# Optional App Builder / Autograph integrations

This runbook covers Arrusted, Vendor and Autograph App Builder, not Bo AI.
It documents the delivery sequence and does not itself authorize provider or
production operations.

Integrations are an optional complete capability. A tenant owns a reusable
connection; each app owns its installation, typed recipe, permissions and
canonical records. Ampersand owns credentials and execution. Generated SQL owns
canonical persistence and authorization.

## Composition

| Layer                                | Responsibility                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/integration-control-plane` | Minimal connection/binding/grant authority, tenant RLS, lifecycle transitions and canonical-write leases. Installed only in the central service database. |
| App integration definition           | Tested recipe selection, typed target bindings, provider semantics, normalization, presentation, and bounded configuration. CUE remains authoritative for schema and policy. |
| `packages/integrations`              | Retained legacy external SDK wrappers; new shared setup uses protected server OAuth.                                                                      |
| Repository installer                 | Optional routes, app-bound `Integrations` component, and optional page/navigation. Same operation for fresh and existing apps.                            |

Apps with no integration definition receive no integration routes, UI dependency,
sync jobs, provider configuration, or operational connection tables. Selecting a
recipe prepares capability; it does not provision a provider, service identity,
credentials or app activation. A missing platform host is a capability gap.

App pages use the same component:

```tsx
import { Integrations } from "@/app/integrations/Integrations";

export default function IntegrationsPage() {
  return <Integrations />;
}
```

The server wrapper resolves authorized summaries through the app DAL. UI filters
cannot grant authority. Supported customization is title/description, provider
subset/order, section visibility and placement. Use shared semantic tokens; do
not copy the surface into apps or expose arbitrary renderer/theme hooks.

## Executable app composition

The app definition imports the selected generated `data-operations` metadata
module directly. The `data-server` entrypoint deliberately carries a Next-only
`server-only` marker and is not the repository CLI's metadata import. Select the
actual checked schema release; never copy a schema or loosen types for a recipe.
Vendor's `integrations/sql-recipes.ts` demonstrates all three target bindings.

Compose `createAppIntegrationHost` with the central control plane, the supported
provider adapters, the app's existing authenticated request/DAL, and explicit
service-actor lookup. The installer emits protected actions, bounded read ingress,
`AppIntegrationClient`, the server wrapper and optional page/navigation. It checks
for a real host before writing files. A platform operator must configure the
central database, provider secrets, proof signer, exact installation identity
readback, and app service permissions. Those environment operations are not
inferred from a selected recipe.

`createAmpersandReadIngress` supplies signature-before-parse, exact installation
authority, signed split-message identity, bounded transient download and generated
canonical apply for QuickBooks/Xero. Download hosts are explicit configuration;
redirects and resolved public addresses are checked and the HTTPS transport pins
the vetted address. Ramp's supported recipe consumes proxy transactions through
its separately configured sync host; it is never treated as a mapped-read webhook.
The control-plane delivery lookup requires exactly one connected tenant connection
and active app binding for the signed external provider, connection, group and
installation identifiers. It fixes the app to the authenticated route owner and
returns the tenant from that binding row. App entitlement authorization runs on
each ingress before this lookup; removal denies new deliveries immediately while
the app-only installation pause is reconciled.

## Central lifecycle

The authority authenticates and authorizes each operation. Its host must provide
current tenant/app scope, explicit organization-management permission, exact
provider connection/installation readback, and an administrator-provisioned
integration service actor. Provision its existing protected actor membership with
`actor_kind: "service"` through `kernel_bind_actor_membership` using
schema-admin authority. Ordinary human memberships cannot enter trusted ingestion;
role/generation changes and revocation are checked again inside canonical apply.
Canonical apply also reserves integration source provenance to this protected
membership, so ordinary writes cannot capture a provider identity or make matching
ambiguous. Legacy SQL rejects the actor-kind field: fence and drain ingestion,
install the reviewed upgraded SQL bundle, then provision and verify this kind
before admitting the replacement ingress. Keep ingestion fenced throughout.
A stored legacy source reference remains matchable; a human actor is not exempted.
None of this authority comes from browser props or request body scope.
The service identity receives only compiled model/field/row permissions needed
by selected recipes; it never impersonates the user who clicked Connect.

Inline setup uses `createAmpersandConnectionSetup`: the protected server requests
an OAuth URL, and the client opens only an explicitly configured HTTPS provider
authorization origin. Its short-lived signed proof binds purpose, app, tenant,
actor and a fresh consumer slot. Completion queries that exact slot and the
central authority independently verifies connection ownership before registration.
No Ampersand API key or broad existing-account management token reaches the browser. App activation creates a pending binding and a five-minute single-use
Ed25519 grant. Its shared wire claim binds the authenticated actor, tenant,
target app, app integration key, connection provider key, connection and binding,
activation-only audience, issue time, expiry and nonce. Redemption requires the
authenticated actor to match the signed actor. Verification tolerates up to 30
seconds of issuer clock lead while retaining the absolute expiry. An app cannot
select the same effective connection provider for multiple integrations, and
binding actions require the app integration key to match. Only the signed token's
hash is stored. Signature, current app-owned integration mapping, and the named
actor's current tenant membership, target-app assignment and integration-management
permission are checked before grant consumption; binding revision, expiration, consumption and
revocation are checked transactionally. The signing key must be supplied by the
configured central authority and the verification key by the target app; local
source tests do not provision either hosted authority. Installation completion
independently verifies the exact connection, tenant, app route and installation
before marking the binding active.

The optional installer emits an app-owned `POST /<app>/api/integrations/<key>/activate`
route for each selected integration. Its bounded JSON body accepts exactly one
field, the opaque `grant`. The route fixes the app and integration/provider key;
the app host reauthenticates and passes those route-owned keys to transactional
grant consumption. The shared browser action rejects activation by account or
provider selector. An app must supply its configured host and central grant
issuer before this route can activate a real provider installation.

`createAppInstallationLifecycle` sequences app-owned provider operations. Every
attempt first reconciles the stable routing identity. An uncertain result stops
creation; a provider timeout leaves pending state. Provider adapters must
serialize creation by that route and independently read back the installation.
Ampersand does not document idempotent installation creation. Its adapter uses
`claimInstallationCreate(request, binding)` from inside the activation lease:
a creation marker on the consumed grant commits separately before the POST,
survives an uncertain result/outer rollback, and prevents a second POST for that
routing identity. A missing result after a claimed attempt requires reconciliation;
retrying a blind POST is not supported. This adds no second delivery store. No credential, config,
cursor, raw payload or provider response is persisted in the registry.

Disable first moves the app binding to suspending and revokes grants. It leaves
other apps active. App cleanup stops/drains work and verifies installation
removal or disabled-state readback before acknowledging. Ampersand's DELETE may
also delete the connection when its last installation is removed. App disable
therefore retains an exact paused installation, with all supported reads disabled
and app jobs drained; an authorized reactivation reconciles/resumes that identity. Organization disconnect requires explicit
permission and a reviewed list of affected app/binding revisions. Concurrent
activation invalidates that review. All bindings suspend atomically; the
connection remains disconnecting until every app acknowledges and provider
disconnection is independently verified. Partial failure is visible and retryable.

Canonical-write leases hold shared connection/binding locks through the app SQL
transaction. Disable/disconnect waits for admitted writes, then prevents new
leases. The deployment host must preserve this lease across the app transaction;
replacing it with an HTTP read or cached active flag loses that guarantee.
Nested authorized reads/provider rechecks reuse that lease's database transaction.
The separately committed create claim uses a short independent database client,
so it cannot starve waiting for the pool client held by its own activation lease.

## Evidence snapshot — 2026-10-28

Read-only GitHub readback confirms both implementation PRs merged on October 27.
Their source/CI results do not prove a configured integration host or live sync.

| Work                                                                              | Verified result                                                                                                                                                                                                                                                                                                                                     | Remaining evidence                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Arrusted #1598](https://github.com/withAutograph/arrusted-development/pull/1598) | Merged as `9c03def23a5ffa428c56edeeccc53345bf0d7b7d`. Final head `e2fee31d91a3363e5931004d69faf1e840402d65`; [CI 40582097399](https://github.com/withAutograph/arrusted-development/actions/runs/40582097399) passes, including aggregate Check, native Vendor lifecycle and SQL parity/scale. Apps Preview and Preview auth migration checks pass. | Configured central host, live Vendor migration, authenticated provider proof.                                                                                                                                                |
| [Builder #784](https://github.com/withAutograph/autograph-app-builder/pull/784)   | Merged as `9416113d7506f21ac5450abc83b08978b4f47dfe`. Final head `6023e9407dea86037b850245277cb3d874868985`; executed jobs in [CI 40595013466](https://github.com/withAutograph/autograph-app-builder/actions/runs/40595013466) pass. Vercel deployment-proof job is intentionally skipped for PR events; normal Preview status passes.             | Normal public create and existing-app revision using the configured capability.                                                                                                                                              |
| Dedicated Gateway Git delivery                                                    | The merged dedicated `packages/platform-microfrontends/vercel.ts` sets literal `git.deploymentEnabled: false`; root apps native Git delivery remains enabled. The merged PR records zero Gateway deployments for its final head.                                                                                                                    | This supersedes the October 15 blocked Gateway Preview as an implementation-PR blocker. It neither approves Trusted Sources nor proves hosted integration readiness. No Trusted Sources change is requested by this runbook. |

These SHAs identify evidence, not deployment selectors. The original October 15
local documentation commits were not published before the implementation PRs
merged; this follow-up recovers their runbook and reconciles it with merged code.
Documentation changes after the cited heads are not covered by those CI runs.

The implementation sessions recorded disposable PostgreSQL isolation,
source-resolution/replay/provenance/history tests, and production-build/browser
checks of the installer's standard and embedded wrappers. Provider/auth ports
in local fixtures were synthetic. Those tests were not rerun for this publication
and are not public Builder or authenticated hosted-provider proof.

Downstream activation, migration and isolation work remains separate and must
land before the live rollout is claimed ready.

QuickBooks/Xero have shared read, installation and protected setup mechanics.
Ramp has a typed proxy recipe and still needs its distinct configured sync host.
Central HTTP/admin factories are source implementations; a factory, generated
page or passing Preview build is not an installed host. The merged SQL path uses
generic `kernel_resolve_source_identities` followed by ordinary
`kernel_apply_change_set` in the same transaction, and protected membership is
`actor_kind: "service"`. Do not copy the superseded `integration_service` value
from the October 15 draft.

## Delivery owners and prerequisites

Assign named people to these roles before an operational window; no individual
assignment is implied by this document.

| Owner role                        | Responsibility / existing work                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery coordinator              | Maintain one scoped run record, collect approvals, sequence handoffs and record stop/resume decisions. Coordinate A469 and the two PRs.                              |
| Platform integration owner        | Central host, authentication, exact provider authority, leases, inline setup and central administration; A196, A195 and A197.                                        |
| Database / authorization operator | Central owner/runtime separation, forced RLS, immutable release transition, restricted app runtime principal and provisioned service actor.                          |
| Vendor / provider owner           | Exact installation inventory, provider configuration, legacy ingress fencing, drain, adoption, routing and recovery; A191 and separately authorized EXT-INT-01/02.   |
| Acceptance owner                  | Independent canonical readback, two-app isolation and failure recovery; A198. Keep local, CI, public-product and hosted evidence separate.                           |
| App Builder owner                 | Recipe discovery, configured-host composition, optional page/embedding, public create/revision acceptance; A480.                                                     |
| Delivery / environment approver   | Approve scoped provider/environment effects and production windows; A481 and the existing Gateway delivery session. Approval in one lane does not authorize another. |

The run record must identify the environment, approved organization, apps,
provider/account scope, current installation/routing identities, installed app
release and predecessor, service principal/actor/role/fence, intended effects,
rollback decision-maker and evidence locations. Keep secret values, raw payloads
and signed URLs out of the record. Use protected operator references for private
account identity; do not place customer identifiers in public PRs.

Before the first write, the owners must resolve the missing central host and
protected configuration: database roles, auth context, provider credentials,
proof signer, exact connection/installation inspectors, permitted OAuth/download
origins, binding lease lifetime, and app service permissions. Do not substitute
stubs, cached active flags, a human actor or raw app SQL. Use the selected app's
actual schema and typed recipe bindings. Unsupported objects/providers remain
explicit capability gaps.

## Ordered delivery and migration sequence

Each row requires the preceding applicable exit evidence. All mutating rows are
future work requiring their scoped approval; none is executed by reading or
editing this runbook. Start with an approved non-production QuickBooks cohort,
then qualify Xero reads and Ramp proxy sync independently. Production repeats the
relevant checks against its own observed state and approval.

| Step                             | Owner and action                                                                                                                                                                                                                                                                                                                                | Required exit evidence                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Reconcile the candidate       | Coordinator and code owners refresh both PR heads, checks, source contracts and actual runtime gaps. The implementation PRs are merged; preserve that work and review only remaining source/host gaps. Publish documentation follow-ups normally. The configured Arrusted capability must be available to Builder before claiming it is usable. | Reviewed compatible source and a record of unresolved capability gaps. No Git ancestry or PR state is used as deployment authority.                                                                                                                                      |
| 2. Fix the operating scope       | Coordinator and approver select the environment, organization, initial provider/account cohort, second app, window, owners and rollback authority. Inventory the exact provider and database state read-only.                                                                                                                                   | Approved scope/effects and observed installed predecessor; recoverable configuration and canonical-data baseline. The former Gateway Git-delivery blocker is superseded as described above; any future provider policy change needs its own authority.                   |
| 3. Prepare the host              | Platform and database operators provision/configure the approved central host and app bindings without admitting provider work. Configure authentication, exact inspectors, protected secrets, connection-only setup, service permissions and lease-preserving canonical apply.                                                                 | Forced RLS and owner/runtime separation readback; current-scope and denied-scope checks. Each selected provider has a real adapter; Ramp remains unavailable until its proxy host exists.                                                                                |
| 4. Fence the legacy writer       | Vendor/provider owner stops new legacy ingress/sync admission and drains or stops all in-flight work for the cohort. Establish supported retry/backfill coverage for deliveries during the window. Keep the replacement ingress fenced too.                                                                                                     | No active legacy writer; recorded drain/readback and recovery boundary. If safe fencing or replay coverage is unavailable, stop before changing SQL or adopting anything.                                                                                                |
| 5. Upgrade under the fence       | Database operator installs the reviewed immutable app release using the supported installer, then provisions the existing integration actor with `actor_kind: "service"`, its least required role and the current fence. Preserve actor identity and source matching semantics.                                                                 | Installed-release readback plus verified protected membership and role/fence; human, revoked and wrong-scope writes denied. Do not admit ingestion in the interval between installation and membership verification.                                                     |
| 6. Register and adopt            | Authorized platform/provider operator registers independently verified connections and calls server-only `adoptInstallation` for each exact existing installation. Do not recreate it or remap its route/source identity.                                                                                                                       | Verified connection, app, tenant, installation and routing identity. **Adoption inserts an active binding**; it is not a harmless inventory step. Keep the replacement transport fenced until step 7 and never perform adoption while the legacy writer is still live.   |
| 7. Cut over the cohort           | Vendor/provider owner enables only the verified new ingress and corresponding management path under the approved provider operation. Use normal activation/grant flow for a new installation; use adoption only for the verified existing one.                                                                                                  | Authorized delivery reaches canonical apply; independent records/provenance/history readback, exact replay and conflicting replay checks pass. Old ingress remains fenced. Failure goes to recovery below.                                                               |
| 8. Prove isolation and lifecycle | Acceptance owner uses Vendor and an approved second app with different bindings on the same connection. Exercise app disable, revocation during work, and separately authorized organization disconnect/recovery.                                                                                                                               | Independent installations, mappings, permissions and records; disabled app cannot write while the other still can. Disconnect exposes all affected apps and remains incomplete until every app drains and provider disconnection is verified.                            |
| 9. Qualify Builder composition   | Builder and acceptance owners run one normal public create session with the optional standard page, then a separate existing-app revision embedding the same component. Also verify an app with no selected integrations.                                                                                                                       | Saved public sessions and ordinary replies, authenticated behavior and canonical readback; no evaluator-written backend repairs. No-integration app has no integration routes/jobs/UI behavior. Missing host/adapter is blocked capability, not a successful connection. |
| 10. Expand or release            | Coordinator/approver reviews cohort evidence before expanding provider/account scope or production. Provider owners authorize and execute each outward operation through the existing delivery lane.                                                                                                                                            | Explicit decision and scope-specific evidence. Close only the issue acceptance actually satisfied; CI or these docs alone close no rollout issue.                                                                                                                        |

The October 15 release names are historical; #1598 was subsequently rebased and
issued newer immutable releases. Discover each app's current checked release
through its `schema/index.ts` and observe the actual installed predecessor using
the supported operator path. Legacy SQL rejects `actor_kind`; install compatible
SQL and bind the current `service` kind with its valid role/fence while ingestion
is fenced. Never edit an issued bundle in place or reset a database to bypass
`prepared_revision_mismatch`. See the [compiler contract](../schema-compiler.md).

Deployment and rollback follow the native delivery contract:
native Vercel delivery and provider-owned activation/rollback, followed by
read-only proof. Repository CD does not deploy, promote, alias, roll back or
select a deployment. A schema migration or provider change is not undone merely
by returning to an earlier application deployment.

## Validation and evidence to retain

Record each applicable requirement as passed, failed, blocked or unassessed,
with the observed environment, candidate identity, evidence location and owner.
Maintain separate evidence for:

- Authority: forged, expired, consumed, wrong-app and cross-tenant grants;
  revoked binding/actor/role; signature-before-parse and exact installation
  authority. No denied case may produce canonical writes.
- Data: new delivery, exact and conflicting replay, signed split messages,
  concurrent writes, provider clears and missing relations. Read records,
  bounded provenance and history independently; failure leaves no partial batch.
- Lifecycle: separate app disable and organization disconnect, drain/readback,
  uncertain create reconciliation, and recovery after partial external failure.
- UI: the standard page and embedded component use the same implementation;
  loading, empty, permission-denied, degraded and recovery states work across
  desktop window sizes. Successful activity remains visible during catalog
  failure. UI filters never confer authority.
- Product: public create and revision sessions succeed without private workflow
  calls or manual backend repair. Preserve session IDs, request IDs, cursors,
  ordinary replies and approval records; resume a failed session rather than
  silently replacing it. Provider provisioning and activation remain separate
  authorized operations.

Existing local tests and CI support the first implementation, not the missing
public-product or hosted-provider evidence. Do not relabel synthetic boundaries
as live provider proof, or a passing Preview build as an authenticated journey.

## Recovery and rollback

Default recovery is to stop admission for the affected app, retain canonical
records and receipts, and reconcile observed state. Never restore revoked grants,
silently reconnect, delete shared connections as cleanup, or remove canonical
history to make a retry look new.

| Failure / boundary                               | Recovery owner and procedure                                                                                                                                                                                                                                        | Resume condition                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host, permission or provider prerequisite absent | Platform owner leaves setup/activation unavailable and records the precise missing capability.                                                                                                                                                                      | Real configured host and fresh authorization/readback; no placeholder success.                                                                                                                                                          |
| SQL install conflict or actor provisioning fails | Database operator keeps both ingestion paths fenced. Inspect installed revision and membership, preserve old release bytes, and prepare a reviewed compatible transition. Do not force the same version or reset data.                                              | Correct installed artifact and protected actor/role/fence verified. If reverting application code, prove it can use the actually installed SQL before resuming it.                                                                      |
| Installation-create response is lost             | Provider owner reconciles the exact route/connection using the durable one-shot creation claim. Leave the binding pending on uncertainty. Do not issue a second blind POST.                                                                                         | Exact installation independently found and verified, or an explicitly reviewed recovery decision; never infer absence from a timeout.                                                                                                   |
| Adoption conflicts or new ingress fails          | Keep legacy and replacement admission fenced. Adoption can already have made the binding active; inspect it and use authorized disable/drain when needed. Do not call adoption repeatedly to reset a suspending/removed binding.                                    | Choose either corrected new ingress under current authority or a separately approved legacy fallback compatible with installed SQL. Ensure only one writer is enabled. Normal reactivation uses a fresh grant and exact reconciliation. |
| App disable stops partway                        | App owner retains `suspending`, blocks new leases and retries stop/drain plus exact provider disabled-state readback. Call `acknowledgeRemoval` only after those facts hold. Retain the paused Ampersand installation where deletion would endanger the connection. | No admitted work remains; removal acknowledgement matches the current revision. The other app remains usable.                                                                                                                           |
| Organization disconnect stops partway            | Central operator retains `disconnecting`, lists outstanding app drains and retries only unfinished effects. Reconcile an uncertain provider response. Never report success early or silently reconnect.                                                             | Every binding is removed and provider disconnection is independently verified before `completeDisconnect`. A changed impact review requires a new explicit review.                                                                      |
| Wrong or conflicting canonical data              | App/data owner stops affected ingestion and reads existing change-set receipts/history. Use supported app correction/revert operations only after their effects are reviewed. Exact replay is not a mechanism for overwriting a conflicting payload.                | Corrected data and source identity independently verified; replay/relationship tests pass. Do not use raw SQL, rewritten provider IDs or archive deletion to bypass matching.                                                           |
| Public Builder session fails                     | Builder owner preserves the saved session, transcript and concrete failure. Repair through the ordinary product/workflow path when authorized.                                                                                                                      | The saved public session resumes, or the outcome is explicitly blocked/failed. A manually repaired evaluator checkout does not qualify the run.                                                                                         |

The rollback record must capture the last admitted delivery/change-set boundary,
active binding revisions and provider installation state, installed SQL release,
service actor fence, chosen transport/application fallback and who approved its
effects. Confirm that shared-connection peers remain isolated. Recovery itself
does not grant provider, permission, database or deployment authority.

Legacy Vendor provider behavior and its existing Rust bridge remain migration
inputs. Source-level UI adoption does not constitute a completed live migration.
Do not expose existing-account SDK management if its disconnect action bypasses
the central impact workflow. Generated setup uses the protected server OAuth URL flow and central control-plane
verification. The SDK has no enforced connect-only mode; no new account-management
wrapper is exposed for this flow. A UI callback alone never establishes connection
authority. Retained legacy SDK APIs remain migration inputs, not approved central
connection or disconnect authority.

## Work tracking and evidence

Keep A189 canceled: its coordination was retired to external operations, not
rejected architecturally. A196 owns authority; A195/A197 UI and ingestion; A191
Vendor migration; A198 isolation; A480 generator/Builder composition. A481 and
EXT-INT-01/02 own separately authorized provider operations and hosted proof.

Acceptance evidence must distinguish focused source/local tests, exact-head CI,
a normal public Builder create/revision session, and authenticated hosted
provider proof. Fixture-generated files and direct installer tests are not
public Builder success. Historical provider demos are not current readiness.

## Existing-app reconciliation

The installer records SHA-256 hashes of its generated files in
`app/integrations/.installed.json`. Later selections update unchanged wrappers
and remove stale provider ingress, page and navigation files. Removing the
definition removes unchanged generated outputs and the runtime dependency only
when this installer added it. App-owned hosts and definitions remain app-owned.
An edited generated file blocks the whole reconciliation before any mutation.
For an older installation without the inventory, only exact known templates
are adopted; a generated marker alone does not establish ownership.

Ingestion hashes the verified envelope before downloading URL payloads, checks
for a committed request under current binding/service authority, then replays
through ordinary apply without retrieving the payload. Misses release the short
lookup lease before provider I/O. Fresh writes use generic atomic source identity
resolution and ordinary apply in one app transaction under the binding lease.

## Remaining decisions and approval boundaries

The recommended first cohort is non-production QuickBooks with Vendor and a
minimal second app using different target bindings. Shared connections, inline
setup, typed targets and automatic inbound sync after activation were already
selected; do not ask the user to decide those again.

| Decision needed from the owner                                           | Recommended scope / approval boundary                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which organization and provider account may be used?                     | Name an approved non-production environment, organization and QuickBooks account; identify the person who can complete provider consent. Keep credentials in the protected connection flow, not chat. The coordinator can propose the minimal second app and mapping.                                                                                     |
| May the scoped non-production resources and provider effects be created? | After the actual host/resource/permission plan is prepared, approve its named environment, resources, roles and provider setup/activation. Include inbound test writes, app disable/reactivation and organization disconnect against designated test connections. This is not production authority or permission to disconnect unrelated shared accounts. |
| Is Ramp required in the first rollout?                                   | Qualify QuickBooks first, then Xero; defer Ramp until its proxy-sync host is implemented/configured and proved, unless the owner explicitly includes that work in the initial milestone. Recipe availability alone does not make Ramp operational.                                                                                                        |
| Who approves a live Vendor cutover, and when?                            | Before production work, choose the exact organization/account cohort, maintenance window and accountable approver. Review the concrete immutable SQL transition, fencing/drain, retry/backfill and compatible rollback plan prepared by the operators. Approve production activation separately from non-production acceptance.                           |

The remaining central host wiring/configuration, provider-adapter readiness and
normal public Builder create/revision tests are engineering and acceptance work,
not a request for the user to design interfaces or approve speculative fixes.
Assign technical owners through the existing delivery coordinator. Source fixes
should be prepared for review without repeatedly seeking permission; actual
hosted writes, credential/role changes, provider operations and production
cutover still require the scoped authority above. Do not introduce purchases
or new paid services without a concrete need and separate approval.

A469/A480 dependency reconciliation was already explicitly approved and applied;
do not request or apply it again. A189 stays canceled. Both implementation PRs
are merged, so neither needs another merge approval. The prior Gateway Trusted
Sources request is not a current prerequisite for these merged changes; the
scoped Git opt-out is not approval to change any provider security setting.
The user has authorized publishing this documentation, not executing its
provisioning, activation, disconnect or production migration steps.
