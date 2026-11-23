# Deployment security

The custom authenticated Gateway is the final deployed composition plane. The
pinned MIT `@vercel/microfrontends` library is used directly for standard
configuration and local behavior; Vercel's paid Microfrontends product, project
groups, native shared-domain routing, and product fallback are prohibited.

The active kernel path owns persisted correctness. During the SQL rewrite, each
operation remains on the existing Rust/PostgreSQL path until parity and caller
cutover make its generated SQL function authoritative.

## Authentication and principal boundary

The public Gateway authenticates the user, validates tenant and application
authorization, strips caller-supplied trusted headers, and attaches the bounded
delegated principal required by a private upstream. Product projects do not
receive Better Auth secrets. Direct immutable product origins stop at Vercel
Deployment Protection before application execution.

Private bindings are accepted only from the checked Gateway caller. Delegated
requests bind the target route and principal; client source cannot read server
credentials or private binding URLs.

Within a native Services deployment, private product Services verify delegated
principals over exact in-deployment Service bindings. They do not use sibling
project origins, branch aliases, deployment enumeration, or Production
fallbacks.

The exact default Auth routes for identity readback and private proof collection
may receive the existing internal native-caller carrier only after Gateway verifies
the original workload OIDC. Private proof collection is restricted to a query-free
`POST /api/auth/platform/operator-link` with
`Accept: application/vnd.realm-operator-proof+json`. Shell
independently verifies the configured Preview operator identity before returning
proof JSON; the original public OIDC header is stripped. Normal session and origin
checks remain required, and collecting an identity proof grants no organization
membership or application access.

An explicitly enrolled public isolated app includes one aggregate
`runtimeBindingDigest` in anonymous `/_platform/health`. Private Gateway policy
hashes the fifteen loaded app/Auth environment values as sorted `{key, sha256}`
entries, then hashes that canonical manifest. The configured protected-app set
must match the set the Gateway actually enforces. For this verified isolated
deployment, Gateway restores the enrolled public host only on its own native
Service ingress with the existing strict forwarding checks. The response exposes no values,
individual hashes, enrollment metadata, or owner identities. Builder compares
this aggregate with the concrete approved public-release plan before recording
readiness, so an old deployment with the same source and signing key cannot
stand in for a newly configured app. Ordinary health remains `{status: "ok"}`;
the digest grants no user, organization, or application access.

## Origin isolation

The Gateway owns browser-facing route composition. Its selected logical
application resolves through an in-deployment native Service binding; it does
not list deployments, map Git/PR/SHA state, reconstruct aliases, elect by time
or readiness, or use Production fallback. All binding transport failures remain
visible and fail closed.

Product navigation is rewritten to Gateway-relative paths. The Gateway's
request-scoped resolver cache cannot mix origins across applications or branch
requests. Vercel OIDC is captured only inside the request scope and is available
only to the selected protected product origin.

## Service exposure

One retained Vercel project contains explicit Gateway and Shell Services.
Every standard registered Next.js app contributes its private frontend Service
through the root programmatic configuration. HC and Vendor retain checked,
catalog-gated compatibility manifests for their existing nonstandard runtimes;
new applications must use `microfrontends.json` and the standard frontend
shape, not introduce an app Service manifest. Gateway is the only public
composition ingress; Shell, frontends, Rust APIs, and agents remain private.
Only the exact Vendor Ampersand webhook and notification ingress routes precede
its catch-all.

Each native runtime Service owns a focused entry point and route contract.
Private Service request paths remain intact for delegation signatures. The
Vendor API binding is accepted only as the exact `<application-name>-api` target
Service origin derived from the Vendor package identity in `microfrontends.json`
(currently `vendor-api`) and issued under Vercel's private Services domain; sibling Service names,
public hosts, credentials, ports, paths, queries, and fragments fail closed. The
native Function entry does not start a listener or create a second public
ingress. Shared trusted-ingress, replay-protection, and Vercel adapter mechanics
live in the private `platform-service-runtime` package; application route policy,
body limits, authorization choices, and initialization remain app-owned.

The direct Ampersand paths are a deferred provider-callback relay boundary.
They authenticate non-browser delivery through Vendor's raw-body Svix signature
verification, not a browser session. A future Gateway-only ingress change must
preserve raw bytes and signature headers while retaining signing secrets and
verification in Vendor; it requires a separate security review and provider
readback. This repository change does not alter callback paths, Deployment
Protection, or provider callback configuration.

## Environment and migration ownership

The root Services project owns hosted environment configuration. Server secrets
stay outside browser bundles and are neither printed nor committed. App-owned
secrets retain their application ownership without becoming sibling-project
configuration.

Vercel's native Rust builder compiles each API from its app-owned source and
the pinned Rust toolchain. The build hook does not query Auth, receive database
installer credentials, or mutate an application database. The protected
operator owns approved schema installation and tenant activation through the
existing per-operation journal and fence; installation failures block that
operator operation. Each API retains restricted runtime database access and
fails readiness when its installed schema or required runtime state is
unavailable or incompatible. Database installation and native deployment are
separate effects. No global migration controller, fleet release manifest, or
cross-project rollback is permitted.

Vendor's protected release-bundle effect also grants its generated runtime
capability read-only access to the three tenant-scoped readiness metadata
tables and execution of their row-policy scope check. Their forced row-level
policies still require the exact tenant binding;
Vendor checks activation and legacy lookup state in a tenant-scoped transaction.
The same effect reads the grants back before installation can complete.

A native deployment does not install the selected schema release. If the
protected operator has not installed and activated that release for a tenant,
the corresponding API remains unready. Deployment completion alone is not
evidence that installation or activation completed; the operator's journaled
readback and the API's tenant-scoped readiness check are separate evidence.

Production proof checks each application's registered launch route through the
Gateway. Its authenticated, read-only QA pass requires successful HTML routing
and the exact Gateway ownership receipt. It records only the route path, status,
and ownership receipt; it does not retain response bodies or install or activate
schemas.

Shared proof does not consume app-declared readiness endpoints or JSON shapes.
App-specific schema, storage, and business readiness checks remain app-owned;
they are not generic CD gates. A successful launch-route proof does not claim
those semantic outcomes or replace protected installation and tenant-scoped
readback. Actual launch, authentication, routing, ownership, and provider
failures remain proof failures.

## One-project deployment and rollback

Vercel native Git delivery owns the one-project deployment, atomic activation,
and rollback. Repository CD is read-only proof. It does not associate pull
requests, enumerate commits, use merge, ancestry, containment, freshness, or
Git selection to select a deployment, and it does not promote or reconcile
provider state.

A rollback is one provider deployment rollback. Read-only proof confirms its
Gateway route, privacy boundary, and authentication. Application health and
migration compatibility remain separate app-owned evidence.

For a source-hook regression, repair or revert the affected source on a
reviewed branch and rebuild through native Git delivery. Keep the HC and Vendor
hooks limited to pinned toolchain preparation; a hook repair must not restore
the former Auth lookup or database materialization command. The protected
operator's exact installed-release and tenant-state readback remains separate
from native deployment. App-owned compatibility checks are not generic CD
gates. A failed readback leaves that tenant unready and does not authorize a
repository CD deployment, alias change, or database repair.

## Retained Production proof

Production proof is read-only evidence. It validates the current
provider-owned Production domains and deployments through the authenticated
Gateway with protected QA credentials. Its bounded artifacts exclude
credentials, cookies, principals, response bodies, private binding URLs,
database identifiers, provider project/deployment identifiers, deployment URLs,
and provider payloads or errors. Receipt v2 retains only one `ciSha` for
diagnostic traceability; it never compares that SHA with current `main`.

Before creating a QA session, proof polls the public `/api/auth/ok` endpoint
with at most thirteen GET attempts, a fifteen-second timeout per health request,
and ten-second intervals. Only transient HTTP/network failures retry; redirects,
access denials, malformed health bodies, and invalid provider receipts fail closed.
Every attempt captures the provider-current binding; a successful response must
be bracketed by matching binding reads before sign-in begins. A replacement
during the probe needs another health observation. Exhaustion reports the
sanitized `gateway-readiness` stage. Sign-in mutations are never retried. This
checks current public health, not whether a particular Git revision has activated.

If the provider-current binding changes during the authenticated proof, the QA
session is signed out and invalidated before proof reports a sanitized
`provider-replacement` cancellation. Failed cleanup remains a cleanup failure.

A fresh proof establishes present provider health; it is not a repeat of
activation and does not expand provider mutation. The current provider
deployment is authority even when repository history has advanced. Historical
or in-progress non-current deployment attempts neither select nor invalidate
the current provider binding.

## Provisioning and provider proof

The checked Vercel provisioner validates exact project identity, Git roots,
Deployment Protection, OIDC, reviewed Trusted Sources, private bindings,
public-domain ownership, and absence from paid-product groups. It does not
treat provider variables, credentials, aliases, alerts, hooks, environments,
integrations, or resources as repository-owned cleanup targets.

EXT-GW-03 independently owns external deletion after its approved sanitized
inventory. The repository must not mutate those external resources.

## Better Auth best-practices audit (2026-07-18)

The Gateway's Better Auth integration retains the server-only secret boundary,
secure session cookie requirements, centralized session verification, tenant
authorization, CSRF/origin checks for mutations, and explicit logout
invalidation. Changes to authentication must preserve these properties.

## Verification

The authoritative local gates are:

- `mise run check:deployment-policy`
- `mise run check:microfrontends-deployment`
- `mise run check:vercel-services`
- `mise run check:types`
- `mise exec -- actionlint .github/workflows/*.yml`

These gates verify repository contracts. They do not substitute for provider
activation or external cleanup authority.

`check:vercel-services` first loads the sole root `vercel.ts` entrypoint through
the pinned `@vercel/config` validator, then checks the complete evaluated
Services graph against this repository's catalog, private-binding, and ingress
policy. The provider validator covers its supported programmatic configuration
fields; the repository graph check remains authoritative for Services-specific
topology and forbidden paid-product rules. Neither gate contacts or mutates
Vercel.
The entrypoint directly imports the private
`@autograph/platform-microfrontends/vercel-config` factory. That package owns
Autograph's public callback routes, Gateway selection, and security headers;
the neutral catalog compiler appends the Gateway catch-all without embedding
repository policy.
