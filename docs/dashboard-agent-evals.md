# Dashboard Agent Evaluations

The dashboard-agent evaluation package measures whether an AI agent can build
a valid Autograph dashboard from the public composition vocabulary without
bypassing data, ownership, or chart-library boundaries.

Its private implementation lives in `packages/dashboard-agent-evals`. It is
repository evaluation tooling, not a product application or deployable service.

## Run the harness

List the corpus:

```sh
mise run eval:dashboard-agent -- --list
```

Score the canonical Vendor example:

```sh
mise run eval:dashboard-agent -- \
  --case vendor-spend-overview \
  --submission packages/dashboard-agent-evals/fixtures/vendor-spend-overview/submission.json
```

Add `--json` for a machine-readable report. The command exits nonzero when the
submission fails.

## Inspect the rendered result

Run the component catalog and open **Agent Evaluations / Dashboard Results /
Canonical Vendor Submission**:

```sh
mise run storybook
```

The result workspace renders the exact chart configs recorded in the canonical
submission through the production `ChartComposition` contract. It includes
desktop and narrow previews, live controls and action feedback, complete scoring
evidence, run metadata, and the submitted JSON chart specs. The checked-in report
fixture is evaluator output; update it whenever the canonical submission changes
so visual and deterministic evidence remain paired.

## Agent protocol

For each run, give the agent:

1. one case from `packages/dashboard-agent-evals/corpus.ts`;
2. the case's fixture/generated-client data supplied by the app test;
3. the public design-system and composition contracts; and
4. a fresh task-scoped app directory or worktree.

The agent builds normal app code and emits a versioned `submission.json` next
to the source files it changed. The manifest records the case and process
evidence, entry file, task-scoped source paths, exact serializable chart
configs, host-owned control bindings, and host-owned opaque action bindings.
The entry file must import that exact manifest and render its chart configs
through `ChartComposition`, so the scored artifact and rendered artifact cannot
silently diverge.

The evaluator strictly validates the complete envelope before scoring. The
runner recursively derives the candidate source set from the bounded submission
directory, rejects symlinks, and requires the manifest's source inventory to
match. An agent cannot omit an unsafe or over-budget file from evaluation.

The manifest is deterministic evaluation evidence. It is not a runtime app
manifest and production code never consumes it.

## Scoring

The deterministic rubric totals 100 points:

| Check                                           | Points | Hard failure |
| ----------------------------------------------- | -----: | :----------: |
| Correct case identity                           |      5 |     yes      |
| Production chart-spec validation                |     20 |     yes      |
| Requested families present                      |     10 |     yes      |
| Public API boundary; no direct AG Charts access |     15 |     yes      |
| Expected aggregation values                     |     15 |     yes      |
| Currency and missing-value policy               |      5 |     yes      |
| Host-owned control bindings                     |     10 |      no      |
| Host-owned opaque action bindings               |     10 |      no      |
| Task-scoped file budget                         |      5 |      no      |
| Valid first attempt                             |      3 |      no      |
| At most one repair                              |      2 |      no      |

A submission passes at 80 points only when it has no hard failures. Validator
and aggregation diagnostics include stable paths suitable for one repair pass.

## Corpus

The initial ten cases cover Vendor spend, headcount movement, compensation,
recruiting, budget versus actuals, sparse data, multi-currency data, duplicate
heatmap coordinates, ambiguous chart activation, and a narrow embedded
dashboard. The canonical Vendor fixture proves the evaluator itself; it is not
a production Vendor adapter.

## Proof boundary

The deterministic lane proves that an agent produced production-valid chart
specs, rendered those exact specs through the public composition, used
requested public families, preserved declared data policies and aggregations,
declared controls/actions in both the specs and host binding inventory, and
stayed within a runner-owned file and repair budget.

It deliberately does not execute candidate-authored commands or trust an agent
to self-report typecheck/browser success. A production runner must create the
candidate workspace itself and run repository-owned typecheck, ast-grep, and
browser commands. The browser lane owns responsive layout, console errors,
keyboard action parity, real control effects, action outcomes, and visual rendering. The
Storybook evaluation result is the human inspection surface and reference
fixture; it does not replace automated browser assertions for arbitrary
candidate submissions.

## Success targets

- At least 80% of cases pass on the first attempt.
- 100% pass after at most one validator-guided repair.
- No direct `ag-charts-*` or internal chart-runtime imports.
- No aggregation, currency, or missing-value hard failures.
- Median file and repair budgets remain predictable across agent versions.
