# Isolated trusted Gateway project

This opt-in source layout has not been deployed or qualified. The existing root
`vercel.ts` and its legacy Services deployment are unchanged.

## Three Git-delivered projects

| Project              | Git root                                 | Entrypoint and authority                                                                                                |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Generated app        | Its ordinary `apps/<app>` Next workspace | Normal Server Components and Server Actions; own app runtime DB, public Gateway origin/JWKS only                        |
| Trusted Gateway/Auth | `packages/platform-microfrontends`       | Native Gateway Node function plus private default Next shell/Auth service; private Auth runtime and signing credentials |
| Protected operator   | Its reviewed separate operator workspace | Exact protected `/v1/runtime` handler; private approval/owner/resource dependencies and no app process                  |

The operator deployment adapter and its complete dependency factory are a separate
prerequisite. This change does not implement or deploy that service. A service
without ingress has only in-project bindings, so a cross-project operator HTTP
endpoint needs deployment protection plus existing workload and owner checks.

The trusted Gateway config defines only two services. Its sole native binding is
Gateway to the default shell. No app, app API, agent or operator service runs in
this Auth credential environment. Configure Vercel to include repository source
outside the selected project root, using the supported monorepo setting, for workspace
dependencies and the catalog. Both service roots are `.` within this project; the
Gateway uses `src/trusted-function.mts` and the shell builds to `shell/.next`.
Source inclusion does not authorize service roots outside the project. Normal
Git delivery builds each project; repository CI does not choose deployment
activation from Git SHA, PR membership or branch freshness.

### Managed Gateway Preview exception

The existing `autograph-gateway-preview` project uses this workspace root but
accepts only approved REST/integration Preview deployments. Its workspace
`vercel.ts` sets the literal `git.deploymentEnabled: false`. The selected project
root scopes this exception: `autograph-gateway-preview` uses
`packages/platform-microfrontends`, while `apps` uses the repository root and
its separate `vercel.ts`. Git admission must not depend on build-time project
environment variables. The previous project-ID condition omitted the opt-out
without that environment, and a fresh Git attempt was blocked before any build.

The root `apps` config and the shared trusted Gateway factory keep normal Git
delivery. The exception changes no repository connection, deployment-source
policy, service graph, or existing deployment. REST/integration deployments still
use the same config and existing provider approval policy. Do not substitute
`gitProviderOptions.createDeployments`, which controls GitHub deployment event
notifications rather than Git-triggered Vercel deployments.

This is source configuration, not a saved provider toggle or hosted proof. It
requires a separately authorized source publication before Vercel can consume it;
existing blocked Git statuses are historical and are not made successful by it.

## Published cross-project transport configuration

`PLATFORM_GATEWAY_PROJECT_BINDINGS` is private trusted-host configuration published
by the approved operator after provider readback. Its provenance literal describes
that publication; it is not proof of fresh observation. Each binding includes:

- `appId` selected from the repository catalog;
- `approved`: exact target project ID, owner ID, project name, scope slug,
  environment, deployment ID and immutable `deploymentUrl`;
- `observation`: the same fields normalized from the provider deployment response,
  including `readyState: READY`.

The projection's `source` contains the trusted Gateway project ID/owner/environment,
public origin and exact approved Vercel OIDC issuer, audience and subject. Runtime
compares provider-owned `VERCEL_PROJECT_ID` and `VERCEL_ENV` with that source. It
verifies every forwarded workload token's RS256 signature with public provider
JWKS and exact issuer/audience/subject/owner/project/environment claims. Request
headers cannot self-attest IDs. No provider administration token, static bypass
key or realm secret is passed to the app host.

The URL must match the exact approved provider-observed immutable deployment URL;
branch/Production aliases are rejected. URL syntax does not establish ownership:
resource ownership comes from the trusted publisher's provider observations and
approved binding. Missing, changed or cross-environment bindings fail closed with
no Production fallback. The optional trusted `observeDeployment` port can add
fresh readback; the source entrypoint does not supply it or claim live observation.

Only selected standard Next apps and the owned shell are retained in Gateway
routing. App requests use signed app-role/fence principals and verified provider
OIDC transport; the app still revalidates its current binding inside actual DB
transactions. Provider protection, source configuration and runtime JWT verification
do not prove human login, business behavior or installed app DB permissions.

## Reviewed setup effects before activation

1. Link the three distinct Git projects and confirm their project IDs, owners,
   environments, root directories and native service graph by provider readback.
2. Assign realm SQL/signing credentials only to the trusted Gateway/Auth project;
   assign operator credentials only to the operator; assign only the owned app
   runtime URL and `PLATFORM_PUBLIC_ORIGIN`, `PLATFORM_ORIGIN`,
   `PLATFORM_JWKS_URL` to the app project. Inspect actual delivered environments;
   a dictionary-filtered projection is insufficient.
3. Enable source Gateway OIDC. Configure each protected target's Trusted Sources
   for the exact approved source team/project/environment. A Preview Gateway
   must not be authorized as a Production source.
4. Observe the app's READY immutable deployment URL and target protection settings,
   review and publish the exact binding projection to the Gateway project.
5. Independently read back project/deployment identity, credential isolation and
   OIDC target protection; then verify hosted sign-in, protected reads/mutations,
   cross-app negatives, revocation and replay through the ordinary public boundary.

These are provider effects requiring coordinator approval and execution. This
source change performs none of them.

### Bootstrap order

An initial published projection may contain `bindings: []`. It starts only the
trusted shell/Auth/JWKS boundary; no app receives an authorization or route binding.
This permits observing the trusted deployment identity before app preparation.
Publish app bindings only after independent provider readback and approval.

Native shell bindings are unavailable to Function build imports. The catalog's
private shell address is used only for constructor validation. Actual forwarding
requires the current native Gateway-to-shell binding and never uses that address
as a fallback. Missing or malformed runtime bindings deny forwarding.
