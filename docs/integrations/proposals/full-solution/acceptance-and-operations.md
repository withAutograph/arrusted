# Acceptance and operations

Status: proposed release criteria. No pilot substitutes for this matrix.

## Acceptance matrix

Test Ampersand and Merge across multiple source domains and apps, shared connections, multiple connections per app, and both managed/customer-owned account modes. Each advertised operation needs actual hosted qualification; unsupported capabilities remain visible.

- Verify initial and incremental reads, relationships, collections, enums, money, field clearing, deletions and schema changes against app policy.
- Interrupt pagination and processing; recover without skipped records or duplicate writes. Exercise delayed/duplicate notifications, missed events, partial failures and throttling.
- Exercise outbound approval, concurrent edits, uncertain results, idempotency expiry and independent target readback. Verify outbound echo handling.
- Deny cross-tenant, cross-app, cross-account and cross-environment access. Test service permissions, credential rotation, reconnect, disable, disconnect and in-flight work.
- Prove multiple apps use one connection with different mappings and independent permissions.
- Verify secrets and raw payloads are absent from logs, workflow arguments/results, generated configuration and durable operational records.
- Run normal public Builder creation, existing-app revision and provider-extension journeys. Manual implementation cannot replace Builder evidence.
- Verify standard and embedded UI, actionable partial failures, removal and zero integration runtime/UI additions for apps that do not opt in.
- Stop Builder and verify deployed app integration processing continues.

Fixtures, static checks, local database tests, public Builder journeys and hosted service evidence are separate evidence classes. Preserve passed, failed, blocked and unassessed outcomes explicitly.

## Operations

Expose connection health, sync freshness, pending/failed/uncertain operations, retry/reconciliation actions and permission/setup gaps without raw provider diagnostics. Monitor queue age, checkpoint lag, rate limits, provider-account usage and repeated failures, scoped to the owning app and organization.

Operator runbooks cover credential/key rotation, provider outages, stale workers, uncertain writes, schema/adapter incompatibility, connection migration, revocation and partial disconnect. Reconcile actual external state before replaying effects. Never automatically switch platforms or resurrect revoked grants.

Provision runtime hosts, service identities, secrets, schedules and provider permissions through concrete protected operator operations. Runtime credentials cannot migrate schemas or install arbitrary model-authored code. Keep canonical persistence in the generated SQL boundary and provider credentials outside app source.

## Documentation validation

For this proposal publication, verify relative links/anchors, Markdown diff and current-versus-proposed labels. Preserve the earlier Merge brief's prose and date, changing only link destinations required by its move. Run required repository commit/publication hooks. No runtime behavior is claimed by this documentation change.
