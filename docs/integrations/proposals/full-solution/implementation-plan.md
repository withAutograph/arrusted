# Full integration implementation roadmap

Status: proposed. Engineering milestones build one complete capability; none is a pilot.

## Baseline

Extend existing integration-control-plane, integration-runtime, optional installer and reusable integrations UI. Verify the selected source and current hosted configuration before implementation. The earlier Merge assessment used an older checkout; its missing-control-plane observation is not this roadmap's baseline.

## Delivery sequence

| Milestone | Deliverables and exit criteria |
| --- | --- |
| Contracts and ownership | Provider/app interfaces, versioning, capability semantics, storage boundaries and adapter conformance suite. Update normative contracts with implementation. |
| Accounts and authority | Both account modes, environment isolation, protected credential setup, rotation, multiple connections, app grants and safe disconnect. |
| Durable runtime | Recoverable sync, normalized events, transactional outbound commands, typed actions, reconciliation, fair rate limiting and operational visibility. |
| Provider implementations | Adapt Ampersand without identity loss and implement Merge through the same contract. An independent conformance adapter proves extension without core provider switches. |
| Builder and composition | Extend repository discovery, planning, installation and validation for new/existing apps and explicit shared adapter source changes. Preserve optional composition. |
| Migration and qualification | Preserve existing installations and exercise the full multi-provider, multi-app capability matrix with hosted readback. |

Builder discovers configured capabilities without credentials, selects through organization policy, generates typed mappings/actions, and validates the accepted product behavior. Missing adapters can become explicit source extensions; runtime activation requires a configured trusted host. A catalog label, generated page or installer receipt never substitutes for live capability.

Extend normal source planning to review shared provider-package changes rather than hiding them in app-only file operations. Privileged installation consumes approved declarative artifacts through trusted implementations. Reuse current public Builder orchestration and approval surfaces.

## Migration and release

Inventory exact connections and source identities. Fence affected ingestion/jobs, drain admitted work, install compatible storage/runtime changes and restricted service identities, reconcile/adopt existing installations, and verify replay and permissions before reopening admission. Preserve immutable historical releases and app records.

Roll out compatible readers before emitting new contract versions. In-flight work retains its adapter/mapping/schema version; resume only compatible work and surface reconciliation when a version cannot run. Removing an integration revokes authority and drains jobs before generated routes or dependencies disappear.

Native delivery and provider-owned activation remain governed by the native deployment conformance contract. Source publication does not authorize purchases, credentials, migrations or production activation. Application rollback does not undo external effects or database transitions.

## Effort

Working estimate: 20–35 engineer-weeks, approximately 3–5 months with two to three engineers and shared review/QA. This assumes reuse of the existing foundation and includes integration testing. Provider commercial approval and further adapters add time. Re-estimate each milestone against implementation evidence; this is not a delivery commitment.

Completion is defined by [acceptance and operations](acceptance-and-operations.md), not one application demo.
