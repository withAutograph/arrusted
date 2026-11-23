# Tooling Script Ownership

For the strip-down spike, the single starter and its app-owned mise tasks live under root `app/` and run as `mise //app:<task>`. This replaces the historical `apps/<app>` placement for this deployment; repository operations remain under `.config/mise/`.

`mise run` is the supported interface for developer and operator operations.
Package scripts, protected workflows, and mise tasks may invoke an internal
implementation directly when they bind arguments or credentials at the owning
boundary. Documentation should expose the mise task unless
`docs/agent-tooling.md` explicitly names a direct agent helper.

Package scripts expose the package-local commands consumed by Turbo and native
build providers. Use `dev`, `check`, `test`, `build`, and `start` where the package
actually supports them; do not add placeholder scripts. Generated Next apps also
expose `format`, `lint`, and `test:e2e`. Their app-owned mise tasks run the checks,
fix lint findings, and install Chromium on demand for browser tests. Keep scripts
ordered by development, checks and formatting, adjacent tests, then build and
start. Keep `prestart` immediately before `start`, and put specialized commands
after the common lifecycle groups. The manifest checker enforces this ordering
for active app and package manifests.

| Manifest kind                  | Standard scripts                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| App                            | `check`, `build`; `test` when the app owns tests; `dev` and a start command when the app runs locally |
| TypeScript source package      | `check`; `test` when it owns tests; `build` only when it emits artifacts                              |
| Config package                 | `check`; `test` when it owns tests                                                                    |
| Turbo generator workspace      | `check`, `test`                                                                                       |
| Standalone Storybook workspace | `dev`, `check`, `build`                                                                               |

Repository root scripts are scoped orchestration, and fixture manifests carry
only the metadata needed by their consumer tests. Storybook has its own Bun
lockfile and version pins because it installs outside the root workspace. Its
shared dependency pins must match the root catalog; the manifest check enforces
that relationship.

For packages, `check` validates without emitting artifacts, `test` runs the
package's suite once, and `build` produces the files consumed through exports or
deployment. A package with its own `tsconfig.json` declares `check`; no-emit
TypeScript validation belongs there rather than in `build`. App and package
`test` scripts must exit after one run. Packages with test files expose a
`test` script unless a repository task owns a database-dependent suite; those
packages declare `autograph.testTask` in their manifest, and the manifest check
verifies that task names their test directory. Pack hooks must not
repeat the same build in both `prepare` and `prepack`: keep `prepare` only when
the package also needs to build on install, otherwise use `prepack`.
Domain libraries share one Vite+ config, but each library's `test` script must
select only its own `__tests__` directory.
Scripts call installed executables or the owning app's mise tasks so their
contents do not depend on a particular package-script runner. Repository
operations remain root mise tasks. The package lists for new static and
CUE-backed apps live in `.config/turbo/generators/standard-app-dependencies.ts`;
change that profile to change the package set for future apps. The root
`package.json` catalog is the single external version source for workspace
manifests, including generated apps, through native `catalog:` references.
Existing apps are not resynchronized when the profile changes. Framework
upgrades use the repository-owned `mise run repository:upgrade-framework`
operation to update exact central pins and the Bun-generated lockfile. Its effect
is workspace-wide; Builder owns app-source migrations through its reviewed app
revision flow. The
`mise run check:package-manifests` validates active manifests, profile pins,
direct app and package imports, runtime package dependency sections, and the
generated app template. It also rejects duplicate workspace names, unresolved
`workspace:*` references, and package exports or bins without valid targets.
Generated `dist` exports need a build script and an existing source target;
the package's build or packed-consumer test verifies the produced artifact.
`mise run audit:package-dependencies` prints advisory candidates with no
package-local source or script reference. Review config loading, generated
source, CSS, and external consumers before removing any candidate; the audit
does not fail checks or edit manifests. The standard app profile retains
`babel-plugin-react-compiler` for Next's React Compiler and `oxlint-tsgolint`
for type-aware Oxlint; both are loaded by tools rather than imported by app
source. The Ultracite Oxlint preset also loads `eslint-plugin-github`,
`eslint-plugin-sonarjs`, and `oxlint-plugin-react-doctor` by name, so the app
profile declares all three for clean installs. Let the repository formatter
order manifest fields and list dependency
sections in the order
`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`,
and sort package names within each section.

Native repository tooling and the app check, test and runtime task launchers
select workspace `source` export conditions through scoped `BUN_OPTIONS`.
Nested Bun processes inherit that selection. Turbo retains these options in task
environments and includes them in task cache inputs. Packages declaring the condition
resolve to current workspace source without copying or requiring their `dist`
output. Existing caller options are retained; built and packed consumers keep
their own build contract.

`mise run generate:package` creates a workspace source package by default. Its
`check` and `test` scripts run against its source export; it has no build script
or build config. `mise run generate:package --built <package-path>` creates a package with a
`dist` JavaScript export, generated declarations, and a `build` script. The
built shape is suitable for a packed install after its own dependencies are
declared; the generator keeps both shapes private until publication is a
separate, explicit choice.
Pack built packages with `mise run package:pack -- <package-path> --destination
<directory>`. The repository packer stages the package's declared files and
expands `catalog:` references from the root catalog into concrete versions in
the tarball manifest. The source manifest keeps the catalog reference.
Package tests run with their owning package's test configuration; app test
configuration covers app tests.

The repository has two mise ownership scopes. Global repository tasks live under
`.config/mise/tasks/` and are restricted to repository-owned validation,
orchestration, shared tooling, and provider-neutral operations. App-specific
tasks live under `apps/<app>/.config/mise/tasks/` and are invoked through
`mise //apps/<app>:<task>`. A root app alias such as
`.config/mise/tasks/<app>/`, `[tasks."<app>:..."]`, or `mise run <app>:...` is
not allowed. Apps may add local mise tasks; they must not add app-specific
tasks to the global repository namespace.

`mise run check:tooling-layout` enforces this boundary. It discovers the app
slugs from `apps/*/package.json`, rejects matching app/provider task files or
aliases under the root namespace, and tests the rejection behavior.

Compiled application validation is repository-owned. New generated apps use
`mise run app:check` and `mise run app:test`; each depends on `app:compile` with
the same application argument before running its existing validation lifecycle.
A coordinator that has explicitly compiled the current validation input may run
these tasks with `mise run --skip-deps` to avoid repeating that dependency. This
is distinct from `--no-deps`, which skips automatic dependency providers, not task
dependencies. Prepared runtime execution carries the per-command
`APP_RUNTIME_ALREADY_COMPILED=1` marker only after its coordinator has compiled.
The runtime wrapper consumes that incoming marker only for repository check/test
commands and removes it from child environments. A value in the saved runtime
environment does not authorize skipping compilation. Older runtime wrappers
ignore the marker and retain their existing compile behavior.
Selected checked-release verification still runs in both tasks.
Apps do not add Cargo wrappers, Rust build hooks, or app-local compiler commands.
The explicit repository compile task invokes the Rust schema compiler and owns
release layout, checksums, stale-artifact detection, and transition planning.
This keeps Rust a platform build-time concern while the generated app owns only
AppSpec/CUE inputs and its typed Server Action boundary. Builder delivery sets
`APP_BUILDER_DELIVERY_BUILD_ONLY=1` for `app:check` to run the same
repository-owned build without the lint-bearing check task. Builder still runs
the app tests separately. The ordinary repository check keeps both steps.

Generated applications keep Rust services and deployment build hooks outside
app-owned source. Existing HC and Vendor Rust services are grandfathered product
surfaces. New apps can own Next.js Route Handlers within their registered route
topology, using the [generated data boundary](schema-compiler.md) for
authenticated server operations. Additional public routes require the normal
reviewed catalog change.

Generated app provenance is the optional copied AppSpec snapshot, app-owned CUE
source, and compiler-checked release pointer. Creation derives identity and routes
from the app ID and catalog; its resolved transaction plan is internal. App-local
`.config` files remain app-owned or must be assigned to an owning app-scoped task.

This ownership policy classifies every executable or support file under
`.config/mise/` and app-local mise configuration. Root `scripts/` is
prohibited: repository tooling belongs in `.config/mise/scripts/repository/`,
while executable repository entrypoints belong in `.config/mise/tasks/` and
app entrypoints belong in `apps/<app>/.config/mise/tasks/`. Apply the rows in
order; the first matching row is the file's owner and lifecycle.

## Adding a new operation

Start with the public command, not an implementation file:

1. Add a named executable entrypoint under the owning scope and give its
   `#MISE` metadata a concrete description. Repository commands use
   `mise run <task>`; app commands use `mise //apps/<app>:<task>`.
2. Express short orchestration in the task file. If repository behavior needs
   reusable code or focused tests, place that internal implementation under
   `.config/mise/scripts/repository/`; app behavior stays with the app. Have
   the owning task invoke it.
3. Update workflows, hk, package commands, and documentation to call the named
   task. CI may add `--skip-tools` only after its job has explicitly installed
   the task's complete toolset.
4. Add focused proof beside the implementation and ensure the scoped mise task
   is discoverable. A repository implementation without a repository task, or
   an app operation without an app-scoped task, is incomplete.

Do not add a root `scripts/`, `tools/`, `schemas/`, or `examples/` directory, a compatibility launcher, or a direct
developer/workflow command to `.config/mise/scripts/repository/`. The
`check:root-layout` rejects tracked directories outside the final repository
layout. The only source/documentation roots are `apps/`, `packages/`, `docs/`,
and app-local `.config/`; repository configuration is limited to the explicitly
classified `.claude/`, `.config/`, `.github/`, and `.storybook/`
roots. Root `scripts/`, `tools/`, `schemas/`, `examples/`, `kernel/`, and
`domain-libs/` are retired and must not be reintroduced. Rust kernel support
belongs under `packages/kernel/`; domain libraries belong under
`packages/domain-libs/`.

## Package-local boundary

Package-local `scripts/` directories are allowed only when the code belongs to
that application or package: framework build hooks, package tests, fixtures,
code generation scoped to that package, and package runtime adapters. They are
not a place to hide repository orchestration. If a human, agent, or CI job needs
to invoke app-owned behavior as an operation, add an app-scoped mise task under
`apps/<app>/.config/mise/tasks/`. Repository-wide policy, cross-package
orchestration, provider-neutral operations, and shared validation use a root
repository mise task. Provider-specific operations belong to the owning app's
task namespace even when their implementation calls shared repository tooling.

| Match                                                                                                                                                                                                                                                                                                     | Owner and status                                                                                                                                                                                                                                                                        | Side effects                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `.config/mise/tasks/**`                                                                                                                                                                                                                                                                                   | Global repository mise task entrypoint. It may expose only repository-owned validation, orchestration, shared tooling, or provider-neutral operations.                                                                                                                                  | Declared by its `#MISE` metadata and the root task-ownership check.       |
| `apps/**/.config/mise/tasks/**`                                                                                                                                                                                                                                                                           | App-owned mise task entrypoint. It exposes only that app's lifecycle, storage, generation, provider, or validation operations.                                                                                                                                                          | Declared by its `#MISE` metadata and the app task namespace.              |
| `.config/mise/scripts/**`                                                                                                                                                                                                                                                                                 | Thin repository mise-owned process orchestration not covered above. Retain only when a root repository task cannot express the sequence clearly.                                                                                                                                        | Declared by the exposing repository task.                                 |
| `.config/mise/scripts/repository/fixtures/**`                                                                                                                                                                                                                                                             | Validation fixture data owned by the corresponding focused checker.                                                                                                                                                                                                                     | None.                                                                     |
| `.config/mise/scripts/repository/__tests__/**`, `.config/mise/scripts/repository/**/*.test.*`, `.config/mise/scripts/repository/test-*`                                                                                                                                                                   | Positive/negative proof for an owned operation or policy. Delete when the behavior it proves is deleted.                                                                                                                                                                                | Temporary fixtures; integration tests may create isolated local state.    |
| `.config/mise/scripts/repository/capture-*`, `.config/mise/scripts/repository/spike-*`, `.config/mise/scripts/repository/sweep-*`, `.config/mise/scripts/repository/storybook-screenshots.ts`, `.config/mise/scripts/repository/playwright-capture.ts`, `.config/mise/scripts/repository/visual-proof.sh` | Visual-proof and bounded investigation tools. Retain only when referenced by `docs/agent-tooling.md` or an active acceptance document.                                                                                                                                                  | Local servers and `.scratch/visual-proof` artifacts.                      |
| `.config/mise/scripts/repository/generate-*`, `.config/mise/scripts/repository/*-generation.ts`, `.config/mise/scripts/repository/branding-inventory.ts`                                                                                                                                                  | Generated-artifact owners. A generator that owns tracked output must expose one mise generate task and one check-only freshness path with declared inputs and outputs. Ephemeral build configuration may remain an internal prerequisite of its owning mise task or protected workflow. | Tracked output only in explicit generate mode; checks use scratch output. |
| `.config/mise/scripts/repository/check-*`, `.config/mise/scripts/repository/*-validation.ts`, `.config/mise/scripts/repository/supply-chain-security.ts`                                                                                                                                                  | Focused validation owners that cannot be expressed by types, package metadata, ast-grep, or the boundary graph.                                                                                                                                                                         | Sanitized reports under `.scratch`; otherwise read-only.                  |
| `.config/mise/scripts/repository/auth-*`, `.config/mise/scripts/repository/neon-*`, `.config/mise/scripts/repository/vercel-*`, `.config/mise/scripts/repository/*vercel*`, `.config/mise/scripts/repository/*route-zone*`, `.config/mise/scripts/repository/trusted-deployed-smoke.ts`                   | Auth/database/deployment implementation invoked by scoped mise tasks and protected workflows.                                                                                                                                                                                           | Provider or database mutation only through explicitly mutating tasks.     |
| `.config/mise/scripts/repository/build-*`, `.config/mise/scripts/repository/run-*`, `.config/mise/scripts/repository/developer-*`, `.config/mise/scripts/repository/hc-agent-dev-server.ts`                                                                                                               | Build and local-runtime implementation invoked by mise, package scripts, or Pitchfork.                                                                                                                                                                                                  | Build outputs, local processes, or scratch configuration.                 |
| `.config/mise/scripts/repository/**`                                                                                                                                                                                                                                                                      | Root repository tooling implementation and focused proof not matched by a more specific repository category. It is invoked only through a mise task.                                                                                                                                    | Defined by the owning task.                                               |
| Package-local `apps/**/scripts/**`, `packages/**/scripts/**`                                                                                                                                                                                                                                              | Application or package-owned build hooks, tests, fixtures, generators, or runtime adapters. Cross-package/repository orchestration is forbidden here. Expose every developer or CI operation through an app/package-scoped mise task.                                                   | Defined by the owning package.                                            |
| Any unmatched `.config/mise/**` file                                                                                                                                                                                                                                                                      | Unowned. It must be deleted or assigned to an owning package and mise task before merge.                                                                                                                                                                                                | Undefined and therefore unsupported.                                      |

Compatibility launchers are not a category. Validators are invoked through
their natural Konsistent, workspace graph/import, Rust, deployment, application,
or branding owners.

One-off scripts are not retained merely because they once produced useful
evidence. When an active acceptance document needs one, that document must name
the command, inputs, output location, and deletion trigger.
