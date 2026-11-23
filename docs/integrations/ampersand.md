# Ampersand Integrations

Status: V0 implementation exists behind live-readiness and production rollout
gates.

As of 2026-07-20, the vendor QuickBooks V0 code path is implemented in repo:
the shared Ampersand UI wrapper, vendor app manifest/config, vendor app schema
and apply bridge, install/token UI, webhook/notification ingress, generic
integration compiler, source-reference matching, health surface, and visual
proof support have landed. The feature is not yet generally production-enabled:
signed development vendor and bill deliveries, exact replay, persisted rows,
and installed health are proved. Current production configuration verification
also passes. A live URL-result delivery, signed production delivery, and
production customer authorization still need to be recorded before turning on
production customer data flow.

As of 2026-07-20, the vendor Ramp V0 proxy path is checked in with an app-owned
manifest, config parser, proxy client, sync normalizer, apply recipe, health
surface, and operator verification. Ramp remains proxy-only. Development OAuth,
non-empty apply, empty-window filtering, multi-page traversal, replay, exact
provider-app scopes, and JWT configuration were proved. A neutral `created`
installation lifecycle label does not require reconnection when authorized proxy
requests succeed. A production-shaped Vercel preview also proved the bounded
OAuth, apply, persistence, and replay path with Ramp Demo; that is preview/demo
evidence, not proof of provider `ramp` or a real production company. Production
remains `vendor-ramp`, provider `ramp`, and catalog-registered pending every gate
recorded in `integrations/vendor-ramp.md`, beginning with a separate real Ramp
production OAuth app in the production Ampersand project.

## Decision

Use [Ampersand](https://docs.withampersand.com/overview) as the first hosted
integration abstraction. Autograph does not build direct QuickBooks/Ramp
integrations or a homegrown multi-provider abstraction in V0.

Ampersand owns provider OAuth, provider credentials, per-customer installation
state, selected fields, user-defined field mappings, provider API calls,
retries, error parsing, dashboard troubleshooting, and hosted connection/config
UI. Autograph owns app schema, canonical row-version writes, customer scope,
authorization, the app-owned persistence bridge, and kernel apply.

## Boundary

| Owner                            | Responsibilities                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ampersand                        | Provider connection, installation state, saved config, selected provider fields, object and field mappings, read/subscribe/write/proxy execution, retries, health, logs, backfills, dashboard                                                                                                                                                                              |
| `packages/integrations`          | Thin wrapper around external integration libraries: Ampersand React/prebuilt UI wrappers, external-library styles, and generic token request types. No app schema, provider-to-app mapping, Platform API clients, provider capability catalogs, manifest/config schema helpers, webhook ingestion, kernel DTOs, or `ApplyChangeSet` knowledge                              |
| App                              | App schema, customer scope, actor id, route mounting, app copy/policy, app-owned provider semantics, manifest choices, object/field meaning, source-reference requirements, app-owned integration recipe, and app-owned ingress routes                                                                                                                                     |
| App integration ingress/adapters | Webhook signature verification, Ampersand envelope parsing, Platform API authority checks, signed URL download handling, notification acknowledgement, recipe-driven normalization, and compilation to ordinary `ApplyChangeSet` input                                                                                                                                     |
| `packages/integration-compiler`    | Optional reusable compiler substrate for already-verified mapped deliveries and app-owned recipes. It may know generic kernel write contracts and generic recipe/delivery shapes. No webhook verification, provider SDKs, Platform API clients, app crates, QuickBooks/vendor semantics, local integration tables, or provider/source refs encoded as model `external_key` |
| Kernel apply                     | Schema validation, row-version storage, existing `change_set` idempotency, and provenance persistence for already-compiled `ApplyChangeSet` writes                                                                                                                                                                                                                         |

### Tenant connections and app activations

Ampersand remains the provider connection system of record: it owns provider
credentials, provider-side installation/configuration, selected objects and
fields, mappings, transport execution, retries, and provider health. The
Integrations app owns only Arrusted's tenant connection identity and the
connection-to-domain-app authorization/routing metadata. That metadata is not
an Ampersand cache and cannot contain a provider catalog, recipe, app
installation/configuration, mappings, sync state, health diagnosis, raw
payload, or credential.

An app binding is explicit: a tenant connection is unusable by a domain app
until the Integrations app has authorized that exact `(app_id, customer_id)`
binding and issued its short-lived activation grant. The domain app consumes
the grant to create/refresh its own installation, then retains all provider
data-plane decisions and operations. Removing an entitlement revokes grants
before the app removes its installation; safe disconnect revokes every binding
before Ampersand disconnect is requested. The exact record shape, lifecycle,
reconciliation, and DTO ownership are normative in [Integration Data
Model](data-model.md#arrusted-owned-control-plane-metadata). This deliberately
narrows the former V0 “no local integration tables” rule only for those minimal
control-plane records.

`packages/integrations` is a reusable wrapper around Ampersand and future
external integration libraries. It must stay app-agnostic and kernel-agnostic.
It may hide Ampersand SDK/component details from apps, but it must not know
vendor app models, QuickBooks/Ramp-to-vendor semantics, generated app clients,
kernel wire DTOs, or `ApplyChangeSet`.

Application knowledge belongs with the app: app schema, app policy, app-facing
field meaning, provider object choices, source-reference policy, and the
integration recipe that tells the app-owned integration adapter how an accepted
delivery maps to app fields. The adapter verifies, parses, normalizes, and
either compiles accepted deliveries to `ApplyChangeSet` itself or calls
`packages/integration-compiler` with already-verified recipe input. Core kernel
storage stays generic and must not hardcode Ampersand, QuickBooks, provider
catalogs, Ramp, integration recipe semantics, or vendor app semantics.

### Vendor AP source model

The vendor app stores QuickBooks, Ramp, and Xero AP parent objects in the
provider-neutral `vendor_spend_transaction` model. Its common fields are stable
app/provenance identity (`source_record_ref`, `integration_platform_id`,
`source_connection_id`, `provider`, `payload_hash`, `source_record_id`), explicit
`transaction_kind` (`card_transaction`, `bill`, or `credit`), the canonical
`vendor` relation, optional counterparty/document/open-amount facts, signed
`amount`, currency, status, and parent-object dates. Credits use kind `credit`
and a negative signed amount; bills and card transactions retain their source
sign. Provider recipes own that normalization.

Vendor-trusted integration recipes may target only `vendor` and
`vendor_spend_transaction`. The provider compilers enforce that exact set
through an app-owned allowlist typed against the generated Vendor row-write
contract, and the trusted Vendor server independently rejects every other model
before kernel apply.

Provider and installation references are app data and change-set provenance;
they do not become kernel identity or a model `external_key`. The unique app
`source_record_ref` must agree with the provider recipe's declared source
components and the write provenance. Provider-owned matching may emit the
`vendor` relation only from unambiguous authoritative evidence. An ambiguous
match rejects the delivery, an authoritative miss leaves the relation absent,
and an emitted relation still must resolve to an existing canonical vendor at
apply. These are app schema/recipe rules and require no kernel contract change.

NetSuite and Sage Intacct fields are not part of this model until live readiness
evidence proves a missing parent-object fact.

The vendor app's canonical provider authority is
`apps/vendor/integrations/catalog.json`. Its validated TypeScript and Rust
readers feed frontend descriptors, the fixed provider-key setup route template,
Ampersand operations, and recipe enumeration. QuickBooks setup is active. Ramp
is active only in development so operators can execute its sandbox gate; its
production setup remains registered until the live-readiness evidence in
`integrations/vendor-ramp.md` is green. Xero has a supplier/AP-only runtime
contract in `integrations/vendor-xero.md` but remains registered until signed
environment smoke is recorded. NetSuite and Sage Intacct are registered without
customer setup launch.
Only the public setup surface observes `registered | active`. Private signed
webhooks, payload retrieval, and trusted apply do not consult launch state, and
the catalog contract rejects custom setup paths and direct-apply switches.

Autograph V0 implements Ampersand install UI, JWT/token plumbing,
read/subscribe webhook handling, kernel apply, and authorized Ramp read-only
proxy sync with direct apply. Ampersand write/proxy support remains an
Ampersand capability, but Autograph provider writeback and proxy mutations remain
out of V0 until a future plan explicitly adds them.

V0 directly applies verified Ampersand mapped deliveries into canonical app data.
If product needs human preview/review before canonical write, that is a separate
workflow and must not reintroduce import/preview/link tables by default.

This package, compiler, and kernel boundary is enforced by Konsistent plus the
workspace-import, Rust, application, and deployment validators. They prove
`packages/integrations` cannot import `apps/*`, generated app clients,
`packages/contracts`, `packages/kernel-client`, kernel DTO modules, or any module
that exports `ApplyChangeSet`. It also blocks provider-specific package subtrees
and core-kernel Ampersand, QuickBooks, Ramp, NetSuite, Xero, Sage Intacct,
recipe, provider webhook, or
provider dependency surfaces. It separately scans `packages/integration-compiler`
so production compiler source cannot depend on provider SDK/webhook crates or app
crates, hardcode provider/vendor semantics, reference local integration
tables, or emit provider/source identity through model `external_key`. Apps may
import the package's Ampersand wrapper exports; package code may not import back
into apps or kernel layers.
App-local integration `_shared` substrate is also scanned for provider-specific
policy, while provider-owned app subtrees remain allowed. Scoped ast-grep rules
keep provider adapters persistence-free and reject diagnostic sinks throughout
provider transport and raw-envelope owners.

The local syntax subset is enforced by the scoped ast-grep rules under
`.config/mise/scripts/check/ast-grep/rules`; focused Bun lanes do not duplicate those local import
shapes. Bun remains authoritative for CSS provider imports, resolved relative
imports, exported-contract inspection, semantic vocabulary, provider subtrees,
Rust/Cargo edges, and other cross-file checks.

The declarative matrix is:

| Scope                                                                                                               | Allowed                                                                                                    | Forbidden                                                                                                | Rule                                     |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/integrations/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`                                                        | External-library and package-local imports                                                                 | Root or subpath imports from `@contracts`, `@kernel-client`, app-generated clients, or `apps/*` | `integrations-no-app-kernel-imports-*`   |
| TypeScript/JavaScript under `apps`, `packages/domain-libs`, and `packages`, excluding `packages/integrations`                | `@autograph/integrations` wrapper imports                                                                   | Root or subpath imports from `@amp-labs/react`                                                           | `provider-ui-through-integrations-*`     |
| Provider adapters plus provider config and nested ingress/notification/payload/transport/webhook/sync/health owners | Opaque transient payload return, ordinary data properties such as `response.error`, and normalized metrics | Known logging/diagnostic receivers, aliases/destructuring, computed calls, or stdout/stderr writes       | `integration-transport-no-diagnostics-*` |

Run `mise run test:ast-grep` for allowed/forbidden fixtures and
`mise run check:ast-grep` for the repository scan. The exact CLI version is pinned
in the root `package.json` and `bun.lock`.

## Frontend Install UI

Use Ampersand's prebuilt UI components through
`@autograph/integrations/ampersand/react`, which wraps
[`@amp-labs/react`](https://docs.withampersand.com/embeddable-ui-components).
The package owns the direct dependency on `@amp-labs/react` and imports
`@amp-labs/react/styles`; apps should not depend on Ampersand's React package
directly.

The app provides:

- `project`: Ampersand project id from `AMPERSAND_PROJECT_ID`
- `getToken`: backend call that returns a short-lived JWT
- `consumerRef`: platform user id for the acting user
- `groupRef`: server-derived Autograph `customer_id`
- optional display names for the user and customer/workspace

Production uses JWT auth through `getToken`. The frontend must never receive
Ampersand API keys, JWT private keys, or webhook signing secrets.

The integration-keyed install POST authenticates the actor, derives `consumerRef` and
`groupRef` server-side, verifies the actor may manage integrations for the
customer, requires a catalog provider key, rejects providers that are not
`active` in the server-selected environment, scopes the JWT to the expected
Ampersand project/environment, and does not trust client-provided tenant
identifiers without authorization.

For server-managed setup surfaces where the browser cannot supply the trusted
app auth context directly, the app API wrapper may mint a trusted
integration-manager context server-side. The owning app server's setup-route
preparation API is the only authoritative route list and must authorize the
request before it derives the permitted private route, replaces the complete
trusted context, and signs. Generic docs and Vercel discovery shims must not
maintain a second hardcoded allowlist or call the route predicate, authorization,
header, or signing primitives separately. The preparation API must overwrite
every client-supplied trusted-auth header as one complete set, and it must not
sign webhook, notification, trusted apply, or general app API routes. Vendor
QuickBooks V0 records its current setup routes in
`integrations/vendor-quickbooks.md`.

This public setup contract is platform-neutral: setup routes describe app-owned
integration-management operations, not Ampersand transport internals. Private
transport routes remain server-to-server Ampersand plumbing: webhook and
notification ingress, signed URL handling, Platform API authority checks, proxy
reads, and trusted integration apply. Keep that split explicit in route tests
whenever a setup wrapper or alias is added.

This is a runtime route-auth contract, not a package/layer import boundary.
Enforce it in the app/Vercel route tests and the narrow structural boundary lane
for each app shim: the tests must prove setup routes are signed only through the
owning app preparation API after authorization, spoofed client trusted-auth
headers are overwritten, and webhook/notification/trusted-apply routes remain
unsigned.

For V0, Autograph `customer_id` is the canonical integration scope prefix. The
server-derived value, or a colon-delimited installation ref beneath that prefix,
is used as Ampersand `groupRef` and the authenticated prefix is used as the
`ApplyChangeSet.customer_id` for webhook-applied writes. If an app exposes a
workspace id in its UI, the server resolves that workspace to `customer_id`
before minting Ampersand tokens or applying webhook writes.

The validated provider catalog declares whether new installs use the customer
scope directly or mint a slot-scoped group beneath it. Page shells consume that
generic strategy and must not branch on provider keys to construct group refs.

Checked provider apply recipes describe provider-to-model policy only and do
not contain a static `customer_id`. The runtime must derive customer scope from
independently verified installation or signed management authority, compare it
with the compiled apply, and sign that verified value for trusted persistence.

The package wrapper renders Ampersand's `AmpersandProvider` around app-owned
children and passes the app-provided `project` and `getToken`. Use
`InstallIntegration` for install/update/uninstall. Use
`useIsIntegrationInstalled` or package-owned equivalents for install state. Do
not build a custom install wizard unless Ampersand's prebuilt component cannot
support a proved product need.

The wrapper exposes Ampersand's beta `variant="wizard"` install mode. Apps use
that mode for the initial installation flow so Ampersand owns the guided
connect, object selection, field/mapping configuration, and review steps. The
same component automatically renders Ampersand's standard configuration view
when an installation already exists. Because the beta prop may be absent from
Ampersand's public TypeScript declarations, any declaration bridge stays inside
`packages/integrations`; app code must not suppress the type or import
`@amp-labs/react` directly.

An app may present active providers in a catalog-and-detail layout, but the
catalog remains app-owned public setup policy: only the selected active provider
mounts `AmpersandProvider`, install-state hooks, and `InstallIntegration`.
Registered providers may appear as non-interactive “Coming soon” entries and
must not load setup resources or mount Ampersand UI.
Discover excludes installed single-connection providers, which remain
manageable from the Installed view. Providers identified by the app-owned
frontend composition policy as multi-connection remain in Discover with an “Add
connection” action. Because Ampersand permits one installation per integration
and group, that action creates a new tenant-prefixed group reference; installed
row management reuses the selected installation's group reference. Active
provider cards stay hidden until their install configuration resolves so an
installed connection never flashes with the wrong action. The Installed view
also waits for every active provider configuration to settle before it shows a
count or empty state. If any active provider cannot report installation data,
the page renders one concise unavailable state instead of reporting zero
connections. A critical catalog, integration-activity, or active-provider
configuration failure owns the full page content region: Discover/Installed
controls, search, provider cards, and installed-account framing stay hidden
until retry succeeds. That single retry reloads integration activity together
with catalog and active-provider configuration data. Lower-level failures must
not create duplicate alerts or expose raw service diagnostics alongside that
page-level state.
The Add connection flow owns a user-editable connection name, defaulted from
the customer name with the first unused ordinal for additional connections.
The app requires a nonblank trimmed name before mounting the provider wizard
and passes the name as Ampersand's `groupName`. Installed rows expose that app-owned name as the
recognizable connected-account label and never expose installation IDs or group
references. Repeated names receive a visible ordinal so every row remains distinguishable.

The deployed `/vendor/integrations` route is owned and server-rendered by
Vendor's Next zone. Its app-owned platform adapter verifies the gateway
principal; Vendor then fetches, validates, and renders settled state as
app-owned RSC output. The gateway and shell contain no provider catalog,
endpoint, DTO, runtime, or bootstrap knowledge.
The Ampersand React runtime remains dialog-only and client-loaded; SSR uses
only app-owned catalog, installation, health, and activity data.
Connection-scoped management still passes
that group reference to Ampersand and omits provider-level health and sync
controls, whose current APIs do not identify an individual installation; those
controls remain reachable through a separate provider-management action in the
Installed view. If an installation response omits its group reference, its row
remains visible for status but its connection-management action stays disabled;
the row must never fall through to provider-level management.

The Add connection dialog is a wizard-only composition: after any actionable
loading or failure notice and the app-owned connection name, the selected
provider's Ampersand wizard receives the full modal content width.
Connection-scoped management is likewise a minimal wrapper around the
Ampersand wizard selected by group reference. In its normal ready state, it does
not add a header status, installation list, app-owned status card, provider
controls, or promotional footer copy around that component. Actionable setup
failure and completion notices remain visible when Ampersand reports them.
Provider health, installation lists, sync-window controls, and management
guidance belong only to the provider-level management dialog. Add, provider
management, and connection management remain explicit internal intents so that
one surface cannot accidentally inherit another surface's controls.

Ampersand's beta wizard currently exposes a fixed-width labelled stepper with
no narrow-screen breakpoint. At narrow viewports, the app may make its own
wrapper a labelled, keyboard-focusable horizontal scroll region and give the
Autograph-owned Ampersand adapter wrapper a stable minimum inline size. Keep the
overflow cue outside the embedded component. Do not select Ampersand-generated
classes, descend into Ampersand-owned markup, shrink its typography, or hide
wizard steps.

## Setup Path

Each app integration follows the same setup sequence:

1. Create separate Ampersand development and production projects.
2. Configure separate QuickBooks provider apps, redirect URLs, webhook
   destinations, and per-destination signing secrets for development and
   production.
3. Store the required secrets in the app deployment environment; never check
   Ampersand API keys, JWT private keys, or webhook signing secrets into repo
   config.
4. Add the app-owned manifest under that app's integration directory and deploy
   the environment-specific manifest to the matching Ampersand project. GitHub
   Actions deploys the development Ampersand project from PRs and deploys the
   production Ampersand project after merge to `main`.
5. Connect a QuickBooks sandbox company through `InstallIntegration`.
6. Run the sandbox smoke in `integrations/vendor-quickbooks.md` before enabling
   production customer connections.

Operational proof for a provider object means: the manifest is deployed, every
webhook destination is configured with its expected signing secret, a sandbox
delivery reaches the verified ingestion path, the delivery compiles through the
app-owned recipe to `ApplyChangeSet`, replay is idempotent through
`change_set`, and installation or operation health is visible from Ampersand UI
or API.

Ramp follows the same app-owned boundary with a proxy-only V0 shape. Its
provider app credentials belong in the Ampersand Provider Apps dashboard, not
local app env, and development/production must use separate Ampersand projects
and separate Ramp provider apps. The V0 Ramp provider app requests only
`transactions:read`, `vendors:read`, and `accounting:read`; write scopes,
native Ramp webhooks, and provider mutation routes stay gated. Authorized proxy
syncs apply directly and accept no runtime direct-apply toggle.
The operational setup, sync-window smoke steps, and current rollout status
are recorded in [Vendor Ramp Integration](vendor-ramp.md).

## Private Connector Development And Self-Managed Deployment

**Decision, Revisit With Evidence:** Autograph's current integration runtime is
the hosted Ampersand platform. A private connector or self-managed service is a
separate integration-runtime choice; it does not extend the hosted project by
deploying an `amp.yaml` manifest.

Ampersand's [open-source connectors library](https://github.com/amp-labs/connectors)
can be used independently of the hosted platform. Use this path when a provider
is not in Ampersand's hosted catalog and the connector must remain private, or
when the product deliberately takes ownership of provider-runtime operations.
Keep the fork and provider implementation in a private repository unless the
connector is intended for upstream contribution.

### Local Connector Development

Start from a private fork and follow the connector repository's development
guide:

```sh
git clone <private-connectors-fork>
cd connectors
make install/dev
```

Create the ignored root `creds.json` required by the connector test harness.
Use a dedicated provider developer or sandbox account and load credentials from
the supported credential readers; never commit credentials, OAuth tokens, or
client secrets. For OAuth connectors, run the repository's local token helper
to complete the provider flow, then test the connector through its development
proxy:

```sh
go run scripts/oauth/token.go
go run scripts/proxy/proxy.go
```

The proxy listens on `localhost:4444`. Exercise the provider operations that
the app will need, including authentication failure, token refresh, paging,
rate-limit, and provider-error cases. Add focused provider tests before
building a production service.

### Deploying A Private Connector

The open-source library is a Go library, not a documented self-hosted release
of the full Ampersand platform. A production deployment therefore wraps the
private connector in an Autograph-owned service. That service must own the
following responsibilities that hosted Ampersand otherwise provides:

- provider OAuth callback handling, credential encryption, refresh, rotation,
  and revocation;
- tenant-scoped connection and installation state, with app-scoped activation
  and authorization checks;
- provider request execution, pagination, retries, backoff, concurrency and
  rate-limit control;
- schedules and webhook subscription lifecycle, signature verification, and
  idempotent event delivery;
- delivery to the app-owned ingress/recipe path, observability that excludes
  raw provider payloads and secrets, and operational alerting.

The service must preserve the existing boundary: tenant connections remain
separate from app-owned bindings, recipes, ingress, mappings, and canonical
writes. It must compile normalized data through the app-owned integration
recipe and the ordinary trusted apply path; it must not write provider payloads
or provider-specific semantics into shared kernel layers.

Deploy the wrapper as an ordinary private service in the selected Autograph
runtime, with provider credentials in the deployment secret manager, a
publicly reachable HTTPS OAuth callback/webhook endpoint where the provider
requires one, and explicit database migrations for encrypted connection state
and idempotency records. Run sandbox smoke tests before a customer connection
is enabled and retain the same development/production isolation required for
hosted providers.

Do not represent a private fork as an Ampersand-hosted provider in the Vendor
catalog. If the product needs the hosted Ampersand UI, managed auth, dashboard,
or orchestration for that provider, first obtain an explicit private-provider
or upstream-support commitment from Ampersand. Upstream contribution is not
required for standalone/self-managed use, but it is the public path to having a
provider added to Ampersand's shared catalog.

## Operator Tooling

The vendor QuickBooks integration has repo-owned Ampersand operator tasks. They
run through the ignored local fnox profile and require
`.config/fnox/local.toml`; the task wrapper intentionally fails before reading a
plain exported environment when that profile is absent.

The vendor Ramp integration has a non-mutating local manifest check and an
explicit environment verifier that works before or after catalog activation.
`mise //apps/vendor:ampersand:ramp:manifest-check` verifies the checked app-owned
manifest/config/recipe shape without calling Ampersand.
`mise //apps/vendor:ampersand:ramp:verify -- <development|production>` verifies the
deployed Ramp integration, exact hosted provider-app scopes, project separation,
and shared JWT key. The generic `mise //apps/vendor:ampersand:verify -- development`
continues to verify every development-active provider.

```sh
mise run setup:vercel-env
mise //apps/vendor:ampersand:setup-dev
```

`ampersand:verify` fails closed unless the environment-specific expected
Hookdeck read and notification URLs are set. `ampersand:setup-dev` preserves the
two existing shared destinations: it deploys the manifest, reconciles topic
routes, and verifies without rewriting either destination URL. It also skips
provider-app mutation by default. Run
`mise //apps/vendor:ampersand:sync-provider-app -- development` explicitly, or add
`PLATFORM_AMPERSAND_SYNC_PROVIDER_APP=true` to `ampersand:setup-dev`, only when
an operator is intentionally creating or rotating the shared development
provider app.

Manifest deployment is automated through the Ampersand deployment lane called by
`CD` for `main`, and by the `Deploy (Ampersand)` PR workflow, following Ampersand's documented
development/production promotion pattern. Pull requests deploy the vendor
QuickBooks sandbox manifest to the development Ampersand project only when
`apps/vendor/integrations/ampersand/quickbooks/amp.sandbox.yaml` changes.
Development QuickBooks deploys serialize through one shared concurrency group
and refuse the configured production project id before staging the sandbox
manifest.
Other integrations are added to the development matrix only after they have an
explicit sandbox manifest for the matching development provider. Ramp's checked
development manifest uses `rampDemo`. Pushes to `main` serialize in one deploy
group and deploy enabled production Ampersand manifests to the project
identified by the `AMP_PROD_PROJECT_ID` repository secret only when their
checked production manifest changed since that integration's last recorded
production deploy SHA,
currently vendor QuickBooks (`quickbooks`) with vendor Ramp (`ramp`) present
but gated until rollout evidence is green. Production project identity is owned
by GitHub secrets and Ampersand operator setup, not by a hardcoded workflow id.
The production job still refuses the most dangerous secret mix-up: if
`AMP_PROD_PROJECT_ID` equals `AMP_DEV_PROJECT_ID`, deployment stops before any
Ampersand CLI call.
GitHub displays the main jobs under `CD` and the PR jobs under `Deploy (Ampersand)`.
The workflow records successful
production deploys by moving per-integration, per-production-project tags such
as `ampersand-production-deployed-vendor-quickbooks-<project-hash>`, so a later
surviving `main` run can still detect manifest changes if GitHub replaces an
earlier pending run while a production project secret rotation forces the new
project through a fresh deploy marker. Missing deployed-SHA tags force a
production deploy for enabled integrations. The workflow installs a pinned
Ampersand CLI release with
checksum verification and runs `amp deploy` directly using these
repository secrets:

- `AMP_DEV_API_KEY`
- `AMP_DEV_PROJECT_ID`
- `AMP_PROD_API_KEY`
- `AMP_PROD_PROJECT_ID`

If these secrets are absent, the Ampersand deployment lane reports a GitHub Actions
notice and skips the Ampersand CLI step instead of failing the PR or `main`
workflow. Add the secrets before expecting automatic manifest deployment.

Do not add integration-id secrets unless the Ampersand action or CLI starts
requiring them. Destination sync, notification routes, provider apps, OAuth
redirects, and webhook signing-secret retrieval remain explicit operator tasks;
the workflow deploys manifests only.

Production mutation tasks are fail-closed. To deploy or change production
destinations/routes, the operator must set
`PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true` in the same shell:

```sh
PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true mise //apps/vendor:ampersand:deploy -- production
PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true mise //apps/vendor:ampersand:sync-notifications -- production
PLATFORM_AMPERSAND_PRODUCTION_READ_HOOKDECK_URL=https://<hookdeck-read-source>/vendor/api/integrations/ampersand/webhook \
PLATFORM_AMPERSAND_PRODUCTION_NOTIFICATIONS_HOOKDECK_URL=https://<hookdeck-notifications-source>/vendor/api/integrations/ampersand/notifications \
  mise //apps/vendor:ampersand:verify -- production
```

`ampersand:sync-destinations -- <environment>` reads the environment-scoped
read and notification Hookdeck URLs above and updates each matching Ampersand
destination independently. It rejects missing URLs, non-HTTPS URLs, and stale
callback paths; there is no single-base input that can collapse the two shared
sources or bypass Hookdeck.

`ampersand:verify` checks every catalog provider whose launch state is `active`
for the selected environment. It checks project and API-key access, integration provider,
deployed read manifest object/destination, expected destination URLs or fallback
callback URL paths, read and notification destination signing-secret
availability, notification topic/routes, topic-to-destination route,
unsupported notification route drift, and the configured JWT key id. When an
active provider requires a hosted OAuth provider app, verification also requires
exactly one matching provider app with its app-owned read-only scope set. When an
environment-specific Hookdeck URL is configured, that full URL is authoritative
and Hookdeck source path prefixes are allowed. When no full expected URL is
configured, verification still requires the raw Autograph callback path. It does
not print secret values. `ampersand:deploy` uses the Ampersand CLI and deploys
`amp.sandbox.yaml` as a temporary `amp.yaml` for development and the checked
`amp.yaml` for production.

Production verification passed on 2026-07-07 for project
`87b973fd-0174-4e35-9045-6c68e659db9e`. That project is now **Autograph
Development**. As of 2026-07-14, production is project
`1bb05b88-308f-4286-b439-0d2be2ab9762` (`autograph-prod`). Dashboard
inspection confirmed the production QuickBooks provider app and both webhook
destinations, but the earlier verification is historical evidence and does not
transfer to the new production project. Current production verification passed
on 2026-07-20 after merge `38fbd7bc` deployed the corrected nested-field
manifest. Keep production installations disabled until signed delivery smoke,
production customer authorization proof, and URL-result proof are recorded for
the current production project. Once deployed, accepted deliveries apply
directly without an app or provider toggle.

On 2026-07-20, the development verifier passed for QuickBooks and Ramp, and a
fresh QuickBooks sandbox run proved signed inline vendor and bill applies plus
exact Hookdeck retry idempotency. The expected production Ampersand variables
and separate Hookdeck source URLs are configured in Vercel with both direct-apply
flags false; the production project and configured JWT key id are verified. Its malformed
Hookdeck project identifier was repaired to the existing **Autograph Ampersand
Production** project; that project has two unpaused, transformation-free
connections to the production read and notification routes. The production
verifier now passes the provider, integration, destinations, signing-secret
presence, notification topic/routes, exact scopes, and JWT key. No production
QuickBooks company is connected for signed-delivery smoke. Ampersand documents
URL delivery only for a single record over 300 KB and exposes no trigger-read
override; the current QuickBooks sandbox cannot produce that fixture, so live
URL proof remains externally blocked pending an Ampersand-supported fixture or
a naturally oversized provider record.

Use environment-specific variables when one shell needs to operate on both
projects:

- `AMPERSAND_DEVELOPMENT_PROJECT_ID`
- `AMPERSAND_DEVELOPMENT_API_KEY`
- `AMPERSAND_DEVELOPMENT_QUICKBOOKS_INTEGRATION_ID`
- `AMPERSAND_DEVELOPMENT_JWT_KEY_ID`
- `AMPERSAND_PRODUCTION_PROJECT_ID`
- `AMPERSAND_PRODUCTION_API_KEY`
- `AMPERSAND_PRODUCTION_QUICKBOOKS_INTEGRATION_ID`
- `AMPERSAND_PRODUCTION_JWT_KEY_ID`

The existing generic variables remain valid when `AMPERSAND_ENVIRONMENT` is
unset or matches the requested task environment. Project roles are not
hardcoded: GitHub development deploys compare `AMP_DEV_PROJECT_ID` with
`AMP_PROD_PROJECT_ID`; operator tasks compare
`AMPERSAND_DEVELOPMENT_PROJECT_ID` with `AMPERSAND_PRODUCTION_PROJECT_ID`; and
local production mutation guards also use `AMPERSAND_ENVIRONMENT=production`.

## Cross-provider rollout verification

QuickBooks, Ramp, and Xero are the accounting-provider rollout lanes. Catalog
launch state describes which repository lane is exposed, while operational
readiness requires the separate live proof below: QuickBooks is catalog-active
in development and production but current-production installations remain
disabled pending fresh proof; Ramp is catalog-active in development with OAuth,
apply, filtering, and replay proved but remains production-registered pending
pagination and production setup; and Xero remains registered until its
signed delivery smoke succeeds. NetSuite and Sage Intacct are registered
discovery entries only; their missing external provider access is an
intentional no-go lane, and activation requests must continue to reject them.

The durable metadata-only Xero development checkpoint from 2026-07-17 is:

- provider-app verification passed with exact read-only scopes, the shared read
  and notification destinations/routes, and an active JWT key;
- installation `bc8b66e4-1ca4-416b-91b0-f24814b722b0`, group
  `dev:xero:7a7ef64d-1501-4c6f-a8b9-f559a4b129e5`, and configured objects
  `contacts`, `invoices`, and `creditNotes` were healthy;
- fresh contacts operation `019f7024-d307-7d26-a4bf-8783f289f4da` reached
  Hookdeck request `req_NoJPrNhwcqGvZ08GmhkO` / event
  `evt_FwN7uScMFxLTewmKog` on connection `web_Gt3ToJGwk0Q6` from source
  `arrusted-ampersand-development-read`, then reached the real callback runtime;
- that fresh callback returned HTTP 401 `svix_signature_invalid`, so it is not
  activation proof. An older replay returned `svix_signature_stale`; the
  five-minute replay window must not be widened.

Repository diagnosis found three conditions that could produce or obscure this
failure: local database setup generated unrelated signing-secret values, the
callback task claimed an obsolete source name, and Node ingress reconstructed
the request through Fetch before verification. The captured external body and
header values are not committed, so this evidence does not attribute the exact
failed request to one condition. Setup no longer invents destination secrets;
the callback claims the existing sources together and passes exact Node body
bytes and original Svix header values directly to the shared dispatcher. The
remaining smoke must be a newly triggered operation after authoritative secrets
are synchronized and the callback process is restarted; replaying an old event
is not a valid substitute.

External verification must not place persistent Ampersand, Hookdeck, Vercel, or
provider credentials in shared infrastructure or agent runners. Record only project/environment labels,
provider and integration identifiers, installation/group/operation identifiers,
Hookdeck request/event/connection/source identifiers, configured object names,
HTTP status/error codes, rotation class, and pass/fail. Never record API keys,
JWT private material, signing secrets, provider client secrets, authorization
codes, access/refresh tokens, raw webhook bodies, or signed URLs.

For each environment, the repeatable gate is:

1. Run descriptor-derived manifest/recipe/catalog checks for every provider.
   Registered-only providers must remain isolated from active smoke tasks.
2. Run the provider environment verifier for every active lane and confirm the
   shared destinations, exact provider, manifest, topic/routes, and active JWT
   key. Use provider-specific verifier tasks where supplied.
3. Exercise authenticated install and health, trigger a fresh apply, replay the
   same fresh delivery for idempotency, and record only the metadata above.
4. Prove deferred-provider install and activation rejection for NetSuite and
   Sage Intacct.
5. Rotate signing secrets, JWT keys, platform API keys, and active-provider
   credentials one class at a time. Confirm new material succeeds, revoke the
   old material, and record the old-material failure code without its value.
6. Run repository redaction, forbidden-field, contract, boundary, artifact,
   recipe, visual, documentation, and environment checks before changing a
   catalog launch state.

## Local Dev Callback

Use Hookdeck for local Ampersand development webhooks. Start the local app
daemons and the callback bridge:

```sh
mise run start
mise //apps/vendor:ampersand:local-callback
```

The callback bridge listens locally on
`PLATFORM_AMPERSAND_LOCAL_CALLBACK_PORT` or port `3761` by default and starts one
CLI session that claims both existing development sources:

- `arrusted-ampersand-development-read`
- `arrusted-ampersand-development-notifications`

Hookdeck forwards each source's standard CLI destination to local `/` by
default; the local callback server accepts root deliveries and dispatches them
by payload type while also accepting the production-equivalent callback paths:

- `/vendor/api/integrations/ampersand/webhook`
- `/vendor/api/integrations/ampersand/notifications`

Configure the Ampersand development destinations to the Hookdeck HTTPS source
URL plus those public paths. The Hookdeck local destinations may still be `/`;
the local root dispatcher keeps that setup equivalent to the two production
paths. The local server calls the shared app-owned read dispatcher and the
shared notification dispatcher used by the Vercel API routes. Both dispatchers
verify the shared destination signature before routing QuickBooks or Xero to
its provider authority checks. The bridge preserves raw request bytes and
original Svix header values for verification and forwards accepted writes to
the local vendor Rust API through the trusted apply bridge.

Set `PLATFORM_AMPERSAND_DEVELOPMENT_HOOKDECK_PROJECT_ID` to the expected
development Hookdeck project metadata before starting the callback. The task
checks `hookdeck project list` and refuses to claim the shared sources unless
that project is the CLI's single current project.

Before starting the callback, populate local fnox's generic shared
`AMPERSAND_READ_WEBHOOK_SIGNING_SECRET` and
`AMPERSAND_NOTIFICATION_WEBHOOK_SIGNING_SECRET` names from the authoritative
merged-runtime values. Authenticated `mise run setup` imports those names from
Vercel; destination sync writes the exact values returned by Ampersand. If
either value changes, restart the callback process because fnox is loaded when
the process starts. Then deploy and verify against the already-configured shared
destinations:

```sh
mise //apps/vendor:ampersand:setup-dev
```

The setup task verifies the current development project, deploys the sandbox
manifest, preserves the existing read and notification destination URLs, syncs
notification topics/routes, and verifies the final state. It skips provider-app mutation unless
`PLATFORM_AMPERSAND_SYNC_PROVIDER_APP=true` is set in the same shell. It expects
the development provider to be
`quickbooksSandbox`; production verification expects `quickbooks`.

Production setup proof must use an authenticated vendor user with integration
management permission against the production app page's setup APIs after deploy.
For the vendor app, integration-keyed install GET/POST and health GET routes
must fail closed with `auth_required` for anonymous requests and return
their setup responses only after the Vercel wrapper derives actor, customer, and
permission context from the server-side auth guard. Vercel preview URLs may be
protected by deployment SSO, so preview success is necessary but not sufficient
for this production path.

## Webhook Flow

Ampersand webhook handling is part of the app-owned integration ingress path,
not the shared TypeScript wrapper package and not core kernel apply.

1. Ampersand posts read/subscribe deliveries or notifications to an app
   webhook ingress route.
2. The route preserves the raw body and passes headers, raw bytes, route
   configuration, and the app-owned integration recipe to app-owned integration
   ingress/adapter code. Webhooks do not have an authenticated browser actor.
3. App integration ingress verifies the Svix signature before parsing JSON.
4. App integration ingress parses the Ampersand envelope and rejects unsupported
   delivery shapes.
5. For `resultInfo.type = url`, app integration ingress first derives the
   stable replay key from the verified envelope, then downloads the short-lived
   payload server-side before processing it. Do not enqueue the URL for later
   workers. The download must be HTTPS-only, host/IP constrained,
   timeout-bounded, size-bounded, JSON-only, and must not log signed URLs. After
   download, compute a payload hash for provenance and duplicate/conflict checks;
   non-empty URL replay success must prove payload provenance before returning
   an existing change_set result.
6. App integration ingress validates the delivery's Ampersand `projectId`
   against the configured project. The environment comes from the configured
   Ampersand project/destination, not from a required webhook field. Resolve
   customer scope from the signed `groupRef` and installation context, then
   confirm installation authority with the Ampersand Platform API. Confirm
   operation authority only for delivery shapes that include an `operationId`;
   subscribe events use their source record/event metadata instead. Reject
   mismatches and stale or uninstalled integrations before any kernel write.
7. App integration code interprets `mappedFields`, source record refs, object
   names, read/subscribe event metadata, and small provenance through the
   app-owned integration recipe and active app schema.
8. App integration code either compiles the normalized delivery itself or passes
   the already-verified delivery, active schema, and app-owned recipe to
   `packages/integration-compiler` for ordinary `ApplyChangeSet` input.
9. The apply path validates app scope and policy, accepts integration source
   metadata only from the trusted app integration ingress, then calls kernel
   apply.
10. Duplicate deliveries replay through existing `change_set` idempotency.

## Persistence Path

### Optional generated app capability

New integrations-enabled apps compose `packages/integration-control-plane`,
`packages/integration-runtime`, and `packages/modules/integrations`. The first
owns minimal tenant connection authority, the second shares server mechanics and
typed recipe factories, and the third owns safe presentation. This explicitly
permits sharing mechanics formerly described as app-local below. App-owned
recipe instances still own provider-to-domain meaning. `packages/integrations`
continues to wrap the external SDK only. The older Vendor Rust bridge described
below remains a migration source, not a requirement for generated apps.

Shared setup uses the protected server OAuth flow and central connection
verification, separately from app installation. The SDK account-management UI has
no enforced connect-only mode and is not exposed as a new setup primitive.
Connecting must not implicitly enable read objects. App activation consumes a single-use
grant and verifies the app's exact installation before ingestion. Existing
connection management must not expose an SDK disconnect action that bypasses
the central organization's impact review. A UI callback is never proof of
provider identity, setup completion, or authority.

The repository installer is opt-in and also supports existing apps. It may emit
only platform-maintained ingress, actions and component wiring; it does not
provision credentials, create service memberships, activate providers or generate
arbitrary REST backends. Recipe availability and environment readiness are
separate. See [Optional app integrations](optional-app-integrations.md).

`packages/integrations` does not persist canonical app data, verify webhooks,
parse Ampersand delivery envelopes, normalize provider data, or compile
`ApplyChangeSet` input. It wraps external integration libraries for reuse.

Durable writes go through the app-owned apply endpoint or persistence bridge.
The app integration ingress receives the active app schema and app-owned
integration recipe, verifies and parses Ampersand deliveries, normalizes
accepted provider data with the recipe, and compiles ordinary `ApplyChangeSet`
input directly or through `packages/integration-compiler`. The app-owned apply
path validates `app_id`/`customer_id` scope and app write policy, opens the
Postgres-backed kernel path, and calls `apply_change_set`.

The trusted persistence bridge exposes only an app-owned apply operation to
provider adapters. That operation awaits app/customer/source authorization,
then selects the private apply route, derives the complete trusted actor and
customer context, creates every trusted header, signs the validated request,
and forwards it through the bridge-owned transport. Provider adapters and other
callers must not inject a transport, select route aliases, spell the private
apply route or trusted header literals, pass partial trusted context, override
individual trusted headers, import the raw trusted-auth signer, or call another
provider's wrapper. The app-owned types omit those inputs, while the scoped
ast-grep rules under `.config/mise/scripts/check/ast-grep/rules/imports` provide positive and
negative proof for literal/import bypasses that module visibility cannot express.

Server-managed setup requests enter a method-and-namespace authorization
envelope before the registry resolves a concrete integration route. Unknown
setup-shaped GET or POST requests are authorized before returning not found;
setup aliases are not supported.

Implementation language follows the boundary. Ampersand ingress, Svix
verification, Platform API lookups, signed URL handling, notification parsing,
and authority checks live under the owning app, such as
`apps/vendor/integrations/ampersand/quickbooks`, and do not move into core
kernel apply. A reusable Rust compiler crate is allowed only as
`packages/integration-compiler`, where it receives already-verified delivery and
recipe input and emits generic kernel write contracts. It must not depend on
provider SDKs, import app crates, hardcode QuickBooks/vendor semantics, persist
integration state, or encode provider/source refs as model `external_key`.

Provider retry logic and provider API execution stay in Ampersand.
Provider-to-app semantics stay in the app-owned integration recipe. App
integration ingress owns the verified translation into kernel writes. The shared
package owns only external SDK/UI wrapping.

Notification routes use the same signature verification boundary. They
acknowledge supported lifecycle/status notifications and do not persist
notification envelopes locally. Installation health, operation status, logs, and
backfill progress remain queryable from Ampersand APIs or the Ampersand
dashboard.

V0 notifications cover installation lifecycle, read/backfill completion,
triggered read success/error, schedule pause, connection errors, and destination
disabled events. Write async notifications are out of scope until writeback is
designed.

## Mapping And Schema

Ampersand hosts object and field mapping. Autograph consumes
[`mappedFields`](https://docs.withampersand.com/object-and-field-mapping) as the
app-facing input to the compiler. Do not store local mapping JSON, selected
provider field manifests, provider schema manifests, or accepted integration
plans in Autograph.

Source refs that depend on mapped provider fields use
`mappedFields.<mapToName>` from the app-owned recipe. Raw provider `fields.*`
paths are reserved for deliberately unmapped envelope data. This keeps the
checked recipe, Ampersand mapping, and compiler input aligned.

Ampersand can fetch provider object metadata and detect provider schema changes
through [customer schema management](https://docs.withampersand.com/manage-customer-schemas).
Use those Ampersand capabilities when the UI or operator needs provider field
visibility; do not create Autograph provider-schema tables for V0.

App-specific checked-in `amp.yaml` manifests live with the app that owns the
schema they target, for example under `apps/vendor/integrations/ampersand`.
Provider object scope is output-driven: a manifest may retrieve only the
objects and fields required by the app-owned recipe to produce rows for app
models. Adding an object requires a target model, recipe mapping, deterministic
matching/update policy when needed, and no-secrets delivery proof; provider
catalog breadth is not sufficient justification. The app-owned manifest
definition rejects missing or extra deployed read objects, and deployed read
definitions hold the app-owned direct-apply destination and its executable
handler by construction. The same definition derives its exact required and
optional provider fields from the app apply recipe; deployed or checked-in
manifests with missing or additional fields fail contract validation.
They use Ampersand's manifest shape: `specVersion`, `integrations`, `provider`,
and read/subscribe objects. A manifest is not an Autograph data model and must
not be treated as shared package state when it encodes app-specific object or
field meaning.

## Environment

Required environment variable:

- `AMPERSAND_ENVIRONMENT`

When at least one provider is active in that environment, the Ampersand runtime
also requires:

- `AMPERSAND_PROJECT_ID` (identifier, not secret)
- `AMPERSAND_QUICKBOOKS_INTEGRATION_ID`
- `AMPERSAND_API_KEY`
- `AMPERSAND_PAYLOAD_ALLOWED_HOSTS`
- `AMPERSAND_JWT_KEY_ID` (JWT `kid`, not secret)
- `AMPERSAND_JWT_PRIVATE_KEY_PEM`
- one signing secret per shared project webhook destination. The read and
  notification destinations use `AMPERSAND_READ_WEBHOOK_SIGNING_SECRET` and
  `AMPERSAND_NOTIFICATION_WEBHOOK_SIGNING_SECRET`.

Vercel builds validate every active provider identity before database
provisioning or storage materialization. The configured integration UUID must
exist in `AMPERSAND_PROJECT_ID` and resolve to the app catalog's exact
integration name. Stale, cross-project, or cross-provider IDs fail the build
instead of degrading installed-account reads to an empty list. If the catalog
has no active providers in the selected environment, the preflight requires no
Ampersand project credentials and skips the inventory request.

Local JWT creation and development operator mutations also require
`AMPERSAND_PRODUCTION_PROJECT_ID` as a non-secret separation sentinel. Standard
setup imports it from the Vercel development environment. Missing or matching
production identity fails closed before any Ampersand mutation.

Required operator-only Hookdeck URL variables for direct verification:

- `PLATFORM_AMPERSAND_DEVELOPMENT_READ_HOOKDECK_URL`
- `PLATFORM_AMPERSAND_DEVELOPMENT_NOTIFICATIONS_HOOKDECK_URL`
- `PLATFORM_AMPERSAND_PRODUCTION_READ_HOOKDECK_URL`
- `PLATFORM_AMPERSAND_PRODUCTION_NOTIFICATIONS_HOOKDECK_URL`

`ampersand:setup-dev` and direct `ampersand:verify` commands require the full
read and notification URL variables above; setup never derives both from one
source URL or collapses the two shared destinations.

Required operator-only Hookdeck project ids:

- `PLATFORM_AMPERSAND_DEVELOPMENT_HOOKDECK_PROJECT_ID`
- `PLATFORM_AMPERSAND_PRODUCTION_HOOKDECK_PROJECT_ID`

Optional operator-only Hookdeck source-name overrides:

- `PLATFORM_AMPERSAND_DEVELOPMENT_READ_HOOKDECK_SOURCE`
- `PLATFORM_AMPERSAND_DEVELOPMENT_NOTIFICATIONS_HOOKDECK_SOURCE`
- `PLATFORM_AMPERSAND_PRODUCTION_READ_HOOKDECK_SOURCE`
- `PLATFORM_AMPERSAND_PRODUCTION_NOTIFICATIONS_HOOKDECK_SOURCE`

Required operator-only QuickBooks provider-app variables before provider-app
sync:

- `AMPERSAND_DEVELOPMENT_QUICKBOOKS_CLIENT_ID`
- `AMPERSAND_DEVELOPMENT_QUICKBOOKS_CLIENT_SECRET`
- `AMPERSAND_PRODUCTION_QUICKBOOKS_CLIENT_ID`
- `AMPERSAND_PRODUCTION_QUICKBOOKS_CLIENT_SECRET`

Optional provider-app variables:

- `AMPERSAND_DEVELOPMENT_QUICKBOOKS_SCOPES`
- `AMPERSAND_PRODUCTION_QUICKBOOKS_SCOPES`
- `AMPERSAND_DEVELOPMENT_QUICKBOOKS_PROVIDER_APP_EXTERNAL_REF`
- `AMPERSAND_PRODUCTION_QUICKBOOKS_PROVIDER_APP_EXTERNAL_REF`

`mise //apps/vendor:ampersand:sync-provider-app -- <environment>` creates or updates the
matching provider app through Ampersand's Platform API. It must not print
client secrets. QuickBooks provider-app scopes must exactly match Intuit's
`com.intuit.quickbooks.accounting` scope. The optional scope variables are only
allowed as an explicit accounting-only assertion; payment or other extra scopes
make `ampersand:verify` and provider-app sync fail. Production provider-app sync
is a production mutation and requires `PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true`.

Development and production use separate Ampersand projects, destinations, and
QuickBooks provider apps. Do not reuse a development provider app or webhook
secret in production. Raw provider payloads, notification envelopes, signed
URLs, and provider secrets are never persisted or logged; V0 has no retention
switch or policy exception.
Local setup never invents or retains stale webhook signing secrets. The generic
read and notification signing secrets must be imported together from the
authoritative shared destinations. When `ampersand:sync-destinations` creates a
development destination and Ampersand returns the Svix signing secret, tooling
stores the returned destination secret in the ignored Fnox profile. If the
destination already exists, or the API response does not return the secret,
import the actual Ampersand destination signing secret into Fnox before live
Hookdeck smoke. `AMPERSAND_JWT_PRIVATE_KEY_PEM` is different: it must be the
private half of an RSA key pair whose public half is registered with Ampersand
for the configured `AMPERSAND_JWT_KEY_ID`. Runtime configuration accepts the
private PEM with native line breaks or the equivalent deployment-safe form
whose line breaks are stored as literal `\n` sequences. The server normalizes
that representation only at the signing boundary; it never serializes, logs,
or exposes the private key to a browser.
The project value may be the Ampersand project ID or project name. Integration
and JWT key identifiers must have Ampersand's UUID shape; validation does not
pin the UUID version because Ampersand owns identifier generation.
Vercel/API redaction markers such as `[SENSITIVE]`, `[REDACTED]`, and
`[ENCRYPTED]` are unavailable values, never credentials. Runtime readiness
validates the RSA private key before returning install configuration. Preview
QA then mints a tenant-scoped JWT and calls both the Ampersand project and
integration APIs with it. This live acceptance check proves that the configured
`kid` exists in the configured project and that its registered public key
matches the deployed private key; checking only that the token has three
segments is insufficient.

Developer onboarding uses `mise run setup` as the single setup command. After
Vercel development env import, setup attempts local JWT bootstrap: when
`AMPERSAND_PROJECT_ID`, `AMPERSAND_PRODUCTION_PROJECT_ID`, and
`AMPERSAND_API_KEY` are available and identify distinct projects, it generates a
developer-local RSA key pair if needed, registers the public key through
Ampersand's JWT key API, and stores the returned `AMPERSAND_JWT_KEY_ID` plus
private PEM only in the ignored local Fnox profile. The bootstrap is idempotent
and skips when a matching local `AMPERSAND_JWT_KEY_ID` and
`AMPERSAND_JWT_PRIVATE_KEY_PEM` already exist. Vercel development env provides
shared Ampersand project/API inputs; it must not be the source of developer
JWT private keys.

## Generated Code

Generic kernel wire DTOs currently come from the Rust-owned type generation
path. The target compiler will own the same generated metadata and keep it
checked against the Rust internal contract during migration.
App-facing clients come from the app schema artifact and shared TypeScript
tooling. An app may have an app-owned Rust backend for schema materialization,
route authorization, and kernel apply calls. That backend must not become the
default home for Ampersand integration work. Integration verification, parsing,
normalization, authority checks, and recipe ownership live at the app boundary
outside core kernel apply and consume app-owned integration recipes. The only
shared Rust home for provider-to-app write compilation is
`packages/integration-compiler`; it is scanner-enforced to remain generic. Do not
add direct QuickBooks SDK usage, provider API clients, Svix verification,
Platform API clients, app schema crates, or provider-specific recipe compilers
to Rust outside that boundary. Ampersand remains the provider execution layer.

The integration recipe is an app-owned contract. Define it with an app-owned or
shared runtime parser outside core kernel contracts, and infer TypeScript recipe
types from that parser or generated output. App-authored recipe code emits a
checked artifact for the integration compiler path. Do not hand-type
drift-prone mirrors of checked recipe artifacts.

## References

- [Ampersand overview](https://docs.withampersand.com/overview)
- [Ampersand API overview](https://docs.withampersand.com/api/overview)
- [Prebuilt UI components](https://docs.withampersand.com/embeddable-ui-components)
- [Webhook destinations](https://docs.withampersand.com/destinations/webhooks)
- [Object and field mapping](https://docs.withampersand.com/object-and-field-mapping)
- [Manage customer schemas](https://docs.withampersand.com/manage-customer-schemas)
- [Manifest schema reference](https://docs.withampersand.com/manifest-reference)
