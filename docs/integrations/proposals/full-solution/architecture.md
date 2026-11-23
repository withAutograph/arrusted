# Integration architecture

Status: proposed extensions to the existing [integration foundation](../../optional-app-integrations.md) and [data contract](../../data-model.md).

## Ownership and interfaces

| Boundary | Responsibility |
| --- | --- |
| Central control plane | Organization connection identity, app grants, binding lifecycle, revocation and disconnect. |
| Credential service | Encrypted secrets, opaque handles, scoped runtime access, rotation and audit. |
| Hosted-provider adapter | Versioned discovery, connection verification, reads, subscriptions, actions, error classification and reconciliation. |
| App runtime | Durable processing, mappings, source matching, business authorization and canonical apply. |
| Builder | Discover, compose, author extensions, validate, review and deliver source. |

Evolve executable integration definitions around stable integration-use keys rather than hardcoded source-provider names. Declare platform requirements, source schemas, typed mappings, actions, triggers, schedules and app policy. Permit multiple connections and uses of the same system.

The versioned adapter interface covers discovery; prepare/complete/relink/disconnect; paged and incremental reads; event verification/subscriptions; typed invocation; rate-limit and retry classification; idempotency guarantees; and uncertain-result reconciliation. Input/output schemas are validated at runtime. Unsupported capabilities are explicit.

Provider transport is reusable server code composed by app hosts. Apps retain normalization and persistence policy; central authorization is not a provider data proxy. Credential-aware transport restricts requests to declared operations and provider origins. Generated clients receive typed operations and opaque handles, never arbitrary privileged URLs or secrets.

Keep cross-process DTOs in their generated contract authority or the existing shared contracts package. Do not hand-type mirrors.

## Durable state and processing

Use the official Vercel Workflow SDK behind a narrow execution interface. Workflows are application runtime operations, independent of Builder sessions. Pin the implementation dependency and follow its matching documentation. [Workflow foundations](https://workflow-sdk.dev/docs/foundations/workflows-and-steps) describes persisted step results; secrets and raw payloads must therefore remain inside protected steps, not step inputs or outputs.

Contract app operational storage for checkpoints, normalized event inboxes, outbound commands and bounded outcomes. This is an explicit extension of current storage restrictions, not permission for raw payload or provider-state mirrors.

1. Verify incoming bytes before parsing and resolve exact environment, connection and current app binding through trusted authority.
2. Record normalized recoverable event work or a replayable provider reference before acknowledgement.
3. Read and normalize data in resumable pages. Commit canonical writes and checkpoint advancement together.
4. Enqueue outbound commands atomically with the app transaction authorizing them. Freeze typed app inputs or immutable record-version references.
5. Reauthorize dispatch against current binding, app policy and initiating/service authority. Record attempts and reconcile uncertain effects before retry.
6. Persist only bounded status, hashes and external references; retain no raw provider envelopes, responses, signed URLs or credentials.

Use bounded concurrency, renewable execution, provider-account rate limits, retry backoff and fair scheduling. Split large backfills into resumable runs. Pin mapping, adapter, configuration and schema versions for admitted work. Workflow checkpoints carry operation references.

## Identity and external effects

Canonical records remain app-owned and use ordinary generated SQL/apply. Provider IDs are not model external keys. Preserve namespaced platform/account/connection/object/record identity and exact source matching.

There is no atomic transaction spanning local SQL and a hosted provider. A timed-out mutation can have succeeded. Persist uncertain status and reconcile using exact target identity; never blindly repeat a non-idempotent operation. [Merge idempotency](https://docs.merge.dev/merge-unified/writing-data/writes/idempotency) has availability and retention constraints, so capabilities must describe guarantees rather than assume them.

Disable stops admission and drains admitted work; disconnect waits for app acknowledgements and independently verifies provider state. Already-dispatched external effects require reconciliation, not an assertion that cancellation undid them.

[Implementation roadmap](implementation-plan.md) sequences delivery.
