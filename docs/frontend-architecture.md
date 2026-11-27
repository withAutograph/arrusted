# Frontend Architecture

Autograph's frontend is a layered, code-defined system. Apps are built in code (not assembled from runtime manifests), the design system is portable across apps, and reusable workflow surfaces are job-shaped rather than page-shaped.

This doc is the architectural authority for frontend layering, naming, wiring, and the AG2 port-over decisions. It complements `principles.md` (substrate authority) and `ag2-reference.md` (product evidence).

## Route-Owned Applications

**Decision:** the application boundary is the HTTP route. The private Shell adapter is the
default Next.js application; every other supported direct child of `apps/` is
an independently built and served zone. The Gateway forwards the
complete request to the most-specific route owner without stripping the mount,
wrapping React, or transforming HTML. The shell React tree is absent from child
documents.

Registration is explicit in checked root `microfrontends.json`; an app
directory cannot register itself. A native `next.config.*` or `vite.config.*`
under the registered `apps/<name>` supplies the framework implementation while
the checked topology supplies identity, routing, asset prefixes, and local
ports. There is no
`app.manifest.ts`, app entry module, package registry field, shell renderer
route, runtime provider, Autograph framework wrapper, or handwritten shell
import. Apps may retain their own runtime providers; there is no shell-owned
cross-app runtime provider. Generated route data lives only under
`.scratch/microfrontends` as a byte-for-byte local rendering of the checked
topology. Vercel project topology lives in the three tracked Services configs.

Next zones retain their own App Router filesystem, layouts, RSC streams, Server
Actions, Cache Components/PPR, prefetching, and client navigation. Vite zones
retain their SPA root and history routing. Same-zone navigation is native;
cross-zone links are ordinary document navigation. Each zone owns its complete
document, internal routes, API split, errors, redirects, caching, CSS, data
validation, and client islands.

Application owners follow the focused
[existing-app adoption guide](guides/adopting-a-route-owned-app.md). Direct
official Vercel package imports are the only app-facing microfrontend
configuration API; the private Autograph package remains platform
infrastructure.

Inside that private package, neutral route/proxy modules sit below Autograph
policy and hosting adapters. The Gateway composes those layers explicitly:
policy supplies identity, entitlement, browser security, cookies, CSP, and the
existing delegated-auth contracts; local/Compose and Vercel modules supply
their own topology and provider operations. Neutral modules contain neither
product/security vocabulary nor Vercel project, OIDC, or protection behavior.
Application companion metadata, feature-directory placement, and private
adapter import placement are architecture guidance rather than Konsistent
admission rules. Konsistent leaves framework config naming to application
dispatch and native commands. Native application check, type, test, and build
commands report actual failures. Generated schema barrels may contain app-owned exports
or formatting; the compiler still generates its default barrel, while checked
release selection independently verifies the CUE source, artifact identity, and
member checksums. Generic application discovery does not require exact barrel
text or reject files by Rust, API, route, or build-script names.

Konsistent retains repository deployment metadata and shared-package conventions,
including type-only contract imports, pure API discovery barrels, and stable
entrypoint exports. Its existing executable server-auth import restriction is
retained; a directory named `frontend` does not itself prove browser execution,
and erased authentication type imports are allowed. Actual browser/server
credential, tenant-isolation, and approval boundaries remain required.
`mise run check:workspace-imports` owns resolved internal imports and
domain-library cycles. Deployment validators retain their credential and
provider contracts while preserving direct official Next and Vite configuration
imports.

The shell owns `/`, `/auth/**`, `/api/auth/**`, and every otherwise unmatched
route as the default application. Shell auth uses a single Better Auth page
component for browser-only behavior. Its route resolves the requested auth
view and feature configuration before passing them to that component. Better
Auth UI owns form state, query mutations, OAuth handoff, and the configured
return target. The shell supplies the required Next.js navigation adapter and
uses document navigation when that target belongs to another route-owned
application. The `packages/auth/components` tree is upstream-managed source
synced from the Better Auth UI shadcn registry. React Doctor excludes that tree
from app-owned heuristics; the public provider and shell adapter remain in its
analysis. After Better Auth resolves the user and
organizations, it obtains the generic application list from
`/_platform/catalog`, intersects it with app assignment, and renders no access,
organization selection, a sole-app redirect, or ordinary app links. It never
imports or renders an application. The gateway, not the shell, checks session,
active organization membership, and app assignment before forwarding a
protected child request.

The completed [OpenMicrofrontends SSR protocol pilot](open-microfrontends-pilot.md)
remains a production no-go: injecting remote HTML or JavaScript into a shell
document grants shell-origin authority without containment. Route-owned zones
instead return their own complete reviewed document. This is still one browser
trust perimeter, not a sandbox; untrusted UI requires another origin or a
sandboxed iframe. See [Route-Owned Microfrontends](route-owned-microfrontends.md).

Vercel represents the route-owned topology as one root Services project:
`apps`. Its tracked root Services config
keeps its frontend and private API/agent/callback processes colocated. Preview
child deployments are protected by exact environment-matched OIDC Trusted
Sources while Autograph identity remains independently verified.
Services within one project share project environment variables, so the
credential boundary is the project rather than an individual Service. Each
product project owns only its app-scoped server secrets, `apps` alone owns
Better Auth/Auth database secrets, and browser/client source is mechanically
forbidden from referencing server-secret names. Provider-managed server values
must remain sensitive and must not use `VITE_`, `PUBLIC_`, or `NEXT_PUBLIC_`
prefixes.
`.config/mise/scripts/vercel/shell-build` remains a shell-only build on Vercel;
each product API owns and blocks on its migration.

`mise run build:vercel-shell` remains a local assembly proof. Native Git
Previews provide full branch proof; Compose remains the local/provider-neutral
regression proof. The single `apps` Services project deploys and rolls back
atomically.
The ordinary Turbo `build` graph remains compile-only. Workspace-graph
validation requires upstream `^build` dependencies while prohibiting `check`
or `test` dependencies from workspace build overrides.

See [`shell-host-rsc-comparison.md`](shell-host-rsc-comparison.md) for the
decision trail from Vite RSC to Next App Router. In the route-owned topology,
each product zone owns its `/api` split and app-owned permission checks. The
Rust handler rejects routes that lack the required permission.
Each product runs its app's Rust binary in a private Service of the `apps`
project. The owning zone
handles its own `/api` split and asks the gateway to exchange
the verified, request-bound principal for a target-bound private API context;
the shell and generic gateway know no internal app endpoints, and the zone
never possesses the API signing secret.
The private HC agent calls its bound HC API Service with its app-scoped
platform context. Source contains no automation-bypass-secret fallback or
same-project public-route heuristic.

HC and Vendor CSV workspace model calls use the shared `agent-foundation` execution-profile
model resolution, which routes provider/model IDs such as `openai/gpt-5.4`
through Vercel AI Gateway. Vercel deployments rely on Gateway OIDC instead of
an app-managed `OPENAI_API_KEY`; local live-agent runs can use `VERCEL_OIDC_TOKEN`
minted by the repository-owned Vercel pull client, with `AI_GATEWAY_API_KEY` as
an optional fnox override.

Public HC API URLs stay app-scoped (`/hc/api/*`). The HC Vite development
config and app-owned static-zone runner route ordinary APIs to the HC Rust
service and agent paths to the HC agent service. Discovery finds
the app-owned `agent/server.ts` convention and runs that backend separately, so
the UI zone neither imports the agent nor receives its private signing secret.
Vendor owns its native Next API routes. No exceptional path is declared to the
shell or gateway. Every handler independently verifies the private platform
identity. Repository-root `api/` discovery is forbidden: Vercel API entrypoints
belong to their owning app Service, while the root project exposes only Gateway
and privately binds Shell. Better Auth is owned only by the Next App Router
handler. These invariants are enforced by the application and deployment
validators.
The root Cargo manifest is virtual. Each retained product Cargo package declares
its own app-local private Service bin for native Vercel Services deployment.
Each bin owns its complete route policy under `apps/<app>/api/service.rs` and
depends on the private `platform-service-runtime` package for shared trusted
ingress, replay protection, and Vercel request mechanics. No source file is
included across application boundaries.

The gateway applies a non-widenable CSP floor to every zone, while the shell
emits its own shell-only production CSP:
`default-src 'self'`; scripts and styles are local with the inline allowance
required by the current Next Cache Components/PPR output; objects are disabled;
base URIs and form actions are same-origin; and framing Autograph is disabled.
Each zone may add stricter policies or exact data/media origins, but cannot
widen the gateway's executable-code floor. Runtime remote imports,
`eval`/`Function`, script-element construction, raw HTML sinks, and external
stylesheets also fail source checks across apps and shared browser packages.
The ordinary local HMR stack explicitly adds `unsafe-eval` to Next-zone
policies to preserve React's full development debugging experience, including
enhanced cross-environment stack reconstruction. The gateway accepts that
allowance only with `NODE_ENV=development`; Vite zones, Browser QA, and
deployed environments retain the production floor.
The `script-src 'unsafe-inline'` allowance is temporary: replace it with
nonce- or hash-based authorization once Next Cache Components/PPR streaming
supports that without disabling the selected optimizations. This follow-up and
its revisit trigger are tracked in
[Known Footguns](known-footguns.md#shared-origin-route-zone-browser-trust).
This CSP reduces exploit paths but is not an app sandbox: every reviewed app
and bundled dependency still executes in one browser trust zone.

## Layer Hierarchy

**Decision:** the frontend has nine layers, organized as lower-level tracks
that feed workflow modules and apps.

1. **Contracts** — shared TypeScript data/client types. Generic substrate wire DTOs are generated by `packages/contracts/typegen`; package-local convenience types such as `KernelClient` and `TenantScope` are hand-written because they have no Rust wire equivalent. No runtime state, no rendering, no fetching implementation.
2. **Tokens** — semantic theme contract (CSS custom properties). Two-tier: semantic tokens (`--color-text-primary`) map to value tokens (`--color-blue-500`). Components reference semantic only.
3. **Components** — buttons, inputs, modals, popovers, tooltips, tabs, menus, pickers, dialogs. Pure presentational. Props in, callbacks out. No data, no state beyond local interaction.
4. **Compositions** — reusable UI assemblies built from components. Nav, sidebar, filter builder, table (presentational or interactive), breadcrumbs, empty/error/loading states, charts, KPI strip, detail card, timeline, drilldown, prose/callout. Props-first for app/runtime use; spec-driven when a composition is saved, shared, generated, or rendered by a non-app caller (see Composition Spec Contract). Stories document compositions; stories are not runtime dependencies.
5. **Engines** — pure non-UI logic. CSV parsing, field validation, value adaptation, import classification, formatting, stable hashing, UUID helpers, and column compilation. Often more reusable than UI; can be consumed by modules and apps directly. Engines never import UI, stories, modules, kernel-client, or apps.
6. **Modules** — reusable workflow surfaces. Own substrate plumbing (preview/commit/idempotency, draft/apply/discard, error envelopes, tenant wiring). See Layer Discriminators.
7. **Domain libs** — optional app-domain declarative schema, seed vocabulary, structural reconciliation shape, and ordered entity-identity policy under `packages/domain-libs/<domain>/`. They are borrowable app accelerants, not generic substrate or app workflow policy.
8. **App sections/pages** — app-owned route/nav organization. Sections are top-level product areas (e.g., `comp`, `people-analytics`); pages are routes inside sections.
9. **Apps** — own auth, tenant context, domain schema, global shell, route trees. Compose modules into pages; configure modules with app-specific schema/renderers/policies.

The contract track is `contracts`. The UI track is
`tokens -> components -> compositions -> stories`. The pure logic track is
`engines`. Modules and apps may consume all three tracks. Skip-down imports are
allowed (an app may import an engine directly). Skip-up imports are banned (an
engine never imports a module). Modules may import type-only client/error
contracts from `contracts/`, but never from `kernel-client/`. Engines also never import UI:
components, compositions, or stories. `stories/` is terminal example code and
must not be imported by runtime layers. CI-enforced.

Domain libs are a separate borrowable-app track. A folder like
`packages/domain-libs/employee/` may contain app-domain vocabulary because
its job is to seed or accelerate a concrete app schema shape. Other shared packages
(`design-systems/`, `engines/`, `modules/`, `contracts/`, `kernel-client/`)
must not import domain libs or branch on those domain nouns. Domain libs
preserve domain models, fields, lookup values, and declarative business metadata;
they must not preserve source-app runtime metadata such as page tabs, sidebars,
route behavior, rendering state, duplicate audit/change-type authority, or raw
source-app field types. They are not runtime aliases; apps intentionally import,
copy, or fork them when adopting a domain library.

## Layer Discriminators

**Decision:** the frontend taxonomy is based on responsibility, not size.

**Components** are atomic UI pieces that are useless on their own without
wiring. `Button`, `Input`, `Modal`, `Tooltip`, `Popover`, and `DatePicker` are
components. They have local interaction state at most. They never know about
records, clients, routes, tenants, workflows, or data fetching.

**Compositions** are generic structural assemblies that are sensible on their
own. They vary render structure from typed props/specs, work with any conformant
data shape, and do not embed substrate or domain constraints. `DataTable`,
`DataSurface`, `Sidebar`, `FilterBuilder`, `ActivityFeed`, `BarChart`,
`KpiStrip`, `StepRail`, `SchemaForm`, `RecordBrowser`, `RecordHistory`,
`SchemaTree`, `DraftList`, and `AdminLayout` are compositions. A composition
receives data through props or a validated spec; it does not fetch from the
substrate. Interactive compositions may own reusable UI interaction state
(focused cell, open popover, TanStack table state), but not substrate workflow
state (kernel reads/writes, idempotency, pending apply, tenant scope).

**Modules** are coupled to one job to be done. They own a stateful workflow or
an embedded constraint such as preview/commit/idempotency, draft review,
schema-aware editing, hierarchy, join resolution, or integration sync. Modules
are usually usable from both human-driven and agent-assisted interfaces: the
module owns the workflow mechanics, while the host chooses whether a human,
agent, connector, or deterministic routine proposes the next state. Real
modules include `DraftReview`, `RecordEditor`, `EditableRowVersionGrid`,
`OrgChart`, `Reconciliation`, `IntegrationSync`, and `SourceImport`.

The portable CSV product is `packages/csv-workspace`. Its browser installation
owns artifact intake, the agent conversation, one transient typed draft,
capture of current grid edits before feedback or Save, exact pending-Save
recovery, and canonical activity/diff history. Its server installation owns CSV
parsing, bounded agent tools, domain-policy identity resolution, optional
isolated pure-JavaScript preparation, canonical dry-run, and assembly of one
human mainline `ApplyChangeSet`. The agent can propose and refine the same draft
the human edits, but cannot Save.

There is no CSV plan DSL, accepted-plan compiler, durable unfinished session,
resume protocol, or alias-confirmation workflow. Refresh discards draft and
conversation state. Only an exact pending Save survives, retaining its
idempotency key, serialized payload, authenticated context, frozen date,
reviewed schema revision, and filename; the UI blocks other work until that
same request is resolved. Saved import history is a view over ordinary
`source_kind = "human"`, `source_ref = "csv:<filename>"` activity and canonical
change-set diffs, not a new store.

Hosts supply authentication/origin enforcement, active schema, the frozen
tenant/app/actor/date context, domain instructions, ordered identity policies
from `packages/domain-libs/`, model selection, canonical dry-run validation, and canonical
kernel transport. Models without identity policy remain searchable reference
context rather than writable targets. HC and Vendor provide concrete adapters;
their kernel authorization and app write guards remain authoritative.

`packages/modules/source-import` retains only reusable source-intake and
grid-preview presentation leaves and owns no workflow or Save authority. The
deleted `packages/agents/csv`, `packages/csv-import-host`, and
`packages/engines/csv-derivation` packages are not current boundaries. Identity
matching is `resolveImportIdentity`; there is no upstream identity-graph
classifier. See `import-principles.md` for the detailed contract and
current resource limits.

Optional app integration presentation lives in `packages/modules/integrations`.
`IntegrationsSurface` receives safe authorized summaries and explicit action
references; it never receives tenant credentials or chooses authority. An
app-bound Server Component reads through the app DAL and renders this same
surface both embedded and on the optional standard page. Text, provider subset
and order, section visibility, and placement are the supported customization
surface. Filters only narrow presentation. Use existing semantic tokens and
desktop-window resizing, with small client islands and lazy external setup UI.
Shared server mechanics live in `packages/integration-runtime` and central
authority in `packages/integration-control-plane`; app-owned recipe instances
continue to own provider semantics and target bindings.

`packages/integrations` is the reusable wrapper boundary for external
integration libraries. It owns Ampersand React/prebuilt UI adapters,
external-library styles, and generic Ampersand token request types.
The package's Ampersand runtime entries share one side-effect module that imports
Ampersand's published stylesheet. Its UI adapter supplies an external wrapper;
while that wrapper is mounted, the package declares a light `color-scheme` on
the document root where Ampersand defines its `light-dark()` theme values. This
lets CSS compilers resolve those values without overriding Ampersand tokens,
generated class names, or internal component DOM. Any future custom theme must
load after that stylesheet and use only Ampersand's documented `--amp-*`
properties, never generated class names or internal component DOM.
It must not import apps, app-generated clients, kernel-client, kernel DTOs, or
contracts that expose `ApplyChangeSet`; it must not own app manifests,
Platform API clients, manifest/config schema helpers, provider capability
catalogs, provider-to-app normalization, webhook ingestion, or QuickBooks
helpers.

Apps import the package and provide customer scope, actor id, route mounts,
app-specific schema authority, app-owned manifest/config choices, and app copy
or policy. Apps also own integration recipes that encode app/provider field
meaning, matching policy, and source-reference policy. App-owned integration
ingress verifies webhooks, parses Ampersand envelopes, validates authority,
normalizes through those recipes, and then either compiles ordinary
`ApplyChangeSet` input directly or calls the reusable
`packages/integration-compiler` crate with already-verified recipe input.

An app with a provider catalog derives provider keys, launch state, UI copy,
and setup route descriptors from that single app-owned artifact. A
`registered` provider may render an unavailable descriptor, but only an
`active` provider may start customer setup in that environment. Page shells
must not recreate provider arrays or literal setup-route tables. Catalog launch
state is public setup policy only; private signed ingress remains independently
authorized at the app integration boundary.

Active integration cards load `GET /api/integrations/:key/install` and
`GET /api/integrations/:key/health`, render every authenticated installation
returned by the install resource, and use `POST /api/integrations/:key/install`
for both initial and refreshed Ampersand sessions. Page code must not expose
Ampersand, install-config, or token route vocabulary.

For server-rendered integration routes, the vendor-owned server entry issues
the catalog-environment, activity, install, and health requests concurrently
with tenant authentication and `no-store` semantics. The app validates and
renders the settled provider cards, installed accounts, health, and activity as
RSC output. Small app-owned client islands handle search/view state, retry via
`router.refresh()`, and Add/Manage dialogs. Successful bootstrap requests are
not repeated during hydration; install/update completion closes the dialog and
refreshes the RSC route. Ampersand provider components and hooks load only
after a selected setup dialog opens.

`packages/integration-compiler`, when present, is reusable compiler substrate, not
kernel and not app code. It may know generic kernel write contracts and generic
recipe/delivery shapes. It must not know provider SDKs, Svix/webhook
verification, Platform API clients, QuickBooks or vendor semantics, app crates,
local integration tables, or source identity encoded as model `external_key`.
Rust app code may provide route glue, schema materialization, app policy checks,
and the kernel apply bridge, but provider ingress and app/provider policy stay
at the app boundary. Core kernel apply stays provider-agnostic: it validates and
persists the already-compiled write envelope. Do not create local integration
tables for Ampersand V0; Ampersand owns installation, config, mapping, selected
fields, health, logs, and provider operation state. The
`packages/integrations` and `packages/integration-compiler` boundary is active and
scanner-enforced as documented in
[Ampersand Integrations](integrations/ampersand.md#boundary).

High-confidence local integration import shapes within this boundary are also
checked by the scoped ast-grep lane documented in
[Ampersand Integrations](integrations/ampersand.md#boundary). The central scanner
continues to own graph-aware and semantic checks. The narrower provider-adapter
import rule is authoritative for the provider-to-persistence edge: adapters can
import only local transport modules and Node built-ins, while persistence
accepts only the branded app-normalized apply type. Existing broad table-name
tripwires remain active for compiler/package invariants, but provider ownership
does not rely on those spellings.

A page can contain zero, one, or many modules. A page should not become a module
by default, and a module that owns more than one job should be split.

**Engines** are substrate-aware, app-domain-agnostic transforms. They are pure
logic: no React, no UI imports, no fetching, no kernel-client, no module imports.
TypeScript engines may provide browser-side advisory transforms such as
schema-to-form-spec, import classification, value adaptation, or formatting.
The active kernel path remains authoritative for persisted invariants. During
the rewrite, each operation moves from the existing Rust/PostgreSQL path to
generated SQL only after parity and caller cutover. When an advisory concern
also exists in TypeScript, generate both surfaces from the manifest and add
parity tests around the overlapping contract.

**Domain libs** are app-domain accelerants. They package a coherent declarative
shape: models, fields, seed vocabulary, and reusable structural metadata so a
new app can start from a known schema. Ordered import identity and
reconciliation policy are app-owned because matching authority depends on the
app's selected fields, provider contracts, and ambiguity handling. An app may
author that policy beside its CUE schema and generate a validated artifact; a
domain library must not create a second policy authority.
They may contain domain nouns (`position`, `employee`, `requisition`) but may
not contain imperative matching mechanics, relation policy, runtime workflow state,
fetching, rendering, page-shell metadata, kernel invariants, app-specific
authorization, or app-specific normalization thresholds. Apps import, copy, or
fork domain libs; the app remains the schema and workflow-policy owner after
adoption. Within
`packages/domain-libs/`, entity domains may import `_shared` only. App-owned schema
catalogs may assemble domain-lib blocks in deterministic order; that fan-in
composition must live in `apps/`, not in a domain-lib package. Shared packages
never import `packages/domain-libs/`.

**App-owned shell** owns error state and orchestration, not the error wire
contract. It may render global banners, route-level errors, and logging sinks.
Apps may opt into `packages/kernel-client/` for fetch transport and wire-error
normalization, or supply their own transport. Modules may place workflow-local
errors inline, but they consume `ErrorEnvelope` as data from `contracts/` and
receive shell behavior through props/callbacks. Compositions only render errors
passed through props/specs.

**How to tell:**

| Question                                                                             | If YES      | If NO       |
| ------------------------------------------------------------------------------------ | ----------- | ----------- |
| Does it own a stateful workflow with steps?                                          | Module      | Composition |
| Does it have embedded domain constraints such as hierarchy, join key, or draft mode? | Module      | Composition |
| Does it work with any conformant data shape?                                         | Composition | Module      |
| Does it fetch from a substrate endpoint directly?                                    | Module      | Composition |

This rule prevents the AG2 trap where every page-sized surface accreted into a
module and the module catalog stopped being meaningfully reusable. Use modules
for jobs and compositions for reusable structure.

## Composition Spec Contract

**Decision:** compositions are props-first for runtime use and spec-driven when
they need to cross a persistence, sharing, agent, or non-app boundary. Skip the
spec only when no consumer would save/share/generate the surface.

Any composition meant to be saved, shared, generated, or rendered by a non-app
caller exposes a typed serializable spec:

```ts
compositionRegistry.render({
  type: "data_table",
  config: { columns, source, actions },
});
```

The same spec can come from:

- app code (constructed directly)
- saved user view/config (loaded from storage, validated)
- agent-generated answer (validated harder, size-capped, permission-checked)
- module output (typechecked, usually trusted)
- Storybook fixture (documentation)

Same renderer, different trust levels at validation. There is no separate
"agent rendering" pipeline or "saved view" pipeline; the composition spec is
the unified contract for those cross-boundary uses.

### Chart Composition

**Decision:** AG Charts Enterprise is hosted only by the internal charting
runtime under `packages/design-systems/core/compositions/`. Apps and other
packages render the exported prop-first chart components or the validated
`chart` composition and never import `ag-charts-*` directly. The structural
boundary rule includes positive and negative fixtures.

The supported families are `breakdown`, `stacked_timeline` (bar, area, or
line), `waterfall`, `scatter` (including bubbles), `range_marker`, `donut`,
`combined_bar_line`, and `heatmap`.
Trusted callers may supply formatter functions, React empty states, typed
segment callbacks, and control-change handlers. Saved, shared, agent, and
Storybook callers use a smaller serializable config containing normalized
numeric data, stable opaque ids, semantic palette choices, bounded format
descriptors, bounded semantic controls, and an optional opaque segment action
id. Control roles are `group_by`, `filter`, `as_of`, `granularity`, `measure`,
`comparison`, or `custom`; choice controls render as selects or segmented
controls, while `as_of` uses the design system's `AsOfDatePill`. The host
application resolves control values and action ids into queries, navigation,
filters, or other behavior; the composition never gains that authority. The
serialized contract rejects raw AG Charts options,
functions, HTML, arbitrary CSS/colors, queries, model/field authority, and
drilldown or mutation behavior.

The composition never fetches or interprets app records. Apps read through
their generated clients and deterministically adapt visible typed results into
chart input. Missing timeline values remain null in the contract and textual
summary; stacked-area canvas shapes taper to their local baseline around a
missing point rather than restarting with a vertical block. Currency values
retain their explicit currency and are never combined without app-owned
conversion policy. Combined charts carry independent format
descriptors for their bar and line measures. Heatmap cells carry stable row and
column keys separately from display labels, and duplicate coordinates fail
validation. Donut values are finite and non-negative. Every chart renders a
textual data summary so the canvas is not the only representation of its
meaning.

Date controls require real calendar dates with coherent minimum, selected, and
maximum ordering. Waterfall callers supply the closing total explicitly, and
validation requires it to equal the opening value plus every change using a
scale-aware floating-point comparison. This keeps agent output inspectable
without allowing the visual connector, bars, and textual summary to disagree.

The host lazy-loads AG Charts and Enterprise, resolves the active design
system's chart colors, secondary typography, grid color, font family, caption
size, and extra-small radius into canvas options, and requires explicit license
bootstrap. Bar, range-bar, waterfall, and donut series use that shared radius;
callers and serialized agent configs do not carry chart-library styling.
Waterfall charts also show cumulative connector lines. Missing-license mode is limited to callers that
deliberately enable non-production proof behavior.

Some compositions have both a runtime props API and, later, a serializable spec
adapter. `DataSurface` is the precedent: V0 uses a props-first interactive
composition wrapped by an `EditableRowVersionGrid` module; saved-view
persistence is deferred until a real consumer earns the serializable table-view
spec. Do not block reusable interactive compositions merely because their
runtime props include React nodes, callbacks, or editor components.

### Record Detail Panel Composition

**Decision:** `RecordDetailPanel` is the canonical domain-neutral assembly for
inspecting a single record as grouped label/value pairs, editable controls,
notes, and compact tables. It lives in
`packages/design-systems/core/compositions/`; it does not fetch a record,
interpret an app schema, choose field policy, or persist a mutation.

The composition is placement-independent. Apps may render it in a page column
or split pane, or host it inside the floating `Sheet` when a deep-dive work
surface should sit over an interactive page. The panel must not recreate the
Sheet manager, close guard, portal, or overlay semantics.

Responsiveness follows the panel's own inline size rather than the page
viewport. Label/value rows stack when the containing panel is narrow and use
the tokenized two-column layout when the panel has enough room. Text wraps
within its item, while compact tables stay bounded by a local horizontal scroll
region instead of widening the panel or its host.

The panel uses one canonical flat-section treatment with divided, full-width
sections. Surface variants are intentionally absent from the serializable
contract so apps and agents produce the same predictable hierarchy.
An optional validated tab list supplies opaque IDs and labels plus the active
tab. Trusted hosts receive tab IDs through `onTabChange` and remain responsible
for changing the active tab and its record data; display-only agent specs can
describe the selected view without acquiring executable behavior.

Collapsible sections use the shared design-system `Disclosure` primitive so
caret glyph, tokenized size and color, motion, focus behavior, and native
`details` semantics remain consistent across compositions. In this composition,
the caret is down for open sections and up for closed sections. Sections expose
only their heading and content: group subtitles and visual table titles are not
part of the props or serializable spec. Tables retain an accessible `ariaLabel`.

Trusted app and module callers use the controlled props API. They own loaded
values, validation errors, relation options, draft state, authorization, and
save/apply behavior; the panel emits field values and opaque action IDs through
callbacks. Trusted callers may supply render functions for app-owned value or
editor presentation without moving domain rules into the design system.
Read-only hosts may also make field labels selectable through an opaque field-ID
callback; the host chooses the navigation or evidence surface without teaching
the panel any app or domain semantics.
Optional header callbacks expose the AG2-derived entity-detail hierarchy:
status and Edit sit beside the title, with Close as the rightmost control. The
host still owns mode transitions, unsaved-change policy, and whether the panel
can be dismissed; these callbacks are not part of the serializable spec.
Trusted editable hosts may also provide original values and a field-revert
callback. The panel owns the consistent dirty highlight, previous-value label,
and Revert affordance, while the host remains responsible for changing its
draft. Select fields use the shared design-system select control and caret;
compositions must not reproduce native browser caret spacing locally. Optional
selects expose the configured empty label as a clear-to-null choice, while a
required select retains that label as a disabled placeholder. Number editors
preserve intermediate text locally and emit only finite numbers or an explicit
empty value, so partially typed input does not masquerade as a cleared field.

Saved, shared, and agent callers use the validated serializable `record_detail`
composition spec. Storybook documents both that boundary-safe adapter and the
trusted props API. The serializable vocabulary is deliberately smaller: fields,
neutral notes, and the existing `data_table` shape. It does not admit React
nodes, functions, arbitrary CSS, or unknown block/control types. Agent specs are
display-only at the registry boundary; they cannot define executable mutation
callbacks. A future agent-assisted mutation action needs a separate
permission-aware app/module resolver rather than widening the spec into an
execution API.

Positive ownership proof: a conformant caller can pass any neutral record
shape, render the composition directly or inside `Sheet`, and receive typed
field/action callbacks. Negative proof: design-system boundary checks forbid
app, module, kernel-client, and domain-lib imports; validation tests reject
unknown blocks and non-serializable field values. Storybook uses neutral fixture
vocabulary, while employee, position, vendor, and other domain examples remain
in app-local stories.

## Editable Row-Version Grid Module

**Decision:** the editable row-version grid is hosted on AG Grid Enterprise
inside the `packages/modules/editable-grid/` library module. Apps mount the
grid via `<EditableRowVersionGrid>` from `@modules/editable-grid` and never
import `ag-grid-*` directly.

The library owns:

- AG Grid mount (`AgGridReact`, Quartz theme, sidebar / cell-selection /
  getRowId-by-record_id), Enterprise license + module bootstrap via
  `bootstrapAgGrid({licenseKey})` (called once at React root mount time). External
  `@arrusted/ui` consumers pass an explicit `analytics="basic" | "advanced"` prop
  to `<EditableRowVersionGrid>` (neither tier is defaulted or silently downgraded):
  `analytics="basic"` uses `bootstrapBasicGrid()` from `@arrusted/ui` (or
  `@arrusted/ui/grid-basic`) over MIT `ag-grid-community` only, while
  `analytics="advanced"` uses `bootstrapAdvancedGrid()` from
  `@arrusted/ui/grid-advanced` with optional peer `ag-grid-enterprise` (allowing
  unkeyed local trial development and failing closed in production without
  `NEXT_PUBLIC_AG_GRID_LICENSE_KEY`).
- Edit-buffer state and dirty mechanics: `useEditBuffer` over the
  `packages/engines/edit-buffer/` engine; `useApplyChangeSet` for
  idempotency-key reuse + single-flight + error normalization;
  `useRecordReads` for asOf-driven reads with stale-response guards.
- The FieldValue ↔ AG Grid primitive bridge and generic schema-column
  construction: the module inspects generated `Field.type` to choose the
  safe editor/value-bridge pair (`text`, `number`, `bool`, `date`,
  `datetime`, `money_rate`, `relation`, `text_list`). `datetime` is edited,
  pasted and shown in UTC and committed in the kernel's RFC 3339 `…Z` form
  (fractional seconds kept as stored); `text_list` is edited as chips and
  pastes split on commas and line breaks, dropping repeats. Both editors
  commit full FieldValues, and an emptied value is a clear. Unsupported field
  types (`json`, `known_aliases`) still render but are non-editable until the
  module gets an explicit editor mapping.
- Structural no-op detection at commit time via the
  `packages/engines/field-value-adapter/` engine's `fieldValueEqual` —
  AG Grid fires a commit on every editor close; the no-op gate prevents
  empty-typing from registering a dirty entry.
- Apply-success cleanup uses the edit-buffer engine's `revertMatching`
  primitive: clear only entries whose live `{value, source, meta}` still
  matches the submitted snapshot, so mid-flight user edits survive a successful
  apply.
- **In-cell diff rendering**: `diff-cell-renderer.tsx` exposes a cell renderer
  factory via `ctx.diffCellRenderer({ formatValue })`. Dirty cells render the
  new value plus a muted `was X` micro-text below; the diff is read straight
  from the buffer's `priorValuesRef`.
- **Per-row meta strip**: `row-meta-row.tsx` is an AG Grid full-width row
  renderer injected beneath any row with stages. Carries inline-editable
  Type and Effective-date pickers (`EffectiveDatePickerPill`,
  `ChangeTypePickerPill`) that body-portal escape AG Grid's
  `.ag-body-viewport` clipping. CSS in `row-meta-row.css`.
- **Bulk-group state**: per-stage `EditMeta.bulkGroupId` + `changeTypeId`
  carry the user's bulk-action membership through the buffer.
  `controller.setBulkFilter(id)` filters the grid;
  `setBulkGroupEffectiveDate(id, iso)` applies a date change to every entry
  in a bulk group via the engine's `EditBuffer.updateMeta` primitive.
- **Per-stage change_type inference**: when an entry lands without an
  explicit `changeTypeId`, the hook calls the app-supplied
  `inferChangeType(touchedFieldIds) → ChangeTypeId`. The hook never picks
  a change_type itself; the app provides the rule.
- **Save-time partitioning**: `controller.save()` partitions buffer entries
  by effective change_type (per-stage `changeTypeId` → inference → page
  fallback) and submits one `ApplyChangeSet` per partition serially. Pending
  rows retain their last-touched source for review chrome. A reviewed workflow
  may provide an explicit `saveSource`; when present, it owns the persisted
  source/source_ref during partitioning without mutating pending row state. Each
  apply gets a fresh `idempotency_key`. After each successful apply,
  `revertMatching` clears that partition's snapshot from the buffer; failed
  partitions stay dirty + retain their idempotency key for retry. Returns
  `SaveOutcome` with per-change_set status (`saved` / `failed`) so the page
  can render "Saved 4 changes" or "Saved 3, 1 failed (Position update: ...)"
  copy.
- **Reviewed mutation lifecycle**: any workflow that edits row-version data
  after human review should reuse the grid/edit-buffer/apply lifecycle or a
  public adapter over it. Imports and agent-assisted edits must not reimplement
  save/apply orchestration or introduce a parallel write path.
- The dirty-glyph rendering (`.ag-cell-dirty` CSS, applied via
  `ctx.dirtyCellClassRules`) and invalid-cell / editor-mount CSS
  (`invalid-cell.css`, `cell-editor-mount.css`), plus the local AG Grid theme
  definitions (`theme.ts`).

The reviewed mutation lifecycle's local call boundary is enforced by the
`apply-through-editable-grid-*` ast-grep rules. TypeScript and JavaScript under
`apps`, `packages/domain-libs`, and `packages` may call other API routes; direct `fetch`,
`postJson`, or client `postJson` calls to `/api/apply` are forbidden outside
`packages/modules/editable-grid`. Positive and negative fixtures run through
`mise run test:ast-grep`, and the repository scan runs through
`mise run check:ast-grep`; both are part of static validation.

The app owns:

- Schema-column policy through `fieldOverrides`: which fields are hidden or
  ordered, per-field validators, formatters, sizing, editability by mode, and
  relation lookup options / label Maps. There is no callback escape hatch for
  hand-rolled column declarations in the module API; synthetic columns require
  a named extension point before they can be introduced.
- View-asOf state and reload triggers.
- User-facing copy (page title, "New X" button label, banner copy).
- The KernelClient instance.
- App-narrowed wire types from the app's generated-client export (e.g. `@autograph/hc/generated-client`).
- **`inferChangeType(touchedFieldIds)` callback** — the rule that maps a
  set of touched field ids to a change_type id. The HC app uses
  most-specific-superset matching against `schema.change_types` (smallest
  `touches` superset wins; ties fall back to the generic catch-all);
  another app could pick a different rule.
- **`changeTypeOptions: ReadonlyArray<{id, label}>`** — the list of
  change_types the row-meta-strip's Type dropdown shows. Apps filter
  `schema.change_types` by `target_model` + their own policy.
- **Bulk-group label store** — an in-memory `Map<bulkGroupId, name>` on
  the page (no kernel API for it yet — the bulk name lands in
  `change_set.notes` only at save time). `controller.stageBulkUpdate`
  mints the `bulkGroupId`; the page maps it to the user-facing batch name.
- **Save-outcome toast subscription** — the page wires a `useEffect` on
  `controller.lastSaveOutcome` and fires `toast.success` / `toast.warning`
  / `toast.error` via AG2's `useToast()` hook with copy resolved from the
  page's change_type labels. (We landed AG2's `Toast` + `useToast()` in
  commit `7ef5ce2` and retired the inline `SaveOutcomeBanner`.) The
  library doesn't know change_type labels — the page resolves them — and
  the library doesn't render any UI for save outcomes; it surfaces the
  per-change_set result shape and the page chooses the presentation.

**Layer rules** (CI-enforced by focused static validation):

- `ag-grid-*` imports allowed ONLY inside
  `packages/modules/editable-grid/`. Apps mount via
  `<EditableRowVersionGrid>` and call `bootstrapAgGrid()` at the root.
  The same module owns `CurrencyRateEditor`, a controlled community grid for
  currency periods that uses the shared theme and caller-owned persistence.
- The module imports types from `@contracts` only — never `@autograph/hc/generated-client`
  or any app-narrowed client (the existing modules-cannot-import-apps
  rule covers this).
- Engines (including `field-value-adapter`) cannot import React. Pure
  functions in engines, hook wrappers in modules.

**Tests:**

- Pure-function probes in `packages/engines/field-value-adapter/__tests__` cover
  `fieldValueEqual` (variant-by-variant + null/empty distinction +
  cross-type rejection) and `makeFieldValue`/`fieldValuePrimitive` round-
  trip per FieldValue variant — guards the no-op-detection bug class.
- `packages/modules/editable-grid/__tests__/hooks.test.tsx` mounts a
  harness with `useEditBuffer` + `useApplyChangeSet` against a fake
  `KernelClient` and asserts the boring path: edit dirties → save posts
  the right ApplyChangeSet shape (app/customer/source_kind/mode/
  idempotency_key/writes) → success clears + frees idempotency_key →
  failure preserves dirty + reuses idempotency_key.
- AG Grid render integration is covered by the live spike Playwright
  capture in `.config/mise/scripts/repository/spike-hr-screenshots.ts` (kept under that name as
  a sibling of the frontend dev server during the spike phase).

## Draft-Review Module

**Decision:** the two-tab Drafts / Published review surface over
`change_sets` lives in `packages/modules/draft-review/`. Apps mount it via
`<DraftReviewSurface controller={useDraftReview(...)} ... />`. The module
owns load orchestration, card grouping, action handlers, filter bar, and
card layout; apps own the schema, lookup callbacks, primary-cell render,
and HC-specific copy.

The library owns:

- **Hook contract**: `useDraftReview({ client, scope, schema, primaryModel,
defaultChangeTypeId })` returns a `DraftReviewController` carrying:
  - tab state (`tab`, `setTab`) for Drafts vs Published;
  - parallel loaders for both tabs (`drafts`, `published`), each exposing
    `{ data, loading, error, reload() }`;
  - card lists (`cards`) derived from the active tab's `change_sets` via
    `helpers/cards.ts` (named-bulk grouping when `notes` is set, type-group
    aggregation otherwise);
  - tab counts (`draftsCount`, `publishedCount`);
  - change_type filter state (`typeFilter`, `setTypeFilter`,
    `primaryChangeTypes`);
  - action handlers (`onDiscard`, `onPublish`, `onRevert`) that POST the
    matching kernel endpoint and refetch BOTH tabs in parallel before the
    success toast fires (so the segmented-control counts and the list both
    refresh before the user sees confirmation).
- **Surface component**: `<DraftReviewSurface controller renderPrimaryCell
relationLabel ...>` renders the toolbar (FilterBar + optional
  `toolbarTrailing` slot) + the card grid, dispatching CardView per card
  with the library's default `<DiffCell>` (or an app-provided `renderDiffCell`
  override).
- **Slots**: `renderPrimaryCell(row)` for the leftmost identity cell (app
  paints avatar + title + subline), `renderDiffCell(field, diff)` for
  per-cell display overrides, `emptyStateDrafts` / `emptyStatePublished` for
  empty-state copy, `toolbarTrailing` for app-specific toolbar widgets (e.g.
  HC's `<AsOfDatePill>`), `filterBarTrailing` for extra filter dropdowns.
- **Action confirmation chrome**: per-row + card-header destructive
  affordances route through `@autograph/components/ConfirmButton` (two-click arm
  with 5 s auto-revert and `aria-live="polite"` label swap).

The app owns:

- The `KernelClient`, scope (`appId`, `customerId`), and schema (typed via
  the app's generated client; the module accepts `Schema` structurally).
- `primaryModel` (the model name whose records anchor each card row) and
  `defaultChangeTypeId` (the catch-all change_type for the type-filter
  "All" option).
- `relationLabel: (fieldId, key: RecordKey) => string | null` — the module is
  model-agnostic, so apps thread their own key-aware lookup in for each
  relation field (record ids and external keys are distinct keys).
- `renderPrimaryCell(row)`: the avatar + title block per primary model.
- `emptyState*` copy + any extra cross-tab refetch the app needs (HC's
  ApprovalsPage wraps the controller handlers to also reload positions
  after each action).

**Layer rules:**

- Module imports from `@contracts` + `@autograph/components` + `@modules/editable-grid`'s
  `useRecordReads` only. No app-generated clients or app-narrowed types.
- Action handlers POST to `/api/draft/discard`, `/api/draft/approve`,
  `/api/revert` via the injected `KernelClient`. The module never reads
  app-specific endpoints.
- `helpers/cards.ts` is pure (no React, no fetch); card grouping logic is
  exercised in `packages/modules/draft-review/__tests__/cards.test.ts`.

## Kernel-Client Module

**Decision:** cross-app substrate hooks that aren't grid-specific live in
`packages/kernel-client/`. Pages read their schema with
`useActiveSchema<TSchema>(client)`, which fetches the tenant's active effective
schema from `/api/schema/active` (app base plus tenant overlay, so tenant
custom fields and enum additions appear) and exposes `{ schema, error }`. It
refetches after `invalidateSchema(client)`, which schema administration calls
after a revision. The compiled base schema alone (`/api/schema`) never shows
tenant changes, so pages do not read it; when the active read fails a page
shows an ordinary error. The module exists so app pages share one schema
loader.

The module is intentionally thin: any cross-cutting substrate hook that
multiple modules need lands here. Apps consume via
`import { useActiveSchema } from "@kernel-client"`.

**Layer rules:** the scanner classifies `packages/kernel-client/` as the
`kernel-client` layer (sibling of `modules/`, not nested inside it). The
only app-domain import allowed is `@contracts`; React is a vendor
dependency the scanner doesn't classify, so hook wrappers like
`useActiveSchema` are permitted alongside the fetch-factory + envelope helpers.

## Overlay Primitives: Sheet, Modal, Inline

**Decision:** record-edit and other substrate mutate flows pick from a fixed,
small set of overlay primitives. The choice is by job, not by component
preference.

**Principle.** Modals are reserved for genuinely modal jobs — confirmations,
exports, viewer dialogs — where the user must answer the prompt before the page
can continue. Record CRUD is not a modal job: an editor that blocks the page
behind a focus trap stops the user from cross-referencing other rows, the
schema panel, or the activity feed. Editors are work surfaces, not interrupts.

**Primitive choice.**

- **Inline cell editing** (DataSurface composition; substrate plumbing in the
  `EditableRowVersionGrid` module). The default for casual record-edit cases:
  edit a cell in place, commit, move on. PR 53 introduces this surface.
- **Floating Sheet** (`packages/design-systems/core/components/sheet/`). The
  deep-dive surface for record-edit cases that need a multi-field form with
  validation, draft/apply controls, and helper copy. Right-anchored panel with
  a viewport gap on top/right/bottom — explicitly not a full-height edge-flush
  drawer; the page behind stays visible and interactive. A tiny manager
  (`SheetProvider` + `useSheet()`) holds exactly one open sheet at a time and
  threads a per-open `onBeforeClose: () => boolean | Promise<boolean>` so
  hosts can run dirty-discard guards. `openSheet` awaits the prior payload's
  `onBeforeClose("replaced")` before swapping content; replacing a dirty editor
  goes through the same prompt as closing it.
- **Modal** (`packages/design-systems/core/components/modal/`). Reserved for
  confirms (discard prompt over a Sheet, irreversible deletes), exports
  (download dialogs), and viewers (read-only artifact previews). Stacks above
  the Sheet via a body portal so a confirm prompted from inside a Sheet renders
  on top.

**Rationale.**

- Editors that block the page accumulate complaints fast: users want to scroll
  to a sibling row mid-edit, the schema panel sometimes belongs alongside the
  form, and substrate validation errors often need the user to consult other
  surfaces before retrying. The Sheet gives the editor its own canvas without
  hiding the rest of the app.
- Confirms and viewers do need to be modal: the user is being asked to make a
  yes/no decision or to view an artifact, and ambient page interaction would
  only invite mistakes.
- Inline is the fastest path for one-cell tweaks — the most common record-edit
  shape. Reserving the Sheet for cases that genuinely need the form keeps both
  primitives sharp.

**What the Sheet primitive does NOT do, and why.**

- **No focus trap.** Tab freely escapes the sheet to the page underneath. This
  matches the page-stays-interactive premise; trapping focus would lie about
  the relationship between sheet and page.
- **No `aria-modal`.** Setting it without the matching focus-trap behavior
  would mislead assistive tech. The Sheet is `role="dialog"` only.
- **Backdrop is opt-in and visual-only.** When a Sheet uses `backdrop`, the
  dim layer is a visual cue that the sheet is the focal task; clicking the dim
  closes the sheet, but it is not a focus barrier. Default is no backdrop.
- **Modal semantics stay in `Modal`.** True-modal cases (confirm a destructive
  action, complete an export) keep their focus trap, `aria-modal="true"`, and
  blocking backdrop in the Modal component. Use the right primitive; do not
  bolt focus-trap onto Sheet to "make it more modal."

## App Shell IA

**Decision:** the app shell is one topnav surface. On desktop it fits in a single 52px row; on narrow viewports the same topnav wraps controls onto additional rows instead of clipping or overflowing. Page-scoped controls live inside the page surface's own header, not in a separate shell-level control bar. Section-scoped utility (approvals queue, agent chat pullout) lives in the topnav right cluster as togglers for right-side pullout panes that persist across page switches within a section.

Scope determines placement, deterministically:

- **Page-scoped** controls (search-within-page, metrics summary, view toggle, +New, Export, save indicator) → right side of the page surface's own header. Travel with the page; differ across pages.
- **Section-scoped** utility (approvals, agent chat, section-level notifications) → topnav right cluster, as togglers for right-side pullout panes. Persist across page switches inside the section; pullout state is section-local.
- **Section-scoped read state** (the `asOf` reference date) → topnav right cluster, BEFORE the pullout togglers. Pages and pullouts read the same value through React context (`useAsOf()` over `<AsOfProvider>`); changing the date in the topnav rolls every surface in the section to the new date in one move. The org and scenario chips ("scope chips") that the IA contemplates stay deferred — Org is a single-tenant shortcut until multi-org lands, and the Scenarios mini-app hasn't shipped yet — but `asOf` is shipped and section-scoped today. Import data is the exception: matching as-of is an import write date (today by default). Users can set it on Imported file after the file lands. Preview & save shows it as a read-only write fact. The write date is persisted on the session and restored before snapshot/compile; Preview Save is blocked while that date is in flight. The empty drop zone does not show it. The topnav as-of pill is omitted on that route so the import date is not confused with the section view date.
- **Platform-scoped** utility (workspace settings, global ⌘K search, account menu) → topnav far-right. Rare interaction.

The topnav holds: wordmark · section switcher (collapsed pill with dropdown, even when only one section exists) · page tabs · right cluster (asOf pill · pullout togglers). Page tabs use the `PageTabs` component — the ported AG2 `AppModeTabs` leaf visual primitive (see Mode system in "What We Did Not Port" for what stayed behind).

Pullout panes sit alongside the page surface in the body grid; they push the surface narrower rather than overlaying it. Toggling a pullout does not navigate.

Why one topnav surface + per-page headers:

- A second shell-level control bar accumulates (search · view · save · +new · export · …) into a junk drawer over time; per-page headers stay naturally scoped.
- Each page can carry radically different controls (a canvas page, a table page, an agent dashboard) without the shell predicting all of them.
- Cost: controls don't sit at fixed screen positions across pages. Acceptable at HC's scale; revisit if and when telemetry shows control-search costs exceeding scope-discovery costs.

Stop-and-redesign signal: a page's controls duplicate across multiple pages in the same section. That's pressure to promote shared controls back into the shell as a row 2 — but only with that evidence, not preemptively.

Shared settings, data-source, and import pages live under the app-level shell,
outside mini-app route trees. Mini-apps may link to those pages, but they do
not own them. The app composes library primitives into those shared pages based
on its needs.

## Wiring

**Decision:** wiring responsibility is layer-specific.

- **Components, compositions, engines** — no substrate wiring. Components and
  compositions use props/specs/callbacks; engines use pure functions.
- **Modules** — own substrate workflow plumbing for exactly one job.
  Preview/commit, idempotency keys, draft/mainline apply, error envelope
  translation, tenant context propagation. Apps configure via
  props/specs/render-props; apps do NOT re-implement substrate lifecycle for
  each module instance.
- **App sections/pages** — compose modules + compositions; page-local state stays in the page. Pages coordinate route context, refresh, tenant scope, and presentation. They do not reimplement generic module lifecycles such as preview/commit/apply/discard/idempotency.
- **Apps** — own auth wiring, tenant context, route trees, global shell. Wire modules into pages by passing config and renderers.

Implementation note: the private Shell adapter is one independent Next App Router zone. It
owns only its root and auth UI. Applications keep their entire framework root,
document, route tree, data wiring, and style ownership inside their own
directories; the gateway selects the route owner before React is involved.

The shell may compose the public `@autograph/auth/ui` surface, but it must not
import Better Auth UI component internals. Shell-owned presentation copies the
needed utility classes instead of sharing auth presentation primitives. The Bun
graph-resolution boundary lane enforces the allowed public-barrel edge and
rejects both package-subpath and relative imports into `packages/auth/components`.
The shell application selector uses the public microfrontend-aware `Link`.
That component preserves Next's native `next/link` behavior for same-zone
targets, renders a document-navigation anchor for cross-zone targets, and
enables the official cross-zone prefetch support at the root layout. Handwritten
router hooks and app-specific navigation branches remain violations for this
server-rendered dispatch surface.

The modules-own-lifecycle rule is the single most important wiring decision. It prevents the "auth-wiring-rebuilt-everywhere" disease — substrate calls that are repetitive and bug-prone live in one place per workflow.

If a page starts owning preview/commit/apply/discard/idempotency for a reusable
workflow, stop and either reuse the existing module lifecycle or move that
lifecycle into a module before continuing.

## Folder Structure

The tree below shows what currently exists. Shipped modules today:
`editable-grid` (AG Grid surface + edit buffer + apply orchestration),
`draft-review` (two-tab Drafts/Published review surface over change_sets),
and `kernel-client` (cross-app substrate hooks like `useActiveSchema`, sibling of
`modules/` because it serves both modules and pages). The four earlier
modules (`schema-browser`, `record-editor`, `draft-inbox`, `activity-feed`)
were deleted in the AG Grid pivot once their sole consumer
(`apps/dev/frontend`) was removed; reintroduce only when a real second
consumer needs them.

```
packages/
  app-runtime/                ← generic client-side tenant/runtime context provider
  contracts/                  ← shared TS data/client contracts; no runtime state
  design-systems/
    core/
      tokens/
      components/
      compositions/
      stories/                ← Storybook stories for everything in design-system
  compositions/               ← Optional cross-design-system compositions, when needed
  engines/
    csv-parser/
    edit-buffer/                ← pure immutable buffer for cell edits
    field-value-adapter/        ← FieldValue ↔ host primitive bridges
    import-classification/
    stable-hash/
  schemas/
    headcount/
  modules/
    editable-grid/              ← AG Grid host + edit-buffer + apply orchestration
      bootstrap.ts              ← bootstrapAgGrid({licenseKey})
      theme.ts                  ← AG Grid theme variants
      hooks/                    ← useEditBuffer, useApplyChangeSet, useRecordReads
      dirty-glyph.css
      invalid-cell.css
      cell-editor-mount.css
    draft-review/               ← two-tab Drafts/Published review surface over change_sets
      index.tsx                 ← useDraftReview hook + DraftReviewSurface component
      components/               ← CardView, DiffCell, FilterBar, EmptyState
      helpers/                  ← card grouping, column normalization, format helpers
    org-chart/                  ← read-only hierarchy canvas, RelationGraph neighbourhood + generic chrome; apps supply data adapters
    # Future modules (introduce when a real consumer needs them — the
    # earlier record-editor / activity-feed / draft-inbox / schema-browser
    # modules existed for the now-deleted apps/dev/frontend exemplar and
    # were removed alongside it):
    # reconciliation-workbench/
    # integration-sync/
  kernel-client/                ← cross-app substrate hooks
    index.ts                    ← useActiveSchema<TSchema>(client) — tenant active schema
apps/
  gateway/                      ← provider-neutral route and identity gateway
  shell/                        ← independent Next zone for root and auth routes only
  vendor/                       ← standalone Next zone at /vendor, including RSC routes
  hc/                           ← standalone Vite headcount zone at /hc
    shell/                      ← AppShell, TenantContext, error-state helpers, route guards, nav host
    pages/
      PositionsPage.tsx
    sections/                   ← landed when product needs multi-section nav
    zone.ts                     ← app-owned exceptional agent/API routing; no shell entry
```

Multiple design systems are supported by adding sibling folders under `design-systems/` (e.g., `design-systems/v2/`). Apps choose which design system to import.

Package tests are co-located under each owner (`packages/**/__tests__` and
`packages/domain-libs/*/__tests__`) so test imports obey the same layer direction as the
runtime code they protect. Runtime code must not import test files; the boundary
scanner enforces both relative test-file imports and workspace package subpaths.
Direct import-source rules represented in `.config/konsistent.json` are not
duplicated in the scanner; dynamic and resolved-relative forms remain scanner
owned.
If a future test genuinely needs to exercise multiple unrelated layers, place it
in a dedicated top-tier `tests/` sink and add scanner fixtures for that sink in
the same PR.

## Principles

These are the operational rules. Most are CI-enforceable; treat them as constraints, not aspirations.

1. **Domain agnosticism** — `design-systems/`, `engines/`, and `modules/` never reference specific app IDs, model names, or domain concepts. CI grep enforces. Modeled on AG2's `pnpm check:runtime-scanners`.
2. **One-way dependency** — UI flows `tokens -> components -> compositions -> stories`; pure logic lives in `engines`; shared wire/client types live in `contracts`; optional fetch transport lives in `kernel-client`; domain libraries sit above reusable generic packages and below apps. Modules and apps may consume the lower tracks according to their responsibility. Skip-down allowed; skip-up banned. Tests are co-located with the owner they protect and must import only the owner layer plus lower layers; runtime code must not import test files. Engines never import UI, modules, kernel-client, or apps. Modules may import type-only client/error contracts from `contracts`; all `kernel-client` imports remain banned. Stories are examples only, not reusable runtime helpers. CI enforces.
3. **Modules own workflow state** — substrate plumbing lives in modules, never in apps or compositions.
4. **Style visual identity via tokens** — no raw colors, shadows, radii, spacing, typography, sizing, or z-index values in design-system runtime code. Reference semantic tokens; semantic tokens reference value tokens; themes can map differently. The CI scanner blocks raw Tailwind visual utilities in components and compositions so each design system can be remapped without rewriting component code.
5. **Slots over flags** — extensibility via slots and render props, not boolean behavior flags. Variants (`primary/secondary`) and sizes (`xs/sm/md/lg`) are configuration, not behavior branching, and are fine.
6. **Spec at cross-boundaries for compositions** — typed serializable spec for every composition that a consumer saves, shares, generates, or renders outside app-owned code. Runtime-only app/module usage can stay props-first until a cross-boundary consumer exists.
7. **Job-shaped modules, not page-shaped** — a module owns workflow/state/invariants; a page composes them.
8. **Reference, don't abstract for sections/pages** — when two sections need similar UX, fork; promote to a module only when the workflow shape is identical. Premature abstraction at the page level is worse than duplication.
9. **Module-shape discipline for app-owned UI** — when something starts in `apps/<app>/sections/<section>/`, write it in module shape (props in, callbacks out, no global state, no app-specific imports) so promotion to `modules/` is "move file + update imports" rather than "rewrite."
10. **Ask on ambiguous extraction** — if it is unclear whether code belongs in a module, engine, app-domain helper, or flow-local component, ask whether another near-term consumer will reuse it and whether the behavior is generic lifecycle mechanics or app-domain policy.

## Stop And Redesign If

These signals mean the layer boundary is failing. Do not patch around them.

- A runtime JSON manifest becomes necessary for core app behavior. Code-built
  apps are the model; typed app config is acceptable, runtime app execution is
  not.
- Shared packages branch on a concrete `app_id`, `customer_id`, model id, field
  id, or domain noun. Move the behavior into the app or make the shared API
  genuinely generic.
- A module imports from `apps/` or depends on an app route tree. Modules can be
  configured by apps, but they cannot depend on apps.
- A composition saves, shares, or agent-renders state outside its typed spec.
  Saved views, agent-rendered blocks, and app-authored configs that cross the
  runtime boundary must hit the same validator.
- A composition fetches from a substrate endpoint, imports a client type,
  or requires tenant context. It is becoming a module; treat it as one.
- A module owns more than one job to be done. Split it into smaller modules or
  move generic structure into compositions.
- A TypeScript engine produces persisted values that can contradict kernel
  validation or row-version state. Move the invariant into an authoritative
  manifest constraint that compiles to PostgreSQL, or make the engine output
  explicitly advisory.
- App schema declarations move outside `src/lib.rs`, `schema.{rs,ts,tsx}`, or a
  `schema/` / `schemas/` path. The boundary scanner derives domain words from
  those locations so shared packages cannot accidentally absorb app vocabulary.

## What We Did Not Port From AG2

These were AG2 architectural moves that did not earn their keep. They are listed here to prevent re-introduction.

**Mode system as a route/state/manifest abstraction.** AG2 modes were reusable pages that accreted route, state, manifest, and extension baggage. The reusability that "mode" was supposed to deliver is actually delivered by importable modules. Apps own routes; pages own their own state. There is no "mode" abstraction in Autograph. The visual leaf — AG2's `AppModeTabs` underline-tab primitive — IS ported to `packages/design-systems/core/components/PageTabs.tsx`. Only the surrounding mode-as-route-state-manifest machinery is rejected.

**Runtime app manifests.** AG2 apps were defined as data (manifests in DB) and executed by a generic runtime, with extensions and slots as escape hatches. Code-built Autograph apps don't need a manifest schema; the app's source code IS the manifest. A typed `defineApp({ schema, routes, nav, modules })` config is fine; a JSON manifest is not.

**First-class extension layer.** AG2's extension system existed because runtime-manifest apps needed escape hatches. Code-built apps use slots, render props, custom columns/renderers, app services, policies, and adapters — all normal code, no manifest extension runtime.

**Hardcoded app/model branching in platform code.** AG2 enforced this with `pnpm check:runtime-scanners`. Autograph should adopt the same pattern: any `if (appId === "...")` or `if (modelRef === "...")` in `design-systems/`, `engines/`, or `modules/` is a CI-blocking violation.

The Autograph UI pattern that DID work and we are keeping: composable layered packages with internal-vs-published boundaries, Storybook-as-component-validation, and CSS-vars design tokens via Tailwind v4 `@theme`.

## Terminology Note

`principles.md` currently uses "mini-app" in the substrate Layer Boundaries section to describe a UI surface that shares an `app_id` but is conceptually its own product area. The frontend architecture uses **section** for the same concept (matching common product nomenclature like Ramp's Cards / Analytics / Vendors). The substrate has no opinion on section boundaries; sections are app-owned route/nav organization, enforced by app-side authorization, not by RLS.
