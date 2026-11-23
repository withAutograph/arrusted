# Route-owned microfrontends

The pinned MIT `@vercel/microfrontends` library supplies standard
configuration, matching, framework adapters, and local development behavior.
The paid Vercel Microfrontends product is not used. The custom authenticated
Gateway remains the deployed composition plane.

## Checked topology

[`microfrontends.json`](../microfrontends.json) is the
sole logical application and browser-route input. It keeps the `apps`,
`hc`, `spend-review`, and `vendor` application keys. The root
[`vercel.ts`](../vercel.ts) is the sole provider entrypoint for one Vercel
project/deployment. It directly imports
`@autograph/platform-microfrontends/vercel-config`, whose private factory
combines the neutral catalog-derived Services graph with Autograph's physical
runtimes, callback ingress, Gateway selection, and security headers. The neutral
compiler appends the Gateway catch-all. Configuration does not scan directories
or create browser routes.

The private, unpublished neutral compiler composes native Vercel objects and
resolves catalog package identities through standard workspace metadata. Physical
Service names preserve provider-valid catalog keys; other keys use the neutral
compiler's stable, bounded `vercelApplicationServiceName()` mapping. Logical app
IDs and their derived binding environment names stay unchanged. Retained runtime
sidecars append their role to their existing key. It has no required
`apps-*` prefix, directory layout, named default app, build profile, or install
command. Standard Services contain only their workspace root and private bindings
when needed; Vercel detects their framework and build.

New applications use `microfrontends.json` only. Generated Next apps invoke native
framework commands, and registration adds their Service and Gateway binding
without a root config edit. The HC/Vendor legacy manifests and custom schema are
removed, with no replacement descriptor protocol. Their retained physical runtimes
are explicit native Vercel definitions in the private adapter, alongside the
Gateway and native Next Shell. Public callback and Gateway ingress are private
Autograph policy exported through the root entrypoint.

Each child route group uses the opaque asset route produced by the pinned
library. The public configuration has no application-name asset prefix and no
browser-facing internal environment vocabulary.

Generic discovery reads workspace package metadata and the same complete official
configuration used by the compiler. It has no fixed default identity or root.
Arrusted's authorization IDs remain private policy, including the retained Shell
mapping and generated package namespace; these IDs do not define routing identity.
Source-policy checks run in repository artifact validation, separately from metadata
discovery. The [portable runtime compatibility matrix](../packages/microfrontends/README.md#compatibility-matrix)
and isolated Node example define the reusable boundary. Ordinary Next Shell and
individual HC/Vendor sidecar simplifications remain follow-ups.

The Gateway build rebuilds the neutral runtime before compiling the function;
unchanged dependency installs may skip package preparation on warm build caches.
The portable transport bundles its CommonJS proxy dependency so the native
function does not require a separately traced copy at startup.

Shell auth request, server-header, and Preview boundaries derive the private
Service name from the official default application in the bundled catalog.
Vendor resolves its package identity in the same catalog and validates its API
sidecar against `<application-name>-api`, matching the native Service definition.
These boundaries must not retain historical physical names when catalog Service names change.

## Gateway routing

Vercel Deployment Protection applies at the public Gateway ingress. The
Gateway removes caller-supplied platform and forwarding headers, authorizes the
request, and then writes the bounded public-origin receipt used by private
upstreams. Shell and product services remain private except for their reviewed
public routes.

Origin resolution occurs after authorization through the selected in-deployment
native Service binding. Bindings supply reachability only: they never supply
authentication or authorization. There is no deployment listing, Git/PR/SHA
mapping, alias reconstruction, readiness/time election, or Production fallback
for an in-project binding.

The active Gateway does not probe, list, elect, reconstruct, or fall back to a
retained application's provider deployment. After the official matcher selects
an application, it uses exactly the current deployment's native binding. The
binding key is a Gateway convention, derived from the application's checked
Vercel project identity:
`VC_MICROFRONTENDS_BINDING_${PROJECT_NAME.toUpperCase().replaceAll("-", "_")}`.
The retained applications therefore resolve to
`VC_MICROFRONTENDS_BINDING_APPS`,
`VC_MICROFRONTENDS_BINDING_HC`,
`VC_MICROFRONTENDS_BINDING_SPEND_REVIEW`, and
`VC_MICROFRONTENDS_BINDING_VENDOR`.

Application code must not read or hardcode these keys. The root `vercel.ts`
derives every Gateway Service edge from the registered catalog, and Vercel
injects the current deployment's private URL under the derived key. The Gateway
resolver owns the same derivation from the logical application identity, so a
retained application has no app-local origin configuration in Vercel mode. All
bindings are validated as distinct credential-free HTTP(S) origins before
forwarding; missing, malformed, colliding, or unexpected retained bindings fail
closed. Explicit caller-owned external zones remain separately configured and
are never a retained-app fallback.

Product navigation responses pointing to the selected product are rewritten as
Gateway paths. External redirects remain unchanged. Legacy
`PLATFORM_MFE_<APP>_ORIGIN` variables cannot select product origins in Vercel
mode.

## Application deployment ownership

Applications retain independent source/build ownership inside one Vercel
project. Native Git delivery produces one deployment; Vercel owns its atomic
activation and rollback. A failed app build blocks that deployment, rather than
creating cross-project selection or per-app provider rollback.

Vercel supplies the root project name (`apps`) to every Service build. A child
framework service whose logical application key differs from that project name
must select its checked `microfrontends.json` application through the official
framework adapter's explicit application option. The Spend Review and Vendor
Next services call `nextAppConfig()` from their own workspace. The helper reads
the local `package.json` name and supplies it to the official adapter;
`packageName` maps those names to `spend-review` and `vendor` so it retains
each opaque asset prefix. This build identity is not a Service name, routing
catalog, project group, deployment selector, or authorization input.

Provider readiness and authenticated route proof are independent. `READY`
alone is not application-health evidence. Repository CD is read-only,
app-scoped coordination and proof: it has no Git/PR deployment selector,
promotion controller, reconciliation loop, or release graph.

## Provisioning

The private factory used by root `vercel.ts` composes one private Service per
catalog application plus Gateway and the explicitly retained HC/Vendor sidecars.
For example, the HC
frontend is `hc`, with `hc-api` and `hc-agent`; Spend Review is
`spend-review`. `apps` serves the native Next Shell. Root ingress exposes only
the authenticated Gateway and two exact Vendor callback paths. Catalog changes
derive the corresponding physical Service and Gateway target together; browser
routes, asset prefixes, logical binding environments, authorization IDs and
storage ownership do not depend on the physical name.

### Deferred callback relay

Ampersand callback delivery remains direct to `vendor-callbacks` for now.
Vendor authenticates those machine callers by preserving the raw body and
verifying the app-owned Svix signature, rather than by applying a browser
session. A later, separately reviewed Gateway-relay change may make Gateway
the sole public ingress, but must preserve the exact body and signature headers
and leave signing secrets/verification in Vendor. This work neither changes
the callback routes nor mutates Vercel Deployment Protection, provider
callback URLs, or hosted configuration.

The HC and Vendor project-local `vercel.json` files were retired after the
one-project Preview proof. A-433 removes their repository authority; any
dormant provider resources are historical, unreferenced, and may not select a
deployment, binding, activation, or rollback.

The root `apps` project owns both public Production domains. `apps.autograph.so`
enters the authenticated Gateway, while `hooks.autograph.so` reaches only the
two exact Vendor callback rewrites declared before the Gateway catch-all in the
root `vercel.ts`. The obsolete sibling projects must not retain either public
domain or a Git connection after provider cleanup.

### Preview environment migration inventory

For Preview proof, the root project owns the environment keys already consumed
by the retained service owners; the migration copies values through the Vercel
environment UI/API and never records values in this repository. Gateway owns
its existing session, identity, auth-database, and public-origin configuration;
retained app origins are only native Service bindings, never legacy
`PLATFORM_MFE_<APP>_ORIGIN` or `SHELL_SERVICE_ORIGIN` values. HC API/agent own HC database and trusted-auth
keys; Vendor API/callbacks own Vendor database, integration, webhook, and
trusted-auth keys; Shell owns its existing auth build inputs. Frontends receive
only their current public build-time settings.

The root `services` contract supplies only these non-secret private transport
bindings: `VC_MICROFRONTENDS_BINDING_APPS`,
`VC_MICROFRONTENDS_BINDING_HC`,
`VC_MICROFRONTENDS_BINDING_SPEND_REVIEW`,
`VC_MICROFRONTENDS_BINDING_VENDOR`, `SERVICE_API_ORIGIN`,
`SERVICE_AGENT_ORIGIN`, and `VENDOR_API_URL`. The microfrontend binding names
follow the derived Gateway convention above; do not create any of these as
manually managed project environment values. Application-owned database,
integration, and secret values remain app-scoped inside the root project
Services graph.

External cleanup of obsolete projects, aliases, variables, credentials,
alerts, hooks, integrations, and storage is a separately authorized operator
action. The repository inventory remains sanitized and neither performs nor
authorizes that provider mutation.

## Mechanical proof

`mise run check:microfrontends-deployment` validates the standard topology and
its direct Shell consumption. `mise run check:vercel-services` validates
Function/Services ownership, the exact public route allowlist, private bindings,
migration ownership, protected transport, and no-paid-product policy.

Read-only proof confirms protected Gateway routing, app-scoped health, privacy,
authentication, migration, and rollback receipts. It does not consume pull
request association, commit enumeration, merge/ancestry/freshness state, or
repository-managed Preview deployment mutation.

## Neutral Gateway-core boundary

The private `@autograph/microfrontends` package contains official-config
projections and policy-neutral Gateway mechanics. Provider-generic Gateway and
Vercel-adapter mechanics belong in the open-sourceable neutral boundary;
Autograph-specific authorization, identity, fleet mapping, secrets,
provisioning policy, receipts, recovery, and operations remain private.

The neutral package also owns the config-only Vercel Node Services entrypoint:
an installed package validates `microfrontends.json` and generates ephemeral
build output while the consumer keeps no Gateway source. Its routing-only mode
uses required Deployment Protection for ingress and private Service-binding
variables for every selected application. This capability does not itself cut
over or remove the retained authenticated Gateway; that composition change
remains a separately accepted platform operation.

Vercel is the only implemented hosting adapter. Kubernetes, other clouds, edge,
and non-Node runtimes are future choices, not current support claims.
