# Full integrations support for App Builder

Status: proposed architecture and implementation roadmap. Updated November 3, 2026.

Builder must compose complete integrations across hosted platforms and extend support when an adapter is missing. This is a comprehensive platform capability covering inbound sync, outbound writes, event triggers, and on-demand actions. There is no pilot.

Support organization-shared connections and both Autograph-managed and customer-owned platform accounts. Builder chooses providers using organization policy, actual capabilities, and authorized existing connections. Apps own schema, field authority, conflicts, and approval policy.

The existing connection control plane, integration runtime, reusable UI, and optional Builder installer are the starting point. Source implementation is separate from configured hosted readiness. The earlier Merge assessment is retained as a historical smaller proposal.

The original open questions are resolved as follows:

| Question | Decision |
| --- | --- |
| Objects and fields | App requirements and account-specific provider discovery determine coverage; no fixed accounting catalog. |
| Credentials | A protected credential service retains platform keys and account tokens; hosted platforms retain upstream OAuth credentials. |
| Central control plane | Required. Extend and configure the existing foundation rather than deferring it. |

Ship Ampersand and Merge adapters through a common extension contract. Further providers use the same mechanism; no universal support claim follows from a catalog entry. Direct source API connectors and personal connections are outside the selected scope.

Working estimate: 20–35 engineer-weeks, approximately 3–5 months with two to three engineers. This is a planning estimate assuming reuse of the foundation; commercial approval, hosted qualification, and additional adapters can add elapsed time.

Read the [decisions](requirements-and-decisions.md), [architecture](architecture.md), [implementation roadmap](implementation-plan.md), and [acceptance and operations](acceptance-and-operations.md).
