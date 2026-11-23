# Frontend Packages

This folder follows `docs/frontend-architecture.md`.

- `design-systems/` contains tokens, components, compositions, and stories.
  It has no substrate or domain knowledge.
- `contracts/` contains shared TypeScript data and client contracts such as
  `ErrorEnvelope`, `KernelClient`, and `TenantScope`. It has no runtime state,
  rendering, fetching implementation, app-owned shell behavior, or domain semantics.
- `kernel-client/` contains the optional fetch-backed `KernelClient`
  implementation and wire-error normalization. Apps may use it or provide their
  own transport.
- `agent-foundation/` contains generic agent identity/profile contracts,
  execution primitives and scope, generated-id validation helpers, and the
  static `AgentToolDefinition` / `AgentRuntimeTool` contracts. Apps compose
  runtime tools by direct import; reusable libraries may export domain-agnostic
  tools under their own package boundaries. Current modules do not runtime-import
  Agent Foundation. There is no dynamic tool registry. Apps own domain policy,
  semantic acceptance/repair decisions, and host evidence mapping into the
  generated `AgentRunLedgerEntry` DTO; kernel-side code persists it through
  `record_agent_run`. The package must not import apps, domain libs, modules,
  kernel-client, or domain code.
- `agents/` contains reusable agent-type packages. They may own an agent's
  domain-neutral planning mechanics, static tool contracts, clarification
  protocol, and prompt scaffolding while consuming Agent Foundation execution
  primitives. Apps inject concrete tools, domain guidance and policy,
  authorization, persistence, compiler behavior, and UI/session handling.
  Agent packages must not import apps, domain libs, modules, kernel-client, or
  app-generated clients.
- `auth/` contains shared Better Auth configuration, Better Auth UI
  provider/query helpers, client helpers, and fail-closed session/tenant guards.
  Apps and future route handlers consume it at their boundaries; it must not
  import apps, modules, kernel-client, or domain code. Better Auth organization
  ids map directly to kernel `customer_id` values.
- `integrations/` contains thin wrappers around external integration libraries.
  It owns Ampersand React/prebuilt UI adapters, package-owned external styles,
  and generic token request/response types. It must not import apps,
  app-generated clients, contracts, kernel-client, kernel DTOs, provider
  catalogs, manifests, schema helpers, webhooks, Platform API clients, or
  `ApplyChangeSet` contracts.
- `engines/` contains pure reusable non-UI logic. Engines may know generic
  row-version shapes, but they do not fetch, render, or own workflow state.
- `modules/` contains job-shaped reusable workflow surfaces. Modules own
  substrate workflow plumbing and may render design-system compositions.

The consumable tracks are contracts, auth, integrations, kernel-client,
agent-foundation, agents, UI, and engines. Apps may use them. Modules may use contracts
type-only, agent foundation primitives, UI, and an agent package's explicitly exported
domain-neutral accepted-plan contracts or pure analyzers. They must not import agent
runtime orchestration, prompts, or tool composition. Modules receive clients through
props instead of importing `kernel-client`. Lower layers do not import upward.

There is intentionally no runtime manifest system, no mode registry, and no
first-class extension layer.

Dependency direction is one-way by layer. UI flows from tokens to components to
compositions; engines are a sibling pure-logic track; modules and apps may
consume both. Runtime packages and apps must not import design-system stories.
