# Integrations connection management app

The `/integrations` route is an opaque application in `microfrontends.json`.
The Gateway signs the authenticated tenant, actor, role, method, and request
target. Page reads, Server Actions, and the connection API require that signed
principal and an organization owner or administrator role. The browser never
supplies tenant or actor authority.
The shared Gateway request boundary binds the exact body of Next page mutations
before issuing the principal; the app rechecks that binding when accepting a
Server Action. This shared security behavior covers native Next zones and does
not change deployment selection, routing, or provider activation.

The Integrations app owns the SQL connection registry and the connect,
reconnect, and disconnect surface. The runtime database role must use the
control-plane schema and RLS policies in
`packages/integration-control-plane/schema.sql`; it needs `INSERT` on
`integration_service_nonce` for durable replay protection. The service route
`/integrations/api/control` verifies the exact body, method, path, tenant,
app, actor, timestamp, and one-use nonce against its app-specific service secret and
`INTEGRATIONS_SERVICE_MEMBERSHIPS`. A signed request alone does not grant
connection management. Vendor uses this service route for its own binding
operations. Integration credentials are never returned to Vendor.
The central host's `INTEGRATIONS_SERVICE_SECRETS` is a server-only JSON map
from app ID to distinct secrets of at least 32 bytes. Vendor receives only its
own key through `INTEGRATIONS_VENDOR_SERVICE_SECRET`; duplicate keys or unknown
app IDs fail closed. A service key does not establish a human subject's current
membership or authority.
Hosted user-initiated operations additionally require a Gateway delegation
bound to the exact Vendor control-operation body. Integrations verifies its
signature, actor, tenant, audience, method, target, body digest, role, and app
grant; its delegation identifier is consumed once in the nonce table. Auth
independently re-reads the current organization manager role, organization app
assignment, and active actor app grant. A valid app service signature alone is
insufficient. The Auth host and central Integrations host share a distinct
server-only `INTEGRATIONS_AUTHORITY_SECRET` of at least 32 bytes; Integrations
uses the exact HTTPS `INTEGRATIONS_AUTHORITY_ORIGIN` to reach Auth. This secret
must differ from each app service secret and must not be supplied to Vendor.
Missing configuration, failed readback, invalid delegation, and replay deny the
operation. A delegation authorizes only the signed operation and does not prove
the provider installation exists or has stopped.
An owner-controlled trigger prunes nonce records after one hour, well beyond
the two-minute maximum acceptance interval for a signed request. The runtime
role does not receive direct read or delete access to those records.
For user-initiated activation or removal, Vendor also signs the verified human
actor into the service request; activation grants are issued and consumed under
that actor. Requests without a user subject cannot perform those operations.

`INTEGRATIONS_DATABASE_URL` and `INTEGRATIONS_ACTIVATION_PRIVATE_KEY_PEM` are
required outside local fixtures. The signer key must remain stable across app
instances. `INTEGRATIONS_LOCAL_FIXTURES=1` permits disposable SQL-backed
QuickBooks, Ramp, and Xero identities. Their external identifiers are derived
from the tenant and a new UUID, with Ramp's tenant group and provider-specific
QuickBooks/Xero groups. Local fixture verification never contacts a provider.
Without a configured provider verification path, provider operations fail
closed. Hosted activation controls remain unavailable until the app-owned
installation lifecycle is configured and verified; hosted removal
acknowledgment also remains unavailable without independent stop readback.
The local fixture flag must not be set in a hosted environment.

Protected OAuth setup uses `INTEGRATIONS_AMPERSAND_PROJECT_ID`,
`INTEGRATIONS_AMPERSAND_API_KEY`, a stable secret of at least 32 bytes in
`INTEGRATIONS_SETUP_PROOF_SECRET`, and `INTEGRATIONS_AMPERSAND_PROVIDERS`.
The latter is a server-only JSON object keyed by the stable provider key; each
entry supplies `provider`, a list of exact HTTPS `authorizationOrigins`, and an
optional `providerAppId`. Provider API keys and setup proofs do not establish
deployment readiness. Setup rechecks the signed tenant and actor, then reads
the exact provider project, provider, group, and connection before central
registration. Ramp sync resolves the exact active Vendor installation's
connection and provider group before contacting the provider, and the proxy
uses that group rather than deriving it from the tenant. Reconnection and disconnection also remain unavailable without
their corresponding provider verification paths.

Each connection has its own revision. Reconnect re-verifies its exact provider
identity and advances that revision. Disconnect requires a review token bound
to the complete current binding set and connection revision. The current
surface rejects disconnect while app bindings remain; the app must first
remove those bindings. Vendor deactivation removes only Vendor's binding and
installation, leaving the shared connection and unrelated app bindings intact.

Vendor owns activation, mappings, sync, health interpretation, catalogs,
recipes, ingress, matching, direct apply, and canonical writes. Its direct
apply path requires an active exact tenant, provider, group, connection,
installation, project, environment, and launch identity under the binding
lease. Local activation uses a synthetic installation; hosted provider
installation and credential reconciliation belong to EXT-INT-01.

The Vendor migration adapter first compares the approved and observed exact
inventory and matches each record to one registered connection. It then asks
the central control plane to adopt the complete inventory in a single database
transaction, preserving each verified installation's routing identity. The
transaction checks tenant, app entitlement, exact connection and routing fields,
and an independently read identity digest covering project, environment and
launch state; a conflict rolls back every binding in the batch. Registering the
connections happens before that transaction and does not itself activate a
binding. This repository-owned path accepts fixture or separately authorized
operator evidence and does not query or modify a live provider.

Vendor's binding host requires `INTEGRATIONS_VENDOR_DATABASE_URL` for its
scoped registry role, its own runtime database connection, and the configured
`INTEGRATIONS_VENDOR_SERVICE_ACTOR_ID` and
`INTEGRATIONS_VENDOR_SERVICE_ACTOR_ROLE`. Before each apply it reads that exact
tenant's active actor membership through Vendor's restricted runtime principal;
the signed request carries the binding identity to Vendor's canonical write
service, which rechecks the registry and holds its connection and binding locks
through the write. Canonical apply checks the service membership and its current
fence again. The preliminary lookup releases its locks before the write service
acquires its own lease, so a waiting revocation cannot deadlock the two services.
Each source record and relation must also match that binding's provider and
installation. The Vendor transaction keeps the existing QuickBooks rebaseline
lock and rejects deliveries from a completed old installation. Matching legacy
and same-day deliveries return the prior receipt; changed or incomplete batches
fail closed.
Missing configuration or membership rejects the write. These settings do not
provision credentials or authorize a hosted cutover.
