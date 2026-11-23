# Maintaining the Vercel Production proof

> **EXT-GW-04 closeout update (2026-08-24):** Production proof is read-only. Current Vercel
> project Production domains and deployments are the authority; the removed
> custom Gateway alias reconciler, exact-main selection, and Git-derived route
> authority are not recovery mechanisms. Live activation, rollback, and
> forward recovery are the external EXT-GW-02 procedure.

This guide describes current read-only provider proof.
The selected target uses the pinned MIT `@vercel/microfrontends` library with
the custom authenticated Gateway and explicitly excludes Vercel's paid
Microfrontends product.

Do not add a Git-selection predicate, paid-product fallback, or private Vercel
adapter here. Repository proof is read-only and is not activation authority.

This guide is the operational entry point for changing or diagnosing the
config-driven Production proof. The durable security contract remains
[Deployment security](../deployment-security.md#retained-production-proof),
and the checked topology remains
[Route-owned microfrontends](../route-owned-microfrontends.md#checked-topology).
Do not copy transient deployment IDs into code or configuration.

## Completion boundary

The retained Production proof is complete when all of these provider and route
facts are current:

- a successful same-repository default-branch CI run triggered the protected
  read-only proof; its `ciSha` is diagnostic traceability, not activation or
  deployment-selection authority;
- provider read-back proves the current Gateway and product Production
  deployments, domains, route ownership, authenticated application paths, and
  direct-origin denial without movement during the proof;
- historical or in-progress non-current provider Production attempts do not
  select or invalidate the checked current READY binding;
- before session creation, bounded public auth-health reads establish readiness;
  a valid provider-current binding change during this phase requires a fresh
  health observation, including changes seen by the final alias assertion;
- a changed provider-current binding after session creation and route proof
  cancels the obsolete CD after its sanitized receipt is captured; readiness
  does not retry sign-in or replay an authenticated session;
- the accepted EXT-GW-01 and EXT-GW-02 receipts still supply the separately
  authorized rollback and forward-recovery evidence, and EXT-GW-03 proves the
  legacy stable-Preview aliases remain absent; and
- the private source-only candidate is reproducible, anonymously consumable, and
  free of Autograph policy, credentials, identities, private origins, and
  operational receipts.

The standard microfrontend configuration is the fleet authority: each
subsequently registered non-default application joins project capture,
route proof, and direct-origin denial without a workflow allowlist. Current
three-app completion does not prove a future fourth application's provider
lifecycle.

The proof derives capabilities from the evaluated root Services graph. Frontend
Service names use the standard catalog project identity (for example, `hc`);
private sidecars use that identity as their prefix (`hc-api`). The
`check:vercel-services` gate loads this same graph through the production topology
reader, covering private API bindings, callback routes, and frontend-only apps
before CD consumes it.

No repository workflow chooses or moves a Production deployment as part of
proof. A provider mutation or recovery drill is a separate external operation
with a fresh exact-scope approval and sanitized receipt.
## Invariants that must survive every change

- `apps.autograph.so` is the only public Production Gateway. Product Services
  receive no Better Auth secret and direct immutable product origins must stop
  at Vercel protection before application execution.
- The proof uses only protected `PRODUCTION_QA_EMAIL` and
  `PRODUCTION_QA_PASSWORD` credentials. Never restore a retained
  `PRODUCTION_QA_SESSION_COOKIE` or add a fallback to one.
- Each run signs in through `https://apps.autograph.so`, accepts exactly one
  secure `__Secure-better-auth.session_token` cookie, proves the same session at
  `/api/auth/get-session`, uses it for all registered route checks, signs out in a
  `finally`-equivalent cleanup path, and proves invalidation.
- The non-personal QA actor belongs to the one synthetic Production-proof
  organization, has explicit HC, Spend Review, and Vendor assignments, and has an
  organization role of `admin` or `owner`. A plain `member` can pass session,
  tenant, assignment, OIDC, and private-hop checks but still correctly receive
  the HC, Spend Review, or Vendor application's final HTTP 403 policy denial.
- Do not change a persistent QA membership, credential, tenant, or assignment
  from a proof run. A one-row correction requires explicit repository-owner
  authorization, exact actor/organization/source-state checks, a guarded
  transaction, session revocation, and read-back before traffic mutation.
- Route success requires authenticated HTML HTTP 200 at every registered
  application's canonical mount path, plus Gateway-owned application and
  route-origin headers. A source-owned canonical launch redirect may occur
  once only for a browser-followed 301, 302, 303, 307, or 308: it must remain on
  the exact Gateway HTTPS origin and under the registered mount, have no
  credentials, query, or fragment, and preserve the exact ownership receipt.
  The route-origin alias is re-read after the terminal response and must still
  name the captured immutable deployment. Redirect chains and every other
  redirect are terminal. A mutable route-origin alias is bound separately
  to the immutable deployment receipt; it is not itself immutable identity.
- Shared proof checks registered launch routes, authentication, and Gateway
  route ownership. It does not consume app-declared readiness endpoints or
  JSON shapes, and does not claim application schema, storage, or business
  readiness. Those checks remain app-owned and are not generic CD gates.
- Exact project, target, readiness, deployment, and domain receipts are
  mandatory. Git repository, pull-request, merge, ancestry, freshness, and
  source-SHA metadata may be retained as diagnostics but never decide which
  provider deployment is current.
- Read-only proof captures the fleet before route checks and requires the same
  deployments and domains afterward. Rollback and recovery are outside proof;
  their accepted receipts must show one-product movement, sibling immobility,
  and exact forward recovery.
- Logs and artifacts contain only the bounded `status.json` schema. Never add
  cookies, credentials, identities, response bodies, arbitrary provider
  errors, database identifiers, tenant identifiers, provider project/deployment
  IDs, deployment URLs, or private Service origins. Receipt v2 records only
  sanitized project labels, readiness/binding classifications, route paths,
  ownership classifications, and the diagnostic `ciSha`.

## Protected environment prerequisites

The GitHub `production-proof` Environment supplies exactly these proof inputs:

- `PRODUCTION_QA_EMAIL`: the existing non-personal synthetic actor;
- `PRODUCTION_QA_PASSWORD`: its protected credential;
- `VERCEL_TOKEN`: the scoped provider control-plane credential; and
- `VERCEL_TEAM_SLUG`: the non-secret Vercel scope variable.

Only the `Prove (Production Microfrontends)` job in `cd.yml` may consume the
QA credential pair.
The external EXT-GW-02 activation owner obtains any separate mutation authority.
Never print a secret value while checking this configuration; list names and
update timestamps only.

Before diagnosing code, verify the non-secret Production QA predicates through
the existing guarded operational path: exactly one eligible synthetic actor and
organization, `admin` or `owner` membership, Dev/HC/Spend Review/Vendor assignments, and no
unexpected live session retained from an earlier run. Do not use a personal
account as a substitute.

## Required execution order

The one supported sequence is:

`Git push → one native Vercel Services deployment → provider-owned atomic activation/rollback → Gateway routing → read-only CD proof`.

1. Vercel's native Git integration builds and activates the one root Services
   project. Repository CI/CD does not
   deploy, promote, alias, roll back, or select them.
2. A successful same-repository default-branch CI run scopes repository CD.
   The active Arrusted instance runs the lanes because its repository-level
   `REPOSITORY_RELEASE_ENABLED` value is exactly lowercase `true`; generated
   repositories remain disabled by default. The safety job receives the `vars`
   value as an environment input and compares it case-sensitively in Bash. Its
   external activation receipt must prove the repository-level source and the
   absence of a shared organization substitute; the workflow token cannot read
   the Variables API itself.
3. Let the serialized `Prove (Production Microfrontends)` job run in read-only
   mode. `main` may advance while the proof runs; no Git freshness check cancels
   or invalidates the provider receipt.
4. Inspect only the allowlisted receipt-v2 `status.json` fields. Require
   `receiptVersion=2`, `mode=read-only`, `terminal=passed`, one diagnostic
   `ciSha`, one
   provider-current eligibility receipt per checked project, every registered
   route receipt, every required direct-origin denial, and no failure receipt.
5. Confirm the provider deployments and route bindings captured at the end are
   identical to the proof baseline. Any movement, unreadable state, ambiguity,
   authentication failure, readiness failure, network/timeout error, or provider
   4xx/5xx fails closed.
6. If a provider activation, rollback, forward recovery, credential rename, or
   cleanup is required, stop. Use a separately approved external package, then
   merge and accept its sanitized receipt before returning to step 2.

The sibling Ampersand lane may use source order only to protect its own manifest
mutation. A superseded manifest candidate is a successful no-op and cannot
skip, fail, or change Vercel proof or Gateway routing.
## Failure classification and action

| Classification       | Meaning                                                                                                     | Allowed action                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `configuration`      | A required secret name, exact receipt, topology predicate, or bounded output contract is invalid.               | Inspect sanitized inputs and current provider state. Do not retry or mutate from the classification alone.       |
| `sign-in`            | Credentials or the exact secure session-cookie response were rejected.                                      | Verify the protected credential and synthetic actor state. Never fall back to a static cookie.                   |
| `recognition`        | Sign-in returned a cookie but Shell did not recognize the session.                                          | Stop the run and inspect the shared session contract. A retry must remain bounded and read-only.                  |
| `route-access`       | The recognized actor was denied by a product policy.                                                        | Stop immediately. Verify organization role and app assignments before changing auth, routing, or provider code.  |
| `route-ownership`    | A route did not bind to the expected Gateway application, product alias, and immutable deployment.          | Stop immediately and compare exact provider receipts. Do not weaken ownership assertions or move a deployment.  |
| `direct-denial`      | A direct product origin reached application behavior or did not match the exact provider denial contract.   | Treat as a security failure. Any recovery mutation requires its own approved external package.                   |
| `cleanup`            | Sign-out or post-sign-out invalidation was not proved.                                                      | Treat as terminal. Revoke sessions only through the separately authorized identity-operation path.              |
| `provider-transient` | A bounded network, 429, or provider 5xx condition occurred.                                                 | Let the bounded read retry policy exhaust, then fail closed. Never reinterpret it as deployment absence.         |
| `provider-replacement` | The provider-current Production binding changed between the proof baseline and final read-back. | Cancel the obsolete CD after uploading its sanitized receipt. A later CD run proves the new current binding. |

Credential rejection, route denial, ownership mismatch, direct-denial failure,
cleanup failure, and unclassified failure are terminal
for that run. Only the existing bounded read policy retries eligible transient
reads. No proof failure authorizes alias movement, promotion, rollback,
credential mutation, or a broader trusted-origin policy.
## External activation and recovery contract

Repository Production proof is read-only. It exposes no rollback mode and
contains no provider-mutation fallback. The accepted EXT-GW-01 and EXT-GW-02
receipts are the terminal evidence for disposable and retained rollback plus
exact forward recovery. The EXT-GW-03 receipt separately proves removal of the
legacy stable-Preview aliases. Historical receipts are evidence for only their
named source and provider pins; they never authorize another operation.

A future activation or recovery package must preserve the narrow provider
contract already proved by EXT-GW-02:

1. Revalidate exact project, deployment, readiness, domain, no-active-job, and
   sibling preconditions serially.
2. Submit only the one explicitly authorized mutation.
3. Treat an accepted HTTP response as request acceptance, not completion.
4. Require a fresh, correlated, terminal provider job and exact domain read-back.
5. Reject rolling release, replacement jobs, third deployments, sibling
   movement, or ambiguous state.
6. Do not blindly retry a mutation after an ambiguous client result.
7. Use only the captured prior READY deployment for package-authorized recovery.
8. Run a fresh protected read-only Production proof after exact recovery.

The provider's native Instant Rollback defect observed during the original
closeout does not widen this contract. External packages use only the exact
operation and recovery path named in their fresh approval.
## Evidence-first modification procedure

Before opening a PR, identify the first failed invariant and prove it with
bounded, non-secret evidence. One failed workflow should produce one diagnosis,
not one speculative patch.

1. Download `production-microfrontends-proof/status.json` and inspect only its
   allowlisted fields.
2. Treat its `ciSha` only as the CI run that caused the diagnostic proof; do not
   compare it with current `main` or use it to select provider state.
3. Separate control-plane state from data-plane behavior:
   deployment readiness, active public alias, Shell session recognition,
   Gateway authorization, product policy, route ownership, and direct denial
   are distinct gates.
4. Reproduce the exact contract locally with fixtures before changing code.
5. Change only the owner of the disproved contract. Do not bundle host
   normalization, auth policy, origin policy, readiness, retry, or receipt
   changes when the evidence names only one boundary.
6. Update this guide and `deployment-security.md` in the same PR whenever the
   accepted provider or security contract changes.

Use these focused repository gates for a proof-contract change:

```sh
mise exec -- bunx vitest run \
  .config/mise/scripts/repository/__tests__/production-qa-session.test.ts \
  .config/mise/scripts/repository/__tests__/production-microfrontends-proof.test.ts \
  .config/mise/scripts/repository/__tests__/production-microfrontends-workflows.test.ts
mise run check:microfrontends-deployment
mise run check:vercel-services
mise run test:gateway-contracts
```

Workflow changes select the canonical `check:github-actions` HK step, which
runs the pinned actionlint release in both pull-request static checks and
exhaustive main CI. Also run the task-scoped repository gate.
After merge, repeat the complete execution order above; a green pull-request
head is not Production closeout evidence.

## Change ownership map

| Change                                                                         | Canonical implementation                                               | Required paired documentation                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------- |
| QA sign-in, cookie, recognition, cleanup, classifications                      | `.config/mise/scripts/repository/production-qa-session.ts`             | This guide and `deployment-security.md`       |
| Registered-application receipts, route proof, direct denial                    | `.config/mise/scripts/repository/production-microfrontends-proof.ts`   | This guide and `deployment-security.md`       |
| Protected CD job and artifact boundary                                        | `.github/workflows/cd.yml`                                             | This guide                                    |
| Sensitive Gateway key cutover                                                  | Protected rename dispatch plus a separately approved external activation package | This guide and `deployment-security.md` |
| Route/Service topology                                                         | `microfrontends.json` and root `vercel.ts`                             | `route-owned-microfrontends.md`               |
| Reusable provider control-plane parsing and protected transport                | `packages/microfrontends/src/vercel/`                                  | `deployment-security.md` and focused fixtures |

## Follow-up ownership

These items do not invalidate the single-project Services Production contract:

- A-236 owns monitoring, alert delivery/read-back, retention, spend warnings,
  and operational runbooks. Its implementation remains open until its own
  exact-head and hosted evidence gates pass.
- root `microfrontends.json` is the standard Vercel topology source.
- A-360 owns deriving deployed-smoke and rollback capabilities from checked app
  semantics instead of fixed current-product maps.
- A-361 owns a guarded one-command provider onboarding workflow.
- A-363 owns disposable provider-resource creation and ownership-safe teardown
  proof.
- A-364 completed the first private-package split. A-394 completed extraction
  of reusable Vercel origin validation, read-only lookup, retry, protected
  transport, and paid-product rejection into `@autograph/microfrontends`; only
  Autograph-specific policy remains in `@autograph/platform-microfrontends`.
- A-238 owns the open-source Gateway-core roadmap.
  A-367 completed the first private source-only candidate. A-395 completed the
  reproducible refreshed candidate after the reusable adapter extraction and
  selector removal. Publication and non-Vercel hosting support remain
  separately authorized future decisions.

Do not fold those improvements into an incident fix unless their own acceptance
criteria are intentionally taken over. Correctness, privacy, exact ownership,
and failed-closed recovery remain more important than reducing workflow time or
provider calls.
