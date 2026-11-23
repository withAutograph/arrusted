# CSV Import Integration Postmortem

Status: team learning document.

Date: 2026-07-28.

Scope: the effort to add the existing CSV import experience to the Vendor app,
from the first Ramp-specific branches through the merged preview, Save, and
Review Queue handoff.

## Executive Summary

Adding CSV import to Vendor looked like a component-integration task. It was
actually an app-integration program spanning schema authority, mapping policy,
deterministic compilation, identity, authenticated transport, persisted write
policy, and downstream review.

The repository already had substantial reusable import machinery:

- CSV parsing and profiling;
- import classification and coercion;
- file intake and staged source-import presentation;
- editable previews and Save mechanics; and
- the generic kernel apply path.

It did not have a turnkey importer that could accept an arbitrary app schema
and safely infer the rest. The complete HC reference flow remained deliberately
HC-owned: its plan, prompt, tools, identity rules, compiler, session lifecycle,
transport, and Rust validation all encode HC policy.

The first Vendor attempt crossed too many of those boundaries at once. PR #496
combined a Ramp compiler, schema changes, generated DTOs, an authenticated
planning route, identity decisions, and app chrome, but still stopped before
UI composition, persistence, and Mercury. The stacked PR #497 then added a
deployed atomic import and another review workflow, growing to 8,296 additions
across 46 files before it was closed.

The successful approach was to decompose the work into evidence and contract
checkpoints. The merged sequence proved the existing substrate, established
fixtures and mapping behavior, resolved product decisions, added the Vendor
catalog and change types, composed a preview-only flow, enabled the simpler
human-reviewed Save path, and finally proved the Review Queue handoff.

This was not primarily an implementation failure. It exposed an abstraction
and expectation gap: `source-import` is a reusable workflow module, not a
configured import product.

## Intended Outcome

An authenticated Vendor user should be able to:

1. upload a representative spend CSV;
2. receive bounded mapping assistance;
3. review and edit deterministic `vendor` and
   `vendor_spend_transaction` previews;
4. Save permitted rows through the ordinary Vendor and kernel write path; and
5. continue into the existing tenant-wide Review Queue.

The implementation had to preserve the active Vendor schema, existing
connected integrations, strict tenant scope, generated wire authority, and
app-owned product semantics.

## What We Expected To Reuse

The task framing made it easy to infer an integration model like:

```text
Vendor page
  + existing source-import component
  + Vendor schema
  = Vendor CSV import
```

The actual composition was:

```text
generic file intake, parsing, preview, and Save mechanics
  + generated Vendor schema and import catalog
  + bounded Vendor mapping contract and runtime
  + Vendor identity, relation, date, money, and explicit re-import limits
  + deterministic Vendor compiler
  + authenticated Vendor transport
  + Vendor Rust write authorization
  + explicit lifecycle guarantees
  + downstream Review Queue contract
  = Vendor CSV import
```

The second expression is consistent with the architecture: reusable modules own
workflow mechanics, while apps own mapping plans, relation and lookup policy,
deterministic compilation, runtime transport, and product copy.

## Timeline And Evidence

### Initial vertical-slice attempts

#### PR #496 — Vendor Ramp compiler and planning checkpoints

[PR #496](https://github.com/withAutograph/arrusted-development/pull/496)
introduced the first Vendor-owned Ramp compiler and authenticated planning
route. It also added generated mapping DTOs, source evidence fields, schema
changes, identity behavior, fixtures, and app chrome.

The PR description correctly acknowledged that it still did not include:

- source-import UI composition;
- durable sessions;
- raw artifact persistence;
- Save or commit behavior; or
- Mercury compilation.

Review findings exposed policy and parity risks:

- the documented transaction reference did not match the derived-ID behavior;
- empty date samples could produce an unanswerable blocking clarification; and
- two-digit years were interpreted differently by plan validation and row
  compilation.

The branch demonstrated that even a "compiler and planner" checkpoint already
spanned generated contracts, schema transitions, runtime security, deterministic
identity, and product policy.

#### PR #497 — deployed Ramp vertical slice

[PR #497](https://github.com/withAutograph/arrusted-development/pull/497)
stacked an atomic preview/commit/replay runtime, source-import UI, production
routes, schema changes, and a second Review Queue workflow on top of the first
attempt.

Because it was stacked on the first attempt, the branch reached a cumulative
8,296 additions across 46 files, including generated and schema artifacts. Its
own description still listed additional read surfaces and Mercury as
follow-ups. The PR was closed rather than used as the path to `main`.

The important signal was not merely the diff size. A single "CSV integration"
branch was simultaneously deciding:

- lightweight reviewed Save versus durable import commit;
- browser versus server ownership of accepted plans;
- transaction identity and replay semantics;
- schema migration and allowed write types;
- Vendor Type review policy; and
- production routing and request limits.

That cumulative scope made the decisions difficult to review and validate
independently.

### Rebuilt evidence-first sequence

The replacement sequence separated reusable capability, product decisions, and
runtime delivery.

1. [PR #523](https://github.com/withAutograph/arrusted-development/pull/523)
   inventoried the existing substrate and reproduced each Vendor gap. It
   established that most missing pieces were Vendor composition, not kernel or
   generic-module defects.
2. [PR #524](https://github.com/withAutograph/arrusted-development/pull/524)
   defined sanitized fixtures and a deterministic 1,592-row regression corpus
   without adding runtime behavior.
3. [PR #525](https://github.com/withAutograph/arrusted-development/pull/525)
   proved bounded mapping and deterministic execution against the active
   schema. It stopped at typed candidates because transaction identity,
   relation policy, and valid change types were still unresolved.
4. [PR #526](https://github.com/withAutograph/arrusted-development/pull/526)
   made the minimum production composition and outstanding product decisions
   explicit.
5. [PR #565](https://github.com/withAutograph/arrusted-development/pull/565)
   added generated import change types and a fail-closed Vendor import catalog.
6. [PR #575](https://github.com/withAutograph/arrusted-development/pull/575)
   composed the existing source-import surface as a stateless, preview-only
   Vendor workflow.
7. [PR #584](https://github.com/withAutograph/arrusted-development/pull/584)
   enabled the deliberately simpler human-reviewed Save path and permitted only
   the approved model/change-type pairs at the Vendor Rust boundary.
8. [PR #586](https://github.com/withAutograph/arrusted-development/pull/586)
   proved that saved Vendor records enter the existing durable identity-review
   workflow.

This sequence delivered the intended V0 path without introducing a new kernel
contract, a second importer, or an unearned durable-session abstraction.

## Primary Contributing Factors

### 1. The module name overstated the integration contract

`packages/modules/source-import` owns source artifact selection, inspection
handoff, workflow status, preview and Save staging, issue presentation, and
editable-grid apply composition.

It does not own:

- application schema projection;
- semantic mapping vocabulary;
- prompts or tools;
- relation and lookup policy;
- deterministic row compilation;
- source identity;
- runtime transport;
- authenticated actor and provenance policy; or
- application copy.

The module is reusable, but it is not self-configuring. Treating "reusable" as
"ready to enable in another app" hid most of the work.

### 2. The only complete reference flow was app-specific

HC demonstrates a complete agent-assisted import, but completeness comes from
HC-owned code. Its plan, compiler, actions, session state, URL hydration, Rust
session routes, and validations target HC models.

Vendor could use HC as executable evidence, but could not import or rename it
without moving HC policy into another app or into generic packages.

### 3. Preview validity depended on schema and persisted write policy

The UI could not produce a valid typed preview until Vendor had:

- generated import change types for both target models;
- declared which fields were model-mappable, compiler-owned, or
  server/integration-owned;
- supplied a catalog compatible with source-import preview validation; and
- defined required fields for each staged model.

Save then required a separate Rust policy change. The browser write boundary had
to accept exactly:

- `vendor_import` targeting `vendor`; and
- `vendor_spend_transaction_import` targeting
  `vendor_spend_transaction`.

This is why mounting the UI before schema and write policy were settled could
only produce a demo, not a valid integration.

### 4. Identity and relation behavior were unresolved product policy

Generic parsing cannot decide when two source rows represent the same Vendor or
transaction. Vendor had to own:

- source-namespaced transaction references;
- native versus derived record IDs;
- duplicate-row behavior;
- corrected and reordered re-import behavior explored by the fixture and
  abandoned Ramp-specific work, while the delivered generic V0 explicitly
  deferred same-file re-import policy and advanced matching;
- normalization that does not collapse distinct names;
- Vendor creation and transaction-to-Vendor linkage; and
- unresolved chart-account handling.

Review of the preview implementation found that aggressive external-key
normalization could merge names such as `Acme-Corp` and `Acme_Corp`. That is a
product correctness issue, not a parsing issue.

### 5. Planning and compilation could disagree

The first implementation duplicated semantic validation across the plan
contract and compiler. Reviews found concrete drift:

- empty date samples were treated as an ambiguous format requiring an answer
  even though the UI had no evidence to show; and
- the planner and compiler used different two-digit-year cutoffs.

The general failure mode is accepting an agent plan under one interpretation
and compiling rows under another. Shared parsing helpers or parity tests are
required wherever the same policy is evaluated at both stages.

### 6. Authentication and request limits were part of the feature

The mapping route had to:

- authenticate before loading tenant schema or invoking a model;
- bind trusted authentication to the normalized request target;
- reject unsupported methods, query parameters, and content types;
- stream and cap request bodies;
- bound columns, samples, text, diagnostics, tokens, and wall time; and
- avoid sending raw or unbounded source data to the model.

Route and runtime tests had to verify those security and resource boundaries,
while visual proof had to assert that the required mapping request was
exercised rather than merely rendering a mocked success state. This made the
route a security boundary, not routine UI plumbing.

### 7. "Save" concealed two different durability contracts

The durable import lifecycle stores the source artifact, mapping state, preview,
and accepted compiled plan, then commits a referenced preview with stale checks
and deterministic replay.

The chosen Vendor V0 flow is different: deterministic code creates a browser
preview, a human reviews or edits it, and Save submits the current staged rows
through ordinary kernel apply.

The V0 flow intentionally does not promise:

- a stored preview receipt;
- resumability;
- cross-model atomicity; or
- exact-preview stale detection.

The first vertical slice drifted toward the durable lifecycle before the
product had selected those guarantees. Making the lifecycle choice explicit
removed a large amount of unnecessary machinery.

### 8. Validation infrastructure could produce misleading evidence

The capability audit found a Postgres test that returned early when
`PLATFORM_TEST_DATABASE_URL` was absent, allowing Cargo to report a passing test
without executing the persistence assertions. A repository-local ignored cache
also caused the boundary scanner to report a false violation.

Neither issue caused the import design problem, but both made it harder to
separate verified behavior from local-environment artifacts. Later evidence
tests failed loudly when required infrastructure was absent.

## What Went Well

- The architecture boundary prevented Vendor semantics from leaking into the
  kernel or generic source-import package.
- The capability trace converted assumptions into exact interfaces and
  reproduced gaps.
- Sanitized fixtures made identity, candidate re-import behavior, relations,
  currency, and scale reviewable without production data, even where the
  resulting V0 policy was to defer advanced matching.
- Preview-only delivery created a safe checkpoint before widening write
  authority.
- The final Save path reused ordinary authenticated kernel apply instead of
  introducing a second commit protocol.
- Reviews found real correctness and security issues, including identity
  collisions, planner/compiler date drift, request-bound authentication gaps,
  and write-policy mismatches.
- The downstream Review Queue proof verified the user journey beyond a
  successful API response.

## What Could Be Improved

- The initial task should have started with an integration-contract inventory,
  not a vertical-slice implementation.
- `source-import` documentation and API naming should make its required
  app-owned adapter surface obvious.
- The lifecycle choice should be required at intake: interactive reviewed Save
  or durable preview/commit.
- Schema catalog, frontend compiler, and Rust write policy should have a shared
  conformance check so they cannot drift independently.
- Planning/compiler parity needs focused tests for every shared semantic rule.
- Route tests must assert authentication and resource limits; visual proof must
  assert required requests as well as rendered states.
- A second-consumer comparison should happen before copying HC orchestration
  patterns.

## Recommended Corrective And Preventive Actions

These are recommendations from the postmortem, not adopted architecture or
scheduled work. Each requires an owning follow-up decision or PR with its own
acceptance proof.

### Near-term recommendations

1. Start each new app import with a capability matrix covering file intake,
   schema catalog, plan, compiler, preview, identity, relations, Save policy,
   authentication, lifecycle, and downstream workflow.
2. Choose and document one lifecycle before implementation:
   `interactive-reviewed-save` or `durable-preview-commit`.
3. Require generated wire DTOs or `packages/contracts`; do not hand-type
   request or response mirrors.
4. Establish sanitized fixtures and explicitly decide whether re-import
   behavior is delivered or deferred before model or UI work.
5. Add frontend/Rust conformance proof for every permitted
   model/change-type pair.
6. Fail evidence tests loudly when their required database or provider
   infrastructure is missing.

### Design next

Use the companion
[CSV Import App Integration Comparison](csv-import-app-integration-comparison.md)
to define a typed app-adapter contract and conformance suite for the mechanics
now repeated by HC and Vendor.

Graduate only behavior proven domain-invariant by both consumers. Keep app
models, mapping vocabulary, prompts, relation policy, identity policy,
compilers, and product copy app-owned.

## Final Assessment

The Vendor CSV work was difficult because the reusable boundary was narrower
than the feature-level language implied. The architecture itself was mostly
correct: it kept generic mechanics reusable and domain meaning app-owned. The
systemic gap was that the module name, documentation, and integration surface
did not make the required app-owned composition obvious enough at task intake.

The evidence-first rebuild turned that ambiguity into explicit contracts and
delivered a smaller, honest V0. The next improvement should not be a universal
compiler. It should be a clearer app-integration contract, generated starting
points, and shared conformance proof for the domain-invariant glue that HC and
Vendor now demonstrably repeat.
