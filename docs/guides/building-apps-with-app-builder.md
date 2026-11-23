# Building an app with App Builder

Use this guide for the App Builder product flow and repository-owned commands
that create and maintain a generated application. The Builder owns the product
brief, design and prototype, and requests approval before it edits the private
app workspace. The repository owns app identity, scaffolding, schema release,
and validation. Provider setup, deployment, activation, and Production
readiness remain separate operations. The
[implementation contract](../contracts.md#generated-application-implementation-contract)
defines authority and evidence boundaries.

## Read the selected repository before implementation

This guide is the entry point for Builder agents as well as maintainers. Read it
from the selected checkout, then read the selected app's `README.md` and
`AGENTS.md`. The checkout's current contracts and installed framework docs take
precedence over remembered template details. For a CUE-backed app, also read
[Generated Data Operations](../generated-data-operations.md) and the
[generated-app compiler integration](../schema-compiler.md#generated-app-integration).
Use the links below for exact API and operator details; this guide describes
the complete sequence without making a second implementation contract.

For an existing app, inspect its current routes, package scripts, schema, tests,
and data/auth foundation before planning changes. Preserve its identity and
working behavior. Do not run creation again to iterate on an existing workspace.
For a new app, decide which accepted outcomes require persisted data and which
are static presentation. CUE selects a compiled backend; a Markdown brief does
not. Neither source inspection nor selecting a backend authorizes provider
resources or database mutations.

## Source and setup

Select a new Arrusted app or the existing app and repository in Builder. The
Builder owns checkout acquisition, sandbox toolchain setup, and dependency
installation; do not prepare a second checkout on its behalf. Source
inspection and preflight are diagnostics, not proof of a working application.
For a maintainer checkout, follow [developer onboarding](developer-onboarding.md)
for the pinned mise tools and run `mise exec -- bun install --frozen-lockfile`
from the repository root. Dependency installation does not provision app data.

## Build one app

The Builder invokes the repository command below only after the user approves
**Build this app?**. It derives
the application identity, workspace, routes, package, and catalog registration
from the ID and optional convention inputs. The creation transaction writes
`apps/<app-id>/` and registers it in `microfrontends.json`. It rejects an
identity collision, changed input, or invalid projected catalog before
publishing source and topology:

```sh
mise run create:app [app-id]
```

If the ID is omitted, the command generates an `app-<UUID>` ID and includes it
in its receipt. Maintainers supply the conventional optional inputs in the checkout:
`.config/app-specs/<app-id>.md` is copied as an AppSpec snapshot, while
`.config/app-specs/<app-id>.cue` selects the CUE-backed path. With neither
input, the command creates a static app. Do not replace it with
`turbo gen`, hand-authored topology, or a guessed generator command.

The Builder reads identity through
`mise run repository:exec -- app-identity.ts --app <app-id>`. Its returned
fields are required by the current Arrusted integration. The repository
owns the project name; extra producer metadata does not change the contract.
The Builder preserves app identity and safe app-owned paths during execution.
`mise run repository:preflight` is a maintainer diagnostic and is not a
creation prerequisite or Builder gate.

### Creation inputs and outputs

| Input or output                          | Meaning and owner                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Optional app ID                          | Lowercase kebab-case application identity; omission returns an `app-<UUID>` ID in the receipt |
| `.config/app-specs/<id>.md`              | Optional opaque product brief; copied unchanged to `apps/<id>/.config/app-spec.md`            |
| `.config/app-specs/<id>.cue`             | Optional backend authoring input; copied to app-owned `schema/<id>.cue`                       |
| `apps/<id>/`                             | Native Next app with package/configuration, routes, tests, and local mise tasks               |
| `microfrontends.json`                    | Catalog registration derived from identity and the current catalog                            |
| `schema/release/` and `schema/index.ts`  | Compiler-owned checked backend artifacts and stable import pointer, only for CUE-backed apps  |
| Creation receipt and transaction journal | Source publication and interruption recovery, never provider or CI evidence                   |

The command derives the default `/<id>` and `/<id>/:path*` public routes and
asset route. An additional route is a separate reviewed catalog change. The
Markdown snapshot cannot configure routes, capabilities, authentication, or a
backend. After creation, edit the app-owned CUE; the original convention input
is not a second schema authority. Do not supply a resolved creation plan,
topology digest, owner, starter, or lifecycle metadata as a public API input.
The transaction's internal plans and digests support interruption recovery.
An interrupted creation recovers or rolls back before proceeding; an ordinary
repeat against an existing identity is a collision, not an update operation.

## Maintain the generated workspace

Every generated application is a Next.js App Router workspace with its own
package, tests, browser smoke test, and application-local Mise tasks. The root
repository owns compilation and validation.

The root package catalog supplies the versions for the standard app toolset.
Generated app manifests retain native `catalog:` references and private
platform dependencies remain workspace links. The root Bun lockfile resolves
these references for the repository workspace. App-specific packages belong in
the app manifest with a lockfile update. Packages already in the root catalog use
`catalog:`; a new shared catalog entry needs its own reviewed version pin.
The generator profiles define the standard base and optional backend toolsets,
not an allowlist of application features. Change a profile only when changing
that standard toolset. Follow repository dependency validation and the Builder
tool contracts when submitting manifest changes. See
[tooling ownership](../tooling-script-ownership.md).

### Framework versions and existing-app upgrades

New App Builder applications resolve current stable Next.js, React/React DOM,
and React type versions during planning. Store the concrete compatible targets
in the accepted plan and reuse them across retries; never commit `latest` or
canary ranges. Ordinary existing-app edits preserve their framework versions.
An explicit upgrade request includes dependency and app-code migration in the
same reviewed Builder change set, preserving app identity and behavior.

The repository owns central catalog and lockfile updates. Builder invokes:

```sh
mise run repository:upgrade-framework -- --next 16.4.3 --react 19.3.1 --react-dom 19.3.1 --types-react 19.3.0 --types-react-dom 19.3.0 --app <app-id>
```

This operation applies the compatible concrete versions already resolved by
Builder; it does not independently select or re-resolve package peers. Invoke
it in the isolated build checkout with one mutating continuation. Different
builds use separate checkouts, so the operation does not coordinate concurrent
writers to the same dependency files.

These are example concrete targets, not a promise that these versions remain
latest. The operation updates `package.json`'s five framework catalog pins and
asks Bun to generate `bun.lock`. It changes no app source, schema, configuration,
or identity. `--app` identifies the requesting app for the result; the dependency
impact is workspace-wide because the catalog is shared. The JSON result reports
`framework`, `versions` (`next`, `react`, `reactDom`, `typesReact`, `typesReactDom`),
`scope: "workspace"`, `changedFiles`, and optional `appId`. Package-manager output
goes to stderr. A failed install restores both original dependency files and
returns a failed command. Repeating the same targets regenerates any missing
lock resolution and reports only files whose bytes changed.

Builder owns version discovery, supported command invocation, installation,
app-specific migrations, and behavioral validation through its existing
plan/apply/review workflow. Shared dependency files appear separately in the
review. Do not bypass the app edit boundary with generic root-file writes or
rerun `create:app` on an existing app. Use version-matched Next adoption guidance
for Cache Components, Partial Prefetching, and accessible transitions. Keep
Server Components, server-only DAL reads, and Server Actions; preserve product
data and auth behavior. Updating the framework does not require a schema receipt,
version gate, new CI lane, or provider mutation.

### Package, configuration, and task ownership

The generated `next.config.ts` calls `nextAppConfig()` from
`@autograph/next-config`. It reads the package name and supplies that child
identity to the official `@vercel/microfrontends` integration. Keep package name
and catalog `packageName` consistent; do not replace them with a Builder-derived
Vercel project name. Shared configuration supplies native Next defaults and
workspace source aliases. The Next TypeScript preset includes app and test files;
`@/*` resolves relative to the app and `@/schema` resolves its generated pointer.
Do not copy old per-app compiler file lists or invent a new client alias layer.
If deliberately overriding TypeScript `paths`, remember that TypeScript replaces
the inherited map rather than merging it; see the
[configuration ownership contract](../contracts.md#typescript-configuration-ownership).

Declare every directly imported package in the owning manifest. Runtime imports
need runtime dependencies or peers, rather than only development dependencies.
`server-only` is a framework virtual import. Package `check` validates without
emitting; `test` runs once; `build` emits the framework/package output. Generated
apps use direct native Next builds and app-local tasks for checks, tests, and
browser tests. Their check task validates lint and types; formatting is separate,
and `lint` applies supported fixes. Do not infer a formatting pass from `check`.

App operations live in `apps/<id>/.config/mise/tasks/` and are invoked with
`mise //apps/<id>:<task>`. Root tasks dispatch repository-owned operations.
App-specific code and scripts stay in their app, with no root app aliases.
Read the app's actual declared scripts instead of copying a sibling's task
inventory. The [tooling ownership contract](../tooling-script-ownership.md)
and repository layout check enforce these boundaries.

### Local data and development

For local runtime data, use the repository dispatcher only when the application
defines the corresponding task: `mise run app:local <app-id> <operation>`, where
`<operation>` is `setup`, `seed`, or `reset`. This is separate from the Builder's
private preview and applies only to sandbox/local data. Ordinary
development starts from the app directory with its documented package command
(for example, `bun run dev`); use the app README for app-specific requirements.

For ordinary maintainer validation, check the app:

```sh
mise run app:check <app-id>
```

Run the app tests, optionally selecting a test shard for local work:

```sh
mise run app:test <app-id> [shard]
```

Both commands run `app:compile` first. It writes the checked schema release for
a CUE-backed app and is a no-op for a static app. `app:check` then runs the
application's checks and build. `app:test` runs the full test command unless a
shard is supplied. Run `app:compile`
directly only to refresh a checked schema release. Do not add Cargo wrappers or
app-local compiler commands.

### Compile, repair, and validate

A backend release is a checked set of immutable artifacts, not generated code
that features may edit. `app:check` and `app:test` verify the app descriptor and
compile before their app lifecycle commands. The matching release is selected
by the current CUE source map and verified checksums, never directory order.
Compilation refreshes `schema/index.ts`; the pointer is mutable outside the
immutable bundle. Check source and artifacts into the same reviewed change.
When editing an issued schema, change the app-owned CUE `version` according to
its evolution contract, then run `mise run app:compile <app-id>` to generate
the new checked release. `app:check` and `app:test` compile current inputs
before exercising behavior; they do not require historical generated bytes to
match the current compiler first. Their compilation can refresh generated files
in the calling checkout. CI uses a disposable checkout and does not publish
those files or replace an approved hosted release. Keep previously issued
release bytes immutable in reviewed app changes, and preserve the selected
release hashes at installation. Script-only app edits do not invalidate an
otherwise matching frozen release.
Do not manually refresh hashes or copy an older bundle to hide drift.

On failure, use the reported app, compiler phase, exit status/signal, CUE origin,
and retry command to repair the owning input. Diagnostics cover toolchain,
artifact parsing, normalization, SQL generation/verification, and release steps;
SQL errors can map back to CUE origins. Keep stdout and stderr context, including
both ends of long output. Builder's bounded excerpt is not the whole log: read
the retained output through `get_validation_log` paging to obtain the diagnostic
context needed for a repair. Do not infer the cause from a truncated excerpt.
Retry the documented repository command; do not add app-owned Cargo wrappers,
edit generated SQL, or infer successful compilation from a partial artifact.
See [schema compilation](../schema-compiler.md) for authoring vocabulary,
transition rules, checksummed output, and PostgreSQL verification.

Run the actual declared app checks and relevant tests. CI runs one test job per
affected app. Run its browser task as well
when verifying interactions. The generated `test:e2e` task installs Playwright's
matching Chromium headless shell when needed and exercises a production build.
Verify accepted outcomes, denied access, safe selected reads, atomic mutations,
refresh, and reload behavior; report exactly what each test exercised.

### Draft pull request checks

Draft pull requests defer validation. Builder must report checks as deferred,
not passed or failed, until the PR is marked ready. The ready event and each
subsequent head run applicable quality and directly changed app checks. Inspect
the required `Check` for the exact current head; a missing, pending, cancelled
or failed result is not a pass. PR app checks omit app builds; affected main CI
runs the app builds, platform and specialized checks after merge and is separate
evidence from PR validation. Sandbox
validation and Vercel Preview readiness are separate evidence as well.

A static application has only the generated Next.js workspace. A CUE-backed
application additionally owns its declarative `schema/<app-id>.cue` input and
the compiler-maintained `schema/index.ts` pointer to the matching immutable
release. Feature code imports generated types from `@/schema` and obtains
safe DTO reads and mutation commands from the `app/data/` DAL.
Keep reads, authorization, and credentials server-side; application features
must not import `@autograph/generated-app-runtime/*`, hand-edit the schema
pointer, or select a release directory themselves.

## Implement a CUE-backed feature

CUE and the checked domain catalog own persisted schema vocabulary; Rust owns
build-time validation and artifact generation; PostgreSQL functions own runtime
execution. App features own product decisions, input subsets, presentation,
authentication context, provider integration, and workflow composition. Raw SQL,
an ORM schema, browser types, CSV compiler leftovers, or Markdown cannot become
a parallel persisted-schema authority. Start with the supported [CUE manifest and selection definitions](../schema-compiler.md#authoring-inputs).
Choose immutable model/field IDs, relations, constraints, and any authorization
policy from the documented vocabulary. Review schema evolution and retirement
rules before changing an issued model. The compiler's typed manifest accepts
only its documented vocabulary. Optional `connectors` and `agents` metadata do
not generate integrations, agent execution, or authorization policy.

The release includes `operation-manifest.json`, typed `data-operations.ts`,
server-guarded `data-server.ts`, and `data-operations.md`. Use that artifact's
reference for its actual models, fields, capabilities, constraints, and limits.
Features import generated types with `import type` from `@/schema` and call
feature-specific functions from the app's `app/data/` DAL. The scaffold
supplies the authenticated foundation only for a CUE-backed app. Static apps do
not acquire database/runtime dependencies merely to match another app.

Co-locate route reads, actions, interactive components, and tests. Share an
implementation under `features/<feature>/` when unrelated routes actually need
it. Server-only data modules perform authorized reads; dedicated `"use server"`
modules export intended browser mutations. Client leaves may import actions
and generated types, but cannot import data modules or credentials. Keep
request-dependent Server Component reads beneath Suspense as the app requires.
Repository guidance and exercised behavior govern this architecture; Builder
source-string guesses do not establish whether it works.

For forms, choose a feature-owned readonly tuple satisfying the generated
`<Model>CreateField` or `<Model>UpdateField` alias. Reuse it in `parseForm` and
`toFormError`; the parser accepts only those controls and does not authorize or
persist. Compose parsed values with trusted server-owned required fields.
Generated `FormActionResult<Field>` is optional convenience, not a required
product state machine. Expected generated errors may become safe form errors;
unexpected errors must propagate. Never classify `Error.message` or disclose
SQL, credentials, record values, constraint names, or internal diagnostics.

Use an explicit UUID or external-key discriminator when resolving a record.
Literal `select` tuples infer the requested presentation shape; dynamic field
lists require narrowing optional results. Selected records have no full-record
write provenance, and selection grants no permission. Compose generated writes
with explicit workflow dates, atomic batches, and idempotency keys. For supported
updates/deletes, `{ ifVersion: record.$version }` is an explicit concurrency
precondition; the runtime does not infer it from the target. Validate submitted
versions without treating them as authority. Revalidate routes only after
persistence succeeds. The
[generated operation reference](../generated-data-operations.md#application-interface)
documents the current typed API rather than a copied handwritten persistence layer.

Server Components call DAL reads and receive minimal DTOs. Server Actions
validate input, delegate mutations to the DAL, and revalidate after persistence
succeeds. Keep generated operations private to the DAL; no separate backend
directory or HTTP round trip is needed.

### Authentication and authorization setup

The generated foundation resolves `requireTenantScope` on each invocation,
requires `<APP>_DATABASE_URL` (uppercase ID with hyphens replaced by underscores),
checks the release, and binds authenticated app/customer/actor scope. Share the
connection pool only; do not share mutable request identity. Authentication does
not install database membership, provision data, or grant a business role.
Missing mappings fail closed. Never synthesize an actor or copy a demo principal.

When CUE declares authorization, its compiled policy owns model, operation,
field, row, relation, and history grants. The host authenticates the person;
administrator-installed database membership delegates the exact principal,
app, customer, and actor. A role string, hidden field, route parameter, selected
record, or UI visibility cannot widen a grant. Read projections and every write
are authorized, including replay. For an existing policy-absent release, features
still own resource-specific access checks; do not claim finer authorization
than that release supports. Test positive and denied cases with actual identities
and scoped data. Use the [authorization contract](../generated-data-operations.md#authorization-policy)
for precise supported policy combinations.

## Catalog and deployment boundary

Creation and catalog registration are source-only reviewed topology work. The
root catalog derives the application's Vercel Service, Gateway binding, frozen
install, and provider build handoff from its registered identity. The staged
creation transaction runs the same catalog graph policy as
`check:vercel-services` before it publishes source or topology.

Keep one direct application `build` command. Do not add an app-local
`vercel.json`, provider-specific build scripts, `cd`/`--cwd` bootstrap paths,
or provider environment branching. Passing repository validation does not
provision a database or provider resource, create credentials, deploy, activate
an application, or establish Production readiness. Those effects require their
own approved workflows and provider evidence.

## Preview, repair, and publication

Builder validates the isolated implementation and starts its private preview
using the selected app's actual development command. Exercise the accepted
workflow and verify durable writes through independent server readbacks; an
HTTP response or successful build alone is not behavioral evidence.

For an existing draft PR, Builder prepares an isolated candidate against the
current base. Its formatter may change only the selected app. Formatting or
source changes require fresh validation and review of both the complete final
diff and the delta from the previous PR head. Interrupted checks resume in the
same saved session. Publish the reviewed update only after explicit approval.

Spend Review now requires an authenticated session, active organization, app
role, and restricted database in every environment. Its previous synthetic
demo seeds and reset controls are retired. Follow the
[app README](../../apps/spend-review/README.md) for the current QA journey; do
not restore a demo path to make preview checks pass. Other apps own their
local-data and authentication requirements.

The [generated-app Production handoff](../operations/generated-app-production.md)
covers named actors and roles, checked releases, database preparation, access
grants, runtime configuration, and protected proof. Builder validation does
not perform these operator actions or establish Production readiness.

### Production handoff sequence

The current protected operator flow is documented in full in
[Generated app Production handoff](../operations/generated-app-production.md).
It is distinct from Builder's private local setup:

1. Name the organization, real actors, app roles, target database host, route,
   checked release, and digest. Run `app:production -- plan` separately for each
   actor/role and review the credential-free plan.
2. With protected operator credentials and the reviewed digest, prepare the
   dedicated database and restricted runtime login. Install the checked bundle
   without demo seed sets and bind the exact organization scope. A local reset
   is not a production migration or rollback.
3. Bind only the runtime database URL to the native Services environment, verify
   existing Auth configuration, and grant reviewed app assignments to existing
   organization members. Cluster credentials remain outside runtime. Prepare
   the controlled QA organization separately from the business pilot.
4. Exercise protected Preview with real identities and role/tenant denial cases.
   Native provider deployment and activation precede read-only Production proof.
   Verify the current Gateway route, page marker, authenticated scoped schema
   receipt, active deployment, and domain before opening pilot access.
5. Revoke assignments to stop access when required; retain business and audit
   data. Protected export and later retention decisions use the operator guide.

The restricted Spend Review pilot implements this sequence. Other apps must
supply their own declared roles, runtime requirements, and operator contract;
Builder must not hard-code Spend Review's identities or assume every app has
its handoff metadata. Read-only scoped release observability can diagnose an
installed release; it does not install, activate, or certify hosted readiness.

## Approval and delivery boundaries

Design acceptance and **Build this app?** approval are separate: design
acceptance confirms the product direction; build approval permits
implementation and validation only in the private Builder workspace. GitHub
changes, draft PRs, deployment, provider provisioning, and release each require
their own explicit approval and repository/provider evidence.

## Recent app-building changes covered by this guide

This coverage map follows the landed September 15–29, 2026 history. It points to
current contracts; historical tests or demo behavior are not instructions to
restore retired paths.

| Landed change                                                                                                                                                                                                     | Current guidance                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Typed form parsing, writable field vocabulary, safe operation errors, explicit version guards, authenticated data scaffold, and schema authorization (#1407, #1415, #1420 plus associated commits)                | Feature/data ownership, form and write composition, authenticated foundation, database grants; detailed API in Generated Data Operations |
| App Builder metadata moved into app configuration (#1404, #1413); direct creation, unnamed IDs, and simpler commands (`a28ad4cb`, #1447, #1448)                                                                   | One public creation command, optional Markdown/CUE, repository identity and internal-only recovery state                                 |
| App lint/format/types, generated docs, staged formatting and template validation (#1431, #1433–#1440)                                                                                                             | Native generated checks, separate formatting, typed tests, private validation versus CI evidence                                         |
| Native Services, neutral portable microfrontends, shared Next/Vercel configuration, catalog identity and child package names (#1444, #1449, #1454, #1456, #1461, #1464, #1467, #1471, #1473, #1475, #1476, #1478) | Repository-derived catalog/configuration and native build; provider-owned deployment/activation                                          |
| Shared TypeScript aliases/file patterns and standard manifests/dependencies/scripts/tasks (#1479, #1481, #1484, #1485, #1487)                                                                                     | Shared presets, app-local task ownership, catalog/workspace dependencies, capability-specific scripts                                    |
| Scoped release diagnostics, CUE-origin SQL diagnostics and repair across compiler phases (#1490, #1493, #1495 and associated commits)                                                                             | Compiler-owned checked artifacts, actionable origin/phase diagnostics and complete paged logs                                            |
| Generated command verification, PostgreSQL 17 SQL verification and script-only release freshness (#1498, #1502, #1497)                                                                                            | Repository app validation, declared shards and immutable release selection; no app Cargo wrappers                                        |
| Generated application implementation contract, artifact-derived typed helpers/API reference, runtime acceptance/scale proof (#1503, #1506 and associated commits)                                                 | Schema→compiler→PostgreSQL authority, artifact reference, inferred typed feature boundaries and separate evidence classes                |
| Local PostgreSQL failures/output detachment and CSV compiler containment (#1509–#1511)                                                                                                                            | Declared local setup with concrete process errors; no new CSV schema-authority path                                                      |
| Builder-created request/reviewer workflow (#1500), draft CI (#1513), authenticated-only Spend Review and guided Production (#1514)            | Preserve the successful Builder lifecycle; real role/tenant checks, no demo fallback, separate operator handoff and exact-head ready-PR CI  |

## Where to go next

Use the generated application's `README.md` for its local package commands and
`AGENTS.md` for server-first feature and generated-data rules. Read
[Generated Data Operations](../generated-data-operations.md) for the runtime
API and [Tooling Script Ownership](../tooling-script-ownership.md) for command
ownership. App Builder users should follow its `Build an Arrusted app` guide for
the product-facing workflow.
