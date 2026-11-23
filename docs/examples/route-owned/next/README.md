# Next route-owned template

This is a native Next.js 16 App Router template. It is intentionally stored
outside `apps/`, so it is not installed or deployed. Copy this directory to
`apps/<name>` and rename the ordinary package metadata. Discovery then uses its
directory and `next.config.ts`; there is no app manifest, shell entry, or
shell-owned route. The official build adapter consumes the generated route and asset paths
from the copied directory name.

The root page is a React Server Component with a small client counter island.
The nested details route uses `next/link`, preserving native same-zone RSC
navigation and prefetching. The root layout mounts the official cross-zone
prefetch client, and the route to the paired Vite example uses the official
microfrontend-aware `Link`.

Once copied, discovery generates an independent native Next.js Vercel project
named `apps-<name>`. That private deployment is reached through the public
gateway; it is not rendered inside Shell. Production access protection and
Vercel OIDC are owned by the generated project/release tooling rather than by
template-specific code. Preview protection is proven; Production remains gated
until the separately authorized cutover. The same app remains buildable as a
standalone OCI artifact for the provider-neutral Compose proof.

After copying it to `apps/reports` and renaming its package metadata, update
the workspace install before running it:

```sh
mise exec -- bun install
bun run --cwd apps/reports dev
```

The package scripts intentionally use paths relative to that installed
`apps/<name>` location. The documentation template is not run in place.
