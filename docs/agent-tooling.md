# Agent tooling

Repository operations are exposed through named Mise tasks. Use
`mise run <task>` for developer and CI-facing operations; non-trivial
implementation belongs under `.config/mise/scripts/repository/`.

## Deployment boundary

- Provider-owned Vercel domains and deployments are deployment authority.
- The pinned MIT `@vercel/microfrontends` library is used directly.
- The custom authenticated Gateway owns deployed composition.
- The paid Vercel Microfrontends product, project groups, native shared-domain
  routing, and product fallback are prohibited.
- In-project Service bindings supply reachability only and have no Production fallback.
- The supported sequence is `Git push → one native Vercel Services deployment
→ provider-owned atomic activation/rollback → Gateway routing → read-only CD proof`.
- Repository CD is read-only Vercel coordination/proof plus the separately
  scoped Ampersand manifest lane. It never runs Vercel deployment, promotion,
  alias, or rollback commands. It must not use
  pull-request association, commits, merge state, ancestry, containment,
  freshness, or other Git selection to choose provider deployment state.
- `REPOSITORY_RELEASE_ENABLED` is template-instance safety, not Vercel release
  authority. It is enabled only for an active repository instance; fresh
  generated repositories remain disabled. The workflow compares the injected
  `vars` value case-sensitively in Bash; the separately authorized activation
  transaction must prove the repository-level source and reject a shared
  organization substitute because the workflow token cannot call the Variables
  API. Ampersand may retain source ordering only for its own mutation, with
  superseded candidates succeeding as no-ops.
- `mise run check:deployment-policy` checks the direct-library, Gateway-only,
  and neutral-to-private boundaries.

## Workflow and validation

Use the pinned `actionlint` through Mise for tracked workflows. Preserve
app-scoped secrets, protected environments, immutable provider receipts, and
the provider's current deployment ownership. Repository tests and policy checks
are evidence about source contracts; they do not activate, roll back, or clean
up provider resources.

Draft PRs keep the existing `Check` job name and skip validation, including
the aggregate. `ready_for_review` starts validation on the same head, and
`converted_to_draft` skips it again. Both transitions retain the existing
per-PR concurrency group. Ready runs retain `always()` and the aggregate's
selected-check failure handling.

GitHub accepts a skipped required `Check` as satisfying that status rule.
Draft state prevents draft merges, but after marking ready the earlier skip
on the same commit may remain accepted while the new run is scheduled or
its dependencies execute. Wait for the new ready `Check` to finish before
merging. Required checks are commit-scoped, so an earlier real passing result
can also remain valid. This workflow does not enforce fresh validation after
every draft toggle. Required-check and permission settings are unchanged.

Ready PR `Check` requires selected lint, types, and directly changed app
jobs and fails closed when selection fails. Format and React Doctor findings are
advisory. The existing lint command includes selected generic React Doctor
rules as warnings for Next and Vite apps; ordinary lint errors remain required.
The full React Doctor scan runs separately on main, with no separate PR scan or
automatic React Doctor PR summary or inline comments. Shared-only changes do not
select app jobs on a PR. Main CI runs affected static checks and selects affected consumers, platform fixtures,
Rust, kernel and PostgreSQL parity coverage after merge, including applicable
credential, tenant isolation, approval, installation and recovery tests.
Unknown inputs and unavailable comparisons retain full main validation.
Selection reasons appear in the run summary.
Bun lock changes select every JavaScript workspace and platform fixture proof;
Cargo-only suites remain selected by Cargo, core, or uncertain inputs.
Application matrices discover every workspace app, including newly generated
identities; shared workflow code contains no app-name allowlist. Rust suites
are selected independently from web phases using affected Cargo applications
and their actual Rust/schema/runtime inputs. Each selected Rust app owns its
`test-rust` Mise task. Application-owned CI metadata declares schema-base and
compiler requirements instead of embedding app names in shared actions.

For source-only diffs, app test tasks select Vitest files whose transitive Vite
imports intersect changed sources, including workspace aliases and setup files.
The generated task forwards native test filters and shard arguments. Tests with
filesystem, dynamic, unknown external or otherwise uncertain inputs remain
selected. Config/schema/data changes, coverage qualification and unavailable
comparisons run the original complete app suite. Selected test failures retain
the normal failing exit status. `APP_TEST_INPUTS` is included in Turbo's task
hash, so narrowed results cannot satisfy later full qualification. Default local
validation runs complete app suites; main pushes use dependency-aware selection
and manual CI qualification runs complete suites.
Dependency analysis caches direct inputs once per Vitest project and invocation,
and stops inspecting a test once uncertain inputs require retaining it. Resolvers
and transforms are never cached across projects. Runner logs separate initialization,
discovery, selection, execution and shutdown timing so a lower file count is not
mistaken for lower command time. Generated app test entrypoints use the same runner.
Full fallback also selects kernel application/workspace tests and both SQL
parity lanes, even when an uncertain path misses their normal filters.
The standard PostgreSQL parity lane frees unused preinstalled SDKs on its
ephemeral runner to leave room for Cargo artifacts and database WAL. It reports
filesystem and Cargo target usage even when the parity command fails; a disk
failure does not skip or relax any parity tests.
The Rust workspace test lane follows Cargo consumers and literal Rust include
inputs. Unknown comparisons, dynamic includes and unclassified inputs fall back
to the complete non-app workspace; app-owned Rust tasks remain separate.

The workspace type lane checks affected projects and consumers; app check
jobs own their primary TypeScript project, while auxiliary service projects
remain explicit workspace checks. TypeScript's resolved source lists retain
consumers of source aliases outside their own include/files entries.
Projects that directly include a changed repository tooling file are checked
even when that file belongs to no workspace package.
The type lane batches source-list discovery through the pinned compiler in a
bounded worker; uncertain responses and worker failure fall back to the
compiler's per-project source-list command. Selection retains resolved alias
consumers and fails if the fallback cannot resolve a project.
PR app checks do not build the application. Affected main CI runs the app build
after its checks; the default local `app:check` still includes the build.
Source-only app edits verify the checked
release's CUE source hash and artifact integrity instead of rebuilding the
schema compiler in every app job. Changed schema/release, compiler, runtime,
composition or global inputs retain schema compilation. The local/default
app lifecycle still compiles unless CI selects the explicit verify mode. Apps
without a CUE backend or Cargo workspace do not install compiler tools merely
because composition changed. HC's
check job retains history and an exact base fetch for its schema version guard;
other app jobs use shallow checkouts. Renames select both the old and new owners.
Compiler-consuming app phases restore the existing workspace Rust cache.
Each selected app runs its tests in one CI job. HC's legacy schema artifact also reuses the
verified compiled release in source-only CI, keeping the existing compiler path
for changed schema/compiler inputs and default local builds.
PR and main CI app jobs display the application and check or test phase; the
required `Check` and `CI` statuses still aggregate all selected jobs.
Check names express categories in GitHub's flat job list: `Quality`, `App`,
`Platform`, `Test`, `Database`, `Tooling`, and `Build`. App phases appear as
`App (<app> / Check)`, `App (<app> / Test)`, and `App (<app> / Rust)`; platform
fixtures appear as `Platform (Fixtures / <group>)`. Static matrix category
names keep skipped jobs readable. Naming does not change advisory behavior:
`Quality (React)` and formatting remain advisory.
The PR `Quality` job runs selected lint, types, and format concurrently with
separate log groups; format results cannot fail the job but can extend its duration.
Main CI retains parallel `Quality (Lint)`, `Quality (Types)`, and `Quality (Format)` jobs. `Changes` and
the aggregate status names remain unchanged.
Database checks are `Database (Parity)` and `Database (Scale parity)`; kernel
validation is `Test (Kernel)`. Workflow validation, developer setup, and
template readiness use the `Tooling` category. Repository static validation
is `Quality (Repository checks)` and the platform package suite is
`Platform (Package tests)`.
Repository policy checkers with dedicated static gates do not fan out into app
lifecycles. Workflow and selector validation runs on affected main changes;
explicit dispatch runs full qualification.
The main PR workflow lane installs the pinned workspace dependencies before
running compiler-backed selection fixtures; it does not restore a dependency
cache for that lane.
Formatting runs as an independent advisory report. Main CI retains the full
React Doctor scan as an independent advisory report. PR jobs restore dependency/tool
caches; main owns cache publication. Bun caches use exact dependency/toolchain
keys without older-store fallback, so an
unrelated repository task edit does not invalidate them. Remote Turbo cache requests have bounded
5-second operation and 10-second upload timeouts so an unavailable cache does
not dominate validation. Quality lanes install their own tool requirements.
Main CI installs the tools consumed by its selected static checks; configuration
and uncertain inputs retain the full tool set.
An app may declare `autograph.ci.testNeedsPostgres: false` after its full test
task is verified without a database. Omitted capabilities and full validation
retain PostgreSQL. Primary TypeScript projects already owned by selected app
checks skip repository discovery; auxiliary projects still resolve imports.
Konsistent checks changed source paths; changes to its configuration or
structural inputs run the full repository convention suite and its fixtures.
Branding analysis runs with advisory formatting; design-system changes retain
their runtime semantic-token checks in the main CI static lane.

For timing qualification, dispatch `Check` on a reviewed ref with
`validation_base` set to its exact base commit. This executes the same selected
jobs and final gate. Omitting that input retains runner qualification mode.
The base input is available only on manual runs; PR selection always uses the
PR event base. Report measurements as qualification evidence, including change
scope, setup/cache time and runner minutes, rather than as production proof.

`Mirror (CI images)` is a weekly and manual maintenance workflow outside the
`Check`/`CI`/`CD` topology. It copies `postgres:17` into this repository's
GHCR namespace so CI service containers do not depend on anonymous public
registry quotas. It needs only `packages: write` and changes no code or
provider deployment state.

CI Postgres service containers use the `CI_POSTGRES_IMAGE` repository variable
(set here to the public mirror `ghcr.io/withautograph/postgres:17`) and fall
back to `public.ecr.aws/docker/library/postgres:17` when it is unset, as in
fresh generated repositories.

## External ownership

EXT-GW-03 exclusively owns external cleanup of obsolete aliases, variables,
credentials, alerts, hooks, environments, resources, and integrations. The
repository may retain only a sanitized no-consumer inventory and must not mutate
those external objects.

HC and Vendor Rust suites have independent main CI selection and completion results.
Own Rust/schema/generated inputs and app test tooling select the owning app;
affected shared dependencies select their consumers. Kernel/compiler changes,
unknown inputs and unavailable comparisons retain both suites. Product-only
TypeScript changes retain app web tests without starting Rust suites.

Platform fixture jobs install Chromium only when the Gateway browser proof is
selected; installer, organization and runtime-only proofs do not consume it.

The browser/CSP proof follows Gateway/transport, Auth, and composition inputs;
generated-runtime changes alone retain installer/runtime proofs without selecting
that unrelated browser proof through a package-consumer edge.
