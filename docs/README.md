# Autograph Docs

These docs are the source of truth for Autograph.

## Reading Order

1. [Principles](principles.md): durable architecture, invariants, and committed decisions.
2. [Contracts](contracts.md): schema lifecycle, row-version storage, write/read APIs, and layer boundaries.
3. [SQL Schema Compiler And Generated Runtime](schema-compiler.md): implemented compiler/runtime surface, integrated features, temporary compatibility paths, verification, and rollout steps.
4. [Generated Data Operations](generated-data-operations.md): typed model operations, server-only reads, app-owned Next Server Actions, and database-backed proof.
5. [Field Atlas](field-atlas.md): canonical map of records, identity (`uuid`/`external_key`/`ref`/`known_aliases`), the field-type vocabulary, and model-vs-enum-vs-reference-data. Tags concepts `[current]`, `[current gap]`, `[planned]`, or `[future]`.
6. [Frontend Architecture](frontend-architecture.md): UI layering, module/composition contracts, and AG2 port-over decisions.
7. [Component Port Tracker](component-port-tracker.md): reconciled component inventory, AG2 port status, acceptance gates, and AI-composition proof strategy.
8. [Agent Foundation](agent-foundation.md): canonical agent architecture, current-main implementation status, and ownership boundaries.
9. [Dashboard Agent Evaluations](dashboard-agent-evals.md): executable corpus, submission protocol, deterministic scoring, and browser-lane handoff for agent-generated dashboards.
10. [AG2 Reference](ag2-reference.md): product lessons and explicit non-port list.
11. [AG2 Baseline Vocabulary](ag2-baseline-vocabulary.md): headcount schema template, HC subset, and intentional departures.
12. [Import Principles](import-principles.md): current agent-led CSV workspace contract, authority split, recovery semantics, and limits.
13. [CSV Import Integration Postmortem](csv-import-integration-postmortem.md): why Vendor CSV reuse expanded into an app-integration program, why the first vertical slices became too broad, and what the evidence-first rebuild changed.
14. [CSV Import App Integration Comparison](csv-import-app-integration-comparison.md): historical 2026-07-28 HC/Vendor side-by-side; not current architecture. Current contract is `import-principles.md`.
15. [Route-Owned Microfrontends](route-owned-microfrontends.md): checked root Vercel Services topology, route ownership, preview resolution, provider-neutral Compose proof, and shared-origin security boundary.
16. [Adopting a Route-Owned Application](guides/adopting-a-route-owned-app.md): canonical local source and route registration, optional hosted provisioning, validation, and framework-boundary guidance for route-owned Next.js and Vite apps.
17. [Building an App with App Builder](guides/building-apps-with-app-builder.md): complete app-building sequence: source/setup, direct creation, native configuration and tasks, generated-data features, authentication, compiler repair, validation, publication, Production handoff, and recent history coverage.
18. [Deployment Security](deployment-security.md): protected Vercel project graph, staged cutover, app/API authorization requirements, and browser hardening.
19. [Maintaining the Vercel Production Proof](guides/maintaining-vercel-production-proof.md): exact execution order, QA prerequisites, failure triage, provider receipt semantics, and safe modification checklist.
20. [Vercel Better Auth migration runner](guides/vercel-auth-migration-runner.md): native-Git Deployment Check migration boundary and provider setup.
21. [Independent Vercel Deployments Operations](operations/vercel-independent-deployments.md): sanitized monitoring, alert ownership, runbooks, Preview QA lifecycle, and spend-warning contract.
22. [Integrations](integrations/ampersand.md): hosted Ampersand integration boundary and V0 storage model. The [local connection-management app](integrations/connection-management-app.md) records the fixture UI and authorization boundary. The [Xero readiness gate](integrations/vendor-xero-readiness.md) records U8 evidence; the [Xero supplier/AP integration](integrations/vendor-xero.md) owns U11 runtime and rollout.
23. [Known Footguns](known-footguns.md): bounded V0 risks with explicit hardening triggers — substrate / contract layer.
24. [Interaction Footguns](interaction-footguns.md): UX / interaction questions with multiple defensible answers; current behavior + deferred-debate triggers.

## Operations and Tooling

- [Generated App Production Handoff](operations/generated-app-production.md):
  reviewed operator plan, tenant preparation and grants, runtime binding,
  protected proof, and pilot recovery.
- [Agent Tooling Reference](agent-tooling.md): the durable Actions contract:
  each pull request automatically creates only the change-aware `Check` run;
  the default branch automatically creates `CI` followed by `CD`. Deployment
  and deployed-provider proof are CD-owned or explicitly dispatched, never
  automatic pull-request workflows.
- [Tooling Script Ownership](tooling-script-ownership.md): the task-first command
  contract for humans and agents, the prohibition on root `scripts/`, and the
  narrow package-local script boundary.

## QA Evidence

- [Integrations Design QA](qa/design-qa.md): historical visual, interaction, and
  accessibility verification record for the Vendor integrations experience.

## Other References

- [OpenMicrofrontends SSR Protocol Pilot](open-microfrontends-pilot.md):
  completed standards proof and production security no-go decision.
- [Vendor Review Queue](vendor-review.md): active app contract for server-owned
  review projections, durable decisions, and interaction semantics.

## Proposals

- [Integration proposals](integrations/proposals/README.md): preserved Merge assessment and comprehensive App Builder integration architecture, decisions, implementation roadmap and acceptance criteria.

## Doc Roles

- `principles.md`, `contracts.md`, and `field-atlas.md` are lasting reference docs for the substrate.
- `schema-compiler.md` is the lasting reference for compiler inputs, generated
  artifacts and runtime APIs, integrated features, temporary migration paths,
  verification, and rollout sequencing.
- `frontend-architecture.md` is the lasting reference doc for UI layering and the design-system port.
- `ag2-reference.md` is the only place for AG2-specific rejected terms.
- `ag2-baseline-vocabulary.md` records AG2 baseline vocabulary, the `packages/domain-libs/` headcount domain libraries, and the explicit Autograph departures.
- `import-principles.md` is the current contract for the agent-led CSV
  workspace: one transient human-editable draft, agent preparation, exact
  pending-Save recovery, one canonical atomic Save, and the public
  package/app/kernel authority split.
- `csv-import-integration-postmortem.md` records the Vendor CSV integration
  failure modes and delivery lessons; `csv-import-app-integration-comparison.md`
  is historical evidence of the removed Vendor CSV product path and does not
  select a new shared abstraction.
- `deployment-security.md` defines deploy-time security requirements for the protected Vercel Services projects, provider-neutral Compose proof, app/API authorization, and browser hardening.
- `agent-tooling.md` defines the durable Actions topology: one automatic
  change-aware `Check` workflow for pull requests, and `CI` then `CD` for
  default-branch delivery. It also names the contract-test requirement for
  any intentional workflow-topology change.
- `route-owned-microfrontends.md` defines the selected production composition
  boundary, its checked root-project Vercel topology, and its gateway/security
  contract.
- `guides/adopting-a-route-owned-app.md` is the canonical application-owner procedure for creating, admitting, validating, and removing a route-owned Next.js or Vite app without shell coupling or application-owned platform configuration.
- `guides/building-apps-with-app-builder.md` is the canonical current setup for
  AppSpec/CUE-driven generated apps, their repository-owned lifecycle commands,
  and the source-only catalog boundary.
- `guides/maintaining-vercel-production-proof.md` is the operator and maintainer
  procedure for read-only Production proof diagnosis and proof-contract
  changes. Provider activation, rollback, and forward recovery require a
  separately approved change. The guide does not
  replace the durable security authority in `deployment-security.md`.
- `integrations/ampersand.md`, `integrations/data-model.md`, and the provider integration docs define the hosted boundary, the minimal tenant connection/app-binding control plane, retained app-owned data plane, and provider rollout gates.
- `known-footguns.md` is institutional memory of bounded risks and subtle edge cases, not unresolved architecture questions.
- `vendor-review.md` is the active Vendor Review Queue product/data contract.
- `agent-foundation.md` is the canonical source for current agent architecture
  and current-main HC implementation status.
- Canonical docs retain decided contracts and product rulings, not execution
  state or a work backlog.

## Decision Callouts

Docs use three labels:

- **Decision:** committed unless a future architecture PR explicitly changes it.
- **Decision, Revisit With Evidence:** default for V0; revisit only when a product flow proves pressure.
- **Open:** not decided; do not build substrate for it yet.
