# Contracts

The root `app/` single-deployment starter is scoped separately; historical multi-app deployment rules below do not describe that starter.

The target ownership model
records the selected Auth, app, resource, and versioned-interface boundaries.
It keeps Arrusted app code and schemas on one Git main while adopting independent
app databases through protected provisioning. A clean synthetic Neon baseline
is a separate provider resource; existing Production main is not reset.
Current runtime behavior and the distinct
hosted evidence predicates remain defined below.

HC and Vendor emit a private `service-database-binding` runtime-log observation
once per process and selected connection kind (`runtime`, `initialization`, or
HC `schema-admin`). It reads built-in identity functions through the connection
already selected by the application, after its session configuration, in a
short read-only transaction that rolls back. The event contains the selected
environment key, deployment/environment metadata when available, timestamp,
and SHA-256 fingerprints of the configured host/database/login and observed
SQL database, login, effective role, schema, search path and optional Neon
identity settings. It contains no URL, credentials, customer scope, request
body, or raw resource names. Failure emits only `observation-unavailable` and
preserves the application result. There is no new HTTP route or grant.
The [HC/Vendor binding observation procedure](operations/hc-vendor-database-binding.md)
defines how a protected read-only request and private log/provider readback
establish the serving binding before adoption or migration.

## Generated application implementation contract

Framework versions are exact root-catalog pins referenced by generated app
manifests through `catalog:`. New Builder builds resolve stable targets once per
accepted plan; ordinary app edits preserve versions and explicit upgrades carry
concrete framework targets through retries. `repository:upgrade-framework`
updates central framework pins and the package-manager-generated lockfile only,
restoring both on installation failure. Builder reviews the workspace-wide
shared dependency impact separately from its app-owned migration. Generation
and upgrade never fabricate product behavior or replace existing app source.

The current repository creation interface is `mise run create:app [app-id]`.
An optional AppSpec Markdown file is a copied product-intent snapshot, not a
schema or executable workflow contract. An optional app-owned CUE file selects
the compiled PostgreSQL backend. The checked CUE manifest and domain catalog
are logical schema inputs; Rust validates, lowers, and verifies immutable
release artifacts; the installed, hash-pinned PostgreSQL functions are the
request-time data authority. Generated TypeScript operations expose that
authority to server-only application code. App Server Actions own workflow,
authentication context, and browser-safe disclosure. The exact compiler input
surface and current runtime capabilities are in [the schema compiler
contract](schema-compiler.md) and [generated data operations](generated-data-operations.md).

Supported manifest members must survive normalization in their documented
destination: persisted schema, compiler-only extras, or optional app client
metadata. Unknown members at typed boundaries fail compilation. The opaque
`connectors` and `agents` values are preserved only as app-owned client
metadata when `label` is supplied; their presence does not generate provider
integrations, agent execution, or database policy. They are not a way to extend
the compiler's schema vocabulary. App generation does not accept arbitrary
routes, Rust services, raw SQL, lifecycle overrides, or deployment instructions.
The optional integrations installer may compose platform-maintained webhook,
notification, setup and supported sync handlers through thin generated wiring.
This is a fixed capability boundary, not permission to generate arbitrary REST
backends. CUE owns domain schema and authorization; executable app-owned typed
integration definitions select supported recipes and bind generated fields.
Apps that do not select this capability receive none of its runtime wiring.

### Application discovery and isolated runtime

`mise run app:describe <app>` returns the versioned, source-derived identity,
backend, immutable selected release, declared roles, runtime binding, route and
validation commands. Route discovery is a capability observation; it does not
prove authenticated response behavior. Builder must author app-owned CUE and
business rules from accepted requirements, including explicit role policy.
The optional app-owned `package.json` `autograph.deployment` declaration supplies
`deployment.framework`, `deployment.sourceFilesOutsideRootDirectory`, and optional
`deployment.buildCommand` when present; `app.workspacePath` remains the source-derived
deployment root.

`mise run app:runtime <plan|prepare|verify|installed|resume-installed|cleanup> <app> <local|preview>`
owns isolated validation resources. `installed` reads the existing local
checkpoint without starting its database; `resume-installed` starts only the
recorded existing local PostgreSQL cluster and then returns its installed
identity. It never initializes or replaces the data directory. The private state is checkpointed before
provisioning and contains installer credentials, restricted runtime credentials
and fixture sessions outside the checkout. Public output is sanitized. Preparation
creates separate app and Auth databases, restricted principals, two tenants,
two real identities per role per tenant, or two explicitly admitted identities
per tenant when the checked app has no business roles, and one authenticated
organization member per tenant without app admission or kernel membership. The private
browser identity manifest represents that member with no app roles. With `APP_RUNTIME_CONTEXT_DIR`, a single
version-2 protected context checkpoint owns shared Auth, origin, credentials,
fixture actors and app installation references; each app retains its own database
and runtime principal. The public plan remains version 1 with optional
`authScope: "context"` and `authPrincipal`. Legacy per-app journals and
`APP_RUNTIME_STATE_DIR` remain supported and cannot be combined with context
mode. The context lock serializes preparation, verification and cleanup. A
second app preserves existing accounts, passwords, signing keys and sessions;
access still requires explicit per-app assignments and kernel membership.
Apps in one validation context share its Auth runtime principal and credential;
this is a trusted first-party synthetic realm. App assignments enforce application
access, while separate app databases/principals enforce the app-data boundary.
The shared Auth credential does not isolate malicious sibling application code.
App cleanup removes only its grants/database/principal and reference; Auth and
its local cluster remain until the last recorded app is cleaned. Interrupted
preparation retains its reference and original resources for explicit recovery.
See [Shared validation Auth](guides/shared-validation-auth.md) for context
checkpoint, command and teardown ownership. Preparation installs the exact checked release
and creates both Auth assignments and database actor memberships for named-role
actors. Intentionally roleless local apps use positive-generation Auth
`app_actor_access` and database `kernel_actor_access` instead, without inventing a
business role. Their identity manifests distinguish `access: "admitted"` from the
`access: "unassigned"` negative actor even though both have `role: null`. Legacy
null-role entries without that discriminator remain unassigned. The local Auth
reader uses the journal-owned `PLATFORM_LOCAL_APP_ACCESS` workspace/resource
binding, restricted loopback connection and local TLS policy; it cannot select a
managed Production realm. Application processes cannot write admission rows.
Prepared local task launches omit inherited managed-realm, Production identity,
Auth resource and deployment-profile selectors before applying the saved local
environment. Explicit saved conflicts still fail Auth validation; nonlocal
launches and direct Auth parsing retain their existing authority checks.
Runtime verification rejects table or column mutation privileges on operator-owned
admission and invitation records. Local active-release verification uses the
fixture actor's positive admission or named-role membership fence; adding named
roles retains the principal's existing actor-binding requirement and resources.
Preparation reuses matching positive fences, and refuses revoked or conflicting
Auth/database grants rather than reactivating them. The unassigned member has
neither admission nor membership. Admission does not add a global record-owner
policy: applications own any private-per-actor filtering and write authorization. Verification
checks active release identity and resource authority; application behavior stays
unassessed until authenticated app tests execute. Cleanup checks ownership of
all resources before deleting any resource. Preview preparation requires an
approved isolated provider endpoint; it cannot provision Production.

`app:runtime run` injects the protected runtime environment only into declared
app development/browser tasks or the repository app validation tasks. Installer
credentials never enter application processes. CUE source and the selected
release are packaged by the generated Next config; historical releases remain
immutable and are excluded from runtime tracing. Provider adapters own hosted
binding and readback, while native Git delivery and operator activation retain
their existing boundaries.

### Evidence classes

Evidence is scoped to the exact source and release artifact under test. Each
class has its own predicate; passing an earlier class does not imply a later
one.

| Class      | Required evidence                                                                                                                                                                                        | Claim permitted                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Local      | Source digest, checked release checksums, successful compiler/app checks, and exercised local PostgreSQL or browser behavior for the named workflow                                                      | That workflow works with the tested local inputs and environment                                   |
| CI         | Passing applicable checks at the exact commit and artifact digest. PR checks cover quality and directly changed apps; affected main CI separately covers PostgreSQL parity and other specialized suites. | The named checks passed for the observed commit; PR success alone does not establish post-merge CI |
| Preview    | Provider read-back of the exact native Preview deployment and release, protected Gateway ingress, bound auth/tenant scope, and exercised workflow or readiness receipts on that deployment               | The named protected Preview path worked at the observed deployment                                 |
| Production | Provider read-back of the active Production deployment and route, exact release identity, authorized activation, and exercised read-only health/workflow proof with its receipt                          | The named Production path was observed at that deployment and time                                 |

For source-only app PRs, CI may reuse the checked release when schema, release,
compiler, runtime and global compilation inputs are unchanged in the PR
comparison. Reuse still verifies the CUE source hash, app identity and every
release member checksum. Changed or unknown compilation inputs retain schema
compilation; the default local application lifecycle continues to compile.

A policy check, fixture, dry run, pending check, or `not-run-*` receipt does not
count as hosted proof. Documentation and local or CI results alone cannot
establish Preview or Production behavior. Provider-owned deployment and
activation remain separate from repository validation and application creation.

Generated Next apps serve the root implementation at their registered
`/<app-id>` route through an editable `app/<app-id>/page.tsx` entry. The Gateway
forwards the registered pathname to Next. An app may provide its own page at
that route. For a CUE-backed app, resolve authenticated app scope inside the
feature's Suspense boundary. The shared server foundation exposes session-only
`getAppSession()` and operation-bearing `app/data` DAL functions. Both use the
existing authenticated app guard, and operations retain their
per-invocation and per-operation authorization and checked-release protections.
The generated scaffold does not mount a schema GET endpoint. An app that opts
into semantic Production proof may provide its optional authenticated release
receipt; the read-only proof uses it to verify installed-versus-packaged release
identity. This endpoint is not product data access, page authorization, or
activation authority. Product Server Components read through server-only app data functions;
client-triggered mutations use app-owned Server Actions that validate input,
authorize each invocation and revalidate affected routes after persistence.
Both call generated PostgreSQL operations directly, without self-directed HTTP.
Builder supplies the product page and actions in the same build. Product
acceptance requires evidence from the implemented workflow.

[Generated app behavior acceptance](generated-app-behavior-acceptance.md) defines
the local authenticated fixture, independent readback, process-restart predicate
and portable assertion result consumed by public acceptance reporting. Missing
behavior fails; absent infrastructure blocks; unexercised behavior stays
unassessed. A reference-app fixture run is not public Builder generation proof.

### Local repair and hosted validation

For a concrete failure, reproduce it locally when feasible through the real
serialization, command or request path with controlled test-owned inputs. Use
the observed failure to make the smallest functional repair and add focused
regressions before another hosted cycle. Preserve credential, tenant-isolation,
approval and cancellation boundaries; local fixtures do not authorize hosted
effects.

Once the integrated change is ready, run applicable local validation once.
Reuse valid evidence for unchanged behavior and inputs; repeat checks when a
change, failure or unresolved concern warrants it. Exact-head CI owns broad
deterministic checks. Hosted validation establishes actual provider credentials
and bindings, native deployment, and authenticated acceptance separately from
local and CI results.

If the failure is hosted-only or local reproduction is impractical, state the
evidence gap and use a targeted diagnostic deployment. This policy does not
require exhaustive local proof, add a generated-app test or release gate, or
change provider-owned activation.

## Repository validation ownership

`.config/konsistent.json` is the source of truth for syntax-local structural
filesystem and TypeScript import/export conventions. The repository's custom
validators own only semantics that require workspace resolution, generated
artifact comparison, package metadata, JSON/TOML parsing, Rust inspection,
deployment topology, or security-specific analysis. A rule moves between these
owners atomically with its positive and negative proof; the prior implementation
is removed rather than retained as a compatibility check.

## TypeScript configuration ownership

`@autograph/typescript-config` owns reusable compiler presets (`base`, `nextjs`,
and `vitest`). Root `tsconfig.json` owns only root TypeScript files, the root directory,
and only the generic `@/*` rule. Its `include` keeps root type checks scoped to
root files; TypeScript's default would select files throughout the workspace.
`${configDir}` resolves the alias to each extending project's directory.
`.config/typescript/workspace-paths.json` owns
the shared source aliases used by apps, packages, and repository tooling. The
generated Next app template extends it, so new apps start with the same source
aliases and an app-local `@/*` rule. Capability packages
such as `@autograph/csv-workspace` resolve through declared dependencies and
package exports. HC and Vendor use the shared alias map for legacy shared source
imports, including generated data runtime code. The shared map contains no
app-owned client aliases. The Next preset owns the standard app file patterns
using `${configDir}`; projects with different file sets own their selections
and deliberate overrides. `.config/typescript/domain-lib.json` owns the shared
file patterns for domain libraries while inheriting the package test preset.
TypeScript replaces a `paths` map rather than merging its entries, so the
shared map repeats `@/*` alongside its source aliases. A project that defines
`paths` must also restate any shared aliases it still uses.
Vercel repository scripts own their file list in
`.config/mise/scripts/vercel/tsconfig.json`.
The shared Next defaults provide `@/*` resolution for both Next bundlers,
matching TypeScript and Vite when they read `${configDir}`. Next also reads the
shared source alias map for both bundlers because its build does not resolve
those aliases from the inherited TypeScript config.
Declaration build configs copied into standalone package candidates remain
self-contained.

## Application creation and provenance

`mise run create:app [app-id]` is the complete repository creation interface.
When omitted, the command generates a collision-resistant lowercase kebab-case
ID in the form `app-<UUID>` and returns it in the creation receipt. The supplied
or generated ID and current `microfrontends.json` derive the
workspace, package, project, title, default public routes `/<id>` and
`/<id>/:path*`, asset route, topology digests, and collision checks. Additional
routes require a separate reviewed topology edit. Resolved transaction plans
and their digests are internal recovery state, never caller-supplied API input.

With neither convention input present, creation produces a static Next.js app.
Optional `.config/app-specs/<id>.md` is copied byte-for-byte to
`apps/<id>/.config/app-spec.md` as a product-intent snapshot. Optional
`.config/app-specs/<id>.cue` selects server-side data support within the Next app,
is copied to `apps/<id>/schema/<id>.cue`, and is compiled into the checked release and
`schema/index.ts` pointer. After creation app-owned CUE is schema authority;
validation checks that source and release instead of a separate generation
manifest. Creation accepts no owner, capabilities, starter, or write-lifecycle
metadata. App features own product write and review behavior.

Schema release validation preserves compiler stderr and stdout with the app,
failing compiler phase, exit status or signal, and a concrete retry command.
Long output retains its beginning and end. A missing CUE or native toolchain
gets a toolchain check; malformed compiler JSON names the artifact stage.
Consumers may show a bounded, sanitized excerpt but must retain related CUE
source context and indicate truncation. Retry commands use the supported
`schema:release` mise task and preserve an explicitly selected repository root.

The generator validates the projected workspace and catalog before publishing
either, checks immutable input and topology digests under its transaction lock,
and records durable recovery state before mutation. Interrupted runs recover
or roll back before proceeding; a journal proving complete publication returns
the recovered receipt. Existing app identities otherwise fail as collisions.
Source creation, publication, provider provisioning, and deployment activation
remain separate authorities.

### Generated app Production handoff

The Builder handoff ends at a checked app source and Preview receipt. Production
readiness requires a reviewed app ID, route, immutable CUE release and digest,
named organization and actors, app-owned role policy, and an operator plan.
`mise run app:production -- plan <app> <organization-id> <actor-id> <role>`
emits a credential-free plan and digest bound to the release and reviewed
database host. `prepare` accepts that digest, creates the dedicated database
and runtime login, installs the checked release without demo seeds, activates
it for the named tenant, and binds the runtime principal to that scope. `grant`
checks existing Auth membership, installs the exact actor role in the generated
database, then exposes the application in Auth and records the app assignment.
`revoke` closes that Auth assignment before disabling the database actor role.
Repeated preparation and exact grants must be safe to replay; a changed plan
digest fails before mutation. Operator credentials and database passwords never
enter a Vercel runtime environment or a public receipt.

The protected operator allocates and journals one positive `fenceGeneration`
for each approved access operation and passes that exact value to the protected
installer. The Auth assignment and kernel membership rows retain the highest
applied generation. A larger generation advances the row, an equal generation
is idempotent only for the same active/inactive intent, and a lower or
conflicting generation fails without changing the row. The protected installer
reads back both the intended state and exact generation; missing or mismatched
rows remain incomplete. Auth changes and the `organization.appIds`
compatibility projection commit together; the projection is recalculated from
active assignments for that app while preserving unrelated app IDs. The
`app:production` CLI is a generation-zero compatibility path: it may operate
only on generation-zero rows and cannot change a row once protected fencing has
advanced it. It does not substitute for the protected operator journal.

The operator binds `<APP>_DATABASE_URL` to the checked native Services runtime
using a runtime-only login and keeps the cluster login in protected operator
storage. Provider-owned Git deployment and activation, Gateway routing, and
read-only CD proof remain separate stages. Production proof confirms the
provider deployment, Gateway route ownership, and authenticated launch-route
response. App-specific mutations, role decisions, and browser journeys remain
app-owned.

### Builder-managed Production access

An explicitly enrolled `managed-production-realm-v1` binds normal Production
Auth to one Builder workspace, repository, native sender, public origin, exact
database resource, and allowed organizations. It preserves existing Preview
enrollment and keeps generic Production signup closed. A protected app-scoped
invitation authorizes a one-use email sign-in/signup link. Auth must verify the
actual account, email and live session before reporting the accepted identity
to the protected operator with native workload authority. An email match alone
never creates membership or an app grant, and invitees need no Builder account.

A saved creator link belongs to the exact authenticated Builder owner,
issuer/audience, workspace and Auth resource. The protected host can reuse that
accepted identity for a new app after the original Auth session expires, but
must reread the actual still-verified account and accepted source invitation.
The Auth worker binds the target invitation to that source without email-based
identity matching. Reuse cannot restore previous grants or revoked access for
an existing app; it is only initial creator enrollment for a new app.

Normal generated data apps receive app-scoped public runtime metadata through
`<APP>_APP_BOUNDARY`, with the uppercase, underscore-normalized app ID matching
`<APP>_DATABASE_URL`. The protected operator supplies the saved destination's
exact public origin/JWKS URL and independently owned runtime identity. Generated
Next ingress and session readers use these facts to verify Gateway-signed app,
actor, tenant, role and request bindings without forwarding shared Auth cookies.
The scoped value takes precedence over historical `PLATFORM_APP_BOUNDARY`. A
present empty, malformed or conflicting scoped value fails closed and never
falls back to `PLATFORM_APP_BOUNDARY`.
Frontend-only generation retains its existing Auth path without a data boundary.

The fixed Auth app-access worker owns scoped invitation creation, readback,
delivery, renewal, cancellation and completion. It records a delivery attempt
before requesting a token, uses that attempt as the provider idempotency key,
and reconciles uncertain sends without automatically issuing another token.
A stale approval before any send releases only its own unsent reservation.
Invitation membership checks and locks the current verified, unexpired invitation
inside the member transaction; cancellation and expiry cannot reuse an earlier
read. Completion cannot first accept an expired invitation, while an already
accepted response remains reconcilable. Redirects require the enrolled HTTPS
origin.
First-time public signup prepares the verified claim's existing-organization
membership with only its workspace, organization and actor identity. The app
binding stays on the claim and is checked before and after preparation. This
step activates the same verified session's organization and creates no app grant;
the separately fenced access step must still complete before launch.
The operator checks the saved invitation and current inviter authority before
joining the existing organization as a member and granting app access. Existing
organization roles are never promoted. A membership newly created by the protected
join retains its exact `managed-membership-v1` organization-and-actor-derived ID;
reusing an existing membership preserves its ID. Auth recognizes that existing
origin marker and requires a current app role or explicit role-less admission
for each app, including legacy apps in the organization's catalog. A found
nonmatching membership keeps its previous organization entitlement policy;
missing membership denies tenant access, and unreadable authority is an error.
The shared chooser and app-specific organization choices apply the same
restriction, including the explicit empty-role admission check. Existing
per-organization lookup failures keep the other usable app choices available.
The origin marker grants no app role,
and sign-in, invitation identity callbacks, signup continuation and recovery
remain usable before app access is installed. Historical policy-derived signup
IDs are not treated as immutable origin evidence: their mutable policy records
lack retained membership provenance and need a separate lifecycle contract.
Data-backed apps use the coordinated
positive-generation Auth/database installer; frontend apps use a separately
fenced app entitlement. Apps without named roles receive no invented business
role: Gateway carries the positive-generation app admission claim separately
from data-role grants and rereads access on each request. For a data-backed app,
the same generation binds the restricted database principal, app, tenant and
actor in `kernel_actor_access`. Reads hold the current admission row; mutations
also retain the signed request and payload replay boundary with a null role.
Work sessions use the same admission and retain its human or agent identity;
explicit agent contexts cannot acquire human-only Save authority.
Admission never bypasses the schema's current field, record or business-role
policy, and the schema-admin binder rejects replacing named policy roles with
role-less access. Revocation retains
fenced tombstones, and listing or changing access stays within the selected app
and organization. The same saved app, destination and resources survive resume
and revision. Normal delivery requires no synthetic Preview preparation.

Runtime role-less admission reads only the configured Builder workspace, and
managed-app discovery also binds invitation records to the configured Auth
resource. A same-named app in another workspace cannot supply access. Frontend
access changes reconcile the organization's app list in the same transaction:
the app remains while any active role or admission exists and disappears after
its last grant is revoked, preserving other apps.

The existing Production Auth host must use the exact enrolled
`AUTH_DATABASE_RESOURCE` and restricted runtime credential. Its fixed protected
schema migration installs both the managed-access tables and
`runtime-privileges.sql` functions/ACL before activating the managed realm.
Its protected schema-only plan separately binds the dedicated Production
app-access login and its checked grant profile. Protected access workers use
that login for invitation and membership effects. Its exact read/write scope
excludes authentication secrets, organization role changes and schema ownership.
Legacy provisioning without that resource does not establish these permissions.
Runtime preflight rejects direct, PUBLIC, inherited, and column writes to managed
app admissions and invitations as it does for operator-owned assignments and
signup policies; ordinary Auth requests cannot become a provisioning authority.
The realm's native Production sender, operator origin, and managed email sender
are platform configuration described in `packages/auth/README.md`; creators do
not enter provider or database details. Provider-owned native deployment remains
the activation mechanism.

## Platform service runtime ownership

`platform-service-runtime` is private reusable infrastructure for Rust product
Services. It owns trusted-ingress verification, mutation-replay storage,
caller-controlled platform-header stripping, bounded Vercel request conversion,
and per-scope initialization caching. It must not own application routes, body
limits, storage policy, provider behavior, or product authorization decisions.
Each product owns one complete app-local Service entrypoint and consumes the
runtime through its Cargo API; cross-application `include!` and `#[path]` source
coupling are forbidden.

## Disposable Gateway Preview proof fixture

## Neutral Gateway access and delegated identity

`@autograph/microfrontends` owns only neutral Gateway mechanics. Every selected
HTTP or WebSocket route requires one caller-supplied `GatewayAccessAdapter`
decision; explicit allow proceeds, while deny, a missing decision, a missing
adapter, and adapter failure fail closed before origin resolution. The package
may mint and verify short-lived Ed25519 delegated-identity envelopes, but owns
only expiry, audience, method, request-target, optional body digest, and replay
binding. Principal fields and their meanings, session mapping, authorization,
tenant/organization vocabulary, entitlement decisions, and private headers
remain caller-owned. The neutral package must not depend on `@autograph/auth`
or `@autograph/platform-microfrontends`; private session-to-principal adapters
belong in `@autograph/platform-microfrontends`. Zone API delegation there mints
a fresh trusted-auth replay id for each delegated backend call, including
repeated calls with the same method, private target, and body digest, so one
browser request can issue multiple backend POSTs without sharing a mutation
claim.

The optional `transport.prepareRequest` port is pure and synchronous. It prepares
the public request URL using locally published destination metadata and returns
a `target` URL, `setHeaders`, and optional `removeCookies` names. The neutral
Gateway immediately snapshots the prepared `requestTarget` string and copies
and freezes the header and cookie-removal plan before awaiting authorization.
This preparation performs no origin resolution, provider request or credential
minting; those remain behind the access decision. The original public
`requestTarget` remains the authorization and denial-redirect input. The
separate `principalRequestTarget` and forwarded request-target marker bind the
principal to the exact prepared downstream target. The existing post-signing
query-change guard and destination verifier remain unchanged.

## Config-only Vercel Gateway Service

`@autograph/microfrontends` owns the generic Vercel Node Services build
boundary. A source-free consumer names its existing `package.json` as the
configured Service entrypoint, installs the package, and runs
`microfrontends vercel-service build`. The command validates the one
standard `microfrontends.json` with the pinned official schema and atomically
emits only `microfrontends-vercel-service/server.mjs`; the generated file
embeds the ephemeral route catalog and is never a tracked manifest.

`@autograph/microfrontends/vercel-config` reads standard `microfrontends.json`
through the pinned official validator. Its `compileCatalogVercelServiceGraph()`
composes ordinary Vercel Service objects and complete private bindings;
`resolveCatalogWorkspaces()` resolves catalog package identities through standard
workspace metadata. Neither requires `apps-*` identities, `apps/<id>` roots,
a default application named Shell, or custom install/build commands. Framework
and build detection belong to Vercel. Flagged catalog routes are valid compiler
input; a Gateway runtime without flag evaluation rejects them before routing.
The package remains private and unpublished with an isolated packed-consumer proof.

The configuration compiler and runtime discovery share the official loader. Its
full configuration remains the route authority; routing groups and options are
not rebuilt from a reduced schema. Package identity is `packageName ?? applicationName`.
Development ports and asset prefixes come from the pinned library, and framework
classification belongs to native Service fields or framework adapters. The neutral
Node entrypoints ship JavaScript and declarations and require no Arrusted runtime.
HC and Vendor declare their official asset prefixes in the checked catalog so their
runtime bundles can consume those fields without loading the schema validator.
Local Vite zone runners resolve their workspace through the validated catalog. OCI
Vite zones receive that discovered prefix at image build time for the static runtime.
The [compatibility matrix](../packages/microfrontends/README.md#compatibility-matrix)
distinguishes verified behavior from hosted-product features outside this phase.

Private authorization identity policy preserves existing app identifiers independently
of catalog keys and workspace roots. Repository source checks validate Arrusted's
framework/security requirements; metadata discovery does not impose those source
requirements on consumers. The repository source checker accepts ESM framework
configuration; CommonJS Vite config files are outside that static inspection boundary.
Private container builds and cache mounts use discovered workspace roots, and
prevalidated build inputs compare actual catalog keys without an `apps-*` naming rule.
The portable Gateway adds an HTTP hop and is not a
claim of hosted-product performance or independent-release parity.

The private `@autograph/platform-microfrontends/vercel-config` factory assembles
the neutral catalog graph with the remaining Gateway, native private Shell, and
HC/Vendor runtimes using native Vercel fields. Frontend physical Service names
preserve catalog keys that meet Vercel's lowercase-letter/hyphen/underscore
grammar and 64-character limit. Other keys use `app_` followed by the first
32 SHA-256 hex digits of the logical key encoded with `a`–`p` instead of
`0`–`f`. The neutral `vercelApplicationServiceName()` helper supplies the same
stable name to the frontend and Gateway binding target. The binding environment
continues to derive from the logical catalog key, as do application identity,
routes, package names, Auth and storage ownership. Colliding physical names or
binding environments fail closed without counter suffixes or catalog reordering.
Caller-owned physical Service names and binding targets must meet the
[provider constraints](https://github.com/vercel/vercel/blob/main/packages/fs-detectors/src/services/resolve-v2.ts);
the compiler does not rename explicit mappings or static runtimes. Retained
HC/Vendor sidecars append their role to their existing catalog key. There is no legacy manifest
schema, build-profile language, optional package-export protocol, or application
registry. Standard Next apps need only a workspace and catalog registration.
The private factory owns the two exact Vendor callback rewrites, Gateway
selection, and security headers. The neutral compiler appends the Gateway
catch-all; root `vercel.ts` imports and exports the resulting configuration.
Node Gateway and Express Services use their native entrypoints without identity
`request.path` routes. [Vercel Services routing](https://vercel.com/kb/guide/vercel-services)
preserves the incoming path for public Service rewrites, and [private bindings
reach the same routing layer](https://vercel.com/changelog/secure-internal-communication-between-services).
Repository policy rejects Service-level routes, rewrites, and redirects for
non-Rust Services so no local override changes their runtime-visible paths.
The two Rust API Services retain their `/(.*)` to `/index` dispatch and
original-path transform because local source
checks do not prove what path that dispatch exposes to the Rust runtime.
Nested path, query, and private-binding tests protect the application side of
this contract; deployed provider behavior remains a separate verification.
Generated apps invoke `next build`, `next start`, official `microfrontends port`,
and `vp` directly. Repository checks own staged dependency-link validation and
pass Next's native `--webpack` option only for isolated staged builds. Ordinary
app builds do not generate the platform catalog or require the repository runner.
The generator-owned standard app package profile defines package membership for
new apps, including the optional CUE-backed data dependencies. The root
`package.json` catalog pins external versions. Creation expands package membership
into a normal app manifest with `catalog:` references for external packages and
local `workspace:*` private packages. The root catalog is the single version
source for those dependencies. Apps in this Bun workspace can add packages after
creation; profile membership changes affect new apps only. Repository manifest
checks preserve app additions while requiring shared catalog references.
The manifest check also requires unique workspace names, valid `workspace:*`
targets, and package-relative export and binary paths. Generated `dist`
exports require a package build and an existing source target; packed-consumer
proofs validate their output where packages support external consumers.
Standalone Storybook installs from its own lockfile, with shared pins checked
against the root catalog. The dependency audit reports unreferenced candidates
for review without changing or rejecting manifests.
Apps and packages declare directly imported workspace and external dependencies
in their own manifests. Packages used by runtime source belong in dependencies
or peers, rather than only devDependencies. Framework virtual imports such as
`server-only` do not create install dependencies.

Package scripts follow their actual capability: `check` validates without
emitting, `test` runs once, and `build` emits consumable artifacts. App tests
also run once. A package with its own TypeScript project exposes `check`; a
no-emit typecheck is never a `build`. Pack lifecycle hooks must not run the same
build twice. Turbo reads
these scripts from each package manifest, while the repository manifest check
enforces their shared semantics and requires package tests to have a script or
an explicitly named repository task.
Generated Next apps route `check`, `test`, and `test:e2e` through app-owned mise
tasks. `check` validates lint and types without checking formatting; the
separate `lint` task applies available fixes. `test:e2e` installs Playwright's
matching Chromium headless shell when needed before running browser tests.

Before `create:app` publishes generated source or its catalog registration, it
evaluates that same root configuration against the staged repository and runs
the shared catalog-derived graph policy used by `check:vercel-services`. This
validates every Service and private binding, the Shell build output, the exact
Vendor callback ingress, and the Gateway-only browser catch-all, and rejects
paid Microfrontends fields and orphan legacy-Service manifests. A failed
catalog, workspace, or graph validation leaves both publish targets
unchanged; this source-only validation does not provision, deploy, or mutate
Vercel.

## Catalog-first application Services

Every newly generated application must use the checked root
`microfrontends.json` only: registration there is the source of its logical
identity, browser routes, standard private Next.js frontend Service, and
Gateway binding. It must not create `vercel.services.json`, a second Service
catalog, local Vercel project configuration, or app-local public routing.

Legacy HC/Vendor manifests and their Ajv schema are removed. Their required
physical runtimes are ordinary native Vercel Service definitions in the private
adapter. No new manifest or descriptor language replaces them. App-local Vercel
configuration and legacy manifests, including orphan workspaces, are rejected by
repository validation. Workspace naming defaults used by the app generator are
not requirements of the neutral compiler.

### Deferred scope

This migration deliberately does not generalize a new-runtime authoring path,
add app-local public ingress, or mutate Vercel projects, environment settings,
Deployment Protection, provider callback URLs, or callback secrets. Native Git
delivery remains the delivery mechanism; a later read-only Preview proof is the
hosted acceptance path. Retiring any dormant provider resources is separately
authorized operator work, not a consequence of this manifest migration.

### Deferred provider callback relay

The two exact Vendor Ampersand callback paths remain private Autograph policy
exported through the root entrypoint as public rewrites to the private `vendor-callbacks` Service until a separately accepted Gateway
relay change. They are not browser routes and do not use browser-session
authentication: Vendor preserves raw request bytes and verifies the configured
Svix signature before processing. The future relay must make the Gateway the
sole public ingress while forwarding the exact raw body and signature headers
to Vendor, keeping signing secrets and provider-specific verification
app-owned. This change does not alter those routes, their signature controls,
or Vercel Deployment Protection/provider callback configuration.
Because the root policy targets `vendor-callbacks`, configuration fails closed
unless the checked Vendor catalog registration and native runtime definitions compose
that exact private Service.

The deployed private Shell builds its checked Next source in
`packages/platform-microfrontends/shell` through the owning package's
`build:shell` script (`next build shell`) and emits `shell/.next`. Its native
`next.config.mjs` imports the official Microfrontends integration and derives the
default application identity from the official catalog. Authentication, browser
policy, public build settings, routes, and rendering remain private Shell code.
The deployed build does not invoke the portable CLI or generate another Next
project.

`@autograph/microfrontends-shell` separately owns the neutral, source-free
Next.js Vercel Service build boundary for portable consumers and existing local
launchers. `microfrontends-shell vercel-service
build` validates the standard configuration selected by
`VC_MICROFRONTENDS_CONFIG` (or discovers `microfrontends.json`), creates the
ignored `microfrontends-vercel-shell` atomically, and emits its Next output at
`microfrontends-vercel-shell/.next`. It uses the official
`withMicrofrontends` Next integration directly. A custom adapter is an
installed package export with a default Server Component; consumer identity,
authorization, routes, and rendering stay outside the neutral package. A
consumer invoking the generator at repository root declares the Shell package
as a direct root runtime dependency so the generated Next config resolves it
after installation. A configured adapter must also export `shellPublicBuildEnvironment` from its
`/config` export. The neutral builder validates this caller-owned string record
and fails closed when it is missing or malformed. Because Next inlines these
values into browser JavaScript, the record is public configuration only and
must never contain secrets, private origins, or server-only settings.

The private source-only Shell candidate is prepared through
`mise run repository:prepare-microfrontends-shell-candidate -- --verify`.
It copies the Shell package allowlist verbatim, records source and artifact
integrity plus a CycloneDX SBOM, initializes review-only history, and proves
anonymous packed installation for both the built-in launcher and an installed
custom adapter. The candidate is not a publication or licensing action.

Repository tasks set Turborepo's distinct
`VC_MICROFRONTENDS_CONFIG_FILE_NAME` override to an intentionally absent
filename. This prevents Turborepo from treating the canonical root
`microfrontends.json` as a second package-local proxy graph and constructing a
root self-cycle. It does not change the official Microfrontends configuration:
the package builders and adapters continue to receive the sole root catalog
through `VC_MICROFRONTENDS_CONFIG`.

Every route-owned framework runner resolves that variable to the checked root
`microfrontends.json`, including native Vercel Service builds whose working
directory is an application. No application-local or retired Shell path may be
used as configuration authority.

Native Next development and start commands preserve the configured application
port and `0.0.0.0` hostname as defaults. Explicit Next CLI arguments supplied
through the application package script override those defaults, including
`--port`/`-p` and `--hostname`/`-H`. A leading package-script `--` separator is
removed before forwarding options; build/check/test contracts are unchanged.

The output directory is intentionally not dot-prefixed: the pinned Vercel Node
builder discovers a dot-prefixed file but subsequently resolves that relative
path as a bare module. This provider constraint is covered by the disposable
native Services proof.

The routing-only generated server accepts ingress only under required Vercel
Deployment Protection and resolves every selected application at request time
from its private
`VC_MICROFRONTENDS_BINDING_<NORMALIZED_APP_NAME>` Service-binding variable.
Missing, malformed, credential-bearing, path-bearing, or colliding bindings
fail closed. The server owns both HTTP and WebSocket upgrade handlers. It does
not discover public product origins, reproduce Autograph identity or session
policy, enable the paid Vercel Microfrontends product, or grant repository
automation deployment-selection authority.

`@autograph/microfrontends` exposes a repository-only static fixture for the
external Preview proof. It has exactly two authenticated public route classes:
`found` accepts exactly one caller-supplied READY Preview receipt whose branch
name and SHA exactly equal the caller-supplied expected branch; `absent` may
use its caller-supplied READY Production receipt only when the reusable Vercel
adapter returns its explicit `absent` result for the Preview receipt. It never
discovers a repository or project, calls a provider, selects retained projects,
or writes provider/repository state.

Unreadable, unauthorized, ambiguous, malformed, unready, canceled, failed,
timed-out, 4xx, and 5xx receipt classifications fail closed. They are never
absence. The retained `apps` root Services project and paid
Microfrontends product enrollment are rejected. The fixture's deterministic
`/_fixture/health`, `/_fixture/migration`, and `/_fixture/recovery` payloads
contain only `ready` or explicit `not-run` recovery states. Its evidence
command emits classifications, statuses, and SHA-256 hashes only.

## Existing-account password recovery

Shared Auth exposes recovery only when its environment has a server-only
`AUTH_RECOVERY_RESEND_API_KEY` and verified `AUTH_RECOVERY_EMAIL_FROM`. Use a
sending-only key restricted to the approved sending domain. Preview never
inherits or copies the Production Better Auth Infrastructure key; configuring
recovery does not register its dashboard. Missing or incomplete sender settings
preserve ordinary sign-in and keep recovery routes and controls unavailable.

Better Auth owns token issuance, expiry, atomic consumption and password hashing.
The reset callback sends plain text through the maintained Resend SDK, and Vercel
retains delivery with native `waitUntil` after the generic response. Both existing and
unknown emails receive the same confirmation; neither a successful request nor
the confirmation page proves delivery or account existence. Tokens, links,
credentials and recipient details never belong in public evidence or delivery
errors. Resetting a password revokes only that user's previous sessions and
creates no user, organization, membership or app grant. Account capture still
requires ordinary sign-in and verification of the original account/tenant.
The sign-in recovery link, reset-email callback and confirmation preserve the
validated same-origin app return path, including its query string. Completing
the reset returns to sign-in for that app; it does not itself grant app access.
External or protocol-relative return targets retain the safe root fallback.
The native Auth page passes the requested return path to its client independently
of the optional signup-policy read. Server-rendered recovery and sign-in links
use that same path before hydration. Root-relative paths do not require a
configured origin; absolute paths use the existing validated current Auth origin,
without requiring database or sender credentials merely to normalize a link.
Malformed or conflicting origin configuration supplies no absolute-URL authority.
The browser retains its existing query-first redirect precedence. A relative-path
normalization base is never an Auth provider origin or an OAuth callback base.

For signup links, the shell may nominate the canonical base path of the requested
app only from its checked bundled routes when both paths select the same app.
The existing exact requested-path policy takes precedence. Only an explicit
miss permits one distinct canonical candidate; an unavailable read does not.
The unchanged signup-policy lookup must still authorize that exact path. Signup and verification use the selected policy's exact destination; ordinary
sign-in and recovery retain the requested leaf and query. This presentation
mapping grants no app or organization access and performs no signup on page load.
The signup form sends that selected destination as an absolute `callbackURL`
using the actual browser origin, after custom fields so they cannot replace it.
The existing managed request handler still resolves and authorizes the exact
callback policy before account creation. Ordinary local signup retains its
validated requested destination without requiring a managed policy.

## Auth database Preview migration eligibility

The Vercel dispatch runner skips a Preview only when the exact dispatched
commit has no open pull request on its dispatched branch. This skip occurs before
Neon access or artifact lookup and leaves the Preview migration status
unreported. GitHub lookup failures, malformed associations, and multiple open
matches fail closed. The no-secret PR plan workflow runs for Auth source,
migration tooling, or workflow changes. The existing PR Check workflow verifies
the Auth dependency snapshot against `bun.lock`; a changed Auth dependency
closure requires an updated snapshot under `packages/auth/`, which starts a
plan. Unrelated root manifest and lockfile edits do not start a plan. Preview
still validates its isolated database. For a PR whose current head equals the
dispatched SHA before and after a complete changed-file inventory read, no Auth
paths means that no PR artifact is needed; the trusted runner still validates
the isolated Preview branch, provisions Better Auth, and checks its schema.
Renames from an Auth path count as Auth changes. A changed PR head retains the
exact artifact requirement. Auth changes still require the successful matching
plan workflow and SHA- and PR-bound additive artifact. Production migration and
its required Deployment Check retain their existing authorization path.

## Environment-owned signup policy

Auth sign-in and sign-up navigation preserve the validated same-origin return
path, including its query string, through account creation and back to the
original connection flow. External and protocol-relative redirect targets use
the existing safe redirect fallback.

Local, Vercel Development, and Vercel Preview allow public email/password
signup. Google user creation is disabled in every environment. Preview omits
the Google provider entirely; Local and Production may expose Google only on
sign-in for previously linked identities when the complete provider and OAuth
proxy configuration is present. Vercel Production disables email signup. The
Better Auth server-owned user-create hook idempotently adds each new
Local/Preview user to the canonical `dev` organization. The database
provisioning hook also selects `dev` on any signup session that was created
before the membership hook completed. The database provisioning contract marks
that one all-app signup organization; browser signup cannot select an
organization or application set. Its `appIds` assignment remains server-owned.
The Shell validates the Gateway-owned Preview origin receipt and reconstructs
that public authority before Better Auth server API session reads; private
Vercel Service hostnames are never added to Better Auth's allowed-host policy.
A protected Preview Realm uses its existing validated resource/enrollment and
exact configured public origin, independent of the template's provider project
name. Its private Shell host, HTTPS forwarding and Gateway-owned origin receipt
must still agree; forwarded request headers never enroll another origin.
The root deployment's exact Gateway and native Service bindings are the Preview
issuer and private product control-plane authority for JWKS and delegation.
Services fail closed when an in-deployment binding is absent or malformed; they
never use a sibling project, branch alias, or Production fallback.
Vite product builds pin a neutral root input, write into a service-owned clean
output directory, and use the platform-derived official Microfrontends asset
prefix exactly once in both the HTML references and app-owned build output.
The native Services builder receives that derived prefix as its build base
because its provider build does not apply the local adapter's base rewrite; the
value is derived from the same registered application name and is never
hard-coded. The service-owned directory prevents a restored provider cache
from satisfying the build with a pre-contract root-asset artifact. Unprefixed
root assets are not public Gateway routes.
Preview databases remain isolated and ephemeral, and no Production identities
or data are shared. Preview acceptance requires email signup and all-app access
proof, negative Google provider proof, and Production signup-negative proof.

Better Auth account identity is keyed by its supported `(providerId, accountId)`
pair. The former `account.issuer` is retained only as nullable legacy data when
present; the 1.7.3 runtime never writes it. Database provisioning relaxes an
old required issuer column before the Better Auth CLI runs, preserving existing
values without making new credential or Google account writes fail. Direct
local and Preview seeders use the same supported account contract.

## Agent stream compatibility

`AgentPhase` includes `searching`, `drafting`, `checking`, `repairing`, and the
dormant `out_of_budget` value. Additive-only v1 readers retain
`out_of_budget` for rolling-deployment compatibility with older runtimes;
current runtimes do not emit it.

## Authoring And Compilation

**Implementation state:** the checked-in compiler normalizes the manifest AST
and emits deterministic schema, installation, migration, and generated
PostgreSQL runtime artifacts. PostgreSQL is the sole generic kernel runtime:
every HC and Vendor request path invokes the generated SQL API. Rust remains
only compiler, installer client, artifact-verification, migration, and parity
code. Application facade imports, compatibility translation, fallback
execution, direct substrate DML, and dual runtime authority are prohibited.

HC and Vendor's canonical `/api/records`, `/api/apply` (including dry-run),
`/api/activity` and `/api/diff` now use the explicit public `kernel::generated`
transport, as does HC's `/api/history`. HC's atomic dry-run uses the same generated authority. This transport
promotes the existing static SQL entrypoints, envelope decoding and transaction
helpers; it never probes storage to select a runtime or falls back to the Rust
reference implementation. The applications retain their authenticated scope,
actor, domain and provenance checks, and Vendor retains its application write
lock. Other public operations remain on their existing authority until their
callers explicitly migrate.

This operation cutover is required by the installed lookup layout: generated
installation stores lookup models in shared lookup tables, which the reference
Rust per-model table reader/writer cannot operate on. Tests of the reference
materializer alone do not prove compatibility with a generated installation.

**Decision:** an app-owned manifest is the source for logical schema,
constraints, seeds, and generated read metadata. CUE is the first external
authoring frontend. The Rust compiler validates and normalizes that input into
the internal kernel schema and deterministic PostgreSQL artifacts.

The manifest is richer than the persisted `Schema` DTO because it also carries
inverse relations, authoritative and advisory constraints, typed derived fields,
and seed change-set templates. Every authored property must be consumed by
normalization, SQL generation, seed generation, or client generation, or fail
with a structured compiler error. Unsupported properties remain blocking
coverage gaps; silently dropping catalog metadata is forbidden.

Compiler expressions use typed literals and field references, presence and
absence, boolean composition, cardinality, comparisons, set membership, and
compiler-owned conversions. Raw SQL is not accepted as manifest input.
An authoritative `text_starts_with` constraint accepts a non-empty literal
prefix for a text field. Generated PostgreSQL enforces it case-sensitively for
entity and lookup writes; SQL pattern characters have no special meaning.
Unknown expression kinds, extra SQL properties, empty prefixes, and non-text
fields fail compilation. Generated clients expose the referenced field ID from
the same validated AST.

A `non_overlapping_intervals` constraint is the one cross-record expression.
It names a required date `start` field, a distinct date `end` field and one or
more `subjects` field sets on an entity model. Two live mainline rows (stage
`mainline`, open version, not tombstoned) whose values for every field of one
subject set are present and equal must not have overlapping inclusive
`[start, end]` date intervals; an absent `end` is open. Two intervals overlap
when the later start is on or before the earlier end, so a successor that
starts the day after another's `end` is adjacent and one that starts on that
`end` overlaps. A one-day interval has `start = end`; one whose `end` precedes
its `start` covers no date. It is valid only as a root expression. Nesting it,
using it on a lookup model, an optional `start`, a non-date bound, or a list,
JSON or money-rate subject fails compilation; `end` may be optional. It lowers to a `non_overlapping_intervals`
entry in the revision's constraint catalog, not to a CHECK. Generated mainline
apply and dry-run, draft approval and revert evaluate it after the planned
state is complete. Writers to a constrained model first take a per-tenant,
per-model transaction lock, before their canonical row locks. Because that lock
only protects writers that re-read committed rows after waiting, these writes,
draft approval, revert, installer readiness and activation must run under READ
COMMITTED; REPEATABLE READ and SERIALIZABLE fail closed with
`interval_rule_requires_read_committed`. Installer readiness
and app-base and tenant-overlay activation reject existing overlapping live rows. A violation is a
`constraint_violation` whose message is built from the constraint, model and
field labels. Its first detail (`path: "interval"`) repeats that message,
followed by the usual `model`, `constraint` and `field` IDs and a `record`
detail naming the conflicting record.

Inverse relations are generated read surfaces over authoritative scalar
relations. They do not create arrays or duplicate persisted relationship state.
Reusable catalog `is_multi_value` properties lower to read-only inverse
relations by resolving exactly one authoritative scalar child edge; missing or
ambiguous edges fail compilation. Explicit app-authored multi-value relations
lower to compiler-owned junction models with
stable owner/field-derived identities, pair uniqueness, tenant RLS, and a
generated collection read surface; they are never stored as array columns.
Generated apply accepts atomic unordered-set `add`, `remove`, and `replace`
mutations. Their hidden edge versions inherit the parent change set's effective
dating, stage, causal order, idempotency, approve/discard, revert, history,
activity, and tenant rules; generated reads and diffs project them back under
the authored relation ID rather than exposing hidden models.
Derived fields lower to fixed, app-origin derived custom-field definitions in
the runtime schema, the single runtime representation shared with
tenant-authored derived fields, and are never accepted as persisted write
values. The generated runtime evaluates them over each read image; the
compiler validates the same AST with the same rules and error codes.
Runtime-evaluated forms are `field` (a declared, custom, or other derived field
of the same model, expanded with cycles rejected), `literal` (text, number,
bool, date, datetime), `coalesce`, `concat`, `add`, `subtract`, `multiply`,
`divide`, `normalize_money_rate`, `compare` (`eq`/`not_eq` on matching text,
number, bool, date, datetime or money; ordering on number, date, datetime or
money) yielding bool, `if` (bool condition, branches of one type; a null
condition takes `else`), `min`/`max`/`clamp` on matching number or money
(`clamp(x, lo, hi)` is `max(lo, min(x, hi))`), and `relation_field`, which reads
an active stored (not derived) field of the record related through an active
declared relation. The related value is read through an authorized query of
the related model, so field and record grants apply to it; an empty relation
or unreadable related record is null. `parameter` is valid only in working-session
rules and `inverse_aggregate` remains unsupported; derived fields reject both
with `unsupported_derived_expression`. Expanded expressions are bounded to 256 nodes and depth 32.
Any null operand yields null, as does division by zero; `coalesce` returns its
first non-null operand. Number addition, subtraction and multiplication are
exact; division is exact when the quotient terminates and otherwise rounds to 28
significant digits, half-even. Money adds, subtracts, compares and bounds only
within one currency and period (otherwise null), scales by a number, divides by
money of the same currency and period into a number (a ratio such as a
compa-ratio; otherwise null), and `normalize_money_rate`
converts periods through 2080 hours, 260 days, 52 weeks, or 12 months per year.

Seed change-set templates are deterministic, artifact-scoped data operations.
They preserve ordinary audit, idempotency, tenant, relation, and row-version
rules and become visible only when their effective artifact activates. A seed
write may address an existing `record_key` or declare a deterministic
`new_record_id`, but never both. Its change type is optional because installer
seeds may intentionally use the generic apply contract without claiming an app
workflow action.

The checked compiler artifact is lossless. It retains the normalized kernel
schema together with constraints, inverse and multi-value relations, derived
fields, metadata, and seed templates. Runtime-specific projections may omit
compiler-only metadata only when they are generated from, and checksummed
against, that complete artifact.

## Schema Lifecycle

**Decision:** app schema is the root contract the kernel stores, validates, materializes, and uses for generated clients.

Lifecycle:

1. An app authors a base schema in app-owned CUE, optionally selecting
   declarative schema blocks exported from `packages/domain-libs/`.
2. Customer extensions are expressed as overlays that may add optional fields, labels, import mappings, and app-owned configuration.
3. The app submits an effective schema revision for one `(app_id, customer_id)` pair.
4. The kernel validates the full logical schema.
5. The kernel stores the accepted revision in `schema_revision`.
6. The kernel materializes or validates Postgres DDL for that revision.
7. Generated TypeScript clients and types are produced from the normalized
   compiler contract and stored schema revision.
8. Runtime apply/read paths resolve against the active `(app_id, customer_id)` schema revision.

"Materialization" here means generating typed Postgres DDL (`<model>_record` and `<model>_version` tables with one column per declared field) once per schema apply. It is not row-level denormalization. After the DDL exists, all reads are normal SQL queries against typed columns; there is no decoder, no projection out of EAV cells, and no per-read materialization step.

Schema retirement and record tombstones retain physical and historical data.
Physical erasure is outside app manifests, generated operations, and ordinary
tenant-schema administration. No retention authority exists yet; separate
authorization, provider-evidence, and irreversible-history gates must be
resolved before any privileged implementation is proposed.

A native HC or Vendor deployment compiles the app-owned Rust source
with the pinned toolchain. Its build hook does not query Auth, receive database
installer credentials, or materialize tenant schema. A successful native
deployment therefore does not establish that any tenant is installed or ready.

The protected operator owns approved schema installation and tenant activation
for the exact authorized targets. Installation failures fail that operator
operation. Until the approved release is installed and read back for a tenant,
its database-backed APIs remain unready; deployment completion alone is not
evidence of installation or activation.

The Vendor local/development materialization command accepts
`PLATFORM_VENDOR_CUSTOMER_IDS` as a comma- or newline-separated customer set
and applies each unique customer in order. The generated artifact customer is
the fallback only when neither the plural nor singular setting is configured.
Hosted installation targets are fixed in the protected operator's approved
plan; native Vercel builds do not discover customers or perform installation.

Approved Vendor installation consumes the exact checked `sql-bundle.sql`
through the protected operator's direct initializer connection. It reads the
companion release manifest only to bind the compiled schema,
materialization-plan, transition-contract, and installer checksum hashes, then
invokes the generated prepare, readiness, and activation API with the
artifact's seed templates. No Rust schema materializer or seed-template to
`ApplyChangeSet` adapter participates in that production path. The bundle owns
the candidate seed ledger, defaults-once behavior, forced RLS, baseline role
grants, and drift checks. The same protected release-bundle effect grants and
reads back SELECT on Vendor's three tenant-scoped readiness metadata tables and
EXECUTE on their row-policy scope check for the generated runtime capability;
forced RLS still requires the exact tenant binding. A failed bundle install,
preparation, or activation leaves the previous active revision unchanged.

The protected operator uses Vendor's fixed `protected-materialize` worker when
installation must run under operator authority. The operator independently
selects and verifies the pinned Vendor worker, clears its environment, and
supplies a frozen context and the separately bound direct database URL on
private stdin. Vendor rejects a context whose app, release, or explicit tenant
set differs from its compiled contract, and verifies the database and
restricted migrator identity before installation. It then applies the same
app-owned legacy cleanup, checked bundle install, seed and lookup migration,
readiness, activation, and post-install checks as the direct path. Every
logical write, including readiness and activation, requires a fresh tenant-
scoped operator authorization immediately before effect; a verified readback
digest is checkpointed before the worker proceeds. Read-only inspection does
not receive write authority. The worker's protocol carries typed authority
requests only; receipts contain effect state and digests, never database
credentials. Unknown readback or an unacknowledged checkpoint fails closed and
requires reconciliation against the same frozen target set. The protected
worker path does not establish hosted provider identity or hosted acceptance.

Stored shape:

```sql
schema_revision (
  id bigserial primary key,
  app_id text not null,
  customer_id text not null,
  version text not null,
  base_schema jsonb not null,
  customer_overlay jsonb not null default '{}',
  schema jsonb not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  schema_hash text,
  materialization_source text,
  materialization_git_sha text,
  materialization_vercel_deployment_id text,
  materialization_vercel_environment text,
  materialization_vercel_git_ref text,
  materialized_at timestamptz,
  unique (app_id, customer_id, version)
)

schema_activation_head (
  app_id text not null,
  customer_id text not null,
  base_schema_version text not null,
  advanced_at timestamptz not null default now(),
  primary key (app_id, customer_id)
)
```

Only one active revision per `(app_id, customer_id)` is visible to ordinary writes. Submitting a new accepted revision deactivates the prior active revision for that scope in the same transaction. Schema apply is transactional: a failed materialization cannot leave partial model tables behind.

`schema_activation_head` is created only when an app uses guarded
materialization to declare a forward-only base-schema transition. Today the
Rust reference accepts an app-owned transaction closure. The compiled target
replaces that closure with compiler-owned typed predecessor, catalog, data
assertion, and record-retirement steps; arbitrary app SQL or procedural hooks
are forbidden. The generated transaction holds the tenant's schema-activation
writer lock, checks the expected active artifact, executes the declared plan,
then advances the head and activates the new revision atomically. Guarded
preflight runs the same plan in validation-only mode without advancing the
head, creating a revision, or applying DDL. Once a head exists, ordinary materialization may validate
or reactivate only revisions whose persisted `base_schema.version` equals that
head. A later base-schema transition must use the guarded path to advance it.
Customer overlay revisions remain legal because their revision version changes
while their persisted base-schema version remains the head version.

The generated `kernel_read_runtime_release_observability` entrypoint exposes a
runtime-capability-authorized snapshot for one `(app_id, customer_id)` pair. It
reads checked artifact identities, the active base/effective revision, the
preparation/readiness ledger, tenant activation-lock waiters, and a current
expected-hash comparison. It cannot prepare, repair, or activate a release.
Readiness records completed phases only after all phases pass; partial external
backfill progress and actual failed activation attempts remain installer
receipts. The snapshot labels unmeasured physical drift as such rather than
claiming catalog validation from stored metadata.

The compiled API does not preserve the Rust closure type as a compatibility
surface. A guard is a versioned list of compiler-owned typed assertions in the
materialization plan. The installer evaluates those assertions in the same
transaction as the expected-hash activation compare-and-swap. Unsupported
closure behavior has no raw-SQL escape hatch and fails compilation until a
typed assertion is added to the compiler contract.

A release's compiler-generated transition contract is an immutable closure of
exact checked predecessor schemas, including checked historical artifacts for
a still-supported cutover. Before preparation can create or activate a new
base revision, the generated installer compares the active base schema against
that closure after applying the runtime customer scope. An unknown version or
any shape mutation fails the transition; application Rust cannot widen this
set.

For a new checked release adding one optional app-owned text field, the
compiler can include an exact predecessor in its hashed operation manifest
and generated data bindings. The runtime matches the predecessor artifact
hash and full schema in the authenticated tenant, with only the customer ID
scoped to that tenant. While the predecessor is active, existing-field reads
and writes continue and the added field reads as null. Requests that filter,
sort, aggregate, or write through the added field need its schema installed.
This runtime compatibility does not install a schema or select a deployment.

The allowed state is an active revision at the tenant's head, including a
runtime overlay derived from that base. The forbidden state is activation of a
revision derived from any other base version. Postgres enforces this with a
tenant-scoped trigger on `schema_revision`; the kernel repairs the trigger on
guarded materialization and validates its table, function, trigger, and RLS
contracts. The trigger must have no `WHEN` predicate, and no other `BEFORE ROW`
trigger may handle revision inserts or updates because one could rewrite the
row after the activation-head check. Consequently a binary that predates the head cannot reactivate its
older base schema: its activation transaction fails and rolls back. Both the
head table and schema revisions use forced `(app_id, customer_id)` RLS.

Postgres schema and catalog access follows one global lock order. A
client-owned materialization first completes a short query-role bootstrap
transaction: it acquires the global `kernel_query` advisory lock, creates the
role when absent, and releases the lock before any materialization transaction
or schema-catalog access begins. The materialization transaction then acquires
its Postgres-schema-scoped coordinator lock and tenant activation writer lock
before reading schema relations or catalogs. Schema validation/preflight takes
the corresponding activation reader lock before those reads. Every ordinary
kernel-owned tenant transaction likewise takes the activation reader before
tenant settings or relation access; caller-owned apply takes it at that API
boundary before idempotency, temporary-view cleanup, or schema-relation access.
Because its public database parameter also accepts an autocommit client, that
boundary first verifies a transaction-local probe survives across statements;
an autocommit call is rejected before activation or relation work instead of
allowing its transaction-scoped reader lock to expire after one statement.
The only pre-activation relation read is the client-owned exact-replay probe
described below, whose short transaction finishes and releases its relation
locks instead of later waiting for activation. Materialization's schema-local
query-role grants do not reacquire the global role lock. This ordering forbids
both advisory-after-catalog and activation-after-relation lock inversions.

The global query-role critical section covers only role existence, not DDL,
grants, catalog snapshots, or contract validation. Independent Postgres schemas
therefore remain concurrent after that short bootstrap; each schema's
coordinator continues to serialize only its own shared substrate DDL. Within a
materialization transaction, declared table advisory locks are acquired in one
deterministically ordered batch. After creating or repairing physical storage,
the kernel loads a fresh Postgres catalog snapshot and validates the complete
contract in memory. That snapshot uses at most six set-based catalog queries
for relations and sequences, columns and defaults, constraints, indexes, and
row-level-security state and policies; its query count does not grow with the
number of models or physical artifacts. Expected defaults, check expressions,
index predicates, and policy expressions remain canonicalized by Postgres
through batched temporary probe objects rather than by SQL-string normalization
in Rust. Materialization owns reconciliation of tenant RLS policy drift: when a
materialized table has no policy, an extra legacy policy, or a non-canonical
policy contract, the kernel drops every existing policy on that table and
creates the single canonical `platform_tenant_scope` policy before strict
validation. Guarded materialization performs that reconciliation inside the
materialization transaction before invoking the app transition guard, so a
repairable legacy policy cannot prevent the guarded migration that repairs it.
Read-only preflight uses the same reconciliation helper inside its
rollback-only transaction, so it proves repairability without persisting the
repair.

**Retired migration-only compatibility behavior:** test fixtures for the former
multi-app Rust materializer retain a narrow activation-head policy repair so
historical transition coverage remains reproducible. Production HC installation
does not call it. The checked HC
bundle installs and reconciles its compiler-owned `kernel_tenant_isolation`
policy transactionally, and failed installation rolls back partial schema
objects. When a populated typed-lookup predecessor must be adopted, HC selects
the required bootstrap tables and functions verbatim from the checked SQL
manifest, lets `kernel_prepare_lookup_migration` stage the shadow copy, and
then installs the exact bundle. Application code authors no backfill SQL and
does not switch lookup read authority. The complete temporary compatibility register is in
[`schema-compiler.md`](schema-compiler.md#temporary-compatibility-register).

Every `kernel_tenant_isolation` policy (and the session owner policy) requires
`app_id` and `customer_id` to equal the transaction's kernel scope and checks
the principal-scope and raw-table authorities against that same scope. The
policy reads the scope once per statement in one subquery that yields the
authorized `(app_id, customer_id)` tuple (and `owner_id` for sessions), and the
rows are compared with that tuple; changing a kernel setting during the
statement therefore cannot pair one scope's rows with another scope's
authorization. The installer and admin drift checks expect that form.

Generated repair validates foreign keys over shared physical tables, not one
tenant's visible rows. Before validation it enumerates retained schema scopes
through the authorized schema-catalog policy and restores missing, value-free
lookup identities under each scope's forced RLS. This includes sibling tenants
and retained historical revisions. It restores the caller's scope before
continuing, preserves existing identities and all version history, and neither
creates lookup values nor changes lookup authority. An unauthorized or
unrepairable reference still fails closed; repair never disables tenant RLS.

`base_schema` is the app-authored schema. `customer_overlay` is tenant-authored schema state composed over that base. `schema` is the effective schema after applying the customer overlay to the app base schema. The kernel materializes the effective schema because that is what writes and generated clients use. App base schemas can be shared across customers, but persisted model data is always scoped by `customer_id`.

Schema revisions record the deterministic `schema_hash` plus deploy/source
provenance when materialization runs. Reusing a `(app_id, customer_id, version)`
for different normalized schema JSON is a hard conflict; diagnostics include
the existing and current hashes, not full schema JSON.

**Decision:** tenant schema revisions compose over the app base through typed
create, update, retire, and restore operations. App-owned definitions declare
whether they are fixed or tenant-manageable; runtime-created definitions are
tenant-managed. Tenant operations may manage lookup models and their fields,
enum options, and opted-in custom-field definitions, but cannot change immutable
identity, field type, or a lookup model's `display_field_id`, and never carry
arbitrary SQL. Required and unique
tightening follows expand/backfill/contract: activate the field as optional,
backfill it through ordinary audited generated apply calls, then submit the
tightening revision. Its resumable preparation ledger validates every visible
effective interval before activation. Operations that introduce relations or
other constraints likewise prepare and validate their data projections before
activation. The stored `schema` must equal the composed
`base_schema + customer_overlay`, and activation is an expected-revision and
expected-hash compare-and-swap under the tenant schema lock.

Generated runtime installation records an explicit binding from immutable
database `session_user` to capability and `(app_id, customer_id)` scope. A
schema-admin binding also pins the trusted actor. Request JSON and
`kernel.app_id`/`kernel.customer_id` settings never grant authority; generated
entrypoints authorize the binding first and only then set those GUCs as RLS
selectors. Forced RLS repeats the binding check as defense in depth. Shared
capability roles alone are insufficient to access any tenant.
Database `CONNECT` is independently provisioned for login principals and checked
by PostgreSQL at connection startup. Generated NOLOGIN capability roles need no
`CONNECT` grant of their own. Schema installation and validation neither change
the database ACL nor require a particular login-grant inheritance path.
The execution owner installs or revokes those bindings through
`kernel_bind_principal_scope(jsonb)` using the generated
`InstallerPrincipalScopeBindingRequest`; application request roles cannot write
the binding table or grant themselves scope. Query-only execution may assume
only the generated schema's deterministic query role, returned by the prepare
API after the runtime authorizes the immutable session principal and prepares
tenant-scoped temporary views. Query roles are schema-specific so independent
installers never require administration of a shared cluster-global role.

HC `POST /api/schema/revision` is a generated PostgreSQL application endpoint. It accepts the
generated `TenantSchemaRevisionRequest` unchanged, requires the authenticated
`tenant-schema:admin` permission, and rejects app, customer, or actor values
that differ from the authenticated scope. The route connects only through
`HC_SCHEMA_ADMIN_DATABASE_URL_UNPOOLED` or
`HC_SCHEMA_ADMIN_DATABASE_URL`; it never falls back to an ordinary
runtime or initialization credential. That login principal must be installed
with the matching schema-admin scope and actor binding. The server is a
transaction and trust boundary only: it invokes
`kernel_commit_tenant_schema_revision(jsonb)` without interpreting schema
operations in Rust.

Typed custom fields are opted into per model, entity or lookup, through the
app-authored `extensions.typed_custom_fields`; a model that does not opt in
(including every runtime-created lookup, whose extensions are always empty)
accepts no custom-field definitions or values. Freeform record metadata stays
entity-only: a lookup model never declares `extensions.record_metadata`.
Lookup custom values live in `lookup_version.custom_fields` and are written,
cleared, validated, read, and diffed exactly as entity custom values are. HC
opts all six of its lookups in; tenant administrators define their custom
fields in the same schema-administration form as entity custom fields and edit
their values as extra columns of the lookup's rows on that page.
Schema-administration clients discover these
capabilities, immutable runtime identities, the active revision, and its
effective hash from the generated active-schema read; each mutation returns the
authenticated actor to the server unchanged and remains subject to the
server-side capability and compare-and-swap checks.

`kernel_read_active_schema_revision` returns `{ schema_revision_id, schema,
effective_hash }` (`ActiveSchemaRevision`). `effective_hash` is computed with
the exact expression `kernel_commit_tenant_schema_revision` compares
`expected_effective_hash` against: the installation's effective artifact hash,
else the revision's recorded schema hash, else the SHA-256 of its canonical
schema JSON. Hosts take the hash from this runtime entrypoint and never read
the revision tables themselves, so a restricted runtime principal can supply
it.

HC `GET /api/schema/active` calls that entrypoint as the authenticated actor
and returns `{ schema, schema_revision_id, effective_hash, actor_id }`: the
tenant's active effective schema (app base plus tenant overlay), the active
revision id as a string, the effective hash, and the authenticated actor. A
revision request copies `schema_revision_id`, `effective_hash` and `actor_id`
into `expected_revision_id`, `expected_effective_hash` and `actor_id`; the
revision route still rejects an actor other than the authenticated one, and the
kernel a stale revision or hash. HC `GET /api/schema` returns only the compiled
app base schema; pages read `/api/schema/active` (`useActiveSchema`) so tenant
changes appear, and show an ordinary error when that read fails. HC
`/api/records-by-model` validates requested models and field projections once,
against the same active schema.

HC `POST /api/record-options` (`RecordOptionsRequest`: `model_id`, `as_of`,
optional `query` of at most 200 characters) returns the best 50 matches among
the records a link may choose, `{ options, truncated }`, for search-as-you-type
link pickers; pickers never load a whole target model. There is no paging: `truncated` says more records match, and pickers ask the
user to keep typing. It runs `kernel_data_query` as the authenticated actor
against the active schema for lookup and entity targets alike, with
`exclude_retired`, a `select` of only the fields that name a record, and a
`search` over those fields (display field, `name`, first required text field,
and alias fields; never record ids or external keys), best match first, then
by name. Each option carries a `record_key` (a `record_id` key) and the raw
label parts `name` and `external_key`; the client applies the owner label
rule, so a record id is never a label.

## Logical Schema

```text
Schema {
  app_id
  customer_id
  version
  models: Model[]
  custom_fields?: CustomFieldDefinition[]  -- defaults to []
  change_types: ChangeType[]
}

Model {
  id
  kind: "entity" | "lookup"
  label
  display_field_id?  -- required for lookup models
  origin: "app" | "tenant"
  management: "fixed" | "tenant_managed"
  lifecycle: "active" | "retired"
  extensions?: { custom_fields, metadata, limits }
  fields: Field[]
}

Field {
  id
  label
  type
  required
  is_unique?
  target_model?
  option_set?
  origin
  management
  lifecycle
}

EnumOption {
  id
  label
  aliases?: string[]
  origin
  management
  lifecycle
}

ChangeType {
  id
  label
  target_model
  is_import_default?  -- defaults false; exactly one per importable model
  touches: field_id[]
  required: field_id[]
}

CustomFieldDefinition {
  id
  model_id
  field_id
  label
  type
  target_model_id?
  option_set?
  expression?   -- derived definitions only; a read-only DerivedExpr
  origin
  management
  lifecycle
}
```

`Model.kind` is required in runtime schema JSON; missing kinds fail closed.
Historical omission normalization belongs only to the compiler-owned checked
predecessor transition, not the general runtime deserializer.
`Model.kind` is the explicit runtime declaration for entity models vs lookup
models. Every lookup has a `display_field_id` that references an active,
required text field. The generated data definition carries each model's
`display_field_id` (null for entities), so clients name lookup records by it. IDs are immutable identity; labels and machine names are
editable metadata. Runtime-created IDs are opaque generated IDs. Whether a
domain concept is a model, field-local enum, or reference-data field is authored
explicitly; no generic conversion category infers or rewrites that choice.

V0 field types: `text`, `number`, `bool`, `date`, `datetime`, `relation`, `text_list`, `known_aliases`, `json`, `enum`, `iso_country`, `iso_currency`, `money_rate`. `known_aliases` is a text-list-shaped field type: values serialize as `FieldValue::TextList` / `{ type: "text_list", value: string[] }` and materialize as `text[]`, while the schema type marks the field as alias-match candidates for deterministic import/matching behavior. `iso_country` and `iso_currency` are string-backed declared field types that materialize as `text` and validate supplied values at apply time against pinned in-repo ISO 3166-1 alpha-2 and ISO 4217 tender-currency lists. Declared `enum` fields carry ordered revision-scoped `EnumOption` values, store the selected immutable option ID as text, and validate membership at apply time. Retired options are hidden from new selection and matching but remain resolvable in historical and inherited values. Audit hydration resolves labels through the event change set's pinned schema revision. Deterministic CSV coercion matches active normalized option IDs, labels, and aliases, rejects unknown or ambiguous values, and binds only the canonical option ID. There is no enum DB check constraint because option sets are schema-revision state.

V0 custom field types: `text`, `number`, `bool`, `date`, `datetime`, `relation`, `text_list`, `enum`, `money_rate`. Custom enum definitions use the same option shape and membership validation as declared enums. Custom fields deliberately do not support `json`, `known_aliases`, `required`, or `is_unique` in V0. Custom definitions live in schema revision state, not in a parallel value store; adding a custom field is a runtime schema-revision operation on a model that opted into custom fields, without per-field DDL. Field types are immutable after creation.

A custom-field definition with an `expression` is a derived custom field: a
read-only `text`, `number`, `bool`, `date`, `datetime`, or `money_rate` value
evaluated from the compiler's derived-expression AST at read time and never
stored. A tenant creates one with the same `create_custom_field` revision
operation; the runtime validates its types, references, and cycles against the
active declared and custom fields of the same model before commit, with the
compiler's error codes. The expression is immutable, like the type, and an
active derived field blocks retiring a field it reads. References resolve
against active declared and custom fields only, in the compiler and the runtime
alike. Installer readiness re-validates every active derived field against the
effective schema, so an app-base release or overlay that retires or retypes a
field a derived field reads is not ready (`schema_revision_not_ready`, with the
derived issues as details) until that derived field is retired; activation never
retires tenant definitions implicitly. `kernel_data_query` evaluates only the
derived fields a request reads (select, filter, order, group, bin, and metric
fields, or every field for an unselected list read). It authorizes a derived
field through the stored fields its expression reads, and a declared field or
many-relation id, retired ones included, always resolves to the declared
element, never to a custom definition. A stored
derived cycle fails as `schema_drift`. Writes that set or clear a
derived field fail with `derived_field_read_only`. App-authored `derived_fields`
compile to fixed derived custom fields and need no `typed_custom_fields` opt-in;
tenant-authored derived fields follow the model's custom-field opt-in.

The compiler accepts custom-field definitions only as part of an effective
tenant schema manifest or overlay composition. Reusable app-base catalog blocks
do not silently acquire customer-owned custom fields. The normalized effective
artifact preserves definition identity, model and field identity, type,
relation target, enum options, and archive timestamp before SQL installation.

Within a schema, a custom `field_id` is permanently reserved for its `(model_id, field_id)` pair, including archived definitions; archived field ids cannot be reused for a new custom field. An active custom field, derived or stored, may not use a declared field or many-relation id of its model, retired declared fields included, compared after identifier normalization (`custom_field_declared_field_collision`). The compiler rejects every collision. Tenant schema revisions reject one they would add (creating or restoring a custom field, or creating a lookup field), and installer readiness (`schema_revision_not_ready`) rejects an app release that newly declares an id an active custom field uses. A collision the active revision already holds is tolerated rather than locking the tenant out: recomposition never fails on it, reads resolve the id to the declared element, and a tenant revision can retire the custom field.

`is_unique` is optional schema metadata that defaults to `false`. It is supported only on single-column scalar fields: `text`, `number`, `bool`, `date`, `datetime`, `iso_country`, and `iso_currency`. Unique relation, list, JSON, `money_rate`, and enum fields are rejected at schema validation; enum is a controlled vocabulary, and per-option uniqueness is not a V0 capability.

`app_id` and `customer_id` are opaque non-empty scope ids. They are persisted as text and are not normalized as SQL identifiers.

Relation fields must declare `target_model`. Logical model, field, and change-type ids are the API contract. The kernel normalizes those ids to lowercase ASCII physical identifiers by trimming, converting whitespace/hyphen/underscore runs to `_`, rejecting unsupported characters and reserved SQL words, bounding to Postgres identifier limits, and collision-checking the normalized and bounded names.

`number` and `money_rate.amount` use decimal values, not binary floating point. Decimal values serialize as JSON strings to preserve precision across Rust and TypeScript. `money_rate.currency` validates against the same pinned ISO 4217 tender-currency list as `iso_currency`; `money_rate.period` is one of `hourly`, `daily`, `weekly`, `monthly`, or `annual`.

`money_rate` materializes to typed component columns: `<field>_amount numeric`, `<field>_currency text`, and `<field>_period text`. Those generated component names participate in physical-column collision checks.

`change_type_id`, when supplied on a write, must reference the active schema revision. The kernel does not enforce change-type `touches` or `required` sets at apply time in V0; those drive forms, UX, and audit labels.

### Enum Compilation Target

Declared enum fields continue to materialize as `text`, never PostgreSQL enum
types. Revision-scoped option metadata contains ordered immutable option IDs,
labels, aliases, ownership, management policy, and lifecycle with unique active
normalized match keys per revision/model/field. Generated apply functions
accept only active options under the write's pinned revision. Generated reads
preserve retired option IDs and resolve their labels through the appropriate
schema revision. Option-only revisions remain metadata revisions and do not
rewrite typed DDL.

### Lookup Compilation Target

Lookup models use the compiler-owned generic record/version substrate keyed by
`(app_id, customer_id, model_id, record_id)` plus fixed typed scalar, relation,
uniqueness, label, and alias projections. `kind = "lookup"` is logical model
metadata, not a lookup slot or parallel value-set abstraction. App-authored and
runtime-created lookup models share this substrate, so tenant administration
never emits model-specific DDL or indexes. Runtime-created lookup definitions
still pass through the same preparation ledger, schema-hash CAS, and activation
lock as app-authored schema revisions. Lookup rows remain ordinary change-set
writes with the full draft, history, revert, provenance, effective-date, and RLS
lifecycle.

Lookup matching remains app/import policy. Generated kernel functions accept
resolved record keys and enforce target model, existence, tenant visibility,
lifecycle visibility, and relation constraints. Operational hydration includes
the stable ID, as-of display label, and retirement state; audit hydration also
includes the current label and the event-visible label ordered by effective
date and causal `applied_order`.

## Row-Version Storage

Every entity model materializes to two typed tables. Lookup models materialize
to shared generic tables keyed by `(app_id, customer_id, model_id, record_id)`
plus compiler-owned typed scalar, relation, uniqueness, and alias projections.
The generic tables retain the same version lifecycle columns shown below; user
schema operations never create tables or indexes.

```sql
<model>_record (
  id uuid primary key,
  app_id text not null,
  customer_id text not null,
  external_key text,
  created_at timestamptz not null default now()
)

<model>_version (
  id uuid primary key,
  record_id uuid not null references <model>_record(id),
  app_id text not null,
  customer_id text not null,
  stage text not null,                 -- draft | mainline | discarded | reverted
  effective_start date not null,
  effective_end date,
  change_set_id bigint not null references change_set(id),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  tombstones_record bool not null default false,
  untombstones_record bool not null default false,
  provenance jsonb,
  <declared typed columns...>,
  custom_fields jsonb not null default '[]',
  metadata jsonb not null default '{}'
)
```

Rules:

- `schema_revision`, `change_set`, `agent_run`, and every model record/version table enable row-level security. Policies constrain rows to the current request's `(app_id, customer_id)` scope, backed by transaction-scoped settings or the equivalent Rust/Postgres boundary chosen in PR 2.
- Version rows are full snapshots for one record at one point in time. Ordinary value writes are partial overlays onto the previous visible snapshot; omitted fields inherit their prior value.
- `applied_at` is non-null if and only if `stage = 'mainline'`.
- `effective_end` is null or greater than or equal to `effective_start`.
- A row cannot both tombstone and untombstone a record.
- Tombstone and untombstone rows do not carry typed field values.
- `custom_fields` is a full-snapshot JSONB array column on the version row. Each entry is `{ field_id, type, value }`; `field_id` must be unique within the array. Values mirror the typed field-value contract for supported custom types: relation values are `RecordKey`, money-rate values are `{ amount, currency, period }`, enum values are option IDs, and text-list values are string arrays. Retired definitions and enum options are hidden from new selection but preserved for pinned historical reads.
- Custom field writes use the same row-version write path as declared fields. There is no separate custom-value contract or table. Supplied entries overlay the prior snapshot, `clear_custom_fields` removes named entries, and omitted entries inherit. Declared values use the equivalent disjoint `clear_fields` set. The kernel validates supplied and cleared IDs against the write model and pinned schema revision. Custom relation target existence, same-tenant visibility, model identity, and tombstone state are resolved through the same relation path as declared relation fields.
- `metadata` is a separate full-snapshot object for models that opt in. Writes use explicit set/remove/clear patches with compiler-declared byte, key-count, key-length, depth, and scalar/array bounds. Metadata has no relation, enum, constraint, uniqueness, or typed-query semantics and cannot shadow declared or custom fields.
- Ordinary value snapshots are unique by `(record_id, effective_start, change_set_id)` regardless of stage. Distinct mainline change sets may retain ordinary value snapshots for the same record and effective date; one change set may not contain two ordinary snapshots for that logical coordinate, including while it is a draft.
- Mainline tombstone and untombstone rows retain cross-change-set uniqueness by `(record_id, effective_start, tombstones_record, untombstones_record)`. Materialization enforces the ordinary and lifecycle rules with separate partial unique indexes and rejects the retired all-mainline index as storage drift.
- Mainline visibility is ordered by greatest `effective_start`, then tombstone/untombstone/value lifecycle priority, then greatest owning `change_set.applied_order`. Every eligible mainline version joins a `status = 'mainline'` change set with non-null `applied_order`; disagreement is storage drift, never a timestamp or UUID fallback.
- A displaced same-date ordinary value closes at its own `effective_start`, so both retained versions cover that shared date and `applied_order` selects the winner. The successor inherits the displaced winner's former `effective_end`; a later effective-date boundary remains the day before that later start. A write at a later date retains the existing behavior of closing the predecessor on the preceding day.
- Fields declared with `is_unique` are unique when present across live mainline rows in the same `(app_id, customer_id, model)`. The kernel materializes one partial unique index per unique field over `(app_id, customer_id, <field_column>) where stage = 'mainline' and effective_end is null and <field_column> is not null`, so null or omitted values are reusable and tombstoned/closed historical values do not reserve the value. Blank text is a supplied value, not absence, and is rejected for unique text fields. Direct mainline apply, draft approval, and revert reopen surface conflicts as `unique_field_conflict` with model, field, and value detail.
- In the current greenfield/prelaunch V0, adding `is_unique` assumes there are no live duplicate values. Adding it to a field that already has duplicate live mainline values is a schema/data migration, not a transparent metadata flip. Materialization fails loudly before creating the partial unique index; future non-greenfield rollouts must deduplicate or migrate existing rows before accepting that schema revision.
- When value and record-lifecycle rows share an `effective_start`, lifecycle rows determine visibility before value rows regardless of `applied_order`; a same-date tombstone hides the record.
- External keys are unique within `(app_id, customer_id, model_id)` when declared.

## Change Set

`change_set` is the audit, idempotency, review, and atomic-batch envelope.

```sql
change_set (
  id bigserial primary key,
  app_id text not null,
  customer_id text not null,
  schema_revision_id bigint not null references schema_revision(id),
  created_with_mode text not null,     -- mainline | draft
  status text not null,                -- draft | mainline | discarded
  actor_id text,
  source_kind text not null,
  source_ref text,
  idempotency_key text,
  request_fingerprint text,
  change_type_id text,
  notes text,
  threads jsonb not null default '{}',          -- review threads, keyed by thread id
  thread_receipts jsonb not null default '{}',  -- thread reply/resolve request receipts
  created_order bigint not null,
  applied_order bigint,
  created_at timestamptz not null default now(),
  applied_at timestamptz
)
```

Rules:

- The persisted `schema_revision_id` is always non-null. The apply DTO may omit it; in that case the kernel resolves the active schema revision for `(app_id, customer_id)` before inserting `change_set`. When supplied, `schema_revision_id` must match the active revision for `(app_id, customer_id)` or fail as a stale-schema write.
- `(app_id, customer_id, idempotency_key)` is unique when `idempotency_key` is not null.
- Replays with the same idempotency key return the existing equivalent change_set. The kernel persists a request fingerprint to compare replay equivalence.
- Reuse of the same idempotency key for a different request is an error.
- `status` is the final lifecycle state of the envelope's model writes.
- `created_with_mode` is immutable. It records whether the envelope was originally created through a direct-mainline lifecycle path or draft save; approval/discard APIs use it to reject ordinary mainline change_sets. Revert audit change_sets are direct-mainline envelopes distinguished by `source_kind = 'revert'`, not ordinary apply writes.
- `created_order` / `applied_order` are kernel lifecycle sequence numbers. `applied_order` is the sole causal order for mainline state and is non-null if and only if `status = 'mainline'`; drafts and discarded change sets use `created_order` only for non-causal lifecycle presentation and stale-draft baselines.
- A direct-mainline change set allocates one value only after the request's complete canonical subject and required relation-target lock set is held and rechecked. It persists `created_order = applied_order` in the same insert, so no mainline/null-order state exists even inside the transaction.
- Draft save allocates `created_order` under the same locked observation boundary and leaves `applied_order` null. Approval performs stale, relation, lifecycle, and unique-field checks under the complete lock set, then allocates a fresh `applied_order` and promotes the envelope atomically; it never reuses the draft's `created_order` as causal order.
- `notes` is a free-text field on the change_set. Optional at create. It is editable in place while `status = 'draft'` and frozen once the change_set reaches `mainline` or `discarded`. No versioning of notes in V0; multi-author comments earn their own substrate later if a flow demands it.
- `threads` holds a draft's review threads in the work-session thread shape (`{id, anchor, resolved, messages: [{id, actor_id, author_kind, message, created_at}]}`). Draft Save fills it; see Draft threads below.
- There is no separate causal event table in V0. Version rows plus change_set metadata are the causal record.

## Agent Run Ledger

`agent_run` is the audit and reproducibility ledger for agent execution. It is
not client data, not conversation memory, and not a second write authority.
Agent runtimes may write this ledger directly before they attempt a client data
mutation.

```sql
agent_run (
  id bigserial primary key,
  app_id text not null,
  customer_id text not null,
  run_id text not null,
  schema_revision_id bigint not null references schema_revision(id),
  actor_id text,
  agent_identity_id text not null,
  execution_profile_id text not null,
  source_artifacts jsonb not null default '[]',
  alignment_decisions jsonb not null default '[]',
  model_calls jsonb not null default '[]',
  tool_calls jsonb not null default '[]',
  token_usage jsonb not null default '{}',
  validation_failures jsonb not null default '[]',
  final_outputs jsonb not null default '{}',
  approval_boundaries jsonb not null default '[]',
  compiled_preview_ids jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (app_id, customer_id, run_id)
)
```

Rules:

- The persisted `schema_revision_id` is always the active schema revision for `(app_id, customer_id)` when the run is recorded. Supplying a stale revision is an error.
- `(app_id, customer_id, run_id)` is unique. Re-recording the same run id is idempotent only when the recorded envelope matches; conflicting identity, profile, evidence, or output fields are rejected.
- Every agent-produced client data write must use `change_set.source_kind = 'agent'` and `change_set.source_ref = <run_id>`. Staged agent work in a canvas work session is not an agent write: a human disposes of it, and the human's Save writes it with `source_kind = 'work_session'` and no agent run id.
- Under a declared authorization policy, canonical mainline apply requires an active human-kind trusted membership (or an administrator-provisioned service actor separately authorized by the reserved source-identity gate) for the authenticated principal, tenant, and trusted actor. Missing membership fails closed, and request `actor_id` must match the trusted actor. Scopes without a declared policy do not bind the actor yet (follow-up ad.51.5). Agent-kind memberships may only submit draft client data changes with agent-run provenance. Membership kind is independent of request `source_kind`; human principals may submit agent-produced writes.
- Agent client data writes fail closed unless `source_ref` points at an existing `agent_run` row for the same `(app_id, customer_id)` and active schema revision.
- The JSONB fields are evidence envelopes. Omitted fields use the table defaults shown above; explicit JSON `null` is rejected. V0 validates scope, identity/profile ids, schema binding, and the array/object evidence containers shown above, but does not yet impose narrower typed schemas on `source_artifacts`, `model_calls`, `tool_calls`, or final outputs.
- `update_agent_run_status` is the only terminal transition path. It takes a row lock, moves `recorded` to exactly one terminal status, and may merge terminal evidence at that transition: array fields append, object fields fill missing keys without overwriting recorded values. Replaying `record_agent_run` after a terminal update still compares only the original record envelope, not the later terminal evidence merge.

## Apply API

```text
ApplyChangeSet {
  app_id
  customer_id
  schema_revision_id?
  actor_id?
  source_kind
  source_ref?
  idempotency_key?
  change_type_id?
  notes?
  mode: mainline | draft
  writes: RowVersionWrite[]
}

RowVersionWrite {
  model_id
  record_key?             -- optional for value creates; required for tombstone writes
  new_record_id?          -- permanent UUID for an explicit create; mutually exclusive with record_key
  effective_start
  values?                 -- supplied declared values overwrite prior values
  clear_fields?           -- declared field ids to remove; disjoint from values
  custom_fields?          -- supplied typed custom values overwrite prior values
  clear_custom_fields?    -- custom field ids to remove; disjoint from custom_fields
  metadata_patch?         -- bounded object set/remove/clear for opted-in models
  tombstones_record?
  provenance?
}
```

Tagged enum DTOs serialize with `type` and `value` fields. For example, `record_key` uses `{ "type": "record_id", "value": "..." }` or `{ "type": "external_key", "value": "..." }`.

Relation field values use the same `{ "type", "value" }` record-key shape as `record_key`; the kernel resolves them to tenant-scoped target record ids before writing version rows.

`new_record_id` is a write-subject operation, not a `RecordKey` variant. It creates the record with exactly that UUID and allows ordinary `record_id` relation values elsewhere in the same envelope to target it. The kernel reserves every explicit new subject before applying writes so it has a stable identity for validation and rollback. Every write/version for that new `(model_id, UUID)` in the envelope must use `new_record_id`; `record_key: { type: "record_id", ... }` addresses only an already-existing subject. A new subject cannot be combined with `record_key` or a tombstone. Omitting both subject fields retains anonymous creates for current writers.

Clearing is explicit and kernel-wide. Omitted declared values, custom values,
and metadata inherit from the predecessor snapshot; supplied values overwrite;
clear sets remove. A write may not both set and clear the same identity.
Tombstone and untombstone writes carry none of these value operations.

The app/import/agent compiler may start from any product input. Kernel apply sees only row-version writes. Direct-mainline preparation resolves or reserves every subject, builds one request-local address-to-UUID map, and validates the complete planned effective-date/lifecycle state before physical version insertion. A direct-mainline relation may therefore target a planned explicit-UUID or external-key record regardless of request position, but only when that target is visible and non-tombstoned as of the referring write. Within a direct-mainline envelope, planned timelines are materialized deterministically by subject, effective date, and lifecycle; this is not a general dependency topological sort and request order is not a causal tiebreak.

Draft writes retain envelope-order relation visibility. A target version must be written earlier in the draft before a later source may reference it; reserving the target record row alone does not make it visible. Dry runs follow the relation rule for the requested mode. Anonymous creates have no caller-addressable subject. If `provenance` is supplied, it is stored on the emitted version row.

All client data writes, including agent-produced writes, must enter through `ApplyChangeSet`. The agent runtime has its own `agent_run` ledger write path for audit/provenance, but that path cannot create, edit, tombstone, or approve client records.

### Direct-mainline lifecycle

A new direct-mainline request runs in two phases inside one transaction:

1. A client-owned apply with an idempotency key first probes for an exact replay
   in a short transaction. It takes the tenant-scoped idempotency lock, reads
   `change_set`, and finishes without waiting for the activation lock; all of
   its relation locks are therefore released at this boundary. A replay
   fingerprint is compared using the stored change set's schema revision, so an
   exact replay remains valid while or after schema activation advances.
2. If no replay exists, the mutation transaction takes the tenant activation
   reader before accessing `change_set` or another schema relation. It
   reacquires the idempotency lock and rechecks the replay before loading the
   active schema, reserving subjects, or taking record locks. Caller-owned apply
   starts at this ordered mutation boundary because its relation locks cannot be
   released independently from the caller's transaction. The boundary rejects
   an autocommit client by proving a transaction-local marker persists across
   two statements before it acquires the activation reader.
3. The kernel validates the complete request, canonicalizes UUID/external-key/anonymous subjects and explicit or inherited declared/custom relation targets, reserves new record rows and external keys deterministically, and freezes candidate predecessors without taking discovery-time row locks.
4. It deduplicates the complete subject/dependency set and locks records in ascending `(model_id, record_id)` order. It then rechecks idempotency, addresses, visibility, lifecycle, relations, unique values, and predecessors. Newly discovered dependency drift aborts the transaction: the top-level API restarts its owned transaction, while caller-owned transactional apply returns the serialization failure and requires the caller to roll back the entire outer unit.
5. Only after the stable lock set does the kernel allocate `applied_order`, insert the mainline change set, overlay full snapshots, close displaced intervals, and insert versions. Reservations, the envelope, and every version commit or roll back together.

No public `write_order_conflict` exists. Deadlock, serialization, connection, and transaction failures remain operational failures rather than a caller-facing causal-order inversion contract.

## Hosted Integration Apply Contract

Hosted integrations use the same row-version write contract as imports,
agents, and human edits. Ampersand is the provider-connection system of record
for V0: credentials, installation state, saved config, selected fields, field
mappings, provider schemas, operation logs, health, retries, and backfill state
stay in Ampersand. The Integrations app additionally owns only the tenant
connection and app-binding control-plane metadata defined in [Integration Data
Model](integrations/data-model.md#arrusted-owned-control-plane-metadata). That
metadata authorizes/routes an app activation; it is not an Ampersand mirror and
cannot contain provider configuration or payloads.

Public setup routes and private transport routes are separate contracts. Public
setup surfaces expose platform-neutral install and health resources through the
owning app's route registry. Private
Ampersand transport is server-to-server ingress or apply plumbing: webhooks,
notifications, signed URL downloads, Platform API authority checks, proxy
reads, and trusted integration apply. Setup wrappers may mint server-managed
trusted integration-manager context only through the owning app's atomic
authorization-and-signing API; they must replace spoofed client trusted-auth
headers and must not sign private transport or generic app API routes.

Each app with multiple integration providers owns one validated integration
catalog. For the vendor app that authority is
`apps/vendor/integrations/catalog.json`, parsed by both TypeScript and Rust.
Provider keys, integration ids, capabilities, UI descriptors, per-environment
`registered | active` launch state, and nested Ampersand operations/recipe
references must be derived from that catalog rather than copied into route, UI,
operations, or recipe registries. Public setup routes use the fixed template
`GET|POST /api/integrations/:key/install` and
`GET /api/integrations/:key/health`; catalog data cannot supply a custom route.
The install POST mints the provider session for initial and refreshed setup and
applies the same launch gate. Launch state gates only customer setup in the
server-selected environment. It is not a direct-apply flag and must not disable,
redirect, or otherwise govern private signed ingress or trusted apply.

Catalog readers fail closed on unknown fields, duplicate provider keys, and
duplicate integration ids. Adding a registered provider with no launched
operations or recipe must require only a catalog entry; activating transport
still requires the provider-owned operation/recipe artifacts and their normal
proof. Provider catalogs remain app policy and are forbidden in kernel and
`packages/integrations`.

App-owned manifests retrieve only provider objects and fields required to
produce the row-version writes named by the checked app recipe and app schema.
Adding a provider object requires an app model target, recipe mapping,
deterministic matching/update policy when needed, and no-secrets delivery proof.
Raw provider payloads, notification envelopes, signed URLs, OAuth/client
secrets, API keys, JWT private keys, and webhook signing secrets are transient
transport inputs. They must not be persisted or logged. Persist only canonical
row-version writes, existing `change_set` metadata/idempotency, and bounded
non-secret provenance such as source refs and payload hashes. A policy name does
not authorize raw-payload or secret storage.

Autograph does not create local import, mapping, delivery, source-identity, or
provider-schema tables for Ampersand V0. The only local connection records are
the minimal tenant-owned connection, app-binding, and activation-grant
control-plane metadata defined above; ownership, lifecycle, revocation,
reconciliation, and safe disconnect are normative in [Integration Data
Model](integrations/data-model.md#lifecycle-and-safe-disconnect). An integration
delivery that should mutate canonical app data must compile to ordinary
`ApplyChangeSet` input with `source_kind = 'integration'`, a delivery-derived
`source_ref`, and an idempotency key derived from the verified delivery identity
before any URL payload download. The payload hash is stored or compared as
provenance after payload retrieval; it is not required to find an existing
change_set on replay.

Generic `kernel_resolve_source_identities` supplies transactional source and
relation matching for already-normalized writes. It returns an ordinary apply
request or an explicitly requested, verified existing receipt and cannot persist
canonical records or receipts. Its caller must keep
the same transaction through ordinary apply. Protected source identity belongs
to administrator-provisioned `service` actors, independent of provider type.
An exact authenticated-input digest permits an authorized receipt lookup before
transient payload retrieval; both lookup and apply enforce current permissions.
See [Generated Data Operations](generated-data-operations.md#atomic-source-identity-resolution).

The trusted path is:

1. an app-owned webhook ingress route preserves raw request bytes and app route
   context
2. app-owned integration ingress verifies the Ampersand/Svix signature before
   JSON parsing
3. app-owned integration ingress parses and validates the Ampersand
   envelope, configured project, installation identity, provider, signed
   `groupRef` customer scope, and supported action type. Environment is derived
   from the configured Ampersand project/destination, not from a required webhook
   field
4. app-owned integration code normalizes `mappedFields`, source refs, matching
   policy, and delivery metadata through the app-owned integration recipe
5. app-owned integration code compiles ordinary `ApplyChangeSet` input directly
   or calls `packages/integration-compiler` with already-verified recipe input
6. the app-owned apply endpoint or persistence bridge validates app policy,
   accepts `source_kind = 'integration'` only from the trusted app integration
   ingress path, and calls kernel apply

Rollout gates may keep provider transport disabled until operational proof is
complete. A checked deployed read manifest must nevertheless declare and ship
the app-owned direct-apply path; enabling it must not switch to a local import,
preview, mapping, or delivery-persistence workflow.

`packages/integrations` is not part of this persistence contract. It wraps
external integration libraries for frontend reuse and must not import app
schemas, app-generated clients, kernel-client, kernel DTOs, or contracts that
expose `ApplyChangeSet`.

Connection/app-binding wire contracts follow generated-contract ownership. A
Rust/OpenAPI contract is generated into its consumer DTOs; otherwise the sole
shared TypeScript owner is `packages/contracts`. Hand-authored mirrors in the
shell, a domain app, a provider adapter, or `packages/integrations` are
forbidden. The control-plane API emits no raw provider values and provides no
app configuration read/write endpoint.

`packages/integration-compiler`, when present, is not kernel. It is reusable
compiler substrate outside the app route boundary. It may compile a verified
Ampersand mapped delivery plus an app-owned recipe into generic kernel write
contracts, but it must not verify webhooks, fetch signed URLs, call Ampersand
Platform APIs, depend on provider SDKs, import app crates, hardcode QuickBooks
or vendor semantics, persist integration state, or derive kernel
`RecordKey::ExternalKey` values from provider/source refs.

Provider ids are not model `external_key` values. `external_key` remains
within-batch authoring plumbing. A hashed source ref, QuickBooks id, Ampersand
installation id, or other provider/source id is still provider identity and must
not become a model `external_key`. Ampersand installation/source identity is
delivery context and optional provenance unless a product workflow needs a
provider id as durable app data; in that case, the app declares that field in
its own schema. Automated update/delete events are rejected before apply unless
the app-owned recipe can deterministically match the affected canonical record
from app schema data and verified Ampersand delivery context. Source-reference
recipe components use Ampersand `mappedFields.<mapToName>` for fields declared
as mappings; raw provider `fields.*` paths are allowed only for deliberately
unmapped provider envelope data.

Integration recipes and deployed manifest responses cross app-owned runtime
schemas before compilation. Required recipe collections such as accepted
providers, objects, target fields, and source-reference components are
non-empty; malformed manifest read objects are rejected individually rather
than being coerced to missing values or skipped. The checked generated recipe
artifacts and app-owned provider catalog remain the authoritative inputs. They
are not installation or gateway routing data.

Provider transport adapters live under
`apps/<app>/integrations/<system>/provider-adapters/`. They may fetch provider
transport data, but an import allowlist limits them to adapter-local modules and
Node transport built-ins. They
cannot import generated app clients, kernel write contracts, trusted
persistence bridges, database libraries, or app wrappers around those APIs.
The repository ast-grep boundary owns that rule with allowed and forbidden
TypeScript, TSX, and JavaScript fixtures. Raw downloaded payloads remain opaque,
transient values at this boundary. Data-plane responses that leave a transport
adapter cross an app-supplied runtime parser before app normalization;
control-plane adapters reject malformed response collections while returning
only normalized health/authority results. String, JSON, logger, and diagnostic
rendering of opaque payloads are redacted.

After parsing, app-owned recipe code compiles provider data into a branded
normalized integration apply type. Only that type is accepted by the trusted
persistence bridge. Provider DTOs and opaque payloads therefore cannot reach
persistence by structural compatibility, and table-name spelling is irrelevant
to the ownership boundary. Cargo dependency checks separately keep provider
SDKs out of kernel and generic compiler crates and keep app crates out of the
generic integration compiler.

## Reads And History

**Decision:** internal kernel database entrypoints drop all current-session
temporary views before they resolve catalog or model relations. The SQL
workbench intentionally creates tenant-filtered `pg_temp` views with the same
names as physical `change_set`, record, and version tables, so internal
correctness must not depend on search-path resolution or on workbench cleanup
having completed. Client-owned entrypoints perform the drop immediately before
opening their kernel transaction, which releases cleanup's catalog locks before
materialization acquires advisory and DDL locks. Public caller-owned transaction
variants perform it at their own boundary. Because a caller-owned transaction
can roll its drop back, every later entrypoint repeats the isolation step.
Physical relation references remain schema-local and unqualified;
schema-qualifying every generated catalog and model reference is not the V0
isolation contract.

`query_visible_sql` still removes workbench views after successful and rejected
requests as defense in depth, and it drops prior views before preparing a
repeated query. Callers must not rely on unrelated temporary views surviving a
kernel or SQL-workbench call on the same connection. Tenant settings, forced
RLS, the read-only query role, and tenant predicates on workbench views remain
independent isolation layers.

Mainline reads select `stage = 'mainline'` rows covering an as-of date and join their owning mainline change sets. The shared semantic precedence is:

1. greatest `effective_start`;
2. tombstone, then untombstone, then ordinary value; and
3. greatest `change_set.applied_order`.

Version UUIDs are defensive final sort keys only. `created_at`, `applied_at`, and wall-clock order have no visibility authority. Direct/list reads, record and relation visibility, previous-snapshot overlays, query-visible temporary views, next-boundary selection, history/diffs, draft composition, approval, and revert all use this precedence. A mainline or reverted version whose owning change set is missing, non-mainline, or missing `applied_order` fails as storage drift.

Query-visible temporary relations exist only for the lifetime of one
`query_visible_sql` request. The kernel removes all current-session temporary
views after either a successful or rejected query before returning the
connection to its caller. A later read, history, diff, apply, or revert on that
same connection therefore resolves unqualified record/version names to the
canonical materialized tables, never to a query-only tenant/as-of projection.

Draft reads are explicit by `change_set_id`, with one exception: a data query
with `include_pending_drafts` previews every pending draft over mainline (see
"Pending drafts in reads" under Working sessions). History, diffs and draft composition do not. When one draft is composed with mainline candidates for relation or predecessor evaluation, effective date and lifecycle still win first, the active draft candidate wins an otherwise equal ordinary category/date, and `applied_order` orders mainline candidates.

History APIs derive from version rows and change_set metadata:

- `change_set_diff(change_set_id)`
- `field_history(model_id, record_id, field_id?, as_of?, limit?)`
- `recent_activity(scope, limit)`

`change_set_diff` returns one entry per touched version row, not one entry per record id, because a single change_set may contain multiple effective-start entries for the same record. Each record diff reports declared-field changes in `fields` and custom-field changes in `custom_fields`; request projection filters both lists by `field_id`. A revert change_set is audit-only; diffing it resolves `source_ref` to the target change_set and returns the reverse effect without creating revert-owned version rows.

`field_history` without a `field_id` returns, per selected snapshot, an entry
for every declared field, many relation, and active (not retired or archived) custom field
of the model, in that order; record metadata and lookup lifecycle remain
explicit-`field_id` requests. It is one request with the same snapshot window
and limit semantics as a single-field request. Under a declared authorization
policy, an unqualified request still requires a history grant on the model and
a matching record grant for every selected snapshot, but it does not fail on
fields the actor may not read. Fields no current grant lets the actor read are
left out of every snapshot. A field the actor may read in some snapshots but
not in a given one (for example under an owner-conditioned grant) is emitted
for that snapshot with `withheld: true`, a null `value` and no `enum_value`,
so every authorized snapshot boundary stays visible even when none of its
fields are readable. Readers treat a withheld value as unknown, never as
empty, and infer no change across it. Every other entry has
`withheld: false`. An explicit `field_id` the actor may not read still fails
with `authorization_denied`.

Every `field_history` entry also carries the physical row's `tombstones_record`
and `untombstones_record` flags and its owning change set's `actor_id`,
`source_kind`, `source_ref`, `applied_at` and `notes`. `applied_at` is the change
set's recorded time, so a reverted entry keeps it; drafts have none. These are
read-only attribution facts under the same history authorization as the entry's
field. Under a declared authorization policy, `actor_id` and `notes` are
withheld and returned as null on every entry, whatever the actor's grants;
`source_kind`, `source_ref` and `applied_at` are still returned. Generated apply never
writes `untombstones_record` rows today: a deleted record is restored by
reverting its tombstone, which history shows as a reverted tombstone entry.

`field_history.as_of`, when supplied, excludes logical snapshots whose `effective_start` is later than that date before limiting. `field_history.limit` is clamped to `1..=100`; omission defaults to `100`. It selects the latest logical snapshots by descending effective date, lifecycle, and mainline `applied_order` (or non-causal `created_order` for explicitly requested draft/discarded rows) before applying the limit. Snapshots are keyed by `(change_set_id, effective_start)` and then expanded into their physical version rows. All rows belonging to a selected logical snapshot are returned in chronological semantic order. Record details requests 21 snapshots: one comparison-only predecessor plus 20 candidate snapshots. The predecessor is never emitted as a change; after snapshot deltas are flattened, displayed output is capped separately at 20 field-change entries. `truncated` is true whenever either the snapshot window or flattened-entry cap omits history.

Do not make a second field-change store the canonical truth. A denormalized cache or materialized read projection can be added later only if profiling proves it is needed; user-side SQL projection (`SELECT cols`) on the read surface is a different concept and is first-class.

## Working sessions

Compiler-owned `work_session` and `work_session_record` hold owner-private,
app/tenant-scoped working state. They install with the runtime and are neither
CUE business models nor bitemporal records. A session reads at its `as_of`
(set at creation, changeable with `update`) and holds layout, scope, rules,
threads and one overlay. The overlay is
one `work_session_record` row per staged (model, record, field): value, first
baseline and base version, and provenance (`source`, actor, trusted
`author_principal` and `author_kind`, and `rule_id` or `thread_id` when
relevant, and `turn_id` for an agent's turn), plus `replaced` (the human
value an agent overwrote) and `note` (an agent's rule note). Mutations insert, update or
delete only the rows they touch. A thread
message records its actor and whether an agent or a human wrote it
(`author_kind`). An entry's value, baseline and replaced value are bounded at
1 MiB, a note at 200 characters and threads at 8 MiB. Nothing staged is canonical business truth. A scenario is
a duplicated session; there are no forks.

`kernel_work_session` owns session, duplicate, change, rule, thread and proposal
operations. Edits are last-write-wins: `stage`, `unstage`, `discard_source`,
`discard_turn` and `update` (title, scope, layout, as-of; an agent's only
layout and as-of) take no expected revision
and no request ID (one that names either is refused) and keep no receipt, so a
person and an agent editing at once both land, the later write winning; a
repeated edit simply applies again. Every other mutation (create, duplicate,
pin, archive, unarchive, rules, threads, `save_request`, propose, pull,
dismiss and Save) requires an expected revision and request ID: rules and
threads create identities a retry must not create twice, pull and dismiss act
on the proposal the expected revision identifies, and Save on the overlay the
person reviewed. Every change to the overlay, rules, threads, proposals or
metadata advances the revision. A mutation answers with `{revision}` and only what it touched:
`entries` (touched entries as they now stand), `removed` (touched targets that
no longer hold an entry), and what the operation produced (create and duplicate
the `session_id`, thread_open the `thread`, reply the `message`, propose the
`proposal`, rule create/parameters the `rule` and `overlaps`, Save the
`change_set` and `cleared`, the overlay cleared). Entries a discard restores
are answered only where a fresh authorized read would show them. Only get
returns the session; a client applies an edit's touched entries to what it
shows when that edit's revision is the next one after its read, and re-reads
otherwise. A replay of a receipted mutation with the
same request ID and fingerprint repeats no effect and answers in the same
shape from current state (Save with its recorded change set): collections it
no longer touches are empty, a rule replay reports `overlaps: []` (and
`rule: null` once the rule was removed), and a superseded proposal is `null`. A replay returns only what a fresh authorized
read would, reauthorizing the entries, proposal changes and thread anchor it
returns; a reused request ID with a different payload fails.
Each mutation authorizes only the targets it touches: stage its changes, a
thread its anchor, a proposal its changes, a rule its scan and outputs, Save
everything it writes. Deleting entries reads nothing. A mutation does not
depend on whether unrelated entries are readable, and its response holds only
data it touched and authorized. Targets the server discovers (discard, rule
removal, rule outputs that left the match set, pull) are deleted regardless but
reported in `removed` only where a fresh authorized read would show them. Get authorizes every target under current
grants; `get` with `overlay: false` returns the header, rules and threads and
skips the entry capture. The `entries` read returns one page of staged entries
in `(model_id, record_id, field_id)` key order, filtered by `model_id`, `source`
and `turn_id`, after an `after` key (default 200, at most 1,000 per page). It
omits entries a fresh authorized read would not show, without naming them,
annotates the rest as get does, and answers with the session `revision`,
`has_more` and `next`, the key of the last returned entry to page after. Reads need no request ID. The first baseline and base version survive subsequent stages;
staging the current canonical value unstages, unless a pending draft wrote
that field on that record (as a read with pending drafts overlays it: the same
draft versions and recorded written fields). Then the entry is kept and
Save writes it, so a person can set a drafted value back to mainline. Human
and agent stages, rule outputs and pulls all apply this rule. An agent's
change to the canonical value over a person's entry is also kept (see below).

Staged entries are a shared working tree: humans and agents stage any entry.
When an agent overwrites a human's entry, the entry keeps
`replaced: {value, author_kind, actor_id, author_principal}` of the human's value, which the
canvas shows as "agent replaced your edit" and restores by staging it again as
the human; a later agent write keeps it and a human write clears it. An agent
never removes a person's edit: it may not unstage a person's entry
(`authorization_denied`, as for discarding others' changes); unstaging its own
entry that holds a person's `replaced` value puts that value back as the
person's entry; and its change back to the saved value over a person's entry
stays staged as its entry with the person's value as `replaced`, so Restore
works. A human unstages any entry, removing it whoever staged it; an agent
unstages any agent's entry. Discarding an agent's
changes (`discard_source` of `agent` or `discard_turn`) puts an entry that holds
a human's value back to that value as the human's entry, and answers with it
among its `entries`; other discarded entries return to their pre-session
baseline. There is no other history.

An agent asks the person to Save with `save_request` (`thread_id`, `reason`
of at most 200 characters; agents only): a thread of `kind: "save_request"`
with the reason, `resolved`, and the session `revision` the request made,
replacing (resolving) any open one. Save resolves every open request in its
own transaction, so a failed Save leaves the request open; the person's "Not
now" is `thread_resolve`. The agent may withdraw its own request by resolving
its `save_request` thread, as an author may close their own pull request; that
is intended, and "Not now" stays the person's answer. A request is session
state: Save never sends it with the change set's threads.

`presence` records the session owner's selection in the canvas
(`work_session_presence`: session, actor, `selection` of at most 200
`{model_id, record_id, field_id?}` targets, `updated_at`; owner-private under
row security). It is human-only, takes no `expected_revision` or `request_id`,
bumps no revision, keeps no receipt and notifies nobody, so it never races
edits or wakes other viewers. `get` returns it as `presence` (or null); the
agent reads it through `describe_workspace`, by record name and column
header.
`stage` takes an optional `note` (plain text, at most 200 characters) from a
human or an agent, stored on the entries it writes and replaced with each
write; an agent uses it for the rule behind a value. Bulk `discard_source` and
`discard_turn` remove only the calling agent's own entries. Pull stages a
proposal's changes with the proposal's provenance. Pull and dismiss act on the
proposal identified by the expected revision. Agents may open, reply to and
resolve threads, propose, dismiss their own proposals, create rules,
re-parameterize any rule, and remove only their own rules. An agent may update
a session's `layout` and `as_of` (a patch of only those keys); the agent's
canvas tools apply each layout change to the layout they read, last write
winning. An agent may create a session (`create_session`): it is
owned by and private to the person the agent acts for, as when the person
creates it, and starts with one arranged grid per model (no app supplies a
starting layout). A retried `create_session` (same conversation and call)
returns the session it already created. Duplication,
archive, unarchive, title/scope/pin updates, pull, Save, and removing another
author's rule require a human actor. `unarchive` changes an archived session back to active under the
same revision and replay guards.

Changing `as_of` re-reads the session at the new date in the same
transaction: every rule re-runs, so rule outputs follow the matches at the new
date (outputs that no longer match are removed), and no other staged entry is
changed or dropped. Entries whose record version at the new date differs from their base version
read as stale (or gone) and are confirmed at Save as any stale entry. Each
Save takes effect on the session's as-of at that moment, so changes for
different dates are saved in separate Saves.

The platform agent context marks its transactions with
`kernel.actor_kind = 'agent'` and `kernel.turn_id`. A marked caller is an agent
whatever its membership says (`kernel_request_is_agent`); the mark never makes a
caller human, and membership still decides for unmarked callers. On every app,
with or without a declared policy, the mutation guard lets a marked caller's
work-session mutations skip the protected request protocol (edits are
last-write-wins and every other mutation's revision and request ID receipt
makes it retry-safe) and refuses every other mutation:
canonical apply, draft approval and revert, lookup mutation and agent-run
recording. Human callers keep the protected protocol unchanged. An agent's
staged entries, and the outputs of an agent-owned rule restaged by its agent,
carry the context's turn; request input never sets it, human edits carry none,
restaging moves an entry to the current turn and duplicate copies none.
`discard_turn` deletes one turn's entries (not rules, threads or proposals): a
human any turn in their session, an agent only entries it authored, reporting
`removed` as other bulk removals do. Discarding a turn removes its current
entries; it does not restore values an earlier turn staged and that turn
replaced.

Every committed new revision (create, duplicate and each mutation; never a
receipt replay) notifies channel `kernel_work_session` with
`<customer>:<session id>:<revision>` and no session data.
`workSessionEventsResponse` (`platform-microfrontends`) streams one session's
revisions as Server-Sent Events to a verified human: it listens on its own
direct connection, then reads the session without its overlay as that human,
so a session the human cannot read never streams, and forwards only that
customer's session. Each change set that becomes mainline (apply, draft
approval, revert), each new draft and each discard notifies channel
`kernel_canonical` with `<app>:<customer>`, and the stream forwards it as a
`data` event for that scope, so open canvases re-read published data and open
review surfaces their drafts. Clients re-read through their own authorized
reads. A browser holds one stream per session across its tabs: browsers allow
six HTTP/1.1 connections per host, so a stream per tab would leave a sixth tab
unable to read. The tab holding the session's Web Lock opens the stream and
passes its events to the browser's other tabs over a `BroadcastChannel`; when
it closes, the next tab takes the lock and opens its own stream, which every
tab treats as a reconnect.

List and aggregate reads use the existing `kernel_data_query` with optional
`work: { session_id }` at the session's as-of date. Values overlay canonical
visible rows before filters, grouping and metrics; derived fields are then
evaluated over the overlaid row. Current field and record grants govern the
resulting values as they govern canonical values (record grants are rechecked
on the overlaid image when a staged value changes a record-predicate field);
sessions grant no additional data access. A changed canonical version marks a staged entry stale without
silently rebasing its baseline. Restaging the first baseline after canonical
moves retains an explicit stale edit, requiring Save confirmation.

Pending drafts in reads: a `kernel_data_query` request may set `include_pending_drafts: true` (the
generated client's `includePendingDrafts`; a boolean, false by default). The
read is then a preview of every pending draft change set in the app and
customer (`status = 'draft'`, neither approved nor discarded), whoever saved
it, composed between mainline and the session's staged entries: mainline,
then pending drafts in save order (`created_order`; the latest saved wins per
field and on whether a record shows), then staged entries. It is not a
promise of what approval will produce: approval applies one draft at a time
against mainline as it then is, and may refuse what the preview composes
(below). Every draft write records the fields it names,
set or cleared, declared or custom, on its change set (`written_fields`, keyed
by model, record and effective date; field ids only, never values); a
deletion (tombstone) records its record and date with no fields. A draft's
overlay for a record is the fields it wrote at or before the date of its
version effective at the read's `as_of` (its latest `stage = 'draft'` version
starting on or before it), each taking that version's value (absent means
cleared). Nothing is compared with mainline, so a draft that sets a field back
to the mainline value still overrides an older draft, and mainline moving or
being reverted after the save never changes what a draft shows. Two drafts
writing different fields of one record both show; fields a draft did not
write never override mainline. A draft applies to a record only when that version is at
least as new as the mainline version the read shows (its `effective_start` is
not before it); a draft deletion saved before mainline later changed the
record (a stale draft) therefore stops hiding it from that change's date on.
For a record with no mainline version at all, a draft version applies as the
record's creation; a draft version dated before a record's first mainline
version, or over a record the read does not show (a mainline tombstone, an
ended version, or a lookup filtered by `exclude_retired`), applies to
nothing. Of the drafts that apply to a record, the latest saved decides
whether it shows: a deletion hides it (in lists, gets, counts and aggregates
alike), any other version shows it, so a record a pending draft creates
appears with its draft values (`version_id`, dates and external key from that
draft). A later draft changing a record an earlier one deleted shows it
again, and a later deletion of a record an earlier draft created hides it.
These compositions are preview only: approving the deletion and then the
later change conflicts at approval (`tombstoned_record`), and approval
refuses a stale draft whose records mainline changed since (`stale_draft`), so the preview can show a
state no sequence of approvals reaches. Lookup retirement (availability) is
not read from drafts.
Each row a pending draft contributes to carries `pending_draft`: `created`
(the change set id of the earliest saved applicable draft that creates it,
only on a record with no mainline version) and `fields` (per field id, the
change set id whose value shows; a select keeps only selected fields, and a
field whose value is staged in the session is left out). A row carries
`pending_draft` only when it names a creation or at least one field: rows
with nothing from a pending draft (including a select or staged values
leaving no field), and every row of a read without the flag, carry none. The
generated client decodes it as `pendingDraft` with fields by name. A stale draft (mainline moved after its save) still shows its
written fields while it is pending. Discarded drafts drop out; approval moves
a draft to mainline, so it is never applied twice.

Every read path of the query applies it: lists (including a list filtered to
one record id), aggregates and counts, filters, search, ordering, relation
navigation (the source record is navigated from as previewed: a draft-created
source can be, a draft-deleted one cannot, with the source's record grants and
`read_relations` checked as without drafts), many relations (a draft's written relation list replaces the
canonical one, in the same save order) and derived and computed values
(relation lookups read with the same flag), so grids, charts, KPIs and totals
agree. The generated client's `get` takes no `includePendingDrafts`: it reads
mainline (with a session's staged values when given one). History reads (`field_history`, `change_set_diff`,
`recent_activity`) are unchanged. Record grants apply to the canonical image
and, when a draft or staged value changes a record-predicate field, to the
overlaid image too; field grants are unchanged, so a draft never reveals a
field the reader cannot read. Off, or when no pending draft wrote the read's
model, the read is exactly the canonical read (a cheap check of pending change
sets skips the draft scan); otherwise draft candidates are limited to the
read's records through a `stage = 'draft'` index on each version table. Drafts
saved before `written_fields` was recorded (before comp-canvas v23 and its
sibling releases) have none and contribute nothing to Show drafts (greenfield:
no backfill). There is no draft ownership. The canvas marks each value
`pending_draft` names with a quiet "draft" tag naming the draft on hover, and
a draft-created record once on its name; such a record is read-only in the
canvas (it is edited in Review), as staging needs a mainline record. Work rules evaluate over mainline and the
session's entries, never over pending drafts. The canvas reads with the flag on by default (its
header's Show drafts, view state), and so do the agent's `find_records`,
`aggregate` and `describe_workspace` selection reads.

Tombstoned/ended records and archived/inactive custom fields mark affected
entries, proposal changes and anchors `gone` (`record_gone` or `field_archived`).
Current read grants still apply; gone targets are not authorization failures.
Get, unstage, discard, duplicate, archive and replays remain usable.
Overlay reads and aggregates skip gone entries. Save requires `confirmed_stale`
with the target, `current_version` and `gone` reason, and leaves confirmed gone
entries out of the writes; canonical apply knows nothing of sessions. If nothing
is left to write, Save clears the overlay and returns `change_set: null`
without writing canonical data. A confirmed-gone record restored before the
write is not written: its staged change is dropped.

A rule is a target field, an optional boolean `condition`, a `value` and typed
`parameters`. Condition and value are derived expressions (`DerivedExpr`) with
`parameter` references, type-checked by the same inference as derived fields
and evaluated by the same SQL lowering, so rules and derived fields share one
arithmetic: 28-significant-digit half-even division, null on division by zero,
and unit-safe money (a unit mismatch is null). `relation_field` reads an active
stored field of the related record through an authorized lookup of the related
model, over the same overlay; a lookup is read only when an evaluated branch
uses it. A rule runs as the ordinary authorized query over the session's
overlay, excluding its own earlier outputs, and stages one entry per matching
record with the rule author's provenance. Rules skip fields holding any other
entry, so a manual edit always wins and the first rule to hold a field keeps
it; rule create and parameter responses report `overlaps: [{rule_id, records}]`
for cells another rule actually held. A null value or a false or null condition
stages nothing. Re-parameterizing re-evaluates the rule: outputs of records that
left its match set are deleted, and remaining outputs keep their first baseline.
Removing the rule deletes its outputs.

Save always writes one draft; there is no Save mode and a request names
none. An approver publishes it through ordinary draft approval
(`kernel_approve_draft_change_set`), which refuses any context marked as an
agent. A canvas approver's "Save and approve" is that Save followed by that
approval of the draft it wrote, through the host's approve route (approvers
only); a refused approval leaves the draft pending in Review. A declared
authorization policy refuses drafts, so under one Save refuses
(`unsupported_capability`, `unsupported_policy_lifecycle`) before any work,
without changing overlay or revision;
policy-aware drafts remain a follow-up. Save copies the rule notes of the
entries it writes onto the change set's `entry_notes` (a map from
`model:record:field` to note). Save requires an active trusted human-kind membership. Actor kind belongs to
the principal/actor membership, not a claimed request source. Distinct human and
agent principals may bind the same owner actor while retaining their own kind.
Save acts on the overlay identified by the expected revision, requires explicit
confirmation of changed canonical versions, and invokes ordinary canonical
apply once for one draft change set (Save rechecks the observed versions
under the draft's locks). A failure rolls back both
working state and canonical apply. Each Save is its own change set; a session
does not keep its pending drafts in its overlay; a read with
`include_pending_drafts` shows them (and everyone else's) over mainline.

## Drafts, Reverts, Imports, Agents

### Draft threads

A Save copies the session's open threads onto
the new change set in the same transaction, in the session's thread shape, so
the workspace reads the discussion of every sent change. Resolved threads and
thread proposals stay in the session, and the session keeps its threads.

`kernel_draft_threads(request)` reads and answers them. `get` takes
`change_set_id` and returns `{id, status, notes, entry_notes, created_at,
source_kind, source_ref, threads}` for any status. `by_session` takes
`session_id` and returns `{id, status, notes, entry_notes, created_at, threads}` for every change set the
session saved (pending, approved or rejected), newest first, so the author sees reviewers' replies; only the session's
owner may list them (as work-session `get`). `reply`
(`thread_id`, `message`) appends a message and returns it; `resolve`
(`thread_id`) marks the thread resolved and returns it. Both require
`request_id`: a replay answers from current state, and a reused id with another
payload fails `idempotency_conflict`; reply and resolve receipts count toward
the threads' 8 MiB cap. Anyone who may read the tenant's drafts
(`kernel_draft_require_scope`) may `get`, reply and resolve by id; the kernel
has no approver role. A work session's changes are private to its owner; once
Saved they belong to the workspace. So the canvas host lets every app member
read every draft (pending, published or rejected), its diff, threads and
author, and reply on any thread. Only the draft's author (the owner of its
source session, `source_ref`) or a current approver may resolve, checked in
the same transaction; the host's `get` answers `can_resolve` for the viewer
in place of `source_kind` and `source_ref`, and its drafts list and activity
feed leave out a work session's `source_ref`. Only an approver publishes,
discards, reverts or edits notes. An agent, by membership or
context mark, may reply and resolve. Replies and resolutions work at every
status, so threads stay with an approved or discarded change set. Review cards,
threads and the Comments pane name a record and every related record by its
title column (the model's `display_field_id`, which the generated definition
carries for every lookup), read from published data at the session's as-of; a
name still loading shows as `…`, and no surface shows a record id. Mutations take
the protected-request guard like other draft mutations; agent contexts write
replies without one, as with work sessions.

`kernel_list_draft_change_sets` takes an optional `status`: `draft` (default)
lists pending drafts, and `discarded` lists rejected drafts with their notes;
each row carries `entry_notes`.

Drafts are a per-write mode, not an app-level capability toggle. Declared-policy revisions continue to reject draft apply and draft lifecycle APIs; their field and record write-policy checks apply to mainline writes. Saving a draft validates and reserves its complete write set, locks written subjects and required relation targets canonically, rechecks the ordered mainline baseline, and only then records `created_order`. It writes `stage = 'draft'` version rows and a `status = 'draft'` change set with null `applied_order`; it does **not** close, reopen, supersede, or otherwise mutate mainline version rows. Same-date draft values may overlay the ordered mainline winner, but duplicate ordinary `(change_set_id, record_id, effective_start)` snapshots remain invalid.

A draft that creates a record may also create the record-table identity row so version rows have a stable subject. That record row is not visible without an earlier draft or mainline version, and discard does not delete it. Discard releases the record's `external_key` when no remaining `draft` or `mainline` version row references that record, so discarded never-mainlined drafts do not permanently lock upstream IDs. It flips draft version rows and the change set to `discarded` without allocating a mainline order.

Under a declared authorization policy, approval requires a trusted human actor whose request actor matches the authenticated binding (without one, the actor is not bound yet; follow-up ad.51.5). It loads the complete draft, locks subjects and restored relation dependencies canonically, and performs stale-draft, lifecycle, relation, and unique-field validation before allocating a fresh `applied_order`. It then flips draft rows to `mainline`, sets `applied_at`, closes displaced same-date winners, normalizes timelines, and finalizes the change set as mainline atomically. Approval rejects as stale if a touched record received a mainline version whose owning change set has causal order after the draft's locked creation baseline.

Revert is mark-as-reverted, not a forward-inverse replay. The kernel prepares the target's complete row set and every candidate predecessor, includes declared/custom relation targets inherited by restored snapshots in the canonical lock set, locks and rechecks those dependencies, and only then allocates the revert change set's order. A target is a tip only when no outside row wins at a later effective date, by same-date lifecycle priority, or by greater same-date `applied_order`; rows inside the target change set do not conflict with one another.

The kernel flips the target's version rows to `stage = 'reverted'` (clearing their `applied_at`), rebuilds each affected timeline from the remaining semantic order, and restores the greatest lower-order same-date ordinary predecessor before falling back to an earlier effective date. The audit action is a new `status = 'mainline'` change set with `source_kind = 'revert'`, `source_ref = <target_change_set_id>`, and no version rows of its own. History annotates reverted rows by joining that source reference. The target change set stays `status = 'mainline'` and preserves its historical `applied_at`. Reverting a revert is not supported in V0. Reverting a record creation releases the orphaned external key only when no remaining draft or mainline version references that record.

Dry runs use the same preparation, canonical locks, predecessor/overlay, relation, unique-field, lifecycle, interval, draft, and mainline paths as committed apply. After locks, they use transaction-local synthetic orders and roll back all record reservations, change sets, versions, idempotency results, and sequence effects. Multi-change-set dry runs increment only the local synthetic order.

The durable import lifecycle stores raw source artifacts, mapping state,
preview output, and the compiled accepted row-version plan outside canonical
model tables until commit. Preview validates and compiles mapping for a
specific mode. The import id identifies the exact preview result and accepted
plan, not just the uploaded bytes and mapping, because app-owned validation may
depend on current relation visibility. Commit references the stored import id,
rechecks that the stored preview still matches current validation state,
rejects stale uncommitted previews, reuses the stored accepted plan rather than
applying a newly compiled plan, calls kernel apply once, and may be mainline or
draft. Import commit idempotency is deterministic from `(import_id, mode)`;
replay of an already committed import returns the original change_set even if
current validation state has since changed.

HC and Vendor install the shared agent-led workspace through the public browser
and server exports of `@autograph/csv-workspace`. The host supplies authenticated
app/customer scope and actor, an active schema, domain-owned ordered identity
policies, a run date chosen before upload, a configured model and a canonical
kernel transport. The package owns parsing, agent tools, preparation, transient
draft/conversation state, editable review and one human Save. Apps do not supply
CSV compilers, candidate resolvers, session stores or import change-type
metadata. Models without an import identity policy remain searchable reference
context; access and write permissions remain canonical app/kernel policy.

The agent inspects the source, schema and existing records, resolves exact
identities with the domain hierarchy, and proposes typed rows across related
models. Exploratory record search supplies evidence for the agent's judgments;
it does not redefine identity. Aliases are ordinary domain matching fields and
ordinary visible edits. Optional isolated synchronous JavaScript can compute
batches of ordinary identity requests and a proposal over captured data. Batch
requests use the same exact resolver; grants and matched values remain tool-side
for subsequent computation. Both direct and computed proposals pass the same
shape validation, shared coercion when requested, and canonical dry-run. The
agent has no publishing tool. Model interpretation is probabilistic; the typed
proposal, grid capture and canonical application are deterministic.

The user can discuss and revise the transient draft with the agent or edit the
grid. Feedback and Save capture current grid changes, including hidden models
and explicit clears. One reviewed mixed `ApplyChangeSet` publishes all models
atomically to mainline with `source_kind = 'human'`. There is no alternate CSV
Save or draft-publication mode. Ordinary unfinished work is discarded on
refresh; this interactive path does not use or claim the durable import
lifecycle above.

Only an uncertain Save survives refresh. Its exact draft payload, idempotency
key, original schema revision, filename, authenticated scope/actor and effective
date are retained before sending. Each request has an independent browser-storage
entry scoped to app/customer/actor, preserving concurrent tabs' receipts. Pending
receipts are found even after the page's default date changes. Retry sends the original date
and revision, and ordinary kernel idempotency decides whether it already
committed. Transport or post-apply receipt failures retain that receipt;
definitive rejection releases it. Editing and new imports stay paused while its
outcome is unknown.

Saved-import visibility comes from canonical activity and change-set diffs.
The ordinary human change set carries `source_ref = 'csv:' + filename` for
attribution, never authorization. History shows filename, actor, time, affected
records and before/after effects. No CSV artifact archive, conversation replay,
abandoned-import history, session claim or resume table is introduced.
The initial view filters CSV imports from the latest 30 human activity entries;
it is not complete historical browsing.

The shared HTTP handler and browser client cap requests at 3 MiB. The client
checks returned drafts before promotion against the exact Save body and a next
turn containing the same CSV, instruction and next bounded conversation, keeping
the captured previous draft on rejection. Larger later instructions remain subject
to request preflight. It measures the serialized UTF-8 request again after grid edits; an oversized Save
is rejected before transport and is never partitioned into partially committed
change sets. HC's canonical apply endpoint retains its 4 MiB server limit.
Source/draft tools return bounded pages and computation has bounded resources.
Identity computation accepts at most 1,000 requests per batch and reports
unresolved counts without silently truncating source work. Autograph's host
composes a 210-second response timeout and a 240-second signed principal lifetime
for the existing 180-second agent budget. The underlying Gateway and signer
defaults remain 60 seconds; exact request binding and expiry stay enforced.
Current record populations are loaded in full into the workspace; large-data
scalability requires measured evidence rather than inference from small fixtures.

In scopes that declare an authorization policy, every canonical runtime writer
requires an active trusted actor membership, and mainline apply requires human
authority before replay as well as on first execution. Administrator-provisioned
service actors may instead pass the reserved source-identity gate; current
membership, scope, fence and field/record permissions still apply. Agent actors
cannot use that exception. Scopes without a declared
policy apply canonical writes, approve drafts and revert without an actor
binding, as before. Binding HC and Vendor writers so the rule can apply to every
app is tracked as follow-up ad.51.5. Work-session operations are unchanged: Save
and the other human-only session operations always require a trusted human.
Trusted human provisioning must explicitly bind `actor_kind = human`; omission
remains fail-closed as agent. Protected installer plans and approved access
inspection require an explicit human/agent classification.

Installer seed defaults during release activation have a separate installer-only exemption: they
preserve each seed template's `source_kind` provenance and write through the
schema-admin installer seed path. The revoked internal apply executor accepts
installer seed authority only from that path. Runtime callers cannot supply it
through request fields, session settings or runtime role grants; direct runtime
`system` provenance is rejected. Seed writes retain normal validation,
constraints, idempotency and atomic rollback.

A context marked as agent (canvas work-session tools) never writes canonical data on any app; its staged work reaches canonical data only through a human's Save, as human-disposed work without an agent run id. Agents may submit client data drafts with agent-run provenance; under a declared authorization policy, canonical mainline apply requires an active human-kind trusted membership (or an administrator-provisioned service actor separately authorized by the reserved source-identity gate) for the authenticated principal, tenant, and actor; request `actor_id` must match that trusted actor, and missing membership fails closed. Revisions without a declared policy do not bind the actor yet (follow-up ad.51.5). Request `source_kind` describes provenance, not authority: a human may submit an agent-produced write, while an agent cannot claim a human source to publish. Before an agent draft is applied, the runtime records an `agent_run` ledger entry; the resulting `change_set` links back to that entry with `source_kind = 'agent'` and `source_ref = <run_id>`.

## App And Library Contracts

An app contract is deliberately small:

```text
App {
  id
  label
  schema
  connectors
  agents
}
```

The kernel reads app id, customer id, and schema revision. Connectors, agents,
workflows, prompts, and surfaces are app-owned unless a kernel contract
explicitly names them. An entity's ordered import identity is owned by its
domain library; app workflow policy remains app-owned.

When review comments talk about app model or field IDs "drifting," name the
actual authority. The kernel schema is generic and has no awareness of a
particular app's model catalog. HC field/model literals can drift against
HC-owned schema declarations or generated HC client artifacts, not against a
kernel-owned list of app fields.

Libraries may provide:

- generated-client helpers
- import/source artifact helpers
- reusable review and diff components
- app shell options
- connector scaffolds
- agent scaffolds
- reference implementations

Checked-in app-generated clients are app-owned artifacts, even when exposed
through private package subpaths such as `@autograph/hc/generated-client`. Those
subpaths exist so TypeScript tooling and static analysis can see the same
generated artifact that the Rust app servers embed and serve from
`/generated/*-client.ts` and `/generated/*-client.js`; they are not a generic
cross-app runtime API.

Libraries must not own app-specific matching policy, derived domain values, product workflow rules, or kernel invariants.

Domain libraries (`packages/domain-libs/`) are an app-agnostic, domain-specific layer
between Libraries and Apps. They own schema definitions, seed vocabulary,
structural reconciliation shape, and explicit ordered entity identity policies.
Reusable catalog traversal, validation, relation-graph checks, and canonical
serialization are owned by `packages/engines/schema-catalog`. Domain libraries
may import its declarative AST as types only; a boundary check rejects runtime
imports so reusable vocabulary cannot acquire compiler behavior or policy.
The neutral `ImportIdentityPolicy` type has one owner in the reusable import
classification engine. Domain libraries author values against that type; an
app consuming those values must deterministically validate every imported
policy against its active schema before compiling rows, including model,
field, and composite relation-endpoint existence. Missing or malformed policy
data blocks compilation.
Generic engines execute those policies; apps import them unchanged and own
workflow decisions such as lookup creation and fuzzy-match confirmation.
Domain libraries must not own I/O, derived app values, product workflow rules,
or kernel invariants.

## Local Next microfrontend executable resolution

The shared Next launcher resolves development and start executables from the
app package using normal Node package resolution. An app-local Next installation
takes precedence; a workspace-hoisted installation remains usable without
creating app-local binary links. Both run with the app as their working directory.
Build/check/test retain their existing repository dependency-root contract.

`test:app:preflight` runs the shared launcher regression once in the required
App Platform CI lane, before workspace package tests. The regression exercises
real CLI invocation for both dependency layouts and both runtime operations.

## HC materialization failure diagnostics

The developer `hc materialize` command preserves the original error code, message,
and details, and appends a `materialization_context` detail containing only the
app identifier, selected customer identifier, and current installation phase.
This attribution is developer diagnostic evidence, not authorization to skip a
tenant or repair its data. HTTP seed error envelopes remain unchanged. No
connection strings, schema bodies, or record payloads are added to diagnostics.

Materialization failures also include `materialization_binding`: the selected
environment variable and SHA-256 fingerprints of normalized TCP hosts and the
configured database. Host normalization lowercases DNS names, removes a trailing
dot, and removes the Neon `-pooler` suffix. A best-effort read on the existing
connection adds current database/schema fingerprints. Inspection failure preserves
the original failure; it never opens another connection. No raw identifiers from
the connection, URL, credentials, or query parameters are emitted.

## Builder runtime installer reconciliation

The provider-neutral `app:runtime` task installs releases through
`installGeneratedAppRuntime`. Existing operator and app-owned validation callers
retain `installGeneratedAppProductionTargets` as a compatibility export of the
same implementation. An explicit nonempty, unique tenant set is prepared and
activated on one connection inside one transaction. A preparation failure rolls
back the entire set; retries retain each prepared revision's original activation
expectation. Neither name authorizes deployment or provider activation.

`createProtectedGeneratedInstaller` is a trusted process capability for a
reviewed app, Auth resource, release and SQL bundle. It checks direct connection
identities and actual database roles before effects, installs the checked release,
then binds tenant scope and actor access. Grant requires existing Auth membership;
revoke closes browser assignment before disabling database membership. The
caller supplies independent reviewed installer trust, current authorization and
durable effect reconciliation, and the journaled positive `fenceGeneration` for
each protected access operation. This library does not allocate provider resources,
bind Vercel environments, keep a journal or authorize an app process to install.
Every observational read of tenant-protected schema or principal-scope rows uses
a short read-only transaction with the exact app and approved customer in
transaction-local settings; the transaction is rolled back before any later
fence exchange or write. App-wide revision metadata uses the compiler-owned catalog policy to select
activation or continuation; final target readback uses only the explicitly
approved tenant set. The compiler and fixed worker share the canonical app-base
activation SQL. The worker installs this trusted implementation after the checked
release bundle, alongside the continuation implementation, so recovery preserves
the immutable release bytes. Both functions establish transaction-local scope
before protected row reads; app-wide observations use the catalog policy and
each locked target read and write uses its exact app/customer scope. Function
ownership, privileges, forced RLS, grouped target validation and atomic activation
remain unchanged. Install
reconciliation reports an exact matching prepared or partially completed
revision as retryable so the same approved operation can resume its idempotent
phases. It reports applied only after the full active install, runtime scopes,
and capability membership read back; conflicting schema, release, hash, or
scope facts remain incomplete.

App-owned installers that cannot use the generic generated-app install path use
the provider-neutral `protected-installer` Rust package. Its versioned context
freezes the operation and approval digests, live fence generation, app and
resource identities, release and installer artifact identities, and an explicit
unique tenant target set. Generated-app, HC and Vendor contexts require a
nonempty set; the dedicated Auth worker uses `app_id: "auth"` with an empty set
because its effects are resource-wide. No synthetic Auth tenant is introduced.
The trusted operator loads the installer pin
from its own immutable catalog, verifies the exact worker artifact before
launch, and independently reads provider project/branch/resource identity; the
worker does not trust a release manifest to attest itself. The worker receives
its direct database binding separately from the nonsecret operation context,
rejects connection overrides and verifies endpoint, database, schema, migrator
login, and session login before any effect. The verified database handle remains
bound to that exact resource identity, and the live login is rechecked before
each write so a prior role change cannot reuse the handle under altered authority.
The reusable parent launcher selects only by the frozen installer identity from
the operator-owned catalog, verifies the pinned bytes before spawn, clears the
child environment, and sends the context and JSON-string encoded direct binding
on separate bounded initial private-stdin frames. Workers use the shared
`read_protected_installer_startup` decoder for these frames. Worker stdout is
reserved for bounded typed authority requests; each request is checked against
the frozen context and current target
before the mandatory live authority is called. The launcher returns success only
after acknowledged checkpoints and a clean worker exit, and kills the child on
protocol failure or timeout. The deployment that constructs the catalog and
authority remains responsible for sourcing both from protected operator state.

For command hosts that expose structured file operations and command logs but
not a duplex process pipe, the crate also provides a file-spool authority
channel. The host creates a fresh private spool for one run, writes the same
context and JSON-string direct-binding startup payloads, then publishes a
startup-ready marker. The worker publishes each unchanged typed authority or
checkpoint request as a file, then publishes a separate ready marker; stdout
contains only the run ID and monotonically increasing frame ID notice. The host
reads the completed request, rechecks current authority, and publishes the
existing typed reply followed by its matching ready marker. Both markers bind
the protocol version, run ID and frame ID. Payload publication is atomic and
markers are published only after complete payloads; payload hashes are not a
second transport admission check. Missing, malformed, stale-run, mismatched,
denied or timed-out frames fail closed. The spool is transport state, not an
effect journal; the host must durably record each checkpoint before replying,
and delete the ephemeral spool after the run. The HC `protected-install` and
Vendor `protected-materialize` commands accept an explicit `--file-spool`
option and otherwise retain their stdio transport. The fixed
`protected-generated-app-install` worker uses the same private spool for its
generated-app release installation. It receives the checked release's twelve
manifest and generated members through the private release directory, then
independently checks every member against the selected manifest. Its closed
effects install the compiled bundle, prepare and validate the selected app
schema revisions, atomically activate the complete app-base target set, grant
only the runtime capability, and bind runtime scopes for the frozen tenant
targets. It has no Auth actor or assignment effects.

For a newly added tenant on an already-current immutable app-base release, the
fixed worker uses the compiler-owned app-base continuation function for only
the frozen prepared targets. Continuation checks the current base identity,
readiness, and each target's activation state in one PostgreSQL call; it rejects
a different-base upgrade, active overlays, and stale target hashes. Initial
activation and upgrades continue to use grouped app-base activation.

Each protected effect and its durable operator checkpoint is a separate
resumable step, so authority callbacks never run inside a database transaction.
A failed run can leave earlier approved effects committed; a retry must use the
same frozen resource, release, and tenant set and reconcile persisted revision,
readiness, activation, capability, and scope state before continuing. Grouped
app-base activation remains atomic across its selected target set. This app CLI
wiring does not establish a hosted host relay or operator deployment.

Workers may also publish closed lifecycle facts in the separate `lifecycle/`
namespace. `worker_started` is emitted only after the caller verifies context,
resource, and the running installer pin; `worker_succeeded` requires all
readbacks and durable checkpoint acknowledgements. A coarse failure fact may
precede `worker_started` for startup rejection. Success requires a prior start,
and only one terminal fact is accepted. Lifecycle notices carry only run and
frame IDs; facts contain no effect result, customer data, SQL, error text, or
credentials. They require no host acknowledgement and do not replace the
operator journal.

Before each app-owned logical write, the adapter requests one authorization
decision bound to the operation, approval digest, current fence generation,
resource, release, installer, effect ID, and (when tenant-specific) one frozen
tenant. The operator rechecks current approval and the live resource fence. A
denial or protocol mismatch prevents the write. After the write and readback,
the adapter sends only a sanitized outcome and readback digest and waits for the
operator to acknowledge its durable journal checkpoint before continuing. The
operator remains the sole journal owner; the Rust adapter retains no parallel
operation state. A lost response or unknown readback remains unknown and must
reconcile the same frozen targets. Database credentials never appear in
protocol frames, diagnostics, or receipts. Local/disposable PostgreSQL evidence
does not prove provider identity or protected hosted behavior.

An effect's readback digest identifies stable installed facts across a replay
of the same frozen operation. Generated response flags that describe only the
current invocation, such as `idempotent`, are excluded from that digest.

The verified database handle exposes its raw client only inside an authorized
`perform` callback or an `inspect` callback running in a same-connection
PostgreSQL `READ ONLY` transaction. Inspection always rolls back, including on
success, so callback session settings do not persist. Persistent writes from
inspection are rejected by PostgreSQL; access closes before the effect
checkpoint is sent. This protects against accidental writes outside these
callbacks. The pinned worker and its callbacks remain trusted code: raw SQL that
changes transaction state is not contained as hostile code.

### Protected resource bootstrap wire schema (version 1)

The separate fixed database/role bootstrap context, credential serialization,
owned creation recovery, and effect/lifecycle protocol are specified in
[Protected resource bootstrap protocol](protected-resource-bootstrap.md).
It supports Local and Preview only and prepares physical resources before
application/Auth installation; it does not replace the protected installer
context below or create another durable operation journal.

### Approved normal account preparation

The protected Preview operator may prepare only the participants in a concrete
approved program through ordinary Auth signup, sign-in, invitations and active
organization selection. Account preparation and the later resolved organization,
membership and app access plan have separate approvals. Source fixtures,
operator identity proofs and schema readiness do not establish a human session.

For an existing account, the owner follows the ordinary Auth link. Its signed
challenge includes the exact pending operation and participant-program digest.
`operator-browser-session` verifies the current native Preview Auth workload,
then uses the fixed Builder `/api/hosted-operator/realm-browser-session` endpoint
for authorize and capture phases. The receiver checks the canonical pending
nonce, original owner and approved program before accepting the actual normal
cookie. The cookie is sent only in the private capture body, never in a proof,
form, URL, public response or diagnostic. Cookie attributes come from the actual
Auth session; no domain rewriting or privileged identity header is permitted.
Explicit sender configuration and actual native identity remain required.

After native sender verification, Auth gives the entire authorize/capture callback
operation one fixed 60-second budget, including acknowledgement bodies. The
separate identity handoff uses the same bounded budget. This allows nested Builder
verification and owner/journal readback without extending the proof or nonce
lifetime. Both paths keep redirects disabled and make no automatic retry. Unknown
or timed-out authorization never releases the capture credential; only its strict
positive acknowledgement permits that next phase. Timers close on every outcome.
Closed diagnostics identify only transport, phase, fixed outcome and timeout
presence; tokens, cookies, proofs, nonces, identities, URLs and exception text are
excluded. These diagnostics do not establish account or capture success.

The protected membership worker accepts the existing single-organization spec
or an immutable `create-owned-organizations` list. A private
`membership-target.json` selects exactly one approved organization per invocation.
The approval digest covers the full unchanged operator plan; the release digest
binds the selected signed owner proof. The existing normal-session proof, resource,
native workload, fence, effect authorization and durable checkpoint checks still
apply. Readback remains read-only. The host owns per-organization durable attempts
and independently verifies each result. Neither this worker nor the capture
transport grants app roles without the separately approved resolved access plan.

Native sender/configuration readback, prepared worker delivery and real signed-in
behavior must be observed independently; source review and local fixtures do not
qualify hosted account preparation.

Failed normal identity readback emits best-effort server diagnostics with only
closed `stage` and `outcome` labels. Core diagnostics distinguish configuration,
native capture attestation, signed proof, captured session, resource scope and
current normal-session reads; route diagnostics distinguish request-body
rejection from a core failure. They include no identities, proofs, credentials,
cookies, origins or underlying errors. Diagnostic failures preserve the original
authentication failure, and the route retains its generic HTTP 401 response.

At the fixed default-shell `POST /api/auth/platform/operator-identity/readback`
route, the Gateway preserves the original raw headers for native caller
verification before sanitizing the upstream request. One well-formed
`Authorization: Bearer <token>` is authoritative when present; malformed or
duplicate Authorization fields fail closed without falling back. When the
bearer is absent, the existing exactly-one
`x-vercel-trusted-oidc-idp-token` carrier remains supported. Both native
carriers are stripped before forwarding, and the private
`x-platform-realm-capture-oidc` header is stamped only after the existing
configured five-claim and signature verification succeeds. Closed native-caller
diagnostics identify only the carrier and rejection reason; they contain no
token, claims or verification error. This source contract does not prove which
carrier a deployed sender currently emits.

### Protected app actor bindings

The app database owns `kernel_actor_membership` for each runtime principal,
app, organization, actor, and role. The read-only `kernel_read_actor_binding`
entrypoint returns the exact `{ appId, actorId, organizationId, role, active,
fenceGeneration }` row or `null` for a missing assignment. It checks the current
session's runtime capability and exact app/organization scope; it grants no raw
membership-table access. The generated server bridge exports
`readPostgresAppActorBinding` for this read through the app's runtime pool.

The fixed protected installer marks runtime scopes with
`actor_binding_required = true`. Activation is monotonic; ordinary runtime
principals cannot assign, reopen, advance, or clear bindings. Existing legacy
scopes retain their prior profile until this trusted activation. For protected
scopes, runtime authorization requires the current active actor role and fence
inside the actual operation transaction, holding a SHARE lock on that exact
membership row until commit. A concurrent protected revoke waits for an already
authorized mutation to finish before its closure can be accepted; later stale
mutations are denied. This scope check applies independently of model policy.
`createPostgresDataContext` accepts
`actorBinding: { role, fenceGeneration }` from the verified server boundary and
sets transaction-local bindings, clearing earlier connection settings first.
Rust hosts use `GeneratedSqlFunction::call_top_level_as_actor`, which binds the
authenticated actor inside each operation transaction and clears the role and
fence bindings; HC binds it for every generated read and apply.
Omitting or replaying an old binding is denied for protected scopes. The
protected revoke closes and verifies app database memberships before closing
shared Auth assignments, so an earlier signed Gateway token cannot retain app
mutation authority after that closure.

### Protected HTTP mutation replay

Protected runtime mutations require a verifier-produced HTTP request descriptor
with issuer, audience, target, method, JTI, and a signed raw-body SHA-256 checked
against the actual forwarded request bytes. The trusted mutation consumer also
supplies a separate SHA-256 of its normalized action payload. A computed payload
digest is not a verified signed-body claim. Body-less Gateway tokens remain
insufficient for protected mutations until shared Gateway ingress and mandatory
Next middleware enforce the body binding. Reads do not consume a nonce.

`createPostgresDataContext` snapshots `protectedHttpRequest` and exposes
`requestTransaction(run)`. `withPostgresDataContext(input, run)` wraps one entire
Server Action in that transaction. Nested generated operations reuse its actual
connection; ordered mutations are serialized. The shared context also supplies
stable generated create IDs for an exact nonce/request retry. Application
idempotency keys still require equivalent canonical writes across different
HTTP requests.

App-owned request and ordered operation admission records survive business
rollback. They bind the physical session principal, app, organization, actor,
role, fence, verified request identity, signed body digest, and normalized
payload digest. Admission uses separate runtime-only autocommit connections,
including with a single-connection business pool. Changed body, identity, or
previously admitted operation order is refused after rollback as well as commit.
Nonce consumption and mutation receipts commit atomically with business effects;
rollback permits an exact retry. Concurrent duplicate consumption serializes
inside PostgreSQL. These are business request records, not an operator journal.

Exact committed `kernel_apply_change_set` (including its caller-owned transaction
variant) retries with an idempotency key re-enter the existing `change_set`
receipt contract and its current policy checks. Other runtime mutations execute
once and refuse a consumed nonce when no exact durable replay contract exists.
The whole admitted operation sequence must finish before commit; no arbitrary
Server Action callback result cache or exactly-once outward side effect is
claimed. Ordinary runtime principals cannot write the admission/receipt tables,
call the private mutation bodies, or alter actor assignments.

Signed `expiresAt` is the verifier-produced JWT `exp` in Unix seconds. The
native database clock rejects it before admission, at each managed mutation
(including after a consumption-lock wait), and before commit. A client DTO or
caller flag cannot supply verified expiry. The Gateway must issue fresh random
JTIs rather than re-signing an old JTI with a new expiry.

Private `kernel_prune_expired_http_requests()` maintenance removes only rows
whose signed expiry is recorded and has passed. It takes consumption then
admission locks with `NOWAIT`, skipping an active transaction; runtime roles
cannot execute it. Expired descriptors remain denied even after all request
state is removed, so cleanup does not depend on permanent per-JTI tombstones or
a request quota. Legacy records without proven expiry remain intact until an
explicit trusted migration establishes that their tokens are invalid. No
bounded storage or automated hosted cleanup is claimed for that transition.
Lookup hydration is read-only and does not consume an HTTP nonce. Lookup
availability changes use their existing canonical change-set receipt for exact
replay and preserve current policy checks.

### Protected installer wire schema (version 1)

Frames are UTF-8 JSON, bounded to 1 MiB each. Structs reject unknown fields.
The pipe transport sends the context object and then a JSON string containing
the secret direct database URL on private stdin; the same reader continues with
authority replies. The file-spool transport uses those same JSON payloads in
its private startup/request/response files and separate ready markers containing
`version`, `run_id`, and `frame_id`. Its stdout contains only a bounded frame
notice, never a request payload. Secrets never enter authorization or checkpoint
frames or stdout. Lifecycle facts use a separate `lifecycle/` counter and the
same marker shape, with `kind` equal to `worker_started`, `worker_succeeded`, or
`worker_failed`; only `worker_failed` has a required closed `failure_code`.
Failure codes are `startup_rejected`, `authority_denied`, `effect_failed`,
`readback_unknown`, `protocol_failure`, `cancelled`, and `timeout`. Lifecycle
stdout notices use `protected_installer_lifecycle_ready` and carry no fact
payload.

| Object                | Required JSON fields                                                                                                                                                                                                       | Optional or nullable fields                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Context               | `version: 1`, `operation: object`, `app_id: string`, `resource: object`, `release: object`, `installer: object`, `tenant_targets: string[]` (unique, frozen order; empty only for resource-wide Auth)                      | None                                                                                            |
| Operation             | `operation_id: string`, `approval_digest: string` (SHA-256), `fence_generation: positive u64`                                                                                                                              | None                                                                                            |
| Resource              | `resource_id: string`, `environment: "local" \| "preview" \| "production"`, `hostname: string`, `port: u16` (positive), `database: string`, `schema: "public"`, `migrator_role: string`, `runtime_role: string`            | `provider_project_id: string`, `provider_branch_id: string`; both required for hosted resources |
| Release / installer   | `id: string`, `sha256: string` (64 lowercase hexadecimal characters)                                                                                                                                                       | None                                                                                            |
| Authorization request | `kind: "authorize_effect"`, `version: 1`, `operation_id`, `approval_digest`, `context_digest`, `fence_generation`, `sequence: u64`, `effect_id`, `app_id`, `resource_id`, `release_id`, `installer_id`, `installer_sha256` | `tenant_id: string \| null`                                                                     |
| Checkpoint request    | `kind: "checkpoint_effect"`, `version: 1`, `operation_id`, `context_digest`, `fence_generation`, `sequence: u64`, `effect_id`, `resource_id`, `receipt: object`                                                            | `tenant_id: string \| null`                                                                     |
| Receipt               | `state: "applied" \| "no_change" \| "unknown"`                                                                                                                                                                             | `readback_sha256: string`; present only for confirmed sanitized readback                        |
| Authorization reply   | `kind: "effect_authorized"`, `version: 1`, `operation_id`, `context_digest`, `fence_generation`, `sequence`, `effect_id`, `allowed: boolean`                                                                               | None                                                                                            |
| Checkpoint reply      | `kind: "checkpoint_recorded"`, `version: 1`, `operation_id`, `context_digest`, `fence_generation`, `sequence`, `effect_id`, `recorded: boolean`                                                                            | None                                                                                            |

Auth schema and owned-organization workers verify the complete approved operator
plan before interpreting a worker projection. They accept the existing recursive
canonical JSON digest or the Builder producer's exact full JSON wire digest.
The accepted context approval digest stays unchanged for fencing, markers and
replay; no subset digest or rehashed projection replaces it. Owned-organization
startup also requires the release ID to equal that same accepted approval digest.
This compatibility applies to Auth workers; it does not change generated access
worker hashing.

The source-owned generated installer binary also accepts the fixed
`protected-generated-app-access --file-spool <directory> <run-id> <timeout-ms>
--release-directory <directory>` command. It consumes private startup files
`approved-access-plan.json` and `access-connections.json`. Existing frozen operations
retain their app and Auth migrator/runtime URLs. Repository Production plans bind
`authOperatorRole` and supply `appMigrator`, `appRuntime`, `authOperator`, and
`authRuntime`. The explicit `repository-production-setup-v1` plan kind requires
that role before schema or access effects; its omission never selects the legacy
schema-owner credential path. Frozen legacy plan kinds retain their original
credential contract. `migratorRole` still identifies the Auth schema owner. The worker
verifies the operator's login and bounded column permissions before effects.
It locks membership through the fixed `lock_auth_operator_member` helper.
The complete canonical approved operator plan must hash
to the existing context approval digest before a subset is interpreted. Its
app resource, roles, release manifest, installer binary pin and organization
set must match the frozen context. The checked immutable release supplies the
verified SQL bundle; no model SQL or separate access implementation is accepted.
`prepare` calls the existing grant saga; `cleanup` calls its revoke saga, which
closes and independently reads app authority before changing Auth assignments.
Every existing saga fence callback uses the explicit exchange below. A single
access checkpoint follows independent app/Auth reconciliation; a receipt never
stands in for that observation. Startup credential and plan files are removed
on success and rejection. The companion fixed
`protected-generated-app-access-readback` command performs only SDK access
inspection and fresh fence exchanges, publishes bounded `readback.json` with
its exact operation/context/fence identity and `applied` or `incomplete` status,
and emits no effect authorization or checkpoint. SQL/connection errors fail the
worker and are never reported as absence.
`createApprovedGeneratedAccessInspector` shares complete approved-plan and
checked-release validation with the resource worker; each fixed caller still
verifies its own binary pin and resource context first. Retirement readback
additionally requires every currently active actor of the owned app principal
and every Auth assignment or roleless admission for that app closed. Retirement
and its read-only inspection accept the same strict credential variants as access:
exact approved `authOperatorRole` with `authOperator`, or the frozen legacy Auth
migrator. They verify the actual selected login before reading closure. Auth-only closure inspection
continues to work after the owned app database is physically absent, validates
the native fence of the approved assignments, and rejects any live assignment
for the retired app. Shared Auth users, sessions and other app assignments remain
outside app retirement. The trusted launcher must use a separate guard-only
readback path with the actual leased context, without manufacturing a mutating
worker attempt or claiming a SQL receipt from a journal.

The Node fixed-worker spool supports `check_fence`. Its use requires the paired
Builder launcher implementation; an older launcher rejects this frame. This
Arrusted change alone does not deliver that companion or an operational host.
The frame carries the authorization identity fields above without `sequence` or
`effect_id`, with `kind: "check_fence"`. Its reply is
`{kind:"fence_current",version:1,operation_id,context_digest,fence_generation,current:boolean}`.
The paired launcher rechecks the current owner, durable approval, pending attempt and
active lease before replying. This read-only exchange consumes a new transport
frame but no effect sequence and records no receipt. It can run while an effect
is pending; denial or mismatched identity prevents subsequent worker operations.
It does not independently observe SQL or establish a business outcome. Existing
Rust workers retain the authorization/checkpoint protocol above and do not
require this Node extension.

Unannotated identity fields above are strings; generations and sequence are
unsigned 64-bit integers. Each effect increments sequence from 1 and must receive
its matching authorization before execution and matching recorded checkpoint
before another effect. Replies must echo the exact operation, context digest,
fence, sequence and effect. Denial yields `AuthorityDenied`; malformed, oversized,
missing or mismatched frames yield `Protocol`; an unconfirmed checkpoint yields
`CheckpointUnconfirmed`; uncertain effect readback yields `ReadbackUnknown`.
Errors are sanitized and never contain the connection URL. Invalid context,
installer pin and direct binding failures occur before effects. Local bindings
require loopback and literal `sslmode=disable`; hosted bindings require literal
`sslmode=verify-full`. Duplicate or encoded query declarations are rejected to
match the connector. Installation databases exclude `postgres` and `neondb`.

## Generated application operation projection

For generated Next applications, the default request path is Server Components
with request-dependent work inside narrow Suspense boundaries. Follow
[Request-time Next rendering](guides/request-time-next-rendering.md) when adding
authenticated forms, uncached reads, or request-specific tokens; validation must
observe resolved content and persisted mutations, not only a rendered shell.
Server Components and app-owned Server Actions use generated TypeScript operations and
the generated PostgreSQL runtime. CUE remains schema authority. Model-specific
CRUD is a projection of audited lifecycle operations, not direct table access.
Generated mutations take values/changes separately from execution options.
Typed record and pending-create references normalize to canonical relation keys;
model and scope provenance are checked without granting authorization. Atomic
batches and idempotency keys remain explicit.
Business actions remain app-owned. Ordinary Server Action exports define browser
exposure; apps own authorization, input parsing, workflow composition, and route
invalidation. No separate action configuration or binding adapter is required.
Dedicated `actions.ts` and server-only `data.ts` modules belong to their route
feature; shared features move together under `features/<feature>/`. The shared
`app/data/` DAL binds trusted context per invocation; its feature functions return
explicit, authorized presentation fields. Generated model records
are not automatically safe UI DTOs. Share connections, never mutable principal
context; preserve resource authorization when extracting reusable workflows.

The schema generates the vocabulary; features compose it into workflows and views.
Schema-owned vocabulary includes fields, scalars, enums, relations, canonical
keys, write options, accepted create/update and form fields, selection inference,
persistence receipts, and form errors. Feature-owned usage includes form subsets,
action state, route interpretation, presentation disclosure and reshaping,
filters, ordering, limits, `asOf`, metrics, and workflow decisions. Projection
never grants authorization. Trusted server context owns authentication,
app/customer/tenant/actor resolution, checked release identity, credentials,
pooling, and local-demo restrictions. Generated database policy enforces
operation, field, and record authorization for policy-enabled releases; apps
retain resource-specific checks for policy-absent releases. Consolidate
imports, not ownership: infer generated field aliases and reuse one readonly field
tuple for parsing and error mapping, while `app/data/` owns authorized reads and mutations and returns minimal DTOs. Never move request scope, credentials, or authentication
into CUE; persisted actor and audit fields remain valid app-owned schema fields.

The host derives trusted app, customer, actor, source, and release context.
Every generated operation authorizes its capability. One pooled connection and
transaction bind scope, timeouts, and active schema revision for each write.
Browser inputs cannot override these values. Generated database runtime roles
remain restricted to capability entrypoints and forced tenant isolation.
Optional CUE authorization policies add model, field, and record grants inside
the database. The host authenticates the human; database memberships explicitly
authorize its runtime principal to delegate an actor in that tenant. Generated
queries apply the policy before filtering, counts, aggregates, and pagination; atomic writes
and replay receipts require current permission. Historical data uses current
policy against the requested temporal image. Legacy releases without policy
retain tenant isolation. Native or raw request paths that cannot enforce a
declared policy reject that capability explicitly.

Declarative aggregation reads authorized mainline rows at one `as_of`, optionally
overlaid with an owner session through `work` at its fixed date.
`count` and `countBy` use the same PostgreSQL aggregate path. Requests permit
at most two grouping dimensions, eight metrics, and 100 result groups; excess
groups fail rather than truncate. Group, bin, and metric fields require read
authorization. Numeric metrics return decimal strings, with null for empty
non-count results. Money metrics separate currency and period; they never
convert or sum across units. Bins include explicit underflow and overflow groups.
Derived fields, compiled or tenant-authored, are filter, order, select, group,
bin, and metric fields like their stored type. A derived value is authorized
exactly when every stored field its expression reads is authorized; derived
field IDs are not separately grantable. Derived and computed number and money
reads return canonical decimals (no trailing fractional zeros or `_`
separators), so a derived copy of a stored `100.50` money amount reads as
`100.5`; working-session rule outputs built from them, including a bare money
parameter, stage the same canonical value.

A `kernel_data_query` request may also declare up to eight `computed` columns,
`{ id, type, expression }`, in the same derived-expression AST. They are
validated with the same rules and codes (reported as `contract_validation_failed`
naming the column), may reference stored, derived, and other computed fields of
the queried model, must not reuse a field ID, and are never stored or visible to
any other request. They are select, filter, order, group, bin, and metric fields
exactly like derived fields, returned as `custom_fields` entries under their ID,
and authorized through the stored fields they read. Only the computed columns a
request reads are evaluated; a column another column reads is expanded inline.
Promoting a computed column creates a derived custom field with the same
expression; if it reads other computed columns, promote those first or inline
their expressions, because a derived custom field can reference only stored and
derived fields. Like derived values, computed values read the request's image:
mainline rows, overlaid with the owner session when the request names `work`.
A computed `relation_field` reads its related value through the same authorized
lookup as a derived one, and a computed `parameter` is rejected with
`unsupported_derived_expression`. The query API accepts no ad hoc value overlay.

`packages/engines/derived-expression` evaluates the same AST in TypeScript so
interfaces can preview derived values over staged edits without a round trip.
It is non-authoritative: persisted, aggregated, and agent-visible values come
from the kernel. The compiler, the SQL runtime, and the TypeScript evaluator
must agree on every case in `packages/contracts/__fixtures__/derived-expressions.json`,
including nulls, division by zero, decimal precision, comparisons, and
money-rate normalization. Callers supply related records' stored values for
`relation_field` and typed parameter values for working-session rules.

See [Generated Data Operations](generated-data-operations.md) for the generated
DTOs, exact query and payload bounds, lifecycle semantics, and verification.

Runtime validation lifecycle hardening: `app:runtime plan` is read-only and does
not allocate private state. `prepare <app> <environment> --checkpoint-only`
allocates private credentials and resource identities without starting PostgreSQL
or installing a database; Builder encrypts that checkpoint before full preparation.
Mutating lifecycle commands take an exclusive private
sibling `.lock` file; concurrent callers must retry. After an interrupted command,
an operator may remove that lock only after verifying its recorded process has
exited. State publication uses atomic rename. Local runtime clusters require
SCRAM password authentication and verified `data_directory` ownership before
reuse, verification, or cleanup. Legacy trust-authenticated fixtures must be
stopped and removed by their owning operator before preparing a replacement.
The restricted Auth runtime principal can read, but cannot mutate, the
operator-owned `app_actor_assignment` table. The runtime verifies this privilege
boundary along with release and actor membership. Checked release app and version
identity must agree with the checksummed artifact. Kernel version preconditions
and PostgreSQL serialization-failure retries preserve their existing concurrency
contract; runtime transactions use PostgreSQL READ COMMITTED isolation.

Auth resource enrollment is explicit and compatibility preserving. When supplied,
`AUTH_DATABASE_RESOURCE` is one non-secret version-1 JSON record consumed by both
runtime and protected migration: `environment`, `hostname`, `port`, `database`,
`schema: "public"`, distinct `runtimeRole` and `migratorRole`, and (for hosted
resources) `neon: { projectId, branchId }`. Runtime credentials stay in
`PLATFORM_AUTH_DATABASE_URL`; the record contains no credentials. Unknown fields,
wrong environments, connection overrides, and URL host/database/role drift fail
closed. Direct and pooled Neon hostnames identify the same endpoint; hosted TLS
must verify its hostname. The migrator checks the selected provider project and
branch against the record and requests the explicit migrator role. PostgreSQL
cannot independently attest Neon project/branch IDs: runtime verifies the TLS
endpoint and SQL database/schema/current role/session login; provider identity
readback remains the protected operator's responsibility.

Before an enrolled pool hands a new connection to Better Auth or permission
queries, read-only catalog preflight rejects elevated/inherited administrative
roles, migrator membership, database/schema creation, owned public objects,
missing required Auth tables, and direct or role-reachable table or column
writes to app assignments. Security-definer function capability auditing remains
a separate operator responsibility.
This is connection readiness, not an exhaustive privilege audit or continuous
revocation check for already-open connections. A protected migrator verifies
identity before mutation and may reach an empty store to install its schema;
its final schema check remains required. `packages/auth/migration.ts` is the
explicit migration CLI entrypoint; ordinary Auth configuration defaults to the
runtime role and cannot switch purpose through an environment variable.

Enrolled Auth resources use `mise run auth:db:schema:plan` to inspect the exact
additive SQL and catalog state without applying effects. The protected migrator
passes that plan's `AUTH_SCHEMA_MIGRATION_PLAN_DIGEST` to the existing Auth
provisioner. A private schema-history ledger records the reviewed plan, attempt,
catalog hashes and verification; it rejects changed plans, drift, unsupported
SQL and ambiguous interrupted effects. Schema effects commit before the separate
organization and access reconciliation. Unenrolled resources retain the legacy
provisioning path until explicitly enrolled. This schema receipt does not attest
provider project/branch identity or grant app access.

Repository Auth provisioning commands take `AUTH_CATALOG_APP_IDS` as a nonempty
JSON array of unique app IDs for both planning and applying. They do not infer
app access from the checkout's deployment layout. The same catalog must be used
for the reviewed plan and access reconciliation. Standalone proposals receive
`catalogAppIds` in their input, and protected workers use the approved plan's
catalog. Platform tests supply their own catalog independently of deployed apps.

### Protected Auth worker launch contract

The fixed standalone Auth worker is invoked as:

```text
<catalogued-auth-worker> auth-protected-migrate --file-spool <private-spool-directory> <run-id> <timeout-ms>
```

The CLI requires exactly those five arguments after the executable. `run-id`
contains 1–128 ASCII letters, digits, `_` or `-`; `timeout-ms` is a positive
safe integer. The host supplies the executable from its independently pinned
Auth installer catalog, uses a private working directory and spool, and does
not pass credentials in arguments or environment variables.

The worker reads these private `startup/` files before it requests authority:

- `context.json`: version-1 protected installer context with `app_id: "auth"`,
  empty `tenant_targets`, the enrolled Auth resource, the fixed Auth installer
  identity, and `release.id` / `release.sha256` equal to the schema plan's
  `targetDigest` / `planDigest`.
- `direct-database-url.json`: a JSON string containing the secret direct
  migrator URL. It is never included in notices, logs, receipts or effect
  frames.
- `ready.json`: version 1, the exact `run_id`, and startup `frame_id: 0`.
- `auth-schema-plan.json`: `{version: 1, resource, schemaPlan}`. The plan binds
  the same resource, `toolchain: "better-auth@1.7.3"`, the
  `_auth_schema_history` contract, sorted unique `catalogAppIds`, target and
  before-schema SHA-256 digests, the exact ordered SQL effects with owners and
  hashes, and `planDigest`.

The worker requests the closed effects `auth:apply-schema-plan` and then
`auth:provision-access`. Each receives a matching durable authorization and
checkpoint before the next effect. Schema changes and organization/access
reconciliation commit separately; each is independently read back before its
checkpoint. Only after both readbacks and checkpoint acknowledgements does the
worker publish `worker_succeeded` and exit 0. Startup or effect failure exits
nonzero and may publish one coarse `worker_failed` lifecycle fact. The stdout
stream contains only the generic file-spool frame and lifecycle-ready notices;
failure diagnostics go to stderr using closed categories. Unknown readback
remains unknown and never becomes a successful receipt. This is the worker
contract; it does not prove a hosted relay, provider resource, or deployment
configuration.

The closed `auth-protected-schema-readback` command uses the same schema-only
installer identity, original `auth-schema-plan.json`, full approved
`operator-plan.json`, resource and live authority fence. It never replans or
authorizes migration effects. Read-only connections and a read-only transaction
verify the complete original plan against owned, verified schema history, the
current source target, configured schema, catalog hash, ACL fingerprint and
published readiness. Success writes only a context-bound `readback.json` proof
with `status: "applied"`; no DDL, grants, history/readiness publication or account
changes occur. Missing or mismatched startup authority is `startup_rejected`.
After startup, missing, incomplete or drifted migration state, or an unconfirmed
live authority fence, remains `readback_unknown` for coordinator reconciliation.
An applied migration whose
coordinator checkpoint was lost can therefore be observed without replaying it.

Without enrollment, Production migrations retain the reviewed
`AUTH_PRODUCTION_DATABASE_IDENTITY` dedicated database and same-named role;
Preview retains `platform_auth`. Local fixtures and placeholder source builds
retain their existing path. Enrollment must preserve the reviewed Production
host/database when that legacy identity is also supplied. No new provider IDs,
roles, or credentials are inferred. Before enabling the record on existing
hosted Auth, inventory the actual provider resource, establish restricted
runtime grants and distinct migrator authority, bind the same record in both
consumers, then prove current users/sessions and provider binding. Source and
owned disposable PostgreSQL tests do not establish that hosted enrollment.
Branding changes never authorize an empty-store cutover or user/session loss.
`mise run auth:test:resource-identity` exercises the enrolled preflight and
failure-before-write behavior against an owned disposable PostgreSQL cluster.

### Protected app grants in Gateway principals

The EdDSA Gateway principal can carry `appActorGrants`, a nonempty array of
`{role, fenceGeneration}`. Roles are unique valid app role IDs; each generation
is a nonnegative safe integer from the active Auth assignment row. The trusted
Gateway verifies the human session, organization membership and app access
before reading these rows through `requireAppGrantContext`. It resolves this
context afresh for every request. Trusted composition selects protected apps
through `requiresAppGrants`; Spend Review must be enrolled in that policy before
its consumer switches to these claims. This shared SDK does not declare app IDs
or change the currently deployed composition. Ordinary legacy principal
readers remain compatible, but `requireVerifiedAppActorGrant` rejects a missing
claim, another app/actor/organization, or an ungranted role.

The application chooser filters managed apps through the same current
`requireAppGrantContext` authority for the authenticated actor and each explicit
organization. Repeated classification of an app used by multiple organizations
shares one promise within that render; each actor-and-organization grant is
still checked separately, and later renders read current authority again.
A named app role or explicit role-less admission can make the app available.
Organization catalog membership alone cannot select a managed app,
including through a requested `next` path or sole-app redirect. Only an
`app_access_required` 403 omits a managed app before organization and application
selection; tenant-membership and unavailable-authority failures remain errors.
Pre-existing memberships retain their organization entitlement policy for
unmanaged applications; protected-join-created memberships require explicit app
access there too. This navigation projection grants no access:
the Gateway and application reauthorize the eventual request independently.

Consumers first verify the principal with the public JWKS, including method,
request target, issuer, audience and expiry. The signed `jti` is a request
identifier; public-key verification does not consume it or prevent replay.
For a protected mutation, the consumer must atomically check/consume its
issuer/audience/JTI in a durable replay store bound to the actual method, target,
body digest, actor, organization and grant generation inside the mutation
transaction. A repeated nonce cannot authorize another mutation; an allowed
idempotent retry must resolve through the existing same-operation result.
Neither principal verification nor the grant helpers implement that replay store.
The grant claim is
an authorization observation, not a live grant or proof of human sign-in.
Before a mutation, protected consumers must compare the role and generation
to current authority in their own app database. The SDK
`requireCurrentVerifiedAppActorGrant` accepts only a scoped current-binding
reader and rejects a missing, inactive, rebound or different-generation row.
The consumer must execute this reader inside actual mutation authorization; the
helper does not create bindings or make an out-of-transaction read atomic.
The protected generated-app installer revokes the shared Auth assignment and
reads it back before closing and reading back kernel actor membership. A retry
at the same fence completes the remaining effect after process loss. The SDK
only checks current app binding inside mutation authorization; it does not
implement the protected worker sequence. After an app binding closes, the
current-binding helper rejects an old signed claim.
The installer checks the operator fence after an Auth grant commit. For legacy
private grants, a lost fence or failed grant readback closes only Auth assignments
still at that grant generation and verifies the organization projection. A newer
generation is not overwritten by this cleanup. Managed Production signup retains
its owned reservation and grant witnesses when a write, readback or authority
result is uncertain. It reports unknown; closure requires an authorized revoke
under a fresh higher fence. Operator fence calls remain outside Auth transactions.
JWT freshness alone does not prove immediate revocation.

Realm database credentials, Better Auth secrets, and Gateway signing keys must
remain in a trusted Auth/Gateway host. They must not enter generated app process
environments. An app process needs its own restricted database connection and
public verification configuration. A Services project environment shared by
all services cannot establish this separation through an app projection or by
unsetting environment variables in an app wrapper. Provider host/environment
separation and the app-binding consumer are separate required implementation
and deployment work; this signed-claim contract alone does not qualify them.
The private Auth schema history remains inaccessible to app/runtime consumers;
a schema target publication must expose sanitized target facts separately.

For protected API delegation, the trusted Gateway reissues an EdDSA principal
for the backend method and private request target, preserving the verified
actor, organization, app audience and `appActorGrants`. It adds a fresh JTI and
signed `bodySha256` (canonical base64url SHA-256), forwarding only the public
principal header. The actual backend target must match its signed target. `verifyProtectedAppApiPrincipal` uses a
public verifier and the actual request body; missing grants, a missing/mismatched
body digest, or method/target/audience rebinding fails closed. No realm credential
or app MAC signing secret is required for this protected path. Legacy API
principals retain the existing legacy delegation protocol; they cannot satisfy
the protected verifier. Delegation does not consume the JTI or replace the
required current-binding and atomic replay checks at mutation commit.

### MCP agent sign-in (OAuth grants)

The realm's Better Auth is the only authorization server for MCP agents
(issuer `<public origin>/api/auth`), through the maintained `jwt`,
`@better-auth/oauth-provider` and `@better-auth/cimd` plugins. Each enrolled
app is one protected resource, `<public origin>/<appId>/api/mcp`, with one
scope, `work_session` (plus `offline_access` for a rotating refresh token).
The trusted composition policy enrolls apps:
`PLATFORM_GATEWAY_PROTECTED_APPLICATIONS` (or `agentAppIds`). The plugins'
tables are always part of the realm schema and its runtime privileges, so the
Auth migration lane creates them; the plugins run only for an enrolled app.
Clients register by Client ID Metadata Document (`mcp-2026-07-28` profile,
pinned resolve-once fetch) or by dynamic registration. Dynamic registration
takes RFC 7591 public-client metadata only (the provider refuses
`skip_consent`; resources, key material, subject type and logout channels
are dropped), and HTTP redirects must be loopback. A client that omits
`application_type` and has only loopback HTTP redirects is registered as
native; an explicit `application_type` is kept, so a `web` client with a
loopback HTTP redirect is refused. A client that is not public (a metadata
document declaring `private_key_jwt`) is refused at consent and at issuance.
PKCE S256 is required. Access tokens are JWTs for 15 minutes (`aud` the
resource, `sub` the user, `azp` the client, `org`, `grant` the consent row
id, `scope`); refresh tokens last 30 days and rotate, and reuse revokes the
family.

A grant is one consent row per user, client, app and organization: the
`referenceId` is `agentGrantReference(appId, organizationId)` (the JSON array
`[appId, organizationId]`), and `(clientId, userId, referenceId)` is unique,
so concurrent Allows leave one row. A second app granted to the same client
in the same organization is its own grant, with its own consent page, id,
conversation identity and revocation; a new app never skips consent.
The shell's organization page (`/auth/oauth/organization`, skipped when one
organization qualifies) lists the user's organizations that grant the app and
where the user holds an active app assignment; the pick is stored for that one
authorization request (session, client, redirect, PKCE challenge, state,
resource) and re-checked at consent and issuance. It never changes the
session's active organization. The consent page (`/auth/oauth/consent`) names
the client (a metadata-document client by its verified domain, a registered
one as self-described), the app, the organization and the agent limits.
Deleting a grant also deletes that grant's refresh tokens and unexchanged
authorization codes, and no other app's, before and again after the consent
row is deleted. The token endpoint releases a response only if the consent
row its access token names still exists after the refresh row was written;
for a code or refresh exchange, it must also be the consent row the
presented credential was issued under (read with the credential before the
provider consumes or loads it). Otherwise it
deletes that refresh row and answers `invalid_grant`, so neither a refresh
nor a code exchange racing a revocation ever mints for a later grant of the
same app and organization. The shell serves
`/.well-known/oauth-protected-resource/<appId>/api/mcp` and the path-inserted
`/.well-known/oauth-authorization-server/api/auth`.

`requireGrantContext({ token, appId, kind })` is the one verifier, for both
grant kinds (`work_session` for agents, `canvas` for the canvas in a chat;
`kind` fixes the scope, the resource on the issuer's origin, the client and
the consent reference shape, so neither token passes as the other): it
checks the JWT against the
realm's own keys (signature, issuer, audience, expiry, scope; the key set is
cached at most 60 seconds and never past a key's expiry, and an unknown key
id refetches it), then re-reads
the exact consent row the token names (`grant`, for this user, client, app
and organization), the organization membership and app, and the app
assignment on every call. A deleted grant refuses an unexpired token, and
granting the same app and organization again (a new row) never revives it; a removed membership,
app or assignment answers 403. Agent limits are those of the platform agent
context: no Save, resolve, publish, approval, revert or canonical write.

In protected mode the Gateway (inside the bounded custom Gateway only, no
provider routing) has three lanes. G1: `POST /api/auth/oauth2/token`,
`/oauth2/register`, `/oauth2/revoke` and `/device/code` on the default app
accept requests without a browser session (no `Origin`, or the canvas
frame's cross-origin call) in every environment, with the `Cookie` header
removed; `/device/approve` stays a cookie-bound browser POST. G2: for a protected app, the exact path `/<app>/api/mcp`
authenticates by `Authorization: Bearer` only: cookies are dropped, the
browser-origin check is skipped, the token is verified in preflight and again
when signing, and a refusal answers 401 or 403 with
`WWW-Authenticate: Bearer resource_metadata="…", scope="work_session"` (plus
`error="invalid_token"` for a bad token). The signed principal carries the
current `appActorGrants`, the body digest and `agentGrant: { id, clientId }`.
Every principal verifier refuses an `agentGrant` principal unless the
consumer asks for an agent, so human pages, actions, API delegation and
verified data contexts never accept one; `createVerifiedAgentDataContext`
requires one. A bearer on any other app path is ignored and stripped. The
app's mandatory Next proxy (`createProtectedNextProxy` with `agentPathname`
set to the app's MCP path) verifies an agent principal, with its body digest,
on that exact public pathname only and refuses a human one there; every other
path, including trailing-slash, case and encoding variants, refuses an agent
principal.

The app's MCP route is bearer-only in both modes. Protected mode opens the
agent context from the signed agent principal, binding the approver role
when granted, else member. Legacy mode (no Gateway) verifies the bearer in the
app with `requireGrantContext` (kind `work_session`), answers the challenge itself, and runs
`createLegacyAgentSession` on its own pool with the same capability list,
re-reading the grant before each transaction. A legacy app behind a deployed
Gateway gets no bearer lane: its MCP route answers 503 (no challenge) when a
Gateway principal is present, as it does when the realm origin is not
configured. The conversation identity is the grant id plus
the MCP session; each tool call is its own turn. `mise
//apps/comp-canvas:mcp:local` proves the flow locally with a real MCP client.

### The canvas in a chat (device sign-in and canvas API)

An MCP host that renders views shows the canvas as the MCP Apps resource
`ui://autograph/canvas` (`text/html;profile=mcp-app`): one self-contained
document built from `packages/canvas-host/mcp-app/` into
`packages/canvas-host/dist/mcp-app.html`, with its config (app, canvas API,
device and token endpoints, client id, definition, public AG keys) injected
at read time. Its `_meta.ui` names the app's public origin as the only
connect domain and Claude's frame domain, the first 32 hex characters of the
SHA-256 of the exact public MCP endpoint `<origin>/<app>/api/mcp`
`.claudemcpcontent.com`. `open_canvas` shows a session by id or title
(`_meta.ui.resourceUri`; `structuredContent` `{ session_id }`) and its text
stands alone for clients without views. The canvas never calls tools
through the host.

The canvas acts as the person, on its own grant. It signs in with the RFC
8628 device grant (`oauthDeviceAuthorization`, 10-minute codes, 5-second
polling) as the one static public client `autograph-canvas` (device and
refresh grants, scopes `canvas offline_access`, seeded and rewritten by the
realm), for the app's canvas resource `<origin>/<app>/api/canvas`. Only that
client may start a device sign-in, and only for one enrolled canvas
resource and the canvas scopes; no other client may register for, or be
issued, the `canvas` scope or a canvas resource, and the canvas client is
never issued `work_session` or an MCP resource (the claims gate and the
token response both hold this). The shell's `/auth/device?user_code=…` page
signs the person in if needed, claims the code for them, picks the
organization on the device code itself (the agent organizations rule:
membership, organization app, active assignment) and shows the consent
("Let <app> in this chat act as you: edit, Save, review and, if you approve
drafts, approve and publish"). Approve (`/device/approve`) first upserts the
consent row (client `autograph-canvas`, the person,
`canvasGrantReference(appId, organizationId)` = `["canvas", appId,
organizationId]`, the canvas scopes and resource), re-checking eligibility,
then the provider approves the code. The provider's device exchange carries
no consent reference, so the token endpoint binds it: it reads the approved
code's consent row before the provider consumes the code, the claims name
that row (`org`, `grant`), the issued refresh row takes its reference, and
the response is released only for that live row. Refreshes then rotate and
stay bound like an agent's, and deleting the grant also deletes its device
codes. Tokens are 15-minute JWTs (`aud` the canvas resource, `azp`
`autograph-canvas`, scope `canvas offline_access`).

`CANVAS_FRAME_ORIGINS` (exact HTTPS origins; HTTP on loopback only) plus
Claude's derived frame origin per enrolled app is the one frame origin
list. It feeds Auth `trustedOrigins` and CORS on exactly
`/api/auth/device/code`, `/api/auth/oauth2/token`, `/<app>/api/canvas` and
`/<app>/api/canvas/events`: preflight answered without authentication (204,
or 403 for another origin), `Authorization` allowed, never credentials, and
the headers on every response, failures and the stream included. It is not
the Gateway's browser-origin allowance.

The canvas API is bearer only. `POST /<app>/api/canvas` (`CanvasApiRequest`:
`read`, `session`, `drafts`, `threads`, `create_session`, `viewer`; a `read`
body may be `{ batch }` of 1-40 read requests, answered in order with one
result each, a few at a time, one failure never failing the others) runs
every operation the web canvas performs through its server actions and read
route, through the same host calls and their member and approver checks.
`GET
/<app>/api/canvas/events?session_id=` is the session stream. The route
resolves the person once per request from the bearer and carries that
identity explicitly through access, read and write: never a cookie, and an
agent token is refused (as a canvas token is on the MCP route). Legacy mode
verifies the bearer in the app (`requireGrantContext`, kind `canvas`) and
opens a human context on its own pool, re-reading the grant before every
transaction. Protected mode's G3: the Gateway's bearer lane also matches
exactly the two canvas paths, answers their CORS, verifies the canvas token
in preflight and again when signing, and signs the human principal (body
digest bound) plus `canvasGrant: { id }`. The app's mandatory proxy
(`createProtectedNextProxy(..., { canvasPathnames })`) verifies a canvas
principal on those exact paths only and refuses agent or plain human
principals there; every other consumer refuses a `canvasGrant` principal, as
it refuses `agentGrant`. `createCanvasHttpClient` is the canvas's client in
the frame: the same `CanvasClient` over the canvas API, with a `fetch`
Server-Sent Events reader; the frame keeps its refresh token in
`localStorage` per canvas resource, person and organization (the resource's
own key names only the identity the origin last paired as, which a new frame
opens as), serializes refreshes with Web Locks, and returns to the sign-in
panel when a refresh is refused. Each frame works as the identity it paired as
and never adopts another: a token for anyone else signs it out, and pairing
again clears its canvas and model context first. An auth generation, bumped
by sign-out and by a pairing's start and finish, voids any refresh or device
poll answered after it moved on. An unreachable server is a
retryable state, never a stuck load. Approving a canvas device code records
the consent row and approves the code in one statement, only while the code
is pending under the organization the approval validated; an organization
pick racing it refuses the approval, and a pick after it is refused. Dynamic
registration takes `scope` only as a string or an array of strings and
refuses the `canvas` scope however it is separated, and a preflight on any
auth path but the device and token endpoints is answered 403. The Gateway's
bearer lane denies any path that is not exactly one of its own, assuming no
grant kind.

In the chat the canvas takes the host's theme, fonts (or the system stack)
and style variables (mapped onto the design tokens), offers Full screen
where the host lists both display modes, opens the session `open_canvas`
names, and sends the person's selection and last 20 actions there with
`updateModelContext`, 300 ms after the last change, as sentences by label
plus structured content (the selection's kind, model, column headers and
record count; never a record id, token, code or request id: the agent names
records through `describe_workspace`). `open_canvas` refuses a title several
sessions share and asks for the id. The app's build builds the canvas host's
`dist/mcp-app.html` before `next build`; where the document is absent the MCP
route offers no view (no resources capability, no `resourceUri`) and
`open_canvas` answers in text only. Presence is written once the session's
stored presence is known (a reopened canvas replaces an old selection), and
writes are serialized so a slow one never lands after a newer one. Token loss
returns it to the sign-in panel and closes its stream. The deployed shell,
generated from its adapter, serves `/auth/device` (the adapter's
`device-page`) and answers the auth route's `OPTIONS`. `mise
//apps/comp-canvas:mcp:bridge` proves the view end to end on an ext-apps
AppBridge host page.

### Protected Next static deployment controls

The Vercel preparation adapter maps deployment controls only for protected Next
static asset files at the selected catalog asset prefix, using GET or HEAD in the
ordinary non-suite request lane without a body. Framework document, RSC and
Server Action lanes retain their existing transport. Preparation uses a
snapshot of the app's already trusted, approved immutable deployment ID, not a
provider lookup or a newly selected deployment.

An absent `dpl` is a no-op. A present selector must be exactly one query entry
whose decoded, case-sensitive key is `dpl`, with a decoded value matching that
approved deployment ID; duplicate, empty or mismatched selectors fail closed.
Selector rejection is retained until ordinary authorization settles: denied
callers keep the existing auth response, while allowed callers receive a generic
400 before origin resolution or provider dispatch. Unexpected preparation errors
retain the existing Gateway failure path.
For that validated mapping, the adapter removes only the reserved entry from
the downstream URL and sets a fresh `x-deployment-id` from the trusted value,
overwriting the caller's header. Every ordinary query entry retains its raw
bytes and order, including empty entries, under the existing URL normalization;
an empty reconstructed search normalizes to an empty search. Cookie removal
applies only to the already sanitized child Cookie header and removes
`__vdpl`. Preparation never restores a raw browser-cookie snapshot or supplies
a replacement Cookie header.

Authorization still evaluates the public request target. The principal signs
the prepared wire target before dispatch, so ingress verification and the
post-signing query-change guard accept no alternate target and ignore no query
entry. This is consistency with the selected native deployment binding, not a
Git, latest-version or freshness gate. It neither discovers historical
deployments nor establishes old-client skew support after that binding rotates.
Source changes alone do not prove the hosted asset path works.

### Verified Gateway to generated PostgreSQL context

`@autograph/platform-microfrontends/verified-data-context` exports
`createVerifiedGatewayDataContext`. Its server-only input consists of the actual
request headers/method/target, a public verifier or public JWKS configuration,
an exact app/actor/organization scope, a server-selected role, the app's own
restricted runtime URL and independently selected database/login identity,
and the existing release checker and capability authorizer. It requires an
explicit signed role with a positive fence. Missing claims or a scope, request,
role or runtime-identity mismatch fails before opening an app connection.
It takes no realm SQL URL, Better Auth secret, private signing key, or fake
current-binding callback.

The returned `context` is the actual generated PostgreSQL `DataContext`, with
its actor ID and immutable role/fence supplied on the operation connection.
Protected kernel scopes recheck current active membership and hold its SHARE
lock inside that same transaction. A preliminary snapshot does not substitute
for this admission. The handle's `close` releases its owned app pool. The
capability authorizer and app business policy remain necessary; this adapter
alone does not establish hosted human sign-in or semantic product behavior.

Protected Next hosts install `createProtectedNextProxy` from
`@autograph/platform-microfrontends/next-request-ingress` as their mandatory
`proxy.ts`, without matcher exclusions for mutation routes. Set the standard
`skipProxyUrlNormalize: true` Next configuration option. The proxy uses the
actual received downstream URL, including native `basePath` and query, verifies
the public Gateway signature and complete cloned request bytes, strips caller
verification markers, then forwards its checked method/target/body identity
internally. Truncated bodies fail the signed digest comparison. The proxy
establishes request integrity; each action and kernel transaction still authorize
access.

After those checks, the shared proxy restores `x-forwarded-host` from the exact
configured public origin already verified as the Gateway principal's issuer.
Native Services may replace that header with a private service hostname in
transit. The browser's `Origin` and request body remain unchanged, and Next's
normal Server Action origin check still rejects a foreign origin. Restoring this
header does not itself change the Server Action origin configuration.

When native transport replaces that verified host again before rendering,
`nextAppConfig(config, { trustedPublicOrigin })` accepts the same public origin
from trusted protected-boundary configuration. It adds only the normalized
`URL.host` to Next's supported `experimental.serverActions.allowedOrigins`,
preserving caller origins, body limits and other options without mutation.
The child-app source policy accepts this second argument as an inspectable
object containing only `trustedPublicOrigin`; the shared factory validates its
value. Extra adapter options and further arguments remain unsupported, and the
first configuration argument retains its existing platform-identity checks.
Equivalent casing, default ports and a trailing slash normalize to the same
host; credentials, wildcard hosts and non-origin paths, queries or fragments
are rejected without echoing the value. An absent option adds no origin and
does not infer one from headers, environment or deployment metadata. This
shared reverse-proxy adaptation retains Next's unconfigured foreign-host rejection and
all protected principal, app, method, target, grant and body checks; it neither
rewrites browser `Origin` nor trusts an internal service host.

Protected POSTs also emit best-effort private JSON
`protected_next_action_diagnostic` events, separate from the operational alert
catalog. Their closed projection contains an `outcome`, sanitized configured
`appId`, environment and validated deployment context. The fixed
`proxy-post-entered` outcome contains no request-derived fields.
After existing signature, app, method, target, grant and full-body verification,
the return event checks the actual `NextResponse` override list and forwarded
host value. It reports only `proxy-returned-public-host-override` or
`proxy-returned-override-missing`, response status, and the existing Gateway
request ID when its verified nonce is a valid UUID; other nonce values are
omitted without rejecting the request. No headers, origins, principals, actors,
paths, bodies or credentials are serialized. These events describe entry and
returned request-header instructions, not consumption by the native render.
Correlate them with the provider's existing action-error observation; an absent
event alone does not prove that the proxy was bypassed. Logging failure changes
neither acceptance nor the existing denial diagnostic. These informational
diagnostics introduce no operational-alert service, category, failure class,
runbook or provider configuration.

At its existing denial catch, the shared proxy emits one best-effort private
`protected-next-ingress-denied` diagnostic with closed `stage` and `reason`
labels for request-target, principal, JWKS, grant, body-proof or forwarding
failure. JWKS metadata comes only from the existing request: its HTTP status
and a closed content-type category when a response exists. Only a target-binding
failure reached after signature verification, claim parsing, issuer, audience
and method checks adds target-comparison fields, before the later time and grant
checks. The flat booleans `targetPathnameEqual`, `targetSearchEqual` and
`targetSearchWithoutDeploymentEqual` compare the signed and expected target
components. `signedTargetHasDeploymentQuery` and
`expectedTargetHasDeploymentQuery` report whether each search contains a query
entry whose decoded key is exactly the case-sensitive `dpl`. Searches are split
from targets at the first `?`, retaining that delimiter when present, without
URL reserialization. The comparison without deployment entries removes only
those entries using `URLSearchParams` key decoding, preserving the raw bytes
and order of every other entry, including empty entries; when no entries remain,
the search is empty.

`signedTargetPathKind` and `expectedTargetPathKind` contain only `next-static`
for `/_next/static` and its descendants, `prefixed-next-static` for the same
shape after any nonempty path prefix, or `other`. `targetHeaderPresent` reports
whether the request-target header exists, including an empty header.
`targetHeaderMatchesSigned` and `targetHeaderMatchesExpected` compare its exact
whole value with each target; an absent header matches neither. Private,
ephemeral SHA-256 comparisons may produce these booleans, but no hashes are
returned or logged. These fields are diagnostic only: the header and a search
comparison with `dpl` removed cannot authorize a request, remove `dpl` from its
binding, or accept an alternate target.

Original failures are associated with safe metadata in a private WeakMap and
rethrown unchanged; only exact repository-owned messages map to reason labels,
while unfamiliar errors remain `unknown`. No errors, messages, request paths,
URLs, headers, identities, claims, tokens, cookies, keys or hashes are logged.
Diagnostics add no requests or body reads, preserve the existing verification
decisions and order, and retain the generic 403. Configuration failures caught
outside this shared factory are not covered. Target comparisons identify a
failure's shape; they do not establish its cause, repair a denial, or prove
hosted app behavior.

`readVerifiedNextAppSession` derives server-only actor, organization and app
grant facts from this verified request without a realm SQL URL or cookie
secret. Normal Next Server Actions use `createVerifiedNextActionDataContext`
from `@autograph/platform-microfrontends/verified-data-context`, which reads
actual `await headers()` and requires the proxy's verified POST context. Supply
the validated, server-normalized JSON DTO as `normalizedPayload`. Do not take principal headers,
role, verb, target or expected runtime identity from form controls or caller
JSON. Resolve actor and organization from public-key-verified Gateway context,
then retain the same exact scope through the operation. Keep normal Server
Actions as the mutation boundary and direct server reads as the read boundary;
no self-HTTP app call is introduced.

For Next pages using the legacy organization-scoped principal, Gateway binds
the complete body of Server Action requests and progressive form submissions
after authenticated preflight. API routes and non-Next applications retain
their own request boundaries. The app proxy verifies the signed method, target,
and body before the action consumes the principal; a role alone is not a body
verification marker.

For delegated API requests, select `kind: "delegated-api"` and supply the actual
request body. The signed body digest is checked in addition to public signature
and method/target/audience. A body-bound delegation cannot be downgraded to the
ordinary server-request mode. Public verifier configuration uses
`PLATFORM_PUBLIC_ORIGIN` and `PLATFORM_JWKS_URL`; existing private-zone transport
may also use `PLATFORM_ORIGIN`. These settings are public configuration, not
realm authority. Their presence does not prove provider environment separation.

The adapter supplies verifier-produced request claims and a separate canonical
normalized DTO hash to the actual PostgreSQL context. Mutations require both
the signed complete-body digest and normalized operation identity. Wrap all
generated operations for one Server Action in `context.requestTransaction` so
their writes, nonce consumption and receipts commit in one business transaction.
Admission survives rollback to reject changed identity or ordered operations;
exact retries may reuse existing kernel change-set receipts. Arbitrary callback
results are not cached. Reads remain non-consuming. Application submission
idempotency across separate HTTP requests still needs the app's stable
idempotency key and canonical write identity.

The trusted Gateway host enables this policy through
`PLATFORM_GATEWAY_PROTECTED_APPLICATIONS` (a JSON array of declared non-default
app IDs) or the equivalent `protectedApplicationIds` runtime option. It loads
fresh app grants and signs the complete forwarded entity-body digest for
mutations. Body capture uses private temporary files, preserves original entity
bytes and framing through the neutral proxy, and cleans up on completion or
disconnect. Its untrusted input bound defaults to Next's 10 MiB proxy buffer;
apps with another configured body bound must align both settings. Absence of
this trusted policy retains the explicit legacy contract and is not protected
hosted evidence. Physical app/Gateway/operator environment separation remains
a required independently observed boundary.

`mise run test:verified-gateway-data-context`
uses an owned disposable PostgreSQL cluster and current checked release to
exercise a genuine runtime mutation, mutation/revoke lock ordering, and
forged/cross-scope/stale/inactive/omitted rejection. Those checks do not establish
hosted behavior or qualify the saved public Builder session.
`mise run test:next-action-ingress` additionally exercises a real local browser
multipart Server Action through Gateway and Next into two PostgreSQL mutations,
independent receipt/nonce readback, concurrent exact replay and changed
body/DTO/identity rejection. This local fixture is not public Builder generation
or hosted product qualification.

### Auth schema readiness publication

The trusted Auth migration asset `packages/auth/schema-readiness.sql` owns the
separate `_auth_schema_readiness` namespace and its single current-target fact.
The Auth runtime receives only schema USAGE and EXECUTE on `read_current()`;
it receives no direct publication-table reads/writes, schema CREATE, helper
function access, or private `_auth_schema_history` access. Unknown namespace or
object ownership fails before adoption. The API does not expose historical
plans, SQL effects, attempts, credentials, users, sessions, or memberships.

`read_current()` returns version 1, algorithm
`pg-jsonb-catalog-sha256-v1`, database identity, and readiness status. A verified
or drift result additionally contains the target digest, approved SQL asset
SHA-256, published catalog fingerprint, and independently recomputed observed
fingerprint. The fingerprint covers actual public Auth column/constraint/index,
relation/owner/ACL, trigger, policy and function metadata, database/schema ACLs,
relevant runtime-role attributes/memberships, and private-history/publication
object ACL metadata. ACLs normalize equivalent default and explicit grants.
Publication row values and private-history row contents are excluded, so
publishing a verified fact does not change its own fingerprint.

This PostgreSQL JSONB-text fingerprint is a separate explicit algorithm. It is
never compared to `targetDigest` or the existing TypeScript historical schema
hash. The desired target includes the readiness asset digest and the whole
reviewed plan includes its fixed SQL effect; a new asset therefore changes
plan/target digests and the protected Auth worker executable pin. Existing
app CUE release bundles remain unchanged.

The existing owned Auth migration lock covers initialization, pending-state
invalidation before DDL, schema verification, and atomic verified private-history
plus publication writes. The history retains the recorded readiness fingerprint
for replay and lost-publication recovery. Runtime reads attempt the corresponding
shared transaction lock and report migration-in-progress while migration owns
it. Failed/interrupted migration leaves an unverified fact. Current schema or
permission drift is reported as drift, and verified replay cannot bless it.
Runtime write/create access to the publication or private-history access makes
the fact unverified. Missing publication can be reconstructed only from the same
verified schema and recorded catalog fingerprint.

`@autograph/auth/schema-readiness` provides fixed read/verify helpers. Publication
verification proves this database's schema/permission metadata against a reviewed
target; it does not prove normal Better Auth table DML, human login, session
continuity, app membership behavior, hosted readiness, or a provider deployment.
Those remain independently observed qualification requirements.

### Protected Auth host runtime privileges

The approved enrolled schema migration includes `packages/auth/runtime-privileges.sql`
in its target digest and exact effect digest. It grants the private trusted Auth/Gateway
runtime the configured Better Auth table operations, including invitation resend expiry,
password/account updates, verification consumption, sessions and organization membership.
Organization creation/deletion, enrollment metadata, organization appIds and app actor
assignment writes remain operator-owned. User deletion is also denied: its foreign-key cascades could remove operator-owned
assignments. Optional dashboard destructive user/organization operations remain
operator operations and fail under this runtime profile. No sequence is required by the current text-ID schema; no wildcard
public table/function grant is applied. The profile checks migrator ownership and clears
existing table and column ACLs on its explicit table list (the core Auth tables, then
the agent authorization server's `jwks` and `oauth*` tables) before granting permissions.

This asset applies only through the protected enrolled approved plan. It does not change
legacy provisioning or ordinary build behavior. Its new target/plan digest requires fresh
approval and its changed protected worker bytes require a fresh executable pin. Existing
verified plans and immutable app releases remain historical. A runtime schema metadata
publication is distinct from login evidence; owned PostgreSQL API acceptance is distinct
from hosted human sign-in. Realm SQL and signing credentials belong exclusively to the
physically isolated trusted host, never a generated app project environment.

Verified Auth history and its current runtime publication are checked inside their
shared transaction before COMMIT. A failed publication readback rolls back both
verified writes, retaining an unverified pending publication and recoverable
attempt. A lost verification COMMIT acknowledgement has an unknown outcome; it
must not rewrite history as failed. Retry reconciles the database's actual verified
or applying state under the existing migration lock before returning a receipt.

### Auth new-empty schema proposal

The source-only `proposeEmptyAuthSchemaMigration` producer uses the shared pure
Auth table/plugin definition and trusted SQL assets. It constructs no database
client and needs no realm URL, secret or native settings. Its frame is explicitly
marked `proposal: "new-empty"`; the prospective empty public catalog hash is an
approval condition, not a claimed database observation. The producer accepts no
arbitrary preview SQL. Current genesis SQL and source definition are checked
against the official fresh PostgreSQL planner on an owned disposable database.

The fixed Auth worker independently plans its actual owned database before any
schema write and requires the entire plan, target and effect digests to match.
Nonempty or changed targets cannot use the prospective plan. Verified/interrupted
history still governs replay and recovery; existing database planning remains an
actual read-only catalog inspection. Existing plan semantics and immutable releases
are unchanged. These source/owned PostgreSQL checks do not prove provider grants,
installed hosted resources or human login.

### Starting a canvas session (page components)

`@autograph/canvas` exports the two generic pieces an app's canvas home page
uses before a session is open; the app binds them to its own server action,
router and Auth client and keeps its wording in props.

- `NewSessionForm({ create, onCreated, placeholder? })` takes a title and
  calls `create({ title, session_id, request_id, as_of })`, with `as_of` the
  browser's date at the submit. `create` answers
  `{ ok: true, value: { sessionId } }` or
  `{ ok: false, error: { code, message } }` (the host's `createSession`
  result); `onCreated(sessionId)` opens the new session. Only a success or
  `contract_validation_failed` ends the gesture: any other refusal or a
  thrown request keeps the ids and date, so resubmitting the same title
  (compared trimmed, as the host stores it) replays the create instead of
  making a second session.
- `OrganizationChooser({ organizations, appName, choose })` lists
  `{ id, name }` organizations when a person has several that open the app
  and none is active. `choose(organizationId)` makes one active and resolves
  whether it did; false or a rejection shows that it could not be opened.

## Currency rates

The reusable [currency-rate contract](currency-rates.md) supplies opt-in exchange-rate
schema vocabulary, a tenant-bound adapter over ordinary kernel operations, a pure
conversion function, and a package editor. Kernel versions remain the sole effective
history authority. Custom rates override automatic rates over their inclusive effective
periods; the latest monthly automatic version has no end until a successor is applied.
Provider fetching is explicit preparation outside reads and calculations.

### Managed Production app signup

Generated app access is private unless the accepted app intent and approved setup
select an app-scoped self-signup policy. The protected Auth-management worker
installs and reads back the exact policy version/digest, realm, organization,
return path, eligibility and explicitly approved app-catalog roles. Frontend
apps may use no business roles. Data-backed apps with named compiled roles must
select valid roles; an actually roleless compiled app uses actor-bound app
admission without an invented business role. Disabling signup retains a disabled
policy record and existing access.
An approved app entry-route revision updates the same policy at a newer fence,
preserving its realm, app, organization and origin. Exact retries reuse the
installed digest and approval; older fences and conflicting equal-fence writes
fail. A changed route changes the policy digest, invalidating earlier signup
claims and signed continuations before any new access grant.

The Auth runtime checks the installed policy before creating a password account.
The managed verification email includes a clickable HTML link and the same
complete URL in its plain-text fallback. Both carry the signed continuation
for the exact installed signup policy.
After email verification, a security-definer function checks the persisted user,
current live session, realm and eligibility and mints one frozen signup claim in
`app_access_invitation`. This claim sends no additional invitation email and
grants no membership, assignment or app-data binding. The existing private
Auth-workload callback carries only the signup discriminator, policy ID and
claim ID. Builder reads identity/roles from protected readback, then resumes the
same durable claim under the existing app lease and protected access worker.

Opening an Auth page or reading signup status never claims app access. An explicit
successful sign-in for an installed app policy continues through the same protected
admission path, including an existing Auth account entering from an app leaf. The
request carries only the selected policy's canonical app URL; existing positive
actor/app/organization access returns ready without a new claim or grant. An
immediate ready result may restore the separately validated requested leaf and
query. Verification and signed pending continuations retain the canonical app URL.
Failed completion stays on an actionable retry that retains the requested leaf;
blocked or mismatched responses never navigate into the app.

An expired, never-granted claim may renew under its original ID only with the
current verified session and enabled eligible policy, no grant reservation,
operation or fence witnesses, and no active or inactive Auth access history.
The claim and organization locks serialize renewal with reservation before any
kernel write. A new nonce changes the scope digest and invalidates earlier
proofs. Reserved claims retain their original identity and grant binding.

Production readiness requires observed positive app admission and, for a
data-backed app, its actual generated database memberships before the claim is
completed. A retry preserves the claim and grant operation; it cannot replace
established access, change roles or revive inactive access tombstones. Legacy
`enroll_app_signup_user` remains generation-zero Auth enrollment only and never
consumes a managed Production policy or establishes Production app-data access.

After a lost completion callback, the closed access-readback command may observe
the original witnessed grant operation and fence under current authority. It
checks the approved release, physical resources, actor, app, organization, roles
and complete Auth/kernel grants using read-only connections. Expired claim or
session state and disabled signup do not prevent observing already established
access. Only a complete owned result can settle the original Builder journal;
partial, mismatched or revoked access remains unknown.

An authorized People removal may close a retained partial signup under a fresh
app lease. Closure requires the exact actor's Auth admission and every assignment
inactive at the current fence, plus negative kernel readback for data-backed apps.
The original claim is rejected only after this coordinated proof; other pending
actors continue to block unrelated mutations.
Source tests and worker readback are separate from hosted signup/sign-in proof.
