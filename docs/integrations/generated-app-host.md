# Generated app integration hosting

## Availability without integration setup

`@autograph/integration-runtime/availability` provides a read-only status boundary
without initializing the shared integration runtime. An absent or explicitly
deferred implementation is `unavailable`; it does not trigger a binding read or a
provider probe. Only an explicitly supported implementation with a successful
authorized current-binding read returning `null` may report `not_configured`.
A complete valid binding DTO is `configured`, including retained `pending`,
`active`, `suspending`, or `removed` metadata. This does not claim activation,
health, ingestion, or permission to use a removed binding. Malformed adapter
output or a failed read is `unavailable`, never an empty binding.

Callers must retain their installed app, tenant and actor guards and supply the
installed authority-error classifier. Authorization runs before the operation and
again after an awaited binding read, including failed reads. Authority failure is
re-thrown as a denial; it must not be converted into an availability badge. The
boundary returns no binding identifiers, provider errors or credentials and adds
no setup, connection or activation effects. Existing consumers and installed
capability/ingress guards remain unchanged.
