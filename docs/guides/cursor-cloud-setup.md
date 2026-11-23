# Cursor Cloud setup

This section captures non-obvious startup/run caveats for the Cloud Agent VM.
The startup update script only refreshes dependencies (`mise install` +
`bun install`); PostgreSQL, database creation, and the local daemon set are NOT
started automatically, so a fresh agent must bring them up as below. Standard
tooling and commands live in
[developer onboarding](developer-onboarding.md);
only the gotchas below are Cloud-specific.

### Required host state (not covered by the update script)

- PostgreSQL 17 must be running and reachable at `127.0.0.1:5432` with role
  `postgres`/`postgres` (`psql`/`createdb`/`dropdb` are the PGDG client tools on
  `PATH`). Start the cluster with `sudo pg_ctlcluster 17 main start`. If the role
  password is unset, run `sudo -u postgres psql -c "ALTER USER postgres WITH
  PASSWORD 'postgres';"`. Export `PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres
  PGPASSWORD=postgres` for `mise run setup`/`mise run start`.
- `/etc/hosts` MUST map the proxy hostnames to loopback:
  `127.0.0.1 apps.localhost storybook.apps.localhost`. Browsers resolve
  `*.localhost` on their own, but Node's server-side fetch does not, and the
  Next.js shell's SSR catalog fetch (and other server-to-server calls) fail with
  a silent "Applications unavailable" until these entries exist.

### Local start sequence (from repo root, with the PG env vars exported)

1. `mise trust && mise install`
2. `mise exec -- bun install --frozen-lockfile`
3. `sudo pg_ctlcluster 17 main start` (idempotent; ignore "already running")
4. `mise daemons register`
5. `mise run setup` (recreates the `local_apps_*_{hc,vendor,auth}` databases,
   migrates Better Auth, materializes HC/Vendor storage, registers the proxy
   slug, runs `cargo fetch`; the optional Vercel env import will fail without
   Vercel creds and is skipped — that is expected).
6. `mise daemons register` (safe to repeat after setup updates the proxy
   namespace).
7. `mise run start` and confirm `http://apps.localhost:8080` responds.

Mise derives the proxy namespace and daemon URLs from the current checkout. If
the supervisor was already running with older settings, restart it with
`pitchfork supervisor start --force` after setup; no manual namespace edits are
needed.

### Trusted app auth secrets for the HC/Vendor data APIs

The HC and Vendor Rust APIs read `PLATFORM_MFE_HC_TRUSTED_AUTH_SECRET` /
`PLATFORM_MFE_VENDOR_TRUSTED_AUTH_SECRET` to verify gateway-delegated requests;
these are normally imported by `setup:vercel-env`. Without Vercel credentials
they are absent and every data call returns `500 auth_not_configured` ("Failed
to load schema"). Add them to the gitignored local fnox profile
(`.config/fnox/local.toml`) as `{ provider = "local", value = "<secret>" }`,
reusing the value setup generated for `PLATFORM_TRUSTED_AUTH_CONTEXT_SECRET` so
the gateway (which falls back to that context secret) and the APIs agree, then
restart the `apps`, `hc-api`, and `vendor-api` daemons.

### Testing the product

- Seeded local login: `admin@apps.localhost` / `local-apps-admin` (owner of the
  `dev` organization).
- The shell landing page `/` can render "Applications unavailable" on this
  branch because its origin check rejects the dotted `apps.localhost` host;
  navigate directly to the product surfaces `http://apps.localhost:8080/hc` and
  `/vendor`, which are served by their own zones.
- HC lookup data (departments, etc.) is empty after setup. Populate it with the
  loopback-only `POST /api/seed` on the HC API (use the port from
  `mise daemons ls --json`), signing
  trusted-auth headers with `@autograph/platform-microfrontends/trusted-auth`
  and `PLATFORM_MFE_HC_TRUSTED_AUTH_SECRET`, or via CSV import. CSV import and
  live agent runs additionally need `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`
  (optional; unset locally).
