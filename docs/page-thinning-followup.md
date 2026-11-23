# Page-Thinning Followup

This is the active cleanup backlog after the schema-driven editable-grid
migration. It exists to keep `PositionsPage` and adjacent HC pages from
re-growing page-local substrate plumbing while avoiding premature shared
abstractions.

The frame from the original review still holds:

> The page should not re-declare what the schema, contracts, or reusable
> substrate modules already declare.

That does **not** mean every page-sized surface should become a module. Pages
are allowed to own product semantics, copy, and orchestration. Extract only
when the shape is substrate-forced or already repeated across real surfaces.

## Current Size

- `apps/hc/frontend/src/pages/PositionsPage.tsx`: ~700 LOC.
- `apps/hc/frontend/src/pages/ApprovalsPage.tsx`: ~225 LOC.
- `apps/hc/frontend/src/pages/BulkUpdateSheet.tsx`: ~450 LOC.
- `apps/hc/frontend/src/pages/NewPositionSheet.tsx`: ~245 LOC.
- `packages/modules/editable-grid/useEditableRowVersionGrid.ts`: ~1330 LOC.
- `apps/hc/src/schema.rs`: ~980 LOC.

These are still large, but the remaining bulk is closer to live HC product
semantics than the old hand-declared column/grid boilerplate.

## Done

### F1: Schema-driven column construction

Done. `PositionsPage` now calls:

```ts
useEditableRowVersionGrid({ schema, model, fieldOverrides, fieldOrder });
```

instead of hand-declaring every AG Grid column. Generic column construction
lives in `@modules/editable-grid`; HC-specific validators, formatters,
relation options, widths, and visibility live in
`apps/hc/frontend/src/schema/field-overrides.ts`.

This also completed F7: validator wiring now flows through `fieldOverrides`.

### F2: Formatter consolidation

Done for the no-regret shared formatting surface. `@engines/format` now owns:

- `formatCompactCurrency`
- `formatCompactPercent`
- `formatMoneyRatePeriod`
- `formatCompactMoneyRate`
- `formatIsoDateLong`
- `formatField(value, field, { relationLabel })`

That removed duplicated money-rate period maps and draft-review's local
field stringifier. Keep this engine to one canonical generic string per field
type; app-specific presentation should remain an override in app config or
`fieldOverrides`.

### F3: App-level config

Done for current HC knobs. `apps/hc/app-config.ts` owns:

- `HC_APP_CONFIG.saveMode`
- `HC_APP_CONFIG.positionEditDefaultChangeType`
- shared local-date helper `todayIso()`

`apps/hc/frontend/src/schema/change-types.ts` still exports the convenient
`POSITION_EDIT_DEFAULT_CHANGE_TYPE` binding for the current position grid.
CSV import defaults are selected separately by the app-authored active schema's
`is_import_default` declarations.

### F5: Cross-view lookups

Done at the pure-helper level. `apps/hc/frontend/src/lookups/index.ts` owns
shared pure helpers:

- `buildNameLabelMap`
- `buildRelationOptions`
- `buildLookupBundle`
- `buildPositionLookup`

This removed duplicated label-map and relation-option construction from
`PositionsPage` / `ApprovalsPage`.

Do not add hook-level lookup helpers like `useDepartmentLookup(asOf)` yet.
Defer until the HC app has another real page using the same lookup set;
otherwise the hook shape will be a guess.

### F6: Reads-status helper

Done as an app-local helper. `apps/hc/frontend/src/read-status.ts` combines
schema, primary records, and secondary lookup read states into structured
status copy for `PositionsPage`.

Do not promote this to a shared module yet. The primary / secondary priority
and the final user-facing wording are still app/page semantics unless two
pages repeat the shape exactly.

### F8: Partial-failure save coverage

Done. The old gap was:

1. stage edits across multiple change types;
2. first save partition succeeds;
3. second partition fails;
4. reload runs;
5. succeeded entries clear while failed entries stay dirty;
6. retry preserves idempotency for the failed unchanged payload.

`packages/modules/editable-grid/__tests__/hooks.test.tsx` now covers the
multi-change-type partial-failure flow, retry idempotency reuse, and fresh
idempotency after a failed partition is re-edited.

### Hygiene / Splits

Done in the hygiene branch:

- `packages/modules/editable-grid/index.tsx` is now a small export barrel.
- `EditableRowVersionGrid.tsx`, `useEditableRowVersionGrid.ts`, `types.ts`,
  and `save-partitioning.ts` are split out.
- Package probes now live under the owning package `__tests__` folders instead
  of a central package-test grab-bag.
- HC record-key serialization lives in `apps/hc/frontend/src/record-key.ts`.
- Design-system decimal parsing and record-key serialization are shared inside
  the design-system editor layer.
- `apps/hc/frontend/src/kernel-client.ts` owns HC frontend client/scope wiring.
- `apps/hc/frontend/src/read-status.ts` owns the app-local read-status helper
  used by `PositionsPage`.
- HC-specific app helper tests moved beside HC frontend source; the root
  package-test runner only orchestrates them.
- The HC capture scripts share a small Playwright capture helper.

## Still Worth Doing

### F4: Toolbar / sheet composition, but not as a page shell

Original target was a high-level `<EditableRowVersionPage>` composite owning
toolbar layout, sheet open flow, and grid placement. Do **not** build that
as a page-sized god component yet.

What may still be worth extracting:

- a thin slot-based `EditableGridToolbar` layout primitive;
- a shared submit/discard dock if a second editable page repeats the same
  exact chrome;
- schema-driven sheet primitives only after the app proves the form policy is
  truly schema-shaped rather than HC-shaped.

Keep `BulkUpdateSheet` and `NewPositionSheet` app-local for now. Their copy,
required fields, relation pools, change-type policy, and flow details are
still HC product semantics.

### Visual Proof Script Consolidation

Partially done. `.config/mise/scripts/repository/playwright-capture.ts` now centralizes Playwright
setup, output-directory creation, console capture, and browser cleanup for the
main HC capture scripts.

Still open: migrate the older `sweep-*` and `spike-*` scripts toward the same
helper only when touching them. Do not collapse the scenarios into one
over-abstract harness before the HC visual proof surface settles.

## Defer Until HC Stabilizes

These are real cleanup targets, but extracting now risks locking in the wrong
shape:

- deeper decomposition of `useEditableRowVersionGrid.ts`;
- deeper decomposition of `PositionsPage.tsx`;
- splitting `apps/hc/src/schema.rs`;
- schema-driven `BulkUpdateSheet` / `NewPositionSheet` modules;
- hook-level lookup APIs beyond the current pure helpers.
- page/module seam changes beyond the current no-regret helper extractions.

Use the second-consumer rule here: wait until employee-facing pages, org
planning, or another app repeats the shape. Then extract the part that is
literally shared.

## Do Not Do Yet

- Do not create a page-sized editable-grid shell component.
- Do not move HC sheet form policy into shared modules.
- Do not make domain libs runtime dependencies of shared modules; modules must
  not import `packages/domain-libs`.
- Do not add presentation modes to format engines unless a real consumer
  proves the need.
- Do not split `packages/kernel/src/db.rs` as routine hygiene; only do it as a
  deliberately mechanical backend-contract PR with `mise run check` and
  Postgres-backed kernel tests.

## What Should Stay App-Local

- HC change-type inference policy.
- HC validator wiring through `fieldOverrides`.
- Relation-label lookup composition.
- Sheet copy and form policy.
- Save-outcome toast wiring and position-aware error humanization.
- Route wiring and page-level loading/error copy.
