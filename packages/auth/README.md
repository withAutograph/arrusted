# Auth Package

`packages/auth` owns shared authentication, session, and tenant-scope helpers.
It follows the same package-shaped organization as next-forge, but uses Better
Auth instead of Clerk.

## Boundaries

- Apps and future Next route handlers import `@autograph/auth/server`,
  `@autograph/auth/client`, `@autograph/auth/ui`,
  `@autograph/auth/ui-view-paths`, or `@autograph/auth/next`.
- The package may import shared contracts as type-only data, Better Auth,
  Better Auth UI, TanStack Query, React, and database driver code.
- The package must not import apps, modules, `kernel-client`, or app-domain
  code.

`mise run check:workspace-imports` validates resolved and unresolved workspace
imports and domain-library cycles. Package-direction rules remain documented
ownership constraints rather than claims of that check's fixture coverage.

## UI Boundary

`@autograph/auth/ui` centralizes the Better Auth UI provider, hooks, and shadcn
component layer:

- `AuthUiProvider` wraps Better Auth UI's `AuthProvider` with the shared
  Better Auth client, organization UI plugin, and shared query-client defaults.
- `createAuthQueryClient` and `getAuthQueryClient` provide the
  TanStack Query client shape Better Auth UI expects for SSR and browser usage.
- The package owns the Better Auth UI shadcn source for `Auth`, `UserButton`,
  and the UI primitives they compose.
- Query keys, view paths, and hooks are re-exported so apps can render packaged
  auth UI without duplicating provider config.
- Server Components import pure Better Auth UI route configuration from
  `@autograph/auth/ui-view-paths`; they must not invoke exports through the
  client-only provider module.
- The shell validates route path segments against the configured Better Auth UI
  view paths before rendering the client component.
- Apps provide the route shell and global Tailwind/shadcn tokens, but they must
  not import generated auth UI source directly.

Apps may compose route shells and app-specific layout around these exports, but
they should not configure Better Auth UI directly.

## Tenant Mapping

Better Auth organizations map directly to kernel `customer_id` values. Each
app still supplies its own app-owned `app_id` when calling
`requireTenantScope`.

Each organization also carries a server-owned `appIds` JSON assignment. The
auth boundary parses this field as generic app-id vocabulary and denies access
when it is absent or invalid. It does not import the shell registry. Browser
organization inputs cannot set the field.

`requireTenantContext`, `requireTenantScope`, and auth introspection require the
requested app id to appear in the selected organization's validated assignment.
The selected organization is an explicit `customerId` for a slug-driven route,
or the session-active organization for callers without a route-owned tenant.
Both paths verify current membership. Missing or malformed assignments normalize
to zero apps and fail app access with `AuthBoundaryError` code
`app_access_required` and HTTP status `403`. Authentication failures remain
`auth_required`; missing or stale membership remains `tenant_required`.

Server boundaries that catch unknown values use
`authBoundaryErrorFromUnknown` from `@autograph/auth/server`. The shared parser
owns the app-agnostic auth code, HTTP status, and string-message shape and uses
structural checks so class instances and equivalent objects from other realms
remain valid. Apps consume the parsed result and retain ownership of how each
auth failure maps into app-specific response envelopes.

When a session is created, a user's sole organization membership becomes the
active organization automatically. Non-slug callers with multiple memberships
select an organization through Better Auth's `organization.setActive` API.
Slug-driven routes select their explicit organization without rewriting shared
session state. With neither selection, tenant routes remain fail-closed.

`requireAppContext` (an app's own guard, with app roles) also resolves the
organization for a person whose session names none, or names one that does not
open the app for them (it does not grant the app, or they hold no active app
role there): the only organization that does is used for that request without
rewriting the session, several answer `tenant_required` so the app offers
`appOrganizationChoices`, and none keep `app_access_required`. A named
`customerId` and a missing `requiredRole` in an organization that does open the
app are never redirected.

Apps remain multi-tenant and must not infer a tenant id from the app id. The
shell preserves the selected organization for `/hc`, `/dev`, and `/vendor`,
then passes that authenticated scope and its distinct organization slug to each
mounted app. Better Auth UI receives the selected organization slug through
`organizationPlugin({ slug })`.

Rust API guards must not call Better Auth plugin routes directly. They call the
package-owned introspection route at `/api/auth/platform/introspect`, which is
implemented with this package's tenant-scope guard and returns the stable
`{ appId, customerId, actorId, permissions }` payload. `permissions` is supplied
by app-owned policy at the TypeScript API boundary; the shared auth package does
not mint app permissions by default.

## Environment

The root [`docs/environment.example`](../../docs/environment.example) is the complete OAuth-related
environment contract. Its session-secret and proxy-secret sections are
deliberately separate: `BETTER_AUTH_SECRET` / `BETTER_AUTH_SECRETS` stay unique
to an environment, while `OAUTH_PROXY_SECRET` is shared only by participating
environments in the same administrative trust boundary. It wraps the
cross-environment return envelope; the initiating environment's Better Auth
state remains bound to its own session secret and allowed callback origin.

Public delivery and Auth resource isolation are separate settings. An approved
Builder public release may set `PLATFORM_AUTH_DEPLOYMENT_PROFILE=isolated-development`
while Vercel's native delivery remains `VERCEL_ENV=production`. This profile
requires the exact reviewed installer `AUTH_DATABASE_RESOURCE` with isolated
resource classification (`preview` or `isolated-development`),
the exact restricted runtime `PLATFORM_AUTH_DATABASE_URL`, and a reviewed
`AUTH_PRODUCTION_DATABASE_IDENTITY` whose normalized Neon endpoint differs.
The existing connection, role, schema, query-parameter and verified TLS checks
still apply. Provider preparation and catalog preflight must independently
verify that receipt before delivery; environment configuration is not that proof.

The isolated profile requires matching exact HTTPS `BETTER_AUTH_URL` and
`PLATFORM_PUBLIC_ORIGIN` origins, with trusted origins restricted to that origin
and host-only cookies. Better Auth owns its `/api/auth` routes; these origin
values contain no route path. An enrolled isolated realm enables email/password
signup for its app. The Shell uses the enrolled origin for private Service
requests with matching Gateway forwarding. The isolated profile alone leaves
signup closed. Google, the
cross-environment OAuth proxy and the customer Production Infrastructure
integration are omitted. Session, organization,
application assignment and action permissions remain mandatory. No Vercel
account is required to reach the app's public production domain. The default
and explicit `production` resource profile retain the existing customer
Production configuration and signup policy; this does not migrate its users or
resources. Frozen protected Preview configurations retain their original meaning.

Required for production:

- `PLATFORM_HC_DATABASE_URL_UNPOOLED`: HC's direct/unpooled
  `hc` URL. Vercel requires it to use the same normalized Neon branch
  endpoint as Auth while retaining the distinct HC database and role.
- `PLATFORM_AUTH_DATABASE_URL`: the dedicated Auth database and restricted
  runtime role in the `apps` project's native Neon branch. Better Auth uses
  this binding in Production; the migration runner targets the same
  `platform_auth` database. Product projects never receive the binding.
- `BETTER_AUTH_URL`: current auth origin for production and local development.
  Vercel previews derive their current origin from `VERCEL_URL` instead.
- `BETTER_AUTH_SECRET` or `BETTER_AUTH_SECRETS`: Better Auth signing/encryption
  secret material.

Required for Vercel previews:

- `DATABASE_URL_UNPOOLED`: branch-scoped Neon URL from the unprefixed,
  `apps`-owned integration, routed only to Gateway, Shell, and coordinated Auth
  provisioning.
- `AUTH_PRODUCTION_DATABASE_IDENTITY`: non-secret production Neon
  `hostname/database` receipt whose normalized hostname is used to reject a
  shared production endpoint.

Optional:

- `PLATFORM_AUTH_TRUSTED_ORIGINS`: comma-separated Better Auth trusted origins.
- `PLATFORM_AUTH_COOKIE_DOMAIN`: optional parent cookie domain, for example
  `.autograph.so`, when a stable auth host must share session cookies with
  preview aliases on sibling subdomains. Leave unset for local development.
- Local, Vercel Development, and Vercel Preview enable public email/password
  signup. Google user creation is disabled in every environment, and Vercel
  Production disables all signup. New Local/Preview users receive an
  idempotent Better Auth server-owned membership in the one all-app
  organization marked by the auth database provisioning contract (the
  canonical `dev` organization), whose server-owned app assignment grants all
  apps.
- Protected Preview app signup uses a separate persisted `app_signup_policy`
  installed by the approved Auth membership worker. The policy binds the Auth
  resource, exact origin and app path, app, organization, eligibility, member
  role, explicitly approved app roles, operation, and approved plan digest.
  The worker adds only that app to the selected organization and persists the
  policy before Builder invites ordinary users. Auth enrolls the actual
  Better Auth user id into that organization with `member` membership and only
  the policy's app roles. It does not use the all-app `dev` organization or
  infer administrative owner access. Private readiness requires an unexpired
  signed-in session, matching membership, and all planned app-role assignments.
- `BETTER_AUTH_API_KEY`: server-only Better Auth Infrastructure credential.
  It is required in Vercel Production, ignored outside Vercel Production, and
  must never have a `VITE_` counterpart.
- `AUTH_RECOVERY_RESEND_API_KEY`: a separately supplied server-only Resend key
  restricted to sending from the approved recovery domain. Never substitute or
  copy the Production Better Auth Infrastructure key into Preview.
- `AUTH_RECOVERY_EMAIL_FROM`: the verified sender email address for recovery.
  Both settings are required before recovery controls and routes are exposed.

## Managed Production app invitations

`PLATFORM_REALM_OPERATOR_LINK_CONFIG.managedProduction` enrolls an existing
Production resource without reclassifying it as Preview. It binds the native
project, public origin, repository, Builder workspace, exact Auth resource and
authorized organizations. This mode requires the existing managed recovery
sender (`AUTH_RECOVERY_RESEND_API_KEY` and `AUTH_RECOVERY_EMAIL_FROM`) for
invitation delivery; it does not enable generic Production password signup.

The platform operator activates this on the existing Production Auth resource:

1. Resolve the repository/workspace profile to its exact Auth database and
   schema owner/runtime roles. Create a dedicated, unprivileged app-access
   login and set `AUTH_MANAGED_OPERATOR_ROLE` when planning the enrolled schema
   migration with that `AUTH_DATABASE_RESOURCE`. Use the fixed
   `auth-protected-schema` worker with the approved role and plan digest. The migration includes
   `provision-organizations.sql` and `runtime-privileges.sql`: the invitation
   tables, verified-session functions and restricted runtime grants are all
   required. The managed operator profile also installs the fixed row-lock
   helpers and app-access grants from `operator-locks.sql` and
   `operator-privileges.sql`. Keep the schema owner's credential in the
   migration channel and bind only the restricted app-access login to Builder's
   Production operator. Legacy `db-provision` without the resource follows its
   legacy path.
2. Configure the Auth host with the same `AUTH_DATABASE_RESOURCE`, restricted
   `PLATFORM_AUTH_DATABASE_URL`, and matching managed Production realm. Bind its
   native sender to the Auth project's Production identity and the protected
   operator's exact `operatorOrigin`; preserve the existing Preview profile.
   Managed Production needs only `identityHandoff.sender`; Preview browser
   capture and read-only attesters are not required. A configured optional
   browser capture sender must still match the same Production workload.
3. Supply the managed sender settings above. Newly invited accounts can use
   the normal Forgot password flow to set or recover a password after their
   one-use sign-in; this does not reopen general signup.
4. Native provider deployment activates the configured host. Future enrolled
   migrations must retain the same resource binding and protected authority;
   the legacy deployment migration path must not be treated as an enrolled
   migration. Builder creators never supply these infrastructure settings.

This is service configuration and schema compatibility, not a separate app
release qualification or synthetic Preview requirement.

The fixed `auth-protected-app-access` worker accepts an approved
`authAppAccess` operation and `authOperatorRole` in `operator-plan.json`, using installer
`auth-app-access-v1` and effect `auth-app-invitation`. Requests are `list`,
`list-members`, `read`, `create`, `link-creator`, `send`, `renew`, `cancel`,
`prepare-member`, `complete`, and `set-access`. Every request includes an app and organization
scope. The readback variant accepts only the three read operations. `set-access`
is the Auth-only operation for frontend apps; the protected Builder host must
use the generated installer for data-backed applications.
Production workers bind the app-access login in their approved plan separately
from the existing Auth resource identity. This preserves creator and invitation
bindings across service rollout. The login can read the identity fields required
for enrollment and manage scoped access. Account secrets, organization roles,
schema ownership, and schema migration authority stay outside its grants.
The Production `join-existing-organization` effect and its readback require this
restricted login. Separately approved owned-organization and signup-policy
operations retain their migrator credential path, including readbacks; the
app-access login does not acquire those authorities.

The normal Auth routes handle the emailed one-use link and
`/api/auth/platform/app-invitation/accept`. Acceptance records the verified
account/session, then calls the protected operator's fixed
`/v1/repository-production/access/complete` endpoint with native workload
authority. The operator verifies the saved inviter and app scope, completes
membership and app access, and responds with `{version:1,status:"ready"}` or
`{version:1,status:"pending"}`. Only then does Auth return to the saved app or
Builder URL. Neither passwords nor emailed tokens enter Builder chat.

After a creator links their account once, the protected Builder host may use
`link-creator` for a new app. It binds the new invitation to a saved accepted
invitation, exact scope digest and actual actor in the same workspace/Auth
resource. The host must verify that the saved link belongs to the current
canonical Builder owner. Auth rereads the current verified account; it does
not identify the person by email or require the original sign-in session to
remain live. This path can initialize a fresh unsent app invitation only. It
cannot restore an app with prior grant/tombstone records or reopen a completed
app's membership preparation. Ordinary invitees still verify their own account.

## Existing-account password recovery

Managed Production apps stay private by default. An installed, enabled app signup
policy can expose signup only for its exact app URL. The normal Production Auth
instance keeps password signup disabled. Its HTTP adapter resolves the app policy
and email eligibility before allowing a separate signup request, then rechecks the
policy before creating the user. Direct signup requests without that policy fail
before user creation. This path does not use generation-zero Auth enrollment.

New self-signup accounts must verify their email before app admission. The existing
platform Resend sender delivers Better Auth verification links back to the same
Auth origin and app continuation. Auth reads the signed-in identity and claims the
installed policy; the existing protected access callback reconciles the actual app
grant. A callback response alone is insufficient: Auth re-reads current positive
access before opening the app. Unknown completion stays pending and retries the
same claim. Existing positive app access and legacy private-account sign-in retain
their existing behavior; email verification is not made a global sign-in requirement.
The existing signup-continue route accepts an email GET only with expiring state
signed by the Auth secret and bound to the actual user, current policy digest and
canonical app URL. Missing, changed or cross-user state cannot claim access.
Ordinary sign-in continues through the existing same-origin POST; simply opening
a signup page with a session cookie never enrolls a Production app.

Settle affected Production operations before switching the deployment-owned
`REPOSITORY_PRODUCTION_CONFIGURATION` to compatible Auth-management and
generated-app access worker descriptors. Production resolves those descriptors
dynamically; legacy Preview operations retain their immutable worker pins and
are a separate compatibility boundary. The new verifier supports existing private
commands with the pre-migration schema and privileges while retaining its maximum
privilege allowlist. Select compatible workers before extending the operator's
grant profile; keep older pins as records rather than executing an older strict
allowlist against extended grants. Apply and read back the reviewed additive Auth
migration through the existing protected schema path before activating the new
Auth runtime or enabling a managed signup policy. An older worker's stricter
allowlist will reject the extended grants, including on private access commands.

The protected platform schema-proposal input may explicitly include
`authOperatorRole` for Production. It is bound into the returned plan, target
digest and operator-privilege effects using the planner's existing role checks;
omission retains the legacy proposal. Preview cannot acquire this authority.
An existing-resource proposal must include the separate private
`directMigrationUrlFile`; a `new-empty` proposal cannot substitute for its actual
schema readback. No role or connection is inferred from caller environment.

The sender is configured per Auth deployment, not provisioned per generated app.
Autograph owns the sending domain and sending-only runtime key; provider management
credentials stay in provisioning custody. Reuse the sender binding on retries.
Rotate by installing the replacement key on the same Auth deployment, deploying
fresh configuration, verifying actual receipt, and then revoking the old provider
key. Production and nonproduction credentials remain separate. This package sends
messages; it does not create, rotate, or revoke provider keys or domains.

Configure the approved Resend account and verified sending domain before enabling
this capability. Shared Auth exposes Forgot password, reset-link confirmation and
Reset password through the normal `/auth` UI and Better Auth API. Missing or
incomplete sender configuration keeps recovery hidden without changing ordinary
sign-in or signup policy. Runtime configuration creates no provider account,
project, subscription, database, user or membership.

Better Auth issues and consumes its expiring reset token for the existing user.
Its reset callback uses the maintained Resend SDK with a sending-only credential,
so Preview never needs the Production dashboard key. The plain-text email contains
the normal Better Auth callback link. In Vercel, native `waitUntil` retains delivery
after the generic response so delivery latency does not disclose account existence.
The confirmation proves neither account existence nor delivery. Delivery failures
expose only a closed error, never a key or reset link. Reset revokes that user's
previous sessions; other users, organizations and app grants are unchanged. The
user chooses the new password in the secure reset view and signs in normally
before private test-session capture. Never return tokens or passwords to Builder
chat or logs. Keep open/click tracking disabled for recovery messages.

References: [Better Auth email delivery](https://better-auth.com/docs/concepts/email),
[Resend Node.js SDK](https://resend.com/docs/send-with-nodejs),
[sending-only API keys](https://resend.com/docs/api-reference/api-keys/create-api-key).

## Other authentication configuration

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: configure the server-side
  Google OAuth provider for existing-user sign-in. Preview omits this provider.
- `OAUTH_PROXY_PRODUCTION_URL` and `OAUTH_PROXY_SECRET`: required whenever
  Google sign-in is enabled. The URL is the path-free HTTPS production origin
  `https://apps.autograph.so`; the dedicated secret is shared only across
  production, preview, and local environments administered by the same trusted
  operators. Do not distribute it to an untrusted environment, and never reuse
  Better Auth session-secret material.
- `VITE_PLATFORM_AUTH_SOCIAL_PROVIDERS`: comma-separated browser-visible social
  providers for existing-user sign-in in the default app build. It has no
  effect in Preview or on signup views. Leave it unset for normal local
  development so seeded email/password login works without Google Cloud Console
  changes. Set it to `google` only when the server has `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` and the OAuth proxy variables are configured. The
  shared UI keeps Google hidden by default until an
  app explicitly passes Google in `socialProviders`; it does not infer UI
  providers from server secrets.

In Vercel Production, Preview, and Development, the server trusts exactly the
provider-controlled `x-vercel-forwarded-for` header when Better Auth records a
session's client IP. Generic forwarded headers are not fallbacks, and explicit
IP-header trust remains disabled in local and non-Vercel runtimes. Redact
recorded IP addresses from logs, screenshots, and retained QA evidence.

Configure Google OAuth with only
`https://apps.autograph.so/api/auth/callback/google`. Better Auth dynamically
accepts the configured Production and loopback hosts without a fallback.
Eligible Local sign-in flows proxy provider exchange through
Production, then create their session in the initiating environment. Preview
does not instantiate the Google provider. Explicit trusted origins remain
additive.

Vercel Production and Development must each carry
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_PROXY_PRODUCTION_URL`, and
`OAUTH_PROXY_SECRET` when Google sign-in is enabled. Operators configure the
complete tuple explicitly for opted-in local shells, keeping the local Auth
database, `BETTER_AUTH_URL`, and Better Auth session secret separate from hosted
values. Deployed auth still validates the complete tuple
at its existing runtime boundary; the deployment rollout installs it in all
Vercel targets.

Better Auth 1.7.28 derives its encryption keys differently from 1.7.3, so every
environment sharing the OAuth proxy (`OAUTH_PROXY_SECRET`) must upgrade
together; sign-ins in flight during the deploy must be retried, and no stored
accounts are affected.

For local development, `mise run auth:oauth:doctor` reports the current local
return origin, the stable production callback, and credential/secret presence
without printing credential or secret values. It exits unsuccessfully with the
local fnox/environment and three-environment remedy when configuration is partial.
Worktree shell ports remain dynamic, but no local callback registration is
required.

## Better Auth Infrastructure Dashboard

Vercel Production registers the Better Auth Infrastructure `dash` server
plugin and the browser auth client exposes the keyless `dashClient` bindings.
Preview and local auth do not register the server plugin, even if a stray
`BETTER_AUTH_API_KEY` is present. The initial integration deliberately leaves
Sentinel and `activityTracking` disabled, so it adds no `lastActiveAt` column
and does not change the auth schema.

The private platform composition supplies `Autograph` as the non-secret,
source-controlled `BETTER_AUTH_APP_NAME` runtime/build setting in every
environment, including schema tooling. The reusable auth package requires,
validates, and forwards that generic configuration without owning a
product-name constant. Runtime entrypoints reference
`process.env.BETTER_AUTH_APP_NAME` directly. The private Shell adapter exports
the exact value through `shellPublicBuildEnvironment` from
`@autograph/platform-microfrontends/shell/config`; the neutral Shell builder
validates that plain string record and gives it to Next for static substitution.
The Vercel Gateway wrapper installs the same exact value before dynamically
importing the Gateway runtime. Schema and CLI tasks inject it explicitly. The
Better Auth Infrastructure project is also named `Autograph`, keeping the
provider project and Better Auth display identity aligned.

The root runtime, `@autograph/auth`, Better Auth CLI, and memory test adapter must
remain on the same Better Auth patch. Their dependency graph must also resolve
one shared `better-call` runtime with `@better-auth/infra`. A split peer context
can leave event delivery healthy while adapter-backed signed Dashboard routes
fail at runtime. The auth dependency-identity test enforces both the lockstep
patch and the single `better-call` lockfile entry.

The Infrastructure Dashboard performs administration through its own server
proxy, so signed mutations do not rely on browser `Origin` or fetch-metadata
headers. Production Gateway recognizes only compact bearer-JWT mutations under
the exact `/api/auth/dash/*` prefix and forwards the bearer unchanged; it does
not validate or authorize the JWT. Preview and local Gateway runtimes do not
install that transport exception. The Better Auth `dash` plugin remains the
sole authorization authority for every Dashboard endpoint.

The Next auth route handles Infrastructure's proxy metadata only for
`/api/auth/dash/*`: when the production plugin is active and the request URL is
the stable `apps.autograph.so` auth host, a `Host` or `X-Forwarded-Host` value
of `dash.better-auth.com` is normalized back to `apps.autograph.so` before
Better Auth resolves its dynamic base URL. Better Auth admits the exact
`https://dash.better-auth.com` trusted origin only when the signed Dashboard
plugin is configured. The normalization does not run
for other auth routes, Preview, or local development. No fallback URL is
configured, and every Dashboard endpoint still requires its signed JWT. The
normalized request is reconstructed from its primitive URL, method, headers,
and body stream rather than cloned as a request object, because Vercel's Next
request can come from a different bundled `Request` class with incompatible
private runtime state.

Gateway route authorization evaluates Better Auth directly in the public
Gateway Service. Vercel's Production Services rewrite may present that service
as `gateway.<provider-id>.services.vercel-infra.com`; the Gateway creates an
auth-only header view on the checked `https://apps.autograph.so` origin only
for that exact provider-Service shape, the provider ID bound by
`SHELL_SERVICE_ORIGIN`, exact `apps` deployment configuration, and HTTPS
forwarding tuple. It preserves cookies and browser-origin metadata, does not
mutate proxy headers, and emits only a fixed-enum ingress receipt.
Preview, local, sibling-Service, malformed, and lookalike requests are not
rewritten, and Better Auth's allowed-host policy remains unchanged.

Shell auth routes and authenticated app reads reach their private Services
through Vercel bindings, which rewrite the request host to
`<service-name>.<provider-id>.services.vercel-infra.com` after the Gateway has
sanitized the public forwarding headers. Route-owned auth normalizes that host
only when the exact Service name, HTTPS provider-host shape, Production
environment, and Gateway-owned `x-platform-public-origin` receipt match the
checked `https://apps.autograph.so` origin. Each caller supplies its own
catalog-owned Service name (`apps` for Shell and `spend-review` for Spend
Review). Other Service names, infrastructure lookalikes, public deployment
hosts, ports, and non-Production requests are not rewritten. Missing, foreign,
malformed, sibling-Service, and lookalike inputs remain unchanged and fail
Better Auth's allowed-host policy; the provider-private host is never added to
that allowlist.

The server plugin sends new authentication and organization event metadata to
Better Auth Infrastructure in the background. Audit history begins when the
plugin is deployed; existing events are not backfilled. The external dashboard
queries and manages current users, organizations, members, and sessions through
signed `/api/auth/dash/*` endpoints. Those endpoints can perform auth-state
changes such as revoking sessions, so dashboard administrator access is a
production authority. Unsigned requests fail closed.

The keyless `dashClient()` bindings also expose session-authenticated audit
queries at `/api/auth/events/audit-logs` for the current user and optional
organization, and `/api/auth/events/all-audit-logs` for organization owners and
administrators across the organizations they manage. These routes authorize
against the current authenticated session and organization membership; they are
separate from the Infrastructure dashboard's signed `/api/auth/dash/*`
administration boundary. No application UI consumes them in this rollout.

The production project is named `Autograph`. Create it in Better Auth
Infrastructure with auth endpoint `https://apps.autograph.so/api/auth`, then
store its API key only as the Production `BETTER_AUTH_API_KEY` on the Vercel
`autographing/apps` project. Human administrators use named project membership
at `https://dash.better-auth.com`; the API key is not a human login credential.
Keep membership least-privileged, remove access after offboarding or role
changes, retain an owner/access-recovery record, and obtain explicit owner
approval before removing an unexpected administrator.

For rotation, issue a replacement, replace the Vercel Production secret, and
redeploy. Before revoking the predecessor, verify the production alias serves
the intended commit, `/api/auth/dash/validate` succeeds, current user,
organization, and session inventories load, a controlled fresh authentication
produces its audit event, and runtime logs are clean. With overlapping keys,
restore the predecessor secret and redeploy if validation fails. Without
overlap, coordinate a maintenance action with an explicit downtime and recovery
plan.

The dated, source-linked Better Auth best-practices compliance matrix and live
provider observations are canonical in
[`docs/deployment-security.md`](../../docs/deployment-security.md#better-auth-best-practices-audit-2026-07-18).
It records two intentional follow-ups without changing runtime behavior:
Vercel rate-limit counters remain instance-local until shared storage is
adopted, and email signup permits duplicate-email enumeration during controlled
public-signup windows until automatic sign-in is disabled or verified email is
available. Sentinel, SSO, activity tracking and joins remain disabled rather
than being enabled merely to satisfy an inapplicable plugin checklist.
Transactional email is opt-in only for the configured existing-account recovery
flow above; it does not enable unrelated messaging or the Preview dashboard.

## Schema Operations

Auth schema creation is an automatic deployment-check operation, not a Vercel
build or request-time fallback. Runtime auth handlers and every Vercel Service
build must never create schemas, create tables, or run Better Auth migrations.

- Generate checked-in SQL with `mise run auth:schema:generate`.
- Provision Better Auth migrations and organization assignments with `mise run
auth:db:provision`.
- Verify a configured database without writing with `mise run auth:schema:check`.

`mise run setup` already runs `mise run setup:auth`, which applies the
migration, verifies the schema, and bootstraps local users for local
development. On Vercel, the `vercel.deployment.ready` repository-dispatch
workflow runs `mise run auth:db:migrate-deployment` against the exact native
deployment target, then reports the Production Deployment Check. Preview
dispatches retain the SHA only as data: a no-secret PR workflow emits a
SHA-bound, additive SQL artifact that the trusted default-branch runner
validates and applies. It never checks out or executes Preview source with
database or Auth credentials. Vercel holds
the built Production deployment until that check passes and owns its automatic
domain assignment. Product projects and Service builds never receive this
migration authority. Production uses the reviewed primary Neon branch;
Preview resolves only its existing `preview/pr-<number>` Neon branch from the
dispatched commit and never uses that lookup to select or promote a Vercel
deployment.
Neon currently emits `sslmode=require`; the Auth boundary normalizes that exact
native value to `verify-full` before `pg` sees it so hostname verification
remains explicit across the pg 9 semantic change. The Shell build rejects
missing, non-Neon, unnamed, Production, or wrong
Production/Preview-identity targets; no cross-project release graph or
application storage materialization is involved.

The provisioning command is idempotent. It converges HC, Vendor, and Dev to
their documented app assignments and grants existing users in the configured
organization email domain a missing Dev `member` membership without changing any existing membership or
role. Public Local/Preview email signup also grants the new user an idempotent Dev
membership through the Better Auth user-create hook; browser input cannot
change that organization or its app assignment. The same hook converges a
signup-created session with no active organization onto Dev so first-session
app routing uses the server-owned all-app membership immediately.

## Local User Onboarding

`mise run setup` seeds the local `dev` organization, the fallback
`admin@apps.localhost` user, and a user for `git config user.email` when it
is set. Seeded users get `dev` owner membership automatically, so a new
checkout should only need `mise run setup` and `mise run start` before signing
in locally. The default seeded login is `admin@apps.localhost` with password
`local-apps-admin`.

For a pre-existing local user that lacks a `dev` membership, grant local tenant
access with:

```sh
PLATFORM_AUTH_USER_EMAIL=user@example.com mise run auth:user:grant-local-access
```

The task creates or updates the user's membership in `dev` and sets their
active local sessions to that organization. See
[`docs/guides/developer-onboarding.md`](../../docs/guides/developer-onboarding.md)
for the full local onboarding path.

### Public realm signup and account capture

`PLATFORM_REALM_OPERATOR_LINK_CONFIG.publicEnrollment` is a new explicit
server-owned enrollment. It binds a pre-frozen enrollment reference to the
owner, app, creation session, normal project, public origin and exact original
Auth resource receipt. The resource classification remains unchanged when
Vercel delivers the public domain in Production. Production callbacks require
the explicitly configured native Production workload and the matching resource,
profile, origin and signing key; changing a Preview subject is unsupported.

The ordinary sign-in form carries fresh public release correlation alongside
the pending operator/account plan nonce. Signed proofs retain both scopes.
Builder independently resolves the READY approved public Auth bootstrap and
current owner before accepting the proof. Normal cookie capture remains a
private authorize-then-capture exchange with live same-session readback. The
installed signup policy must match the public origin and exact resource digest;
missing policy does not fall back to generic organization membership. Existing
Preview enrollment and approvals do not authorize this public lane.
