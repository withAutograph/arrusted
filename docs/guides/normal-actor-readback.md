# Independent local actor readback

`@autograph/playwright-config/normal-actor-readback` supports independent
persisted-record assertions after an app-authored browser action. It reuses the
existing protected local runtime fixture; it never prepares resources, creates
identities, seeds data, invokes a provider, or grants permissions. It is not a
hosted-data reader or proof of successful UI authentication.

Pass the accepted app ID, exact normal-actor selector and current browser origin
to `withNormalActorReadback`. The optional `appRoot` identifies the app's checked
source and release; it defaults to the app process directory. Inside its async
callback, use the app's generated operations with the supplied `DataContext` to
read the canonical record affected by the browser action and assert its expected
state. Select that record by its app-owned canonical identity. The helper returns
no record value; assertions run in process. Do not log records or fixture values.

The common private fixture reader verifies the owned private files and exact
local app, runtime, actor, organization and origin. App and Auth connection URLs
stay internal and must select the recorded restricted roles/databases on the same
literal loopback endpoint. SQL readback independently verifies current role and
database ownership markers, lack of administrative flags, current Auth membership
and app assignment, and the actual active kernel actor binding. An unassigned or
foreign actor is denied; a role declaration alone is insufficient.

The checked CUE/release and installed active release must match the recorded
runtime. Every generated read rechecks fixture and actor authority. The supplied
context uses the maintained read-only generated entrypoint boundary; mutation
entrypoints are rejected before dispatch. No raw SQL connection or pool escapes.
Both connections close at completion, and retained contexts reject later use.
Failures expose fixed codes rather than credentials, database records or raw
assertion/query diagnostics.

This helper supplies the database observation only. The app still owns its real
UI sign-in, action and logout assertions, anonymous/unassigned/cross-tenant
denials, and the distinction between application authorization and outer preview
protection. A restored actor cookie, green import test, or controlled PostgreSQL
fixture does not establish those product outcomes.
