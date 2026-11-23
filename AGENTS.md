# Autograph Agent Guide

- [`docs/`](docs/README.md) is the implementation contract. Follow the
  ownership rules in [`docs/principles.md`](docs/principles.md) and
  [`docs/contracts.md`](docs/contracts.md); update code and contracts together.
- Keep changes task-scoped. Use Git and commit completed task changes with
  `HK=true` so repository hooks validate the staged tree.
- New repository operations are mise tasks, not root scripts. Global repository
  tasks belong under `.config/mise/tasks/` and may expose only repository-owned
  validation, orchestration, or provider-neutral operations. App-specific
  operations belong under `apps/<app>/.config/mise/tasks/` and are invoked with
  `mise //apps/<app>:<task>`; never add a root alias such as
  `.config/mise/tasks/<app>/` or `mise run <app>:...` for them. Put non-trivial
  repository implementation under `.config/mise/scripts/repository/`, keep
  app-specific implementation with its app, and expose developer- or CI-facing
  app operations through the app's mise task. Follow
  [`docs/tooling-script-ownership.md`](docs/tooling-script-ownership.md). The
  `check:tooling-layout` gate enforces this split for root task files and
  aliases.
- Prefer the cheapest product cut that still makes the fact visible. Show
  run facts (date, scope) where they are used. A fact the user works in,
  such as a canvas session's as-of date, may stay editable when changing it
  re-reads every view and leaves the work it affects for review at Save,
  never rewriting it silently. Otherwise set the fact at the start of the
  run and show it read-only.
- Read [`docs/agent-tooling.md`](docs/agent-tooling.md) only when its tooling
  applies.
- Any task that changes Vercel deployment, Microfrontends routing, aliases,
  environments, release selection, rollback, or deployed proof must follow
  these rules. Use the pinned MIT `@vercel/microfrontends` library directly, but do not
  enable Vercel's paid Microfrontends product, project groups, native
  shared-domain routing, or product fallback. The bounded custom authenticated
  Gateway is the final deployed composition plane.
  Do not add or expand Git merge, pull-request, commit-containment, ancestry,
  or branch-up-to-date state as deployment authority. The current stable
  Preview alias/merged-PR selector is a documented migration source to contain
  and remove, not a precedent to extend. Provider-generic Gateway and Vercel
  adapter code belongs in the open-sourceable neutral boundary; only
  Autograph-specific policy belongs in the private platform package. The deployment-policy checker and its containment ledgers were removed with
  deployment orchestration in this spike; the deployment authority rules above
  still apply to any later deployment work.
  The supported delivery sequence is `Git push → independent native Vercel
  deployments → provider-owned activation → Gateway routing → read-only CD
  proof`. Repository CD must never deploy, promote, alias, roll back, or select
  a Vercel deployment. `REPOSITORY_RELEASE_ENABLED` is template-instance safety
  only: active Arrusted enables its repository CD lanes, while generated
  repositories remain disabled by default. Ampersand source ordering is allowed
  only inside its own manifest mutation lane and must resolve superseded
  candidates as successful no-ops without influencing Vercel or Gateway results.

- For startup or troubleshooting in a Cursor Cloud VM, read
  [Cursor Cloud setup](docs/guides/cursor-cloud-setup.md).
- Prefer maintained official packages and repository-owned components. Keep
  project-specific agent guidance in this repository and load detailed workflows
  only when the task needs them.

## Iteration and CI

Reproduce concrete failures locally when feasible through real serialization or
command paths and controlled test-owned fixtures. Make the smallest functional
repair with focused regressions before another hosted cycle. Follow
[local repair and hosted validation](docs/contracts.md#local-repair-and-hosted-validation):
reuse valid unchanged evidence, run integrated local validation once ready, and
reserve hosted checks for provider bindings, native deployment and authenticated
behavior. Preserve credential, tenant-isolation, approval and cancellation
boundaries.

Keep CI focused on observable functionality, actual command failures, and
credential, tenant-isolation and approval boundaries. React Doctor findings,
style preferences and design scores are advisory: retain their reports without
making them merge or delivery gates. Do not introduce speculative source, path,
layout, cache, receipt or version gates for normal app changes. Preserve actual
approval and credential bindings, and test behavior instead of exact
implementation details or incidental output.

Platform tests own their controlled schema, compiled release and application
fixtures. Do not copy mutable generated apps into platform fixtures or treat
an app's current roles, schema, workflow or release version as platform rules.
Compile minimal test-owned inputs for the platform behavior under test and
retain credential, tenant-isolation, approval and recovery assertions.
App-owned tests may assert that app's accepted product behavior; normal app
changes do not create a platform admission requirement.

## Project skill ownership

Use the official Vercel package described in
[`.config/codex-marketplace/README.md`](.config/codex-marketplace/README.md) for
React, Next.js, shadcn and Vercel-specific work. Keep platform packages
project-scoped. Use mise checks for validation. Use Vercel verification only
when the task requires a deployed provider flow.
