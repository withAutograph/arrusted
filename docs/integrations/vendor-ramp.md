# Vendor Ramp Integration

Status: V0 manifest/config contract and the app-owned proxy sync/apply runtime
are checked. Development setup is active for sandbox proof; production setup is
registered but inactive pending that proof. Every authorized sync for a
deployed installation applies directly.

Date: 2026-07-20.

## Scope

This document records the Ramp provider contract for applying Ramp data into
canonical Autograph records. Live proof gates installation rollout, not apply
behavior: a deployed, authorized sync always applies and accepts no direct-apply
toggle.

Do not build direct Ramp OAuth, direct Ramp API clients, local provider schema
storage, local integration tables, or native Ramp webhook ingestion for V0.
Ampersand owns the provider connection and proxy execution. The vendor app owns
customer scope, app policy, allowed endpoint selection, fixture review, and the
app-owned compile/apply recipe.

## Result

Current result: **Ramp development OAuth installation, signed non-empty proxy
sync/apply and replay, and direct proxy cursor traversal pass. A production-shaped
Vercel preview also completed a bounded OAuth, apply, persistence, and exact
replay smoke against Ramp Demo. That result validates the preview runtime shape
only; it does not prove provider `ramp`, real production credentials, a real Ramp
company, or production customer rollout. Production remains inactive pending a
separate Ramp production OAuth app, its Ampersand provider app, and every real-
production gate below. The production Ampersand credential has been replaced,
deployed, and verified against the production Ampersand API.**

Ampersand's current Ramp provider guide documents provider `ramp` with Proxy
Actions only. Ampersand's public provider metadata also exposes `rampDemo` for
the Ramp sandbox base URL. Both provider ids report proxy support only: no
Ampersand read, write, subscribe, delete, search, or bulk-write actions. Ramp's
own Developer API docs define the transaction, vendor, and accounting vendor
endpoints needed for the first proof. This workspace now has a checked
proxy-only production manifest, server config parser, app-owned proxy client,
fixture-driven sync normalizer, checked apply recipe, and local manifest/recipe
check task. Sanitized direct-proxy and signed sync-route pagination, trusted
apply, and replay are proved. Failure handling is proved with controlled
contract tests because deliberately breaking shared OAuth scopes or inducing
provider rate limits/timeouts is not a safe or repeatable rollout gate.

The checked fixtures remain sanitized static examples. The 2026-07-17
development smoke additionally proved the live OAuth, proxy, normalization,
trusted apply, and replay path. The 2026-07-19 direct proxy proof exercised the
checked cursor follower over 47 pages; the subsequent signed smoke exercised
the bounded app route over the same live reference collection and proved apply
plus replay idempotency. Accordingly,
`apps/vendor/integrations/catalog.json` keeps Ramp development `active` and
production `registered`. Change production launch to `active` only in the same
change that records the matching production evidence below.

## Source Evidence

- [Ampersand Ramp provider guide](https://docs.withampersand.com/provider-guides/ramp):
  provider `ramp`; Proxy Actions with provider base URL
  `https://api.ramp.com`; prerequisites are a Ramp account, Ramp app client ID,
  client secret, and scopes.
- [Ampersand public provider metadata](https://api.withampersand.com/v1/providers):
  provider ids `ramp` and `rampDemo`; both are OAuth2 authorization-code
  providers with explicit scopes and proxy-only support.
- [Ampersand Proxy Actions](https://docs.withampersand.com/proxy-actions):
  call `https://proxy.withampersand.com` with the same provider path, verb, and
  body; required headers include `x-amp-proxy-version`, `x-amp-project-id`,
  `x-api-key`, and either `x-amp-installation-id` or
  `x-amp-integration-name` plus `x-amp-group-ref`.
- [Ampersand manifest reference](https://docs.withampersand.com/manifest-reference):
  `proxy.enabled: true` is an integration-level capability.
- [Ramp Authorization](https://docs.ramp.com/developer-api/v1/authorization):
  Ramp uses OAuth 2.0, authorization-code flow for third-party apps, and scopes
  such as `transactions:read`, `vendors:read`, `accounting:read`, and
  `accounting:write`. Ramp's OpenAPI also exposes an OAuth host discrepancy:
  the security scheme lists `https://api.ramp.com/v1/authorize`, while the
  token-exchange schema describes authorization codes from
  `https://app.ramp.com/v1/authorize`.
- [Ramp ERP Integrations](https://docs.ramp.com/developer-api/v1/erp-integrations):
  API-managed accounting connections require accounting and vendor scopes;
  transaction flows also require `transactions:read`.
- [Ramp Pagination](https://docs.ramp.com/developer-api/v1/pagination):
  list APIs use keyset pagination through `page.next` and the `start` cursor.
- [Ramp Sandbox](https://docs.ramp.com/developer-api/v1/sandbox):
  sandbox API base URL is `https://demo-api.ramp.com`, demo data has no real
  money movement, and demo actions can create test transactions.
- [Ramp OpenAPI / LLM API reference](https://docs.ramp.com/llms-api.txt):
  endpoint paths, response fields, parameters, and endpoint scopes for
  transactions, vendors, and accounting vendors.

## Provider Setup Contract

Ramp uses Ampersand's standard `InstallIntegration` flow. Do not pass the beta
`variant="wizard"`: the wizard creates an installation only after the user
saves a configured object, while the Ramp manifest is proxy-only and exposes
no selectable objects. Object-based integrations may continue to use the
wizard.

| Area | Current evidence | Gate decision |
| ---- | ---------------- | ------------- |
| Production provider id | `ramp` uses API base URL `https://api.ramp.com`; Ramp's public authorization-code request URL is `https://app.ramp.com/v1/authorize`, and token exchange uses `https://api.ramp.com/developer/v1/token`. If Ampersand provider metadata reports `https://api.ramp.com/v1/authorize`, this workspace has not live-proved whether Ampersand rewrites that install redirect. | Checked manifest uses `provider: ramp` and `proxy.enabled: true` only. Use provider app credentials through Ampersand Provider Apps; live install proof must verify OAuth host behavior before installation rollout. |
| Sandbox provider id | `rampDemo` uses base URL `https://demo-api.ramp.com`, auth URL `https://demo.ramp.com/v1/authorize`, and token URL `https://demo-api.ramp.com/developer/v1/token`. | Use the checked development smoke copy at `apps/vendor/integrations/ampersand/ramp/development` for sandbox deploys after live setup exists. |
| Provider app prerequisites | Ramp account, Ramp developer app, client ID, client secret, selected scopes, and Ampersand OAuth redirect URI `https://api.withampersand.com/callbacks/v1/oauth`. | Required before live install/manage succeeds or any proxy proof begins. The vendor UI may show gated config/health status before this is complete. |
| Ampersand project prerequisites | Ampersand project with Ramp provider app credentials and scopes copied into Provider Apps. | Required before the app backend returns a ready Ramp `InstallIntegration` config. |
| Minimum read scopes for this gate | `transactions:read`, `vendors:read`, and `accounting:read`. | Sufficient only for read/proxy fixtures. |
| Write scopes | `transactions:write`, `vendors:write`, and `accounting:write` exist for some Ramp endpoints. | Out of V0 provider writeback; do not request until a separate writeback plan exists. |

## Development And Production Setup

Development and production must use separate Ampersand projects and separate
Ramp provider apps. Do not reuse a development Ramp app, Ampersand project,
installation, or provider app credential in production.

Development setup:

1. Create or identify an Ampersand development project.
2. Create a dedicated Ramp sandbox app in the Ramp demo environment.
3. In the Ampersand dashboard, add a Ramp provider app for the development
   project using the Ramp sandbox client id and client secret. Store those
   credentials only in Ampersand Provider Apps.
4. Configure the Ampersand OAuth redirect URI in Ramp as
   `https://api.withampersand.com/callbacks/v1/oauth`.
5. Request only `transactions:read`, `vendors:read`, and `accounting:read` for
   the V0 smoke.
6. Deploy the development-only app-owned Ramp manifest copy at
   `apps/vendor/integrations/ampersand/ramp/development` with
   `provider: rampDemo` only after the provider app is present and the provider
   id behavior is verified. Do not edit the checked production
   `apps/vendor/integrations/ampersand/ramp/amp.yaml` file or use
   `provider: ramp` for sandbox smoke proof.
7. Install `vendor-ramp` through the vendor app setup UI for a server-derived
   Autograph customer `groupRef`; do not supply customer ids from the browser.

Production setup:

1. Create or identify the Ampersand production project.
2. Create a separate production Ramp developer app and provider app.
3. Configure the same redirect URI and the same V0 read scopes:
   `transactions:read`, `vendors:read`, and `accounting:read`.
4. Keep Ramp client id/client secret in the Ampersand Provider Apps dashboard
   only. They are not local app environment variables.
5. Deploy the checked production manifest with provider `ramp` only after the
   development smoke status below is green.
6. Keep `AMPERSAND_RAMP_PROXY_MUTATIONS_ENABLED=false`; authorized read-only
   syncs apply through the trusted bridge without a direct-apply toggle.

## Sync-Window Smoke

The first live smoke must use an explicit UTC sync window and a known
installation id. The request body shape is:

```json
{
  "installation_id": "<redacted-installation-id>",
  "sync_window": {
    "start": "2026-07-01T00:00:00Z",
    "end": "2026-07-01T23:59:59Z"
  },
  "page_size": 100,
  "max_transaction_pages": 2,
  "max_reference_pages": 2,
  "max_transactions": 50
}
```

Smoke steps:

1. Confirm the vendor app backend reports Ramp install config ready without
   exposing Ampersand API keys, JWT private keys, Ramp client secrets, or Ramp
   tokens.
2. Complete `InstallIntegration` for `vendor-ramp` with the server-derived
   `groupRef`.
3. POST the request body above through the trusted vendor API route
   `/vendor/api/integrations/ampersand/ramp/sync` using an internal operator
   helper that signs the trusted management context. A plain unauthenticated
   POST must return `auth_required` and is not smoke proof.
4. Include the signed trusted-auth headers required by
   `requireVendorRampIntegrationManager`: `x-platform-actor-id`,
   `x-platform-customer-id`, `x-platform-permissions` with
   `vendor:integrations:manage`,
   `x-platform-auth-context-timestamp`, and
   `x-platform-auth-context-signature` generated with
   `signVendorRampTrustedAuthContext` from the visible route path. Include
   `x-platform-actor-name` and `x-platform-customer-name` only when the helper
   binds them into the signature. Do not include `x-platform-body-sha256`; the
   current management-route verifier does not sign or validate request-body
   hashes.
5. Verify the proxy request hits only the allowed read endpoints:
   transactions, Ramp vendors, and accounting vendors.
6. Verify the response reports `status: "applied"`,
   `integration: "vendor-ramp"`, the requested sync window, and a bounded
   `record_count`.
7. Save sanitized live captures for success and pagination. Redact installation ids,
   account ids, names, addresses, tokens, and any provider identifiers that
   could identify a real customer.
8. Do not send a `direct_apply` field. The runtime rejects that toggle and
   always applies an authorized deployed sync.

## Smoke Status

| Environment | Status | Evidence without secrets |
| ----------- | ------ | ------------------------ |
| Development | OAuth, non-empty apply/replay, empty-window filtering, and signed multi-page proxy traversal pass. | On 2026-07-17, the Ampersand development project deployed `vendor-ramp` with provider `rampDemo`, the Ramp demo app authorized the server-derived `dev` group, and Ampersand reported the connection as `working`. A signed May 2026 sync returned `200`, `status: applied`, and `record_count: 1`; replaying the same bounded request also returned `200 applied` with one record. A July window returned `200 applied` with zero records, proving the provider date filters. On 2026-07-19 the environment verifier reconfirmed the integration provider, exact read-only provider-app scopes, and JWT key. Although the installation authority API then reported a neutral `created` lifecycle state, the checked proxy client followed 47 live Ramp vendor pages and terminated after 92 records. After the route was corrected to reject explicit terminal states without treating neutral lifecycle labels as authorization failures, a signed sync with page size 10 traversed the live reference collection, normalized one May transaction, and applied one trusted change set. Replaying the identical request returned `200 applied`; storage still contained one canonical record, one source reference, one version, and one change set. No raw records, secrets, installation ids, or customer-identifying values were emitted. |
| Production-shaped preview / Ramp Demo | Bounded OAuth, apply, canonical persistence, and exact replay pass; not production proof. | On 2026-07-20 an isolated Vercel preview used Ramp Demo to exercise a temporary production-shaped application path. One bounded record applied, replay resolved to the same change set, and one canonical transaction remained. This smoke did not use provider `ramp`, real production OAuth credentials, or a real Ramp production company. Its temporary preview activation and demo-provider substitutions were discarded with the unmerged smoke branch and do not satisfy any unchecked production rollout gate. |
| Production | Project and integration registration exist; replacement runtime credential is deployed and API-verified, but provider-app setup remains open. | On 2026-07-20 a server/CLI key from the production Ampersand project replaced the failing Vercel production value. Vercel confirmed the replacement deployment Ready on `apps.autograph.so`, and the required production project, JWT, Ramp integration, Ramp host allowlist, environment, and trusted-auth settings are present. A direct request with that exact key returned `HTTP 200` from the production Ampersand project and confirmed `vendor-ramp` among its two integrations; no key or provider data was printed. A separate real Ramp production OAuth app still must be created by an authorized Ramp company administrator and configured as provider `ramp` in the production Ampersand project. The production catalog remains registered, its setup route therefore returns `not_found` by policy, and no real production installation or proxy capture is recorded. |

Live development payload findings now enforced in code:

- Ramp's transaction list filters are `from_date` and `to_date`; `from` and
  `to` are not valid window filters.
- Ampersand connection lifecycle labels are not sufficient proof of proxy
  readiness. The development installation has reported both `working` and
  `created` while authorized proxy requests succeeded; use explicit unhealthy,
  disconnected, or revoked states as failures and require a successful proxy
  smoke before rollout.
- Ramp demo accounts without an ERP accounting connection return `404` with
  `An accounting connection is required` for the optional accounting-vendor
  collection. Only that exact response is treated as an empty reference set.
- Ramp returns `accounting_date` and `settlement_date` as ISO datetimes in live
  payloads; normalization converts them to canonical dates.
- Foreign-currency transactions carry a settled top-level amount/currency and
  a different original amount/currency. Canonical USD writes use the settled
  amount when those currencies differ.

## Production Rollout Gates

Production closeout has two phases. Phase 1 keeps the catalog registered while
provider prerequisites are established. Once every Phase 1 gate passes, change
the production catalog state to active and deploy the manifest/UI for a
controlled operator smoke. Technical activation is required to register the
setup routes and is not by itself approval for general customer rollout. Phase
2 must pass before production availability is announced or used beyond the
authorized smoke organization.

Phase 1 - before catalog activation:

- [x] Development Ramp sandbox provider app exists in Ampersand and has a successful
  `vendor-ramp` installation for a server-derived `groupRef`.
- [x] Development installation completes an authorized proxy smoke at the time of
  the final pagination proof. A direct proxy success can diagnose an
  undocumented lifecycle label, but it does not bypass the sync route's health
  and authority checks.
- [x] Development sync-window smoke records pagination, trusted apply, and replay
  through the signed app route with sanitized result metadata.
- [x] Controlled tests prove insufficient-scope/provider-error classification,
  stale installation and customer authority rejection, bad requests, `429`
  retry metadata handling, timeout bounds, and secret-safe error rendering.
- [x] App-owned source-reference matching is reviewed against the live captures and
  does not encode provider/source identity as model `external_key`.
- [x] Production Ampersand API access verifies with the credential stored in
  Vercel.
- [ ] Production Ramp provider app exists in the production Ampersand project with
  only the V0 read scopes.

Phase 2 - after controlled catalog activation:

- [ ] After catalog activation, production setup APIs are registered and do not
  return `auth_required`. While production remains catalog-registered, the setup
  route is intentionally absent and returns `not_found`.
- [ ] A production installation completes a signed bounded sync through the app
  route, trusted apply, canonical read-surface visibility, and exact replay
  without creating another source reference, version, or change set.
- [ ] `AMPERSAND_RAMP_PROXY_MUTATIONS_ENABLED` remains false unless a separate
  approved rollout explicitly enables it with
  `PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true`.

Checked production manifest path:
`apps/vendor/integrations/ampersand/ramp/amp.yaml`.

The production Ampersand GitHub Actions deploy matrix carries this checked
manifest, with deployment disabled while Ramp production is catalog-registered.
The repository also owns
`apps/vendor/integrations/ampersand/ramp/development/amp.yaml` for the
`rampDemo` proxy-only development lane, and the catalog exposes that lane as
active. Development OAuth/apply/replay evidence does not by itself prove
production readiness: keep production registered until every Phase 1 gate above
is recorded. After controlled activation, complete every Phase 2 gate before
general customer rollout.

Checked production manifest shape:

```yaml
specVersion: 1.0.0
integrations:
  - name: vendor-ramp
    displayName: Vendor Ramp
    provider: ramp
    proxy:
      enabled: true
```

Development smoke manifests must use `provider: rampDemo` and remain
development-only. Do not change the checked production manifest to sandbox
provider ids, request Ramp write scopes, or add read/write/subscribe manifest
actions in V0.

Checked development smoke manifest path:
`apps/vendor/integrations/ampersand/ramp/development/amp.yaml`.

## Server Config Contract

The local server config parser lives at
`apps/vendor/integrations/ampersand/ramp/config.ts`. It accepts only the
Ampersand project/integration credentials required for install/proxy execution:

- `AMPERSAND_PROJECT_ID`
- `AMPERSAND_RAMP_INTEGRATION_ID`
- `AMPERSAND_API_KEY`
- `AMPERSAND_JWT_KEY_ID`
- `AMPERSAND_JWT_PRIVATE_KEY_PEM`
- `AMPERSAND_ENVIRONMENT` (`development` or `production`)
- `AMPERSAND_RAMP_PROXY_ALLOWED_HOSTS` (`api.ramp.com` and, for sandbox
  proof, `demo-api.ramp.com`)

Optional Ramp flags:

- `AMPERSAND_RAMP_PROXY_ENABLED` defaults to `true`.
- `AMPERSAND_RAMP_PROXY_ALLOWED_ENDPOINTS` optionally narrows the checked V0
  read-only allowlist with comma- or newline-separated `METHOD /path` entries.
- `AMPERSAND_RAMP_PROXY_MUTATIONS_ENABLED` defaults to `false`.

Production mutation flags require
`PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true` in the same environment. Keeping
the proxy-mutation flag false is the expected production posture until live
proxy evidence and a separate mutation plan approve that path.

Ramp client ID and client secret stay in Ampersand Provider Apps. Do not add
`RAMP_CLIENT_ID`, `RAMP_CLIENT_SECRET`,
`AMPERSAND_RAMP_PROVIDER_APP_CLIENT_ID`, or
`AMPERSAND_RAMP_PROVIDER_APP_CLIENT_SECRET` to local app config. Ramp provider
app credentials must never be committed or printed. Browser-prefixed env
(`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`) must not contain the Ampersand API key,
JWT private key, Ramp client ID, Ramp client secret, Ramp access token, or Ramp
refresh token.

## Allowed Proxy Surface

The initial V0 proof is read-only. The allowed proxy allowlist is:

| Ramp resource | Method and path | Scope | Fixture |
| ------------- | --------------- | ----- | ------- |
| Transactions | `GET /developer/v1/transactions` and `GET /developer/v1/transactions/{transaction_id}` for drilldown after list discovery | `transactions:read` | `docs/integrations/fixtures/ampersand-ramp-proxy-transactions.json` |
| Ramp vendors | `GET /developer/v1/vendors` and `GET /developer/v1/vendors/{vendor_id}` for drilldown after list discovery | `vendors:read` | `docs/integrations/fixtures/ampersand-ramp-proxy-vendors.json` |
| Accounting vendors | `GET /developer/v1/accounting/vendors` and `GET /developer/v1/accounting/vendors/{vendor_id}` for drilldown after list discovery | `accounting:read` | `docs/integrations/fixtures/ampersand-ramp-proxy-accounting-vendors.json` |

Everything else is denied for V0, including `POST`, `PATCH`, and `DELETE` on
those resources, accounting sync mutation endpoints, native Ramp webhook
management, and any endpoint outside `/developer/v1/transactions`,
`/developer/v1/vendors`, or `/developer/v1/accounting/vendors`.

The config parser's default allowlist is exactly the table above. Any configured
allowlist entry outside those read-only endpoints fails closed.

## Manifest Validation And Deploy Dry Run

Local validation for this contract is:

```sh
mise //apps/vendor:ampersand:ramp:manifest-check
```

The task runs the Ramp config tests, asserts the checked production and
development manifests are app-owned and proxy-only, and does not call Ampersand.
The Ampersand documentation used for this contract documents `amp deploy`, but
does not document a no-write `validate` or `dry-run` command. Until Ampersand
provides a no-write manifest validation command, treat local tests plus
manifest review as the dry-run proof and do not run a live deploy as
validation.

The live development deploy command shape, when an approved operator has a
configured development project and secrets, deploys the checked development-only
manifest copy with `provider: rampDemo`. Do not edit the checked production
`amp.yaml`:

```sh
AMP_API_KEY="[redacted]" amp deploy apps/vendor/integrations/ampersand/ramp/development --project "<AMPERSAND_DEVELOPMENT_PROJECT_ID>"
```

Production deploys require the same explicit confirmation posture as
QuickBooks:

```sh
PLATFORM_AMPERSAND_CONFIRM_PRODUCTION=true AMP_API_KEY="[redacted]" amp deploy apps/vendor/integrations/ampersand/ramp --project "<AMPERSAND_PRODUCTION_PROJECT_ID>"
```

Do not pass the API key as a shell argument, do not echo the API key, do not use
shell tracing, and do not paste Ramp provider app client credentials into local
env; the provider app credentials stay in Ampersand.

## Proxy Request Shape

Ampersand proxy calls replace the Ramp API base URL with
`https://proxy.withampersand.com` and keep the Ramp path, verb, query string,
and body.

Required proxy headers for server-side calls:

- `x-amp-proxy-version: 1`
- `x-amp-project-id: <Ampersand project UUID>`
- `x-api-key: <Ampersand API key>`
- either `x-amp-installation-id: <installation UUID>` or both:
  - `x-amp-integration-name: vendor-ramp`
  - `x-amp-group-ref: <server-derived Autograph customer_id>`

If installation id, integration name, and group ref are all present, Ampersand
uses the installation id. The browser must never receive the Ampersand API key
or the Ramp client secret. Server code must derive `groupRef` from the
authenticated customer scope and must not trust client-supplied tenant ids.

Success responses are expected to be provider pass-through JSON. The Ramp list
responses in this gate use:

```json
{
  "data": [],
  "page": {
    "next": null
  }
}
```

The fixture files also include representative non-2xx provider error examples.
Those error examples are documentation-derived expectations only. The live proxy
gate must prove whether Ampersand returns any wrapper headers, status
normalization, or error envelope around Ramp responses. The checked app-owned
parser consumes provider pass-through list pages and normalized recipe input; it
must not assume undocumented live wrapping.

## Pagination

Ramp list endpoints use keyset pagination. The response `page.next` field is
the URL for the next page and includes the `start` cursor. Continue until
`page.next` is `null`.

When following `page.next` through Ampersand proxy:

- validate that the next URL is a Ramp production or sandbox API URL before
  extracting the path and query;
- call the extracted path through `https://proxy.withampersand.com`, not Ramp
  directly;
- preserve the same installation or `integrationName` plus `groupRef` routing
  headers;
- bound page size and total pages for local proof runs;
- record the first and final page fixtures before enabling a live installation.

## Direct Apply Overlap Handling

Ramp normalization persists only the shared AP source fields. The provider
transaction id becomes `source_record_id`, card rows use
`transaction_kind = card_transaction`, merchant display becomes
`counterparty_name`, and Ramp state/date/update facts map to the common
status/date fields. Ramp vendor and accounting-vendor ids remain transient hash
and matching inputs. An unambiguous accounting-vendor match derives the
canonical vendor external key for the `vendor` relation; ambiguity rejects and
an authoritative merchant miss leaves the relation absent.

The checked app-owned apply path first submits a normal batch `ApplyChangeSet`
so non-overlapping sync windows keep their existing batch `source_ref` and
idempotency behavior. If the trusted vendor backend rejects that batch with
`trusted_integration_same_day_batch_unsupported`, the Ramp apply path retries
the same normalized transaction records as one-write deliveries. That keeps
already-applied same-day rows on the trusted backend's single-write replay path
while allowing new rows from an overlapping or backfill sync window to apply.
The fallback is only used after that specific trusted rejection; clean
non-overlap windows remain a single trusted apply call, while overlap fallback
is bounded to one retry delivery per normalized transaction. Before splitting,
the app-owned apply path rejects duplicate `source_record_ref` identities so the
trusted batch duplicate-source invariant is not bypassed.

Apply responses report `applied_change_sets` as an array plus
`apply_partitioned`, rather than a single `applied_change_set`, so
partitioned applies do not hide earlier change-set ids.

Empty sync windows remain no-ops before trusted apply. Aggregate-only records
still fail closed during app-owned recipe compilation.

## Error And Retry Shape

Current docs prove only partial error behavior:

- Ramp OpenAPI lists `400` responses on the list endpoints in this gate.
- Ramp authorization docs describe insufficient-permission and invalid-scope
  failures during OAuth setup.
- Ramp rate-limit docs describe `429 Too Many Requests` and `504 Gateway
  Timeout` for long-running requests.
- Ampersand proxy docs describe optional rate-limit management with
  `X-Amp-Rate-Limiter-Mode: throttle`; in that mode, Ampersand can return
  `X-Amp-Retry-After` and `X-Amp-Retryable` headers.

Provider error envelopes can vary, so the runtime treats their body as
untrusted, retains only bounded classification needed by policy, and never
renders raw payloads or secrets. Controlled tests must cover:

- missing or insufficient Ramp scope;
- invalid or stale Ampersand installation routing;
- bad request/query validation from one allowed endpoint;
- Ramp 429 behavior with and without Ampersand proxy throttle mode;
- one provider 5xx or timeout path.

These are deterministic code gates, not destructive live-smoke requirements.
Do not remove scopes from the shared provider app or manufacture rate limits
and timeouts to activate production.

## Sandbox Behavior

Ramp documents a sandbox UI at `https://demo.ramp.com` and sandbox API base URL
`https://demo-api.ramp.com`. Demo accounts do not move real money, and the
sandbox demo actions panel can create test transactions.

Ampersand provider metadata exposes `rampDemo` for this sandbox base URL. The
development project has a dedicated Ramp demo provider app with the exact V0
read scopes and a `vendor-ramp` installation for the server-derived `dev` group.
Live OAuth, non-empty proxy/apply, empty-window filtering, and replay were proved
on 2026-07-17. On 2026-07-19 the same installation completed both a live
multi-page direct proxy read and a signed paginated sync/apply/replay despite
Ampersand returning the neutral lifecycle label `created`. The sanitized
evidence above records only aggregate counts and clearly distinguishes live
proof from the static examples. Production activation still requires the
unchecked production gates above.

## Native Webhooks

Native Ramp webhooks are out of V0. Ramp documents its own webhook events, but
Ampersand's current Ramp provider guide documents Proxy Actions only. Do not add
Ramp native webhook receivers, Ampersand subscribe routes, or notification
routes for Ramp until Ampersand documents or a live project proves a supported
Ramp read/subscribe path and real fixtures are captured.

## Fixture Gate

The checked fixtures are:

- `docs/integrations/fixtures/ampersand-ramp-proxy-transactions.json`
- `docs/integrations/fixtures/ampersand-ramp-proxy-vendors.json`
- `docs/integrations/fixtures/ampersand-ramp-proxy-accounting-vendors.json`

They are sanitized, static, contract-shaped examples. They intentionally use
placeholder ids, sanitized names/addresses, and no secrets. They prove the
expected review shape for this gate, not live provider readiness.

Production installation rollout remains disabled until live Ampersand Ramp
evidence proves:

- provider id and sandbox routing;
- success response shape for every allowed endpoint;
- first-page and next-page pagination behavior;
- customer scope and installation authority fields available before apply;
- deterministic source references for app-owned matching.
