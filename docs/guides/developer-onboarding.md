# Developer Onboarding

Use this path for a first checkout, a fresh worktree, or a new contributor
orientation. Keep the root README short; this guide owns the full local setup.

## 1. Read The Entry Points

Start in this order:

1. [Root README](../../README.md) for the short project overview and command list.
2. This onboarding guide for first local setup and validation.
3. [Docs index](../README.md) to find the current doc for the area you are changing.
4. [Principles](../principles.md), [contracts](../contracts.md), and
   [frontend architecture](../frontend-architecture.md) before changing the
   kernel, API contracts, or UI layers.
5. [Adopting a route-owned application](adopting-a-route-owned-app.md) before
   moving an existing Next.js or Vite project under `apps/`; it is the
   application-facing setup contract.

AG2 is reference evidence only. Autograph contracts in `docs/` are authoritative.

## 2. Install Local Prerequisites

Autograph development is driven by mise, Bun, Rust, fnox, hk, Pitchfork,
native Git worktrees, and local PostgreSQL.

Required before running setup:

- [mise](https://mise.jdx.dev/installing-mise.html), activated in your shell.
- Git 2.54 or newer with hk's mise-backed global hooks installed once for the
  machine: `hk install --global --mise`. The dotfiles bootstrap owns this on
  managed developer machines. Global hooks silently skip repositories without
  an hk configuration.
- PostgreSQL running locally. The repository installs the pinned PostgreSQL 17
  client tools (`psql`, `pg_isready`, `createdb`, and `dropdb`) through mise.
- A shell that can load the repo's mise-managed tools.

After installing mise, open a fresh shell or activate it for the current shell,
then verify the bootstrap tools:

```sh
command -v mise
mise exec -- psql --version
```

## 3. Bootstrap The Repo

Run setup from the repository root:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- bun install --cwd .storybook --frozen-lockfile
mise daemons register
mise run setup
```

`mise install` installs the pinned toolchain and repo-managed tools before
the frozen Bun install links every root runtime workspace dependency, including
the generated Shell service package. `mise run setup` stops the current
checkout's mise daemon namespace, drops any existing
generated local app databases for the checkout, recreates worktree-specific
local development, HC, Vendor, and auth app databases, writes generated local
env values to `.config/fnox/local.toml`,
migrates and bootstraps local Better Auth, pulls Vercel development env into
fnox when Vercel auth is available, materializes and validates HC and
Vendor app storage, registers Pitchfork proxy slugs against the shared git
worktree root, and fetches Rust dependencies using the stable Rust toolchain.
Setup does not restart daemons; run `mise run start` after it completes. The Bun
deps provider is auto-enabled, so
later `mise run ...` and `mise exec ...` commands refresh `node_modules` when
`package.json` or `bun.lock` changes.

Setup requires a responsive mise daemon supervisor and fails before database
cleanup if it cannot stop the current checkout's daemons. This prevents live
APIs from reconnecting while their databases are being dropped and
materialized. Repair or restart the supervisor, then rerun setup. The stop is
bounded to 30 seconds so an unhealthy supervisor or oversized shared log store
cannot hang setup indefinitely.

The repository does not override mise's Cargo or Rustup homes. Mise respects
host-provided `CARGO_HOME` and `RUSTUP_HOME` values and otherwise uses the
user-scoped `$HOME/.cargo` and `$HOME/.rustup` defaults. These paths must resolve
outside the checkout; `mise run check:mise-rust-cache-paths` enforces that
contract and rejects a repository-local literal `~/` directory.

App storage materialization is explicit but included in `mise run setup`.
Runtime app servers validate storage but do not create schema revisions,
app-owned tables, or seed rows. Rerunning `mise run setup` resets generated
local databases before materializing and validating storage, so after a schema
change rerun setup before `mise run start`. A materialization or validation
failure stops setup immediately.

Verify the repo-managed tools resolve through mise:

```sh
mise exec -- sh -c 'for tool in bun fnox hk pitchfork postgres psql createdb dropdb rustc; do command -v "$tool"; done'
mise exec -- sh -c 'bun --version; fnox --version; hk --version; pitchfork --version; postgres --version; psql --version; rustc --version; rustc --version'
```

The repository TypeScript compiler is TypeScript 7. Its package exposes `tsc`
but no longer installs a root `tsserver` binary. Editor and LSP integrations
that previously discovered the workspace server through
`node_modules/.bin/tsserver` need a TypeScript 7-aware server command or plugin
configuration instead of falling back to a global TypeScript install.

`.config/fnox/local.toml` is ignored and stores local non-production development env
values in the `local` fnox profile through fnox's plain provider. Mise
sets `FNOX_CONFIG_DIR` to an empty repository-scoped directory so fnox 1.32
does not layer machine-wide secrets or providers beneath this explicit config.
Repository setup never installs, uninstalls, or configures Git hooks; the
machine-wide hk installation owns them. After confirming the global installation, an existing
checkout with stale repository hooks can remove them once with `hk uninstall`.
Set `HK=0` only for an explicit local bypass. Developers on older Git versions
must upgrade to Git 2.54 or invoke the manual hook tasks directly.

The pre-commit hook runs the comprehensive local validation closure. Pre-push
keeps the Git transport bounded to preparation, formatting, lint, focused
contract checks, changed-source architecture checks, and affected TypeScript
projects. Pull request CI repeats the diff-scoped validation and owns the
longer Rust, setup, application lifecycle, and test lanes. Exhaustive Rust,
architecture-boundary, app, and package verification runs on `main`. Run the
local lanes directly with `mise run hook:pre-commit` and
`mise run hook:pre-push`.

The TypeScript projects intentionally remain independent rather than using
TypeScript project references. Most projects consume source across workspace
packages and do not emit declarations; converting them to `composite` projects
would add declaration/output ownership and dependency-graph maintenance. The
affected-project hk lane therefore remains the lower-risk fast path. Turbo
continues to cache package tests and builds, where packages already own explicit
scripts and outputs.

The HC and Vendor CSV workspaces use Vercel AI Gateway. Local live-agent runs can use
Vercel OIDC minted by the repository-owned pull client on pinned Bun;
`AI_GATEWAY_API_KEY` is optional in the same fnox profile for cases where a
developer wants a long-lived Gateway key.
`mise run setup` first generates local `PLATFORM_HC_DATABASE_URL`,
`PLATFORM_VENDOR_DATABASE_URL`,
`PLATFORM_AUTH_DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and the
OAuth proxy placeholders plus the known Ampersand integration env entries in
the local fnox profile. Ampersand
entries are created as missing-allowed placeholders so the vendor app can report
which integration settings still need values instead of preventing local
daemons from starting. It then runs `mise run setup:auth`, which applies Better
Auth migrations in the dedicated Auth database's `public` schema, verifies the
schema, and creates the local seeded users and `dev` memberships. After that,
setup runs
`mise run setup:vercel-env`, which reads the single `apps` project development
environment through the repository-owned Vercel pull client on pinned Bun,
imports shared Ampersand integration inputs from that project (`AMPERSAND_PROJECT_ID`, the non-secret
`AMPERSAND_PRODUCTION_PROJECT_ID` separation sentinel, `AMPERSAND_API_KEY`,
static integration identifiers, allowed hosts, and webhook secrets), imports default-app Google auth
UI/provider values plus `OAUTH_PROXY_PRODUCTION_URL` and `OAUTH_PROXY_SECRET`
from the Vercel `apps` Gateway project when they exist, and preserves checkout-local database URLs, `BETTER_AUTH_URL`,
and `BETTER_AUTH_SECRET` by default so local sessions and storage stay scoped to
the current checkout or worktree. It does not import Ampersand JWT key
ids or private keys from Vercel; those are developer-local. Set
`PLATFORM_VERCEL_ENV_IMPORT_DATABASE_URLS=true` only when you intentionally want
the fnox profile to use Vercel development database URLs. It also
preserves existing fnox Gateway auth values or imports `VERCEL_OIDC_TOKEN` /
`AI_GATEWAY_API_KEY` from the current shell when either is set.

If Vercel auth was unavailable during setup, add a scoped token to the local
fnox profile and rerun only the env import:

```sh
fnox -c .config/fnox/local.toml -P local --no-defaults set VERCEL_TOKEN
mise run setup:vercel-env
```

Vercel credentials are optional for core local database setup. If the remote
Development environment is internally inconsistent, `mise run setup` reports
the failed import, restores the pre-import fnox profile, continues through
storage materialization and validation, and exits successfully once the core
setup is usable. The standalone
`mise run setup:vercel-env` command remains strict and exits nonzero until the
reported remote variables are corrected. When
`PLATFORM_VERCEL_ENV_IMPORT_DATABASE_URLS=true`, setup keeps that import strict:
an import failure stops setup before any app storage is materialized against
the explicitly selected remote databases.

To add or rotate a long-lived Gateway key after setup, run:

```sh
fnox -c .config/fnox/local.toml -P local --no-defaults set AI_GATEWAY_API_KEY
```

## 4. Start The App

This repo configures Pitchfork's proxy for plain HTTP on unprivileged port
`8080`. The `.localhost` hostnames resolve without modifying `/etc/hosts`.
Start or restart the supervisor as your normal user before starting the repo
daemons:

```sh
mise daemons register
```

Start the local development daemons:

```sh
mise run start
```

`mise run start` starts the worktree-aware daemon set declared in
`.config/mise/config.toml`. Mise registers the definitions with Pitchfork and
assigns each linked worktree its own daemon namespace, automatic ports, and
stable URLs. Mise owns startup for the HC API,
vendor API, HC CSV agent, independently served frontend zones,
the route-owned gateway, and Storybook. The `apps` daemon is the public
gateway. Shell, HC, and Vendor frontend daemons are private upstreams;
the gateway selects one using the generated projection of the checked
root `microfrontends.json` topology. Local daemon names describe local process
boundaries and intentionally include `apps-shell`, `hc-api`,
`hc-agent`, and `vendor-api`; they are not additional
Vercel projects. Hosted composition has one Vercel Services project; its
physical service names are transport-only and do not replace the logical
application/browser-route catalog in root `microfrontends.json`.
The pinned `@vercel/microfrontends` framework APIs are used directly; this
local topology does not enroll the paid product or replace the custom
authenticated Gateway as deployed composition. Hosted bindings are selected
inside the one provider deployment, have no Production fallback, and do not use
repository Git state to select a deployment.
The app-local `mise //apps/hc:agent`, `mise //apps/hc:dev`, and
`mise //apps/vendor:dev` tasks declare their API dependencies as daemon
requirements too, so invoking one directly gets the same readiness behavior as
the composed local stack.
The normal HMR gateway opts Next zones into the development CSP needed for
React's full development debugging experience, including enhanced
cross-environment stack reconstruction. The opt-in requires
`NODE_ENV=development`, while Vite zones and `mise run start:strict-csp` retain
the strict floor. The shell also permits Next development resources from the
loopback gateway and the configured public auth/platform origin; production
builds do not receive this development-origin allowance. In development, the
gateway accepts browser mutations and HMR upgrades from its exact raw loopback
origin as well as its configured proxy origin; this exception is neither a
wildcard nor active in production. The route gateway runs on stock Node through
`nub --no-env-file`; keep that runtime because its Node HTTP upgrade semantics
carry the Next and Vite HMR WebSockets through the gateway without loading
ambient `.env` files.
In the generated deployment stack, browser-serving zone variables belong in
`.env.<app>.zone`, while private provider and database variables belong in
`.env.<app>.api`. Override the paths with
`PLATFORM_MFE_<APP>_ZONE_ENV_FILE` and `PLATFORM_MFE_<APP>_API_ENV_FILE`.
Pitchfork runs daemon commands through mise. `mise run setup` enables the Pitchfork proxy
in the user config, configures the local proxy for plain HTTP on port 8080,
records the current user as the daemon owner, and
overwrites the user-level `apps` and
`storybook.apps` proxy slugs so they point at the shared git worktree root.
Setup
does not set proxy TLD, LAN mode, or certificate settings; those stay on
Pitchfork defaults unless the user changes them separately. Inspect
`pitchfork proxy status` for the resolved URLs.

Every local daemon has a preferred port, but Pitchfork may try up to 100
candidates instead of failing on an occupied port. Each service binds the
resolved `$PORT`, and dependent services receive the actual upstream ports
through Pitchfork's dependency templates. Use
`mise daemons ls` or the native status summary printed by
`mise run start` when you need a raw port; the proxy URLs remain stable.
Pitchfork does not terminate an unrelated process merely because it owns a
preferred port.

For Browser QA under the enforced CSP, use optimized Next builds instead of
the development HMR runtime:

```sh
mise run start:strict-csp
```

This keeps HC on its ordinary Vite development server, builds and
starts the shell and Vendor as production-mode Next zones, and runs the same
route-owned gateway and identity boundary. Use the printed `127.0.0.1` origin;
mixing it with `localhost` correctly fails the gateway's same-origin mutation
check. `mise run stop` stops either the ordinary development stack or this
Browser-QA stack.

For a named worktree, mise assigns a stable namespace derived from the repository
and worktree identity. Re-running setup replaces only that worktree's entries and
preserves unrelated user namespaces. The start and stop tasks target only the
current checkout's namespace, so concurrent checkouts do not start or stop one
another's daemons. Each service uses a mise automatic port with a service-specific
base range; the resolved port and stable URL are exposed by mise. The database
safe worktree identity also keeps the HC, Vendor, and Auth database names distinct
within PostgreSQL's identifier limit. Worktree auth trusts both
the `.local` and `.localhost` proxy forms because the proxy TLD remains a
user-level choice.

Useful inspection commands:

```sh
mise daemons ls
mise daemons urls
pitchfork proxy status
```

`mise run start` finishes with mise's daemon status and URL details for the
current checkout. Registered public services include their proxy URLs, so the
local app and Storybook are immediately visible without a repository-specific
status formatter. `mise run start:strict-csp` reports its corresponding strict-CSP
QA daemon set instead. The current checkout's namespace is selected automatically,
so the output does not mix services from sibling worktrees.

Preferred starting ports are HC API `3800`, Vendor API `3900`,
HC agent service `4000`, HC frontend `4100`, Vendor frontend
`4300`, shell Next host `3001`, route-owned gateway `3101`, and Storybook
`6006`. Mise allocates worktree-specific ports automatically and exposes stable
URLs through `mise daemons urls`. `BETTER_AUTH_URL` uses the stable worktree proxy
origin, so a raw port change does not invalidate auth. The config starts both
gateway and shell through fnox so auth guards see the checkout-local auth
database. Use the seeded local account
`admin@apps.localhost` / `local-apps-admin` as the default local login.
Google sign-in is opt-in for local development and requires the shared
`OAUTH_PROXY_PRODUCTION_URL` / `OAUTH_PROXY_SECRET` configuration. Pitchfork
owns daemon ports when you use `mise run start`; if another worktree already uses a preferred port,
mise selects another port and keeps the stable URL. Local ports are therefore
diagnostic values: read them from `mise daemons ls --json` instead of hardcoding them.

The HC agent service and Vendor application route install the shared agent-led
CSV workspace. Local live-agent model
calls need Vercel Gateway auth through either `VERCEL_OIDC_TOKEN` from
`mise run setup:vercel-env` or an optional `AI_GATEWAY_API_KEY` in the fnox
profile. Vercel OIDC tokens are short-lived, so rerun `mise run setup:vercel-env`
at the start of a new live-agent development session or after Gateway auth
errors.

With this repo's setup, the main checkout frontend resolves at
`http://apps.localhost:8080` and Storybook resolves at
`http://storybook.apps.localhost:8080`. Auth flows should use the shell's
`BETTER_AUTH_URL` origin: the stable proxy URL for a mise worktree namespace, or the
configured local gateway origin otherwise.
Mise-managed worktrees also export a
worktree slug during setup, so they register branch-prefixed slugs such as
`http://feature-a.apps.localhost:8080` and
`http://storybook.feature-a.apps.localhost:8080`. These friendly hostnames are
accepted dynamic auth origins. For Google sign-in, set `BETTER_AUTH_URL` to the
local origin that should receive the returned profile and session. Google still
uses only the stable production callback. Pitchfork
wildcard subdomains under each registered slug route to that slug's daemon. The
HTTP proxy uses unprivileged port `8080`; `.localhost` resolves without
`/etc/hosts`, so the supervisor and project daemons run as the developer user.
If the supervisor was already running with older proxy settings, restart it
once after setup:

```sh
pitchfork supervisor start --force
```

To test Google sign-in locally, first verify the stable callback and dedicated
proxy configuration:

```sh
mise run auth:oauth:doctor
```

The doctor prints the current worktree return origin and the one registered
Google callback, `https://apps.autograph.so/api/auth/callback/google`. It reports
only presence for the Google credentials and proxy secret. An incomplete result
names missing variables and directs you to rerun `mise run setup:vercel-env`;
secret values are never printed.

Then rerun setup with the existing social-provider toggle enabled:

```sh
VITE_PLATFORM_AUTH_SOCIAL_PROVIDERS=google mise run setup
```

The Google button is hidden by default, including in isolated worktrees, so
ordinary local development does not depend on Google Cloud Console edits.

If the proxy URL fails while `mise daemons ls` shows the daemon
running, verify the daemon directly on its resolved local port:

```sh
open "$(mise daemons urls --json | jq -r '.[] | select(.name == "apps") | .url')/"
curl -sS "$(mise daemons urls --json | jq -r '.[] | select(.name == "hc-agent") | .url')/api/csv-workspace/workspace?as_of=$(date +%F)"
open "$(mise daemons urls --json | jq -r '.[] | select(.name == "storybook") | .url')/"
```

## 5. Run First Validation

For a first checkout, run a small health pass before feature work:

```sh
mise run test:app
mise run check:types
mise run test:kernel
mise run test:csv-workspace
```

With the authenticated local stack and live model credentials running, the
installed HC/Vendor browser flow is exercised by

```sh
mise run test:csv-workspace-installed
```

Installed HC/Vendor acceptance has passed locally. The retained live runs and
subsequent deterministic repairs are distinguished in the CSV migration report;
this command alone does not establish hosted acceptance.

Run the canonical repository check before a handoff:

```sh
mise run check
```

## 6. Add App or Package

Use the Turbo generators when adding JavaScript apps or packages. They create
the workspace under the existing Bun workspace globs, so no root
`package.json` change is needed for `apps/*`, `packages/*`, or
`packages/*/*`.

For a new route-owned Next.js application, create and register it with:

```sh
mise run create:app [app-id]
```

When omitted, the command generates an `app-<UUID>` ID and reports it in the
creation receipt. It derives the workspace, package, project, title, default
routes, and asset route from the ID and current `microfrontends.json` catalog.
Optional `.config/app-specs/<app-id>.md` is copied into the app as an AppSpec
snapshot. Optional `.config/app-specs/<app-id>.cue` selects the CUE-backed data
path, becomes the app-owned schema source, and compiles the checked release.
Provider provisioning, credentials, deployment, and activation remain separate.

`mise run generate:app <app-id>` remains for bare workspace scaffolding when
an existing app is adopted through separately reviewed source and topology work.
It uses the same base workspace renderer and dependency profile as `create:app`.
The bare workspace runs Next directly on its standard port. When adopting it as a
route-owned app, switch its Next config to `nextAppConfig()` and use the
`microfrontends port` dev and start scripts. The command does not register a route
or create the generated-app data boundary.

Both paths create an editable, standard HK configuration at
`apps/<app-id>/hk.pkl`. Root HK discovers it through `subprojects =
List("apps/*")`; the app owns its hooks, steps, globs, and environment without a
central registry or repository-specific override schema. A minimal app config is:

```pkl
amends "../../.config/hk/vendor/hk-v1.56.1/Config.pkl"

hooks {}
```

`<app-id>` must be one lowercase kebab-case segment. The app generator creates
`apps/<app-id>/` with a Next.js App Router skeleton, `package.json`, app-local
`turbo.json`, standard Next.js package scripts, and its native HK config.
Convention-discovered Next.js and Vite web apps must expose non-empty
`check` and `build` scripts. Apps may declare a non-empty `test` script for their
own tests; CI schedules test jobs only for apps that declare one. Explicitly
requesting `app:test` without a declared command fails rather than reporting a
passing test. CI runs one unsharded test job per selected app. Explicit shards
remain available for local test commands.
App-local Turbo configuration is optional; native Turbo commands validate any
configuration an app supplies.

Generated Next apps use one direct `build` entrypoint for local and CI work.
Their catalog registration automatically derives the root Vercel Service, its
Gateway binding, frozen install, and the pinned-Mise provider handoff before
calling that same command. `create:app` runs the same complete catalog-derived
graph policy as `check:vercel-services` in its staged transaction before
publishing source or topology, including private bindings and public-ingress
restrictions. Do not add `cd`,
`--cwd ../..`, repository bootstrap paths, or app-local Vercel configuration.
Shared-root Services must use an explicit named build variant rather than
provider environment branching.

No workflow registration is required. Pull request Check derives one dynamic
matrix from the affected app and workspace dependency closure, while exact-main
CI derives check/build for every discovered web app and test phases only for
apps with declared test commands.
Gateway, API, evaluation, and proof-fixture packages without the complete web-app
contract retain their specialized validation lanes. Add app-local mise tasks only
for app-specific lifecycle commands such as servers, agents, local database
setup, or mise daemons. Shared format/lint/check validation runs through hk,
and shared test/build orchestration runs through Turbo package scripts.

Create a package with:

```sh
mise run generate:package <package-path>
mise run generate:package --built <package-path>
```

`<package-path>` is relative to `packages/` and must be either `<name>` or
`<group>/<name>`. By default the generator creates a private, source-only
workspace package with a TypeScript export, `check` and `test` scripts, and a
starter Vitest test. Use `--built` for a package that needs to be installed
outside this workspace. That shape emits JavaScript and declarations into
`dist`, exports those built files, includes only `dist` in the package tarball,
and adds a real `build` script. Both shapes reference the root catalog for
development tool versions. Add the package's own runtime and
peer dependencies as its implementation requires.

Pack built packages with `bun pm pack` from the package directory after
installing dependencies. Bun uses `bun.lock` to replace `catalog:` references
with concrete versions in the tarball manifest. Verify the tarball before
installing it elsewhere; `npm pack` leaves catalog references unresolved.

After generating a workspace, install and run the targeted validation:

```sh
mise exec -- bun install
mise exec -- turbo run check test --filter=@autograph/<workspace-name>
mise exec -- turbo run build --filter=@autograph/<workspace-name> # built packages only
mise run check:app
```

For grouped packages, the package name joins path segments with hyphens. For
example, `packages/engines/rules` becomes `@autograph/engines-rules`.

The repo-wide generators live in `.config/turbo/generators/`. Add generators under
`apps/<id>/turbo/generators/` or `packages/<path>/turbo/generators/` only when
they are specific to an existing workspace.

Domain-lib `turbo.json` files are generated from the repo-wide generator source.
The canonical check rejects missing or stale generated configs.
After changing their shared task inputs, regenerate them with:

```sh
mise run generate:domain-lib-turbo
```

Update the generators when the default workspace shape changes. Update root
`turbo.json` only when the repo needs a new shared cacheable test/build task or
output pattern, not for app-specific task names. Update `.config/mise/config.toml`
only when a new aggregate command is needed.

Root `mise.toml` is intentionally only the monorepo sentinel required by mise
for `//path:task` addressing. Keep tool, environment, and task config under
`.config/mise/`.

Root mise task names use an action-first shape: `<action>` for repo-wide
commands such as `check`, `build`, `setup`, `start`, and `stop`, and
`<action>:<scope>` for narrower repo-level commands such as `check:app`,
`build:catalog` and `setup:db`. Keep app-owned lifecycle
tasks under the app namespace, for example `//apps/hc:dev`, instead of adding
root aliases for existing app tasks.

When adding an operational command, first decide its owner. Create
`.config/mise/tasks/<name>` only for repository-owned operations and document it
as `mise run <name>`. Create `apps/<app>/.config/mise/tasks/<name>` for an
app-owned operation and document it as `mise //apps/<app>:<name>`. Never add a
root alias for an app task. Keep a short command in the task itself; move
non-trivial repository implementation and its tests to
`.config/mise/scripts/repository/`, while app-specific implementation remains
with the app. Do not create root `scripts/` or call an internal repository path
directly from developer docs. Package-local scripts are reserved for
package-owned build hooks, tests, fixtures, generators, and runtime adapters.
See
[`../tooling-script-ownership.md`](../tooling-script-ownership.md) for the full
decision boundary.

To verify the onboarding tooling itself after changing setup, mise daemon
configuration, or onboarding docs, run the smoke checks:

```sh
mise run smoke:setup
mise run smoke:worktree
```

The pull request setup lane provisions the complete pinned mise toolchain once,
then uses `mise run --skip-tools` for these canonical smoke tasks. Its primary
checkout and generated smoke worktree share one Cargo target directory outside
both checkouts. That target restores only from the cache published by trusted
`main` validation; pull request jobs cannot update it.

The smoke checks use generated `local_apps_developer_*` database names, an
isolated Pitchfork proxy config, and cleanup traps that restore
`.config/fnox/local.toml` before exiting.

## 7. Work In A Worktree

Create and enter a native Git worktree, then register its mise daemons:

```sh
git worktree add ../arrusted-development-feature -b feature
cd ../arrusted-development-feature
mise trust
mise install --locked
mise daemons register
mise daemons urls
```

Each linked worktree receives its own daemon namespace, automatic ports, and
stable service URLs. `mise run setup:worktree` registers the current worktree
and prints its URLs; `mise run cleanup:worktree` stops its daemons and cleans
its generated local databases before removal:

```sh
mise run cleanup:worktree
git worktree remove ../arrusted-development-feature
```

Use `mise daemons prune --dry-run` to inspect stale daemon state after removing
old worktrees, then `mise daemons prune --yes` when the listed state is safe to
remove.

## Troubleshooting

- If setup cannot connect to PostgreSQL, confirm the local server is running and
  `pg_isready` succeeds.
- If local services use the wrong database, inspect the generated fnox config:
  `fnox -c .config/fnox/local.toml -P local --no-defaults export`.
- If local model calls report missing Gateway auth, refresh Vercel OIDC with
  `mise run setup:vercel-env`, or add an optional long-lived key to the local
  fnox profile:
  ```sh
  fnox -c .config/fnox/local.toml -P local --no-defaults set AI_GATEWAY_API_KEY
  ```
- If the frontend cannot reach an API, check `mise daemons ls` for hc-api.
  and use the resolved port.
- If mise daemon status or log requests time out, inspect the Pitchfork log store
  with `du -sh "${XDG_STATE_HOME:-$HOME/.local/state}/pitchfork/logs"`. Preserve
  any logs you still need before clearing daemon logs with
  `pitchfork logs --clear`; setup never deletes the shared log history.
- If HC data-import requests return `502`, check `mise daemons ls` for hc-agent;
  Vite proxies `/hc/api/csv-workspace/*` to that daemon. Vendor serves its
  authenticated `/vendor/api/csv-workspace/*` adapter from the Vendor app.
- If a proxy URL fails while the direct daemon URL works, rerun
  `mise daemons register`, then inspect
  `pitchfork proxy status`.
- If a default port is occupied, stop the conflicting process and rerun
  `mise run start`.
- If docs and code disagree, fix the relevant doc or code in the same PR.
