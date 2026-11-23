# Multiple Integration Platforms: Executive Brief

Date: October 30, 2026
Status: architectural assessment; no pilot selected

## Summary

Adding Merge alongside Ampersand is feasible. It would be a medium-sized
platform feature, with most work above the kernel. The existing app-owned
schema and `ApplyChangeSet` write boundary provide the foundation.

The distinction to make explicit is between an **integration platform** such as
Ampersand or Merge and a **source system** such as QuickBooks, Xero, or Workday.
Today, those concepts are intertwined. The proposed direction is coexistence,
proved by one eventual pilot, while preserving existing Ampersand connections
and source identities.

This brief describes proposed capabilities and contract extensions. It does not
change the current integration contracts, APIs, or implementation.

## Work required

| Workstream | Required change |
| --- | --- |
| Platform-aware configuration | Separate platform, source system, and connection identity. The current [Vendor catalog](../../../../apps/vendor/integrations/catalog.ts) requires Ampersand configuration for every entry. Each app should declare which platform/source combinations it supports. |
| Connection lifecycle | Add Merge Link, server-side token exchange, reconnect, disconnect, and account-health handling. Merge returns a permanent per-account token that the backend must securely retain. See [Merge Link](https://docs.merge.dev/merge-unified/merge-link/embedded-link). |
| Credential ownership | Define a server-only credential store and authorized access through opaque connection references. The current [connection contract](../../data-model.md#arrusted-owned-control-plane-metadata) excludes credentials from connection and app-binding metadata; preserve that boundary. |
| Reliable synchronization | Implement initial reads, pagination, incremental checkpoints, retries, and recovery from Merge into Arrusted. Merge recommends webhook-triggered reads plus periodic polling, using `modified_after` for incremental retrieval. This adds app-owned operational state beyond receiving Ampersand deliveries. See [Merge sync guidance](https://docs.merge.dev/merge-unified/reading-data/syncing-best-practices). |
| App-owned mapping and writes | Translate Merge models into each app's schema and trusted apply path. The existing [compiler](../../../../packages/integration-compiler/src/compiler.rs) accepts Ampersand envelopes, so Merge needs its own ingress and normalization. Extract common compilation logic where both implementations demonstrate a need. |
| Identity and operational proof | Preserve platform, connection, source object, and record identity. Prove replay, updates, partial failures, tenant isolation, and safe disconnect. Establish which connection is authoritative when two platforms can access the same underlying system. |

Merge would continue to own its upstream source connections and synchronization.
Arrusted would own retrieving that data from Merge and applying it to app
records. These are separate responsibilities.

## Shared boundary and contract implications

Keep the shared abstraction narrow: connection authorization, platform identity,
lifecycle operations, and capability descriptions. Provider transport and app
mappings should retain their current ownership. Merge's normalized models remain
inputs to an app's schema. Canonical writes continue through app-owned policy
and ordinary kernel apply.

The [existing integration boundary](../../ampersand.md) and
[data model](../../data-model.md) remain authoritative. Before
implementation, extend those contracts to define Merge account-token storage and
access, the owner of durable sync checkpoints and recovery state, and
platform-aware connection and source identity. Keep credentials and sync cursors
out of shared connection/app-binding metadata. Retain the current prohibition on
persisting or logging raw provider payloads, signed URLs, and secrets.

The Integrations app's tenant connection and app-binding control plane is
documented, but its implementation is absent from the checkout assessed for
this brief. Confirm that gap against the implementation baseline before sizing
the work. Delivering the central control plane would be a separate workstream
if platform-wide connection sharing is part of the first release.

## Qualification and recommended pilot

Adding Merge does not automatically enable its entire catalog in Autograph
apps. Fields and operations differ by integration, so each app/source
combination needs qualification. Merge exposes account-specific supported
models, operations, and fields through its
[Linked Accounts metadata](https://docs.merge.dev/merge-unified/platform-and-account-metadata/linked-accounts).

The recommended first cut is read-only ingestion through one selected app and
source system, explicit platform assignment, and preservation of existing
Ampersand identities. No pilot has been selected. Automatic platform failover
and migration of existing connections are outside that first cut.

Pilot acceptance should demonstrate:

- Initial ingestion and incremental updates through the app-owned schema and
  trusted apply path.
- Interrupted pagination and retry without skipped records or duplicate writes.
- Duplicate and delayed notifications, replay, and partial sync failures.
- Correct tenant and environment isolation, webhook verification, and token
  handling without secrets or raw payloads in logs.
- Reconnect and revocation during an active sync, with subsequent unauthorized
  work rejected.
- Deterministic source matching and an explicit policy for source deletions and
  overlapping connections to the same underlying system.

## Preliminary effort

A production-quality pilot should be sized as several engineering weeks. This
is an initial architectural estimate: the exact objects and fields, credential
infrastructure, recovery requirements, and whether the central control plane
must ship with the pilot determine the scope. Size that control plane
separately. A tighter estimate requires selecting the pilot and confirming its
coverage and acceptance criteria.
