# Superseded Vercel independent deployments

> A-429 supersedes this procedure. Hosted composition is one Vercel Services
> project/deployment; do not use this document for activation, rollback, or
> binding selection.

This historical procedure is retained only as accepted evidence. Current
delivery is `Git push → one native root Services deployment → provider-owned
atomic activation/rollback → Gateway routing → read-only CD proof`. The
Gateway uses only current in-deployment bindings; errors fail closed and never
fall back to sibling projects or Production origins.

Repository CD runs read-only Vercel proof and the separately scoped Ampersand
manifest lane. It does not select deployments from pull requests, commits,
merge ancestry, current-main equality, or branch freshness. It does not deploy,
activate, promote, alias, roll back, or reconcile provider deployments.
`REPOSITORY_RELEASE_ENABLED` is template-instance safety only and never gates
native Vercel delivery. A superseded Ampersand candidate is a successful no-op
and cannot affect Vercel proof or Gateway routing.

Production activation, rollback, auth, privacy, health, and migration proof
remain app-scoped. The paid Vercel Microfrontends product is not used.

## External cleanup boundary

EXT-GW-03 owns deletion of obsolete provider aliases, variables, credentials,
alerts, hooks, and integrations after its approved external inventory. The
repository neither mutates nor treats those provider resources as authority.

## Gateway outage

Use provider read-only evidence to identify the affected current deployment and
route. Keep the Gateway as the only public composition plane; recovery is an
app-scoped provider operation outside repository CD.

## One application outage

Confirm the affected application's provider deployment and canonical Gateway
route. Do not change a sibling deployment or derive a replacement from Git
history.

## Centralized authentication failure

Verify the Gateway's protected auth boundary and delegated request receipts.
Do not expose private bindings or credentials while collecting evidence.

## Service binding failure

Inspect the affected provider-owned Service binding read-only. Gateway routing
and the private binding contract remain the ownership boundary.

## Neon or materialization failure

Use the owning application's sanitized build and migration evidence. A failed
migration blocks that application's deployment; it does not trigger fleet
coordination.

## Vendor callback failure

Inspect the Vendor callback route and its app-scoped provider evidence. Keep
the callback service private except for its reviewed public routes.

## Vercel provider outage

Record the provider incident and preserve the latest sanitized read-only
evidence. Do not use repository CD as a provider recovery controller.

## Preview route resolution failure

Verify the exact provider-owned Gateway branch origin and the selected app
same-branch origin. Only an explicit deployment-not-found response permits the
Production-domain fallback; all other failures remain visible and fail closed.

## Application-local rollback

Superseded evidence only: current rollback is one provider rollback of the
root Services deployment.

## Forward recovery

Validate the affected provider-owned Production deployment and its Gateway
route read-only after recovery. Repository Git state is not deployment
authority.

## Credential compromise

Follow the provider credential incident process. Do not print credential
values or create a repository compatibility path for retired credentials.

## Spend anomaly

Use the sanitized Vercel-native measurements in the observability contract and
the provider's owner notifications; no automatic Production pause is permitted.

## App-owned smoke ownership

Run the owning app's read-only health proof through the authenticated Gateway.
The proof must not select or mutate a provider deployment.

## Build observability failure

Collect only the bounded build observability receipt and provider log metadata.
Keep tokens, private binding URLs, and customer data out of artifacts.
