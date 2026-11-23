# Vite route-owned template

This is a traditional React/Vite single-page application template. It is
intentionally stored outside `apps/`, so it is not installed or deployed. Copy
this directory to `apps/<name>` and rename the ordinary package metadata.
Discovery then uses its directory and `vite.config.ts`; no manifest, shell
entry, or shell route is involved. The generated Vercel Services project uses
the generic static-zone runner for assets and history fallback. The same runner
is packaged independently for the provider-neutral OCI/Compose proof.

The app includes a deliberately small app-owned client router to demonstrate
that a zone may use its preferred SPA routing library without coordinating
route details with the shell.

The checked-in static `vite.config.ts` and the functional and asynchronous
variants under `configs/` are all executed by the repository example check.
Each keeps ordinary Vite plugins, proxy, test, and build settings while adding
the direct official `microfrontends()` plugin.

Once copied, discovery generates an independent private Vercel project named
`apps-<name>`. The public gateway owns browser ingress and forwards the complete
mount path. Production access protection and Vercel OIDC are owned by the
generated project/release tooling rather than by template-specific code.
Preview protection is proven; Production remains gated until the separately
authorized cutover.

After copying it to `apps/reports` and renaming its package metadata, update
the workspace install before running it:

```sh
mise exec -- bun install
bun run --cwd apps/reports dev
```

The package scripts intentionally use paths relative to that installed
`apps/<name>` location. The documentation template is not run in place.
