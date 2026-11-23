# Shared browser tests

For independent local persisted-record assertions after an app action, use
`@autograph/playwright-config/normal-actor-readback`. Its in-process callback
receives only the current actor's read-only generated data context; credentials
and database pools remain private. See
[the readback contract](../../docs/guides/normal-actor-readback.md) for its local
fixture, authority and release checks and the product outcomes it does not prove.

Generated apps import the default configuration from `@autograph/playwright-config`.
With `APP_TEST_BASE_URL`, tests use that exact HTTP(S) origin and do not start a
local web server. Without it, the existing localhost server and
`PLAYWRIGHT_WEB_SERVER_PORT` behavior remain available.

## Prepared normal actors

Product tests import `test` and `expect` from
`@autograph/playwright-config/normal-actors`. The lazy `normalActors` fixture reads
`APP_TEST_IDENTITIES_FILE`; the lazy `actorContext` fixture creates and closes
independent Playwright contexts from those actual session files.

The private manifest is `{ version: 1, actors: [...] }`. Each entry contains
`actorKey`, `actorId`, `organizationId`, `roles`, and `storageState`. Select with
`actorContext({ actorKey, organizationId })` using the exact account and
organization required by the accepted scenario. The same account can have
separate sessions in several organizations; selecting by account alone is
insufficient. `organizationId: null` identifies an account without organization
membership. `roles: []` means no app assignment and remains available for denial
tests.

Existing runtime preparation also writes `{ version: 1, appId, identities: [...] }`
with `actorId`, `organizationId`, `role`, and `storageState`. The fixture reads
these entries as `actorKey: actorId` and `roles: [role]`, preserving the actual
session file. Select them using the actual actor ID and organization. The reader
uses `actors` when present and validates it without falling back to `identities`.
Additional metadata is ignored, and `appId` is not required by this reader.

Absolute storage paths stay unchanged. Relative paths resolve from the manifest's
directory. Cookie contents, domains, expiry and browser storage are not rewritten;
the helper adds no authentication headers or edge access credentials. The fixture
passes the configured `baseURL` when opening contexts so relative navigation uses
the same prepared origin. Files stay private and errors omit their contents.

For direct use, `readNormalActorManifest`, `selectNormalActor`,
`createNormalActorContext`, `withNormalActorContext`, and
`createNormalActorContextManager` are exported from the same subpath.

Author app-owned tests for the accepted role and organization matrix: allowed and
denied actions, accounts without assignment, tenant isolation, and other product
rules. The anonymous generated smoke test remains useful for apps without
authentication. This shared fixture supplies real prepared sessions; it does not
prove product behavior or native edge access, and it never creates accounts,
seeds databases or changes permissions.

## Browser entry paths

`APP_TEST_BASE_URL` stays the exact Auth/test origin. Tests can supply a separate
`APP_TEST_ENTRY_PATH` and call `appTestPath()` from
`@autograph/playwright-config/entry-path` to navigate beneath that entry.
Without an entry setting, standalone navigation is unchanged.

`resolveAppBrowserEntryPath` selects a unique literal route or validates an
explicit entry against the supplied routes. A caller can supply its route
ownership predicate for a concrete dynamic entry. Invalid or ambiguous entries
remain unresolved; app IDs and route insertion order never select a destination.
The entry path is never appended to BetterAuth origins or callbacks.

Protected actor UI helpers use `/auth/sign-in` at the configured origin. They
accept an explicit same-origin `signInPath` for a custom sign-in page.
