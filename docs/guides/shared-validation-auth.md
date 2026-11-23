# Shared validation Auth

Use one absolute protected directory and one stable runtime ID for apps belonging
to the same synthetic local or Builder Sandbox context:

```sh
export APP_RUNTIME_CONTEXT_DIR="$(mktemp -d)"
export APP_RUNTIME_ID=my_context
mise run app:runtime prepare first-app local --checkpoint-only
mise run app:runtime prepare first-app local
mise run app:runtime prepare second-app local
mise run app:runtime run first-app test-e2e
mise run app:runtime cleanup second-app local
mise run app:runtime verify first-app local
```

The owning caller must retain/encrypt the context `state.json` before effects.
It is the only resource journal. App-specific restricted environments, identities
and cookies live under `apps/<app>/`; they are protected derived outputs, not
independent lifecycle journals. Keep the context outside the checkout. Never
provide `APP_RUNTIME_STATE_DIR` simultaneously. Shared Auth origin is frozen on
first reservation through `APP_RUNTIME_AUTH_ORIGIN` (default localhost:3000).
Changing an app's source/release retains Auth, app database and passwords.
A new context identity requires a new directory and runtime ID; do not rename
an existing identity into another context.

Two actors per declared role and tenant receive explicit per-app assignments.
Roles with the same name reuse context-local actors; assignment to one app does
not grant another app. Credentials and sign-in cookies remain private. App
processes receive only restricted runtime bindings, never context checkpoint or
installer credentials. Managed test tasks receive the selected private fixture
directory for the scoped helpers. The helpers resolve trusted temporary-directory
aliases above that directory and still reject linked private leaves. Apps in this
trusted first-party synthetic context share
one Auth runtime principal and credential. Explicit app assignments govern
application access; separate app databases/principals govern app-data access.
The Auth credential does not isolate malicious sibling app code. These local
fixtures do not establish hostile-code isolation or hosted behavior.

Local apps whose checked schema intentionally has no named business roles get
two admitted actors per tenant and a separate unassigned actor. Their private
identity entries use `role: null` with explicit `access: "admitted"` or
`access: "unassigned"`. Empty roles alone never prove access; old null-role
entries remain unassigned. Preparation binds the same positive admission fence
in Auth and the app database under the context's original resources. The
nonsecret `PLATFORM_LOCAL_APP_ACCESS` environment binding selects only that
owned local workspace and restricted loopback Auth database. A mixed managed
realm, foreign endpoint or credential override fails closed.
When launching a prepared local task, the runtime omits inherited
`AUTH_PRODUCTION_DATABASE_IDENTITY`, `PLATFORM_REALM_OPERATOR_LINK_CONFIG`,
`AUTH_DATABASE_RESOURCE`, and `PLATFORM_AUTH_DEPLOYMENT_PROFILE` before applying
the recorded local environment. Explicit recorded conflicts remain invalid;
nonlocal launches retain their existing selectors. Credentials and deployment
mode flags are unchanged.

Normal actor readback supports these admitted roleless identities and checks
actual tenant membership, current Auth admission and the matching kernel fence.
It continues to deny unassigned identities. App source owns private-per-actor
record requirements; roleless admission does not impose them on every app.

Local preparation initializes a positive kernel fence for each assigned human
fixture, including legacy active fixtures without one. Repeated preparation
preserves existing fences and does not reactivate a revoked kernel membership.
For local named-role fixtures, preparation copies the verified kernel fence
to its Auth assignment, so the Gateway signs the same generation the database
checks. It respects revoked assignments and conflicting generations.
Restricted browser readback uses the current Auth assignment and that exact
kernel fence. Local runtime verification also uses the assigned actor's current
positive fence, including when an existing roleless app gains named roles.
The retained principal's actor-binding requirement stays enabled through
re-preparation and database rehearsal. Verification rejects Auth runtime table
or column write privileges on app admission and invitation records; those
records remain operator-owned.

Cleanup is an explicit owned operation. It revokes that app's assignments and
organization enablement, drops its owned database/principal, and removes its
reference. Other app references, including unfinished preparations, preserve
shared Auth, sessions and the local cluster. The final reference permits owned
Auth/cluster cleanup. Cleanup retries inspect the same recorded resource IDs.
All effects are serialized by the context sibling `.lock` file. Recover a
crashed owner's lock only after independently verifying its PID has exited;
never remove a live owner's lock or discard a checkpoint to retry preparation.
The context retains diagnostic state on failure.

## Local shared-context backup and restore rehearsal

Run the repository-owned acceptance task against its own disposable local
PostgreSQL fixture:

```sh
mise run test:app-runtime-context
```

For an explicitly owned local context, `backup <app> local <bundle-dir>` captures
the shared Auth database, every recorded app database, and the protected app
fixture state. Choose an absolute bundle path outside both the checkout and the
runtime context. The private bundle contains database dumps, credentials,
signing metadata, and saved session cookies; keep it out of source control and
logs. Stop app and database clients before capture and keep them stopped through
the dump. Capture rejects detected client connections but does not stop clients
or prevent new writes. The independent database dumps do not claim an atomic
cross-database snapshot.

`restore <app> local <bundle-dir>` requires an empty
`APP_RUNTIME_CONTEXT_DIR` and the same `APP_RUNTIME_ID` frozen into the backup.
It restores Auth and all app databases into a newly owned loopback PostgreSQL
data directory and port, then verifies the restored identity and readiness.
Saved app/Auth identities, working-account passwords, signing secret,
assignments, sessions, and app data remain usable. A nonlocal environment,
mismatched runtime identity, incomplete bundle, or unverified destination fails
without a successful restore receipt. A partial failed restore keeps its private
context for explicit recovery and does not report readiness.

`restore-app <app> local <bundle-dir>` targets one recorded app in an existing
matching shared context. It replaces only that app database and its saved app
fixture state; shared Auth, sibling app databases, sessions, and credentials
remain owned by the existing context. The operation requires the exact frozen
resource identity and an idle owned local database before replacement.
It restores into an owned staging database and verifies the installed release
before switching names. If post-switch verification fails, it restores the
previous database and fixture files. A failed rollback reports the retained
previous database name for explicit inspection; it does not report readiness.

These commands and the acceptance task use disposable local resources only.
They do not establish hosted recovery, independent provider PITR, atomic
cross-database snapshots, or live RPO/RTO. A-516's local results are measured
fixture evidence; provider-history inventory is metadata, not restore proof or
a current retention promise.

On 2026-10-15, the local task passed on the repository worker in 175.96
seconds for the merged baseline, 119.36 seconds after the staged app-restore
repair, and 95.41 seconds with a post-switch rollback regression. It exercised
three logical dumps (Auth and two app
databases), a separate destination, a retained signed session and password
sign-in, restricted grants, app and tenant denial, app-only restore, restart,
owned cleanup, rejection of a corrupt app archive without losing current app
data, and a post-switch fixture failure that restored both the live database
and fixture files. These are elapsed test times, not recovery time objectives.
The last read-only provider inventory recorded six hours of Neon history, one
manual root snapshot from July 16, and no configured snapshot schedule. That
inventory was not a restore test and does not promise current retention.

A provider branch restore changes all databases on that branch, including Auth
and sibling apps. A per-app logical restore can isolate one app database but
requires a protected dump and reconciliation of Auth assignments and sessions.
Stronger recovery tiers need an approved recovery window, a retained and
tested backup schedule, an isolated restore target, a write-pause or replication
plan for cross-database consistency, verified credentials and signing keys,
read-back of app bindings, and a reviewed cutover and rollback procedure.

Existing version-1 per-app checkpoints use the original mode with
`APP_RUNTIME_STATE_DIR`; there is no implicit physical migration or Auth merge.
Preview still requires an explicitly approved isolated endpoint and Production
identity guard. These commands do not create hosted provider resources or bind
native deployment environments.

## Single-app Builder preview origin

A single-app local runtime initially prepared for validation may retain the
localhost Auth origin. When Builder's owned private preview obtains its actual
HTTPS `*.vercel.run` origin, the normal local `app:runtime prepare` handoff updates
that app's private checkpoint before regenerating Auth sessions and its restricted
environment. It preserves the same local PostgreSQL cluster, app/Auth databases,
identities, passwords and signing secret. The handoff requires the actual owned
loopback cluster, private owner-only checkpoint and unchanged recorded resource
identity/current origin. It permits only the initial localhost-to-private-preview
transition or an idempotent repeat. A different recorded public origin remains a
visible conflict unless the previous-origin match described below is supplied.

Shared-context origin immutability and approved hosted Preview resource guards
remain unchanged. This private preview handoff does not authorize hosted resource
changes or establish public-release/browser acceptance.

## Builder single-app local preview origin

An independently owned single-app local cluster can follow a resumed Builder
Sandbox's new provider preview origin. Builder reads the previous
`BETTER_AUTH_URL` from its exact private runtime environment and supplies it as
`APP_RUNTIME_PREVIOUS_AUTH_ORIGIN` alongside the new provider-issued
`APP_RUNTIME_AUTH_ORIGIN`. A rotation requires an exact previous-origin match;
its destination and prior hosted preview must be canonical HTTPS `vercel.run`
origins. The initial localhost handoff remains supported.

This changes only the recorded origin and regenerated local runtime bindings.
The loopback cluster identity, installer credential, private checkpoint owner,
permissions, and complete checkpoint compare-and-swap must still match. App
resources, data, Auth secret, and identities remain retained. Shared-context
Auth origins and nonlocal or Production-bound runtime state cannot use this
single-app reconciliation. An unknown or stale previous origin fails visibly;
Builder does not reset the checkpoint or reprovision resources to bypass it.

Private Builder working previews require a separate owner launch exchange before app requests. The shared normal-actor fixture consumes Builder's private `APP_TEST_PREVIEW_AUTHORITY_FILE`, verifies its exact origin and lifetime, and exchanges that capability through each context's real request jar. Its default anonymous context also crosses the preview gateway so application-denial tests reach application authorization. BetterAuth cookies remain unchanged. Use the normal-actor fixture for these browser tests; a plain Playwright page does not acquire preview or app access automatically.

The supported private configuration sets trace off and selects the owned bounded reporter while that file is present. That reporter retains test titles, statuses, a run outcome, and up to four failure line numbers in the same repository-relative test file. Recognized Playwright-shaped error messages also produce a closed, value-free diagnostic: an allowlisted matcher or operation, assertion negation, and a fixed reason such as a missing or ambiguous locator, assertion mismatch, action or navigation timeout, or known navigation network failure. Each diagnostic includes `basis: "error-message-signature"`: application errors can mimic these signatures, so the label is an inferred clue, not trusted Playwright origin. Verify it against the app-owned test and behavior before deciding on a repair; it grants no approval or access authority. A generic timeout does not establish that an element is missing. Unknown errors retain their failed outcome without inventing a cause. These observations reach Builder through the ordinary browser task output; a saved checkout receives reporter changes through normal source reconciliation, not a hot patch or a new reporter-version requirement.

The reporter omits locator arguments, expected and received values, page contents, URLs, arbitrary exception text, request steps, attachments, and worker output. Network diagnostics retain only a closed reason, never a response body or an inferred HTTP status from assertion values. A caller overriding trace to an enabled mode or replacing the private reporter is rejected before the handshake: request traces can retain both launch authority and later session cookies. Public and ordinary local test configuration is unchanged. Capability state stays outside generated source and is removed after the owned browser task; never copy cookies or print the launch link in authored tests.

The shared configuration and private preview trace guard resolve the same
package-owned reporter through one CommonJS-compatible path helper. Every shared
runtime module reachable from app configuration and tests must support both
Playwright's CommonJS TypeScript transform and native ESM consumers. Qualification
executes actual CLI tests importing the normal-actor fixture, private preview
helper, entry-path helper, managed runtime, and package configuration in both
formats. It checks trace/reporter denial and missing private authority without
launching a browser or probing a provider. A Vitest import or configuration-only
listing does not establish that the app's test-module graph can execute.

## Genuine local fixture UI login

The shared `normal-actor-login` helper reads the existing owner-only local runtime
checkpoint and actor manifest in process. It creates a fresh browser context with
no restored session state, crosses the real private-preview gateway when needed,
and signs in through the app's ordinary BetterAuth UI. Emails and fixture passwords
are filled internally and never returned as helper results or diagnostic text.

Before private credential reads, this path checks the actual current Playwright
`test.info()` configuration for the bounded private reporter and disabled trace,
video, and screenshots. Caller-provided recording claims are never authority. It verifies the current local app,
installation, Auth origin, actor, organization, and role scope and rechecks the
private files after awaited operations. The resulting real Auth session must match
the selected actor; an existing restored session is not evidence of UI login.
Failure closes the new context and reports a fixed code without raw browser,
filesystem, network, or credential diagnostics. These checks qualify the helper;
actual app login and application permission acceptance still require the ordinary
Builder browser run.

This helper verifies the organization selected by genuine sign-in; it does not
perform organization switching. If BetterAuth returns no active organization or
a different initial organization for a multi-organization account, login
qualification fails closed. Select the organization through the app's ordinary UI
in a separately supported journey; never patch a session, call a hidden setup
mutation, or substitute cookies to make this helper pass. Cross-organization and
unassigned denial remain separate acceptance checks.

### Sign in again without replacing an existing browser context

`signInNormalActorInContext` is a separate protected test helper for an existing
context created by `withNormalActorUiLogin`, with a retained, actually rendered
form. Call it inside that helper's operation callback while the context is active.
Its private app/origin binding prevents arbitrary caller contexts with unknown
HAR/recording options from entering this credential path. First sign out through
the app's ordinary UI. The helper requires the same browser jar's real
`/api/auth/get-session` response to be `null`; it never fabricates logout or
clears/replaces cookies. It crosses the normal preview handshake, opens its own
short-lived sign-in tab in that same context, enters the protected fixture
credentials through the ordinary UI, and verifies the resulting actual actor
and initial organization. It then closes only that helper-owned tab, returning
no credentials, session or page. Caller tabs and context remain open.

This permits a retained form to be submitted after genuine login as an
unassigned or different-tenant actor. It does not require app assignment merely
to prove Auth login. Check the actual typed denial and independently read the
same canonical row/version afterward; no Server Action token/header copying is
needed. Keep browser capture disabled under the actual private reporter policy;
manual tracing, screenshots, HAR capture and credential inspection in test code
are outside this protected helper contract. Configured recording and existing
video pages are rejected before credential reads. Initial-organization and
private-fixture freshness checks remain unchanged.

The private Playwright reporter may retain fixed failure stages for the
protected browser helpers. Login preflight, preview bootstrap, sign-in UI,
session verification, fixture recheck and protected callback failures have
distinct stages. An error from a nested protected helper retains only its
recognized stage. These codes are diagnostic hints and grant no authority or
permission to retry. The reporter continues to withhold raw exceptions, assertion
details, request and response data, and worker output. Recognized Playwright
failures additionally emit only the closed category `assertion`, `timeout`,
`navigation`, or `browser-launch`. These categories distinguish app assertions
from browser setup and navigation problems without disclosing expected/received
values or URLs. Unknown failures retain the generic marker; a finished test run
does not imply that its tests passed.

The private fixture binds its runtime plan to the checked release’s canonical
`sha256:<64 lowercase hexadecimal digits>` schema hash. The reader preserves
that value for exact release readback.
