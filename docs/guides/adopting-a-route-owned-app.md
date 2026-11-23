# Adopting a route-owned app

Applications use the pinned MIT `@vercel/microfrontends` API. Next child apps
call `nextAppConfig()` from `@autograph/next-config`, which applies shared
Next defaults and invokes Vercel's official adapter. Vite apps use Vercel's
API directly. The custom authenticated Gateway owns deployed composition.

A new app is not discovered from the filesystem. Register the reviewed project,
package, and non-overlapping route in
`microfrontends.json`; that standard configuration is the complete
public topology contract for local development and routing. App Builder derives
and stages that registration for a new generated app; maintainers use this guide
when adopting an existing application.

## Source and route registration

For a new route-owned Next.js application, create and register the workspace in
one source-only transaction:

```sh
mise run create:app [app-id]
```

When omitted, the command generates an `app-<UUID>` ID and reports it in its
receipt. It derives the workspace, catalog registration, default routes, and
asset route from that ID and the current catalog. It accepts only the default
`/<app-id>` and `/<app-id>/:path*` routes; add any extra route through a
separately reviewed catalog change. Optional `.config/app-specs/<app-id>.md` is
copied into the app as a product-intent snapshot. Optional
`.config/app-specs/<app-id>.cue` selects the CUE-backed data path and becomes
the app-owned schema source. With neither input, it creates a static app.

Both generated variants include `app/<app-id>/page.tsx`, which renders the root
page at the registered entry. The Gateway forwards the registered pathname to
Next. Keep the mounted page when editing the root implementation. To place the
mounted page in a route group, move the scaffold page and update its relative re-export to point to
the root implementation. Next should have one page for that pathname.

`mise run generate:app <app-id>` remains only for bare workspace scaffolding
when an existing application is being adopted through separately reviewed
source and topology work. It does not register a route or create the standard
generated-app data boundary.

The generated workspace includes a normal, editable `apps/<app-id>/hk.pkl`.
Root HK discovers it as a native subproject, and the app may configure HK
normally. Add an app-local `mise.toml` when the app needs its own named tasks,
tools, or environment; root orchestration can invoke those tasks as
`mise //apps/<app-id>:<task>`.

[Building an App with App Builder](building-apps-with-app-builder.md) is the
canonical creation, generated-workspace, and validation procedure. Creation
registers the workspace and route in `microfrontends.json` as one source-only
transaction; it does not provision or activate a provider.

When adopting a bare workspace, change its Next config from
`nextConfigDefaults` to `nextAppConfig()` and set its `dev` and `start`
package scripts to `next dev --hostname 0.0.0.0 --port $(microfrontends port)`
and `next start --hostname 0.0.0.0 --port $(microfrontends port)` respectively.
Add the mount page at `app/<app-id>/page.tsx` to serve the registered entry.

`create:app` includes this configuration and mount page. The Next helper
reads the app workspace's `package.json`, applies shared Next defaults, and
passes its name through the official adapter's `appName` option. Keep the
manifest name equal to the application's `packageName` in `microfrontends.json`;
the official mapping resolves that package identity to the catalog key and its
hosted asset prefix. Next must load the config from the app workspace, as the
repository build scripts and Vercel Services do. The helper fails when the
current workspace lacks a package name.

Add the app-owned schema, authorization, health behavior, product flow, and
tests separately.

## Vercel Service build convention

The generated Next app owns a single direct `build` entrypoint for local and CI
use. When it is admitted to the root physical Services graph,
`@autograph/platform-microfrontends/vercel-config` owns the repository-pinned
cached Mise bootstrap and calls that same build. Keep application build work in
`build`; do not add
provider-specific package scripts or app-local Vercel configuration.

After an app has been explicitly admitted to the root physical Services graph,
the root configuration derives its app directory `root`,
`"installCommand": "bun install --frozen-lockfile"`, and provider build
handoff. Do not add `cd`, `--cwd ../..`, or a per-app `vercel.json`. Only
Services that intentionally share a package root use a named build variant such
as `build:service`; do not use provider service-name environment variables to
choose an artifact.

## Provider boundary

Vercel owns provider resources, current deployments, Production activation, and
rollback. Repository CD is read-only app-scoped coordination and proof. It does
not derive deployment state from pull requests, commits, merges, ancestry, or
branch freshness.

External provisioning and cleanup, including aliases, credentials, variables,
alerts, hooks, environments, integrations, and resources, are outside the
repository boundary. EXT-GW-03 owns obsolete external configuration cleanup.

## Validation

Validate topology and source contracts with the repository's named Mise tasks:

```sh
mise run check:microfrontends-deployment
mise run check:vercel-services
mise run check:deployment-policy
mise run check:types
```

Provider-owned Preview uses exact branch routing. Only an explicit
deployment-not-found response permits the provider-owned Production fallback;
all other resolution failures fail closed.
