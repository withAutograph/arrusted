# Component Port Tracker

This document tracks reusable UI capabilities that Autograph already has,
partially has, should port from AG2, or must design from scratch. A similarly
named file is not proof of capability parity: status is based on behavior,
ownership, tests, stories, and a real consumer.

## Source evidence

- The preliminary HTML catalogue is preserved in git commit `410ed75d` on
  `codex/bhq-14-vendor-mapping-runtime` at
  `docs/component-catalog/index.html` and
  `docs/component-catalog/from-scratch.html`. It covered four app journeys and
  classified components as shipped, built-unused, partial, missing, or AG2-only.
  It is useful evidence, but it is not current authority.
- That catalogue classified “Form controls, date field, listbox” as shipped.
  The listbox classification was too generous: the cited Autograph component
  is a styled native `<select>`, not behavioral parity with AG2's listbox.
- The current component implementation and stories under
  `packages/design-systems/core/` are the authority for what actually ships.
- AG2 is reference evidence under `/Users/bp/Projects/ag2`; Autograph contracts
  and layer boundaries remain authoritative.

## Status legend

| Marker | Meaning                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| ✅     | Public, domain-neutral API with focused tests, stories, and a real consumer.                                 |
| 🧩     | Working implementation exists, but its API or ownership is too narrow for general reuse.                     |
| ⚠️     | Public name exists, but important expected behavior is delegated to a native control or otherwise absent.    |
| 📥     | AG2 has relevant prior art and a current Autograph consumer has earned the port.                             |
| 🕒     | Evidence exists, but no current consumer has earned a public API.                                            |
| 🛠️     | Neither repository has an adequate reusable implementation or the behavior depends on an undecided contract. |

## Selection and option controls

| Capability                     | Current Autograph evidence                                                               | AG2 evidence                                             | Status | Required outcome                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native single select           | `FormControls.Select`                                                                    | Native selects also appear in legacy forms               | ✅     | Retain where browser-owned popup behavior is acceptable. Do not promise deterministic menu placement.                                                                                         |
| Native select API              | `components/Listbox.tsx` exports `NativeSelect`; deprecated `Listbox` aliases remain for migration | Native selects also appear in legacy forms               | ✅     | Retain where browser-owned popup behavior is acceptable and migrate deprecated aliases intentionally.                                                                                         |
| Anchored single-select listbox | Public `SearchableListbox` owns a portaled, collision-aware single-select popup used by relation/person pickers | `AGListbox` uses Headless UI plus the shared AG2 popover | 🧩     | Complete the remaining touch, Space, focus-restoration, browser accessibility, migration, and story acceptance proofs below.                                                                  |
| Searchable listbox             | `SearchableListbox` provides controlled local filtering, keyboard navigation, ARIA state, and bounded results | `AGListbox searchable`                                   | 🧩     | Keep async search behind caller-owned option loading until a typed option-source contract is earned; complete the acceptance gate below.                                                       |
| Multi-select listbox           | No public general implementation                                                         | `ag-ui/dropdown/MultiSelectDropdown.tsx`                 | 📥     | Controlled selected IDs, checkboxes, disabled items, keep-open selection, select/deselect all, searchable option, summary rendering, clear policy, and keyboard/screen-reader behavior.       |
| Fixed-vocabulary grid selector | `editors/value-select`                                                                   | AG2 listbox/editor patterns                              | 🧩     | Keep editor protocol behavior; eventually render the canonical listbox option surface rather than maintaining independent navigation logic.                                                   |
| Relation picker                | `editors/relation-picker`                                                                | AG2 relation/atom selectors                              | 🧩     | Keep record-key and async-domain mechanics outside the generic listbox; share popup/list navigation primitives where possible.                                                                |
| Person picker                  | `editors/person-picker`                                                                  | AG2 person editor                                        | 🧩     | Same boundary as relation picker, with person-specific result rendering owned by the editor.                                                                                                  |
| Auth combobox/select           | `packages/auth/components/ui/{combobox,select}.tsx`, built on Base UI                    | Not needed                                               | 🧩     | Auth owns its UI package. Design-system code must not import upward into auth; extraction requires an explicit dependency decision.                                                           |

### Listbox port acceptance gate

The port is not complete until all of these are proven:

1. The popup is portaled and matches the trigger width.
2. It opens below the trigger with the declared gap and flips above only on a
   measured viewport collision; it never overlaps the trigger merely to center
   the selected option.
3. Position updates on nested scroll, viewport resize, and trigger movement.
4. Mouse, touch, arrows, Home/End, Enter/Space, Escape, Tab, typeahead, disabled
   options, and focus restoration have behavioral tests.
5. Searchable and multi-select variants have explicit ARIA semantics and pass
   browser accessibility checks.
6. Stories cover normal, nullable, required, disabled, long, searchable,
   no-results, multi-select, narrow Sheet, clipped parent, and viewport-edge
   cases.
7. `RecordDetailPanel`, `SchemaForm`, and existing `Listbox` consumers migrate
   intentionally; native-select call sites remain native only when that
   tradeoff is documented.

## Other catalogue reconciliation

The historical catalogue remains useful but needs a fresh audit before being
restored as a live showcase. Its strongest still-relevant findings are:

| Family                                                                | Historical disposition             | Current tracker disposition                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form controls, date field, Sheet, toast, page tabs, segmented control | Shipped                            | ✅ Verify periodically through public exports, stories, tests, and consumers.                                                                                                                                                                                                                                                            |
| Agent chat, source import, editable grid, draft review, org chart     | Shipped reusable workflow surfaces | ✅ Track in their owning module rather than duplicating their internals here.                                                                                                                                                                                                                                                            |
| Charts and AG2 chart templates                                        | Gated AG2 port                     | 🧩 The Enterprise host plus breakdown, stacked-timeline, waterfall, scatter/bubble, and range-marker props/spec families are implemented with token-driven styling, square-baseline bars, controls, opaque actions, and Vendor Analytics Storybook proof. Production license and the Vendor Analytics app adapter remain consumer gates. |
| Generic issue queue and shared connection card                        | Extract from running app code      | 🕒 Extract only with a second consumer or clear no-regret boundary.                                                                                                                                                                                                                                                                      |
| Server-paged table, chart-to-row drill-through, domain guardrails     | Build/design work                  | 🛠️ These depend on data and policy contracts, not only visual components.                                                                                                                                                                                                                                                                |

### Chart family inventory

This table is the component-level chart port list. “Implemented” means the
family has a public prop contract, a bounded serializable spec, token-driven
rendering, tests, and Storybook evidence. It does not imply that an application
has supplied production data or an Enterprise license.

| AG2 family or template                     | Autograph disposition                                                                    | Remaining gate                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Horizontal breakdown                       | 🧩 Implemented as `BreakdownChart`                                                       | Production app adapter and license.                                                     |
| Stacked bar, area, and multi-line timeline | 🧩 Implemented as `StackedTimelineChart` variants                                        | Production app aggregation and granularity semantics.                                   |
| Waterfall                                  | 🧩 Implemented as `WaterfallChart` with square cumulative range bars and connector lines | Production app data adapter and action resolver.                                        |
| Scatter and bubble                         | 🧩 Implemented as `ScatterChart`                                                         | Production app data adapter and action resolver.                                        |
| Range marker                               | 🧩 Implemented as `RangeMarkerChart`                                                     | Production app data adapter and action resolver.                                        |
| Donut                                      | 🧩 Implemented as `DonutChart`                                                           | Production app adapter, small-segment product policy, and license.                      |
| Distribution cards                         | 🕒 Deferred                                                                              | A real consumer must establish total and compact-layout policy.                         |
| Funnel                                     | 🕒 Deferred                                                                              | A real consumer must establish stage and drop-off semantics.                            |
| Combined bar-line                          | 🧩 Implemented as `CombinedBarLineChart`                                                 | Production app adapter and approved dual-measure semantics.                             |
| Heatmap                                    | 🧩 Implemented as `HeatmapChart`                                                         | Production app adapter and matrix-density product policy.                               |
| Treemap and Sankey                         | 🕒 Deferred                                                                              | Enterprise, hierarchy/flow interaction, and textual-summary proof.                      |
| Radar                                      | 🕒 Deferred                                                                              | A real consumer must establish comparable-scale semantics.                              |
| Quarterly impact                           | 🛠️ Not a generic port                                                                    | Planning semantics belong to the consuming app before any reusable visual is extracted. |

Shared chart controls, value formatting, textual summaries, and opaque series
actions are implemented once across the shipped families. Chart-to-row
drill-through remains app-owned: the component emits opaque metadata and the
host decides whether that means navigation, a detail panel, filtering, or no
action.

When the HTML showcase is revived, generate its status data from this tracker or
another checked structured source. Do not maintain a second hand-written truth
that can again label a native facade as a complete port.

## Proving AI-generated record detail panels

The AI should generate declarative presentation policy, not fetch code,
callbacks, raw persisted values, or write authority. The reliable boundary is:

```text
generated schema + typed read result + app policy
                    |
                    v
deterministic record-detail adapter
                    |
                    v
RecordDetailPanel props / validated display-only composition spec
                    |
                    v
opaque callbacks resolved by the trusted app or module
```

### Contract to add

Introduce a serializable `RecordDetailViewSpec` distinct from loaded panel
props. It should reference `model_id` and `field_id` values, section/order
policy, permitted presentation hints, and optional table/relation projections.
It must not embed record values or executable actions. A deterministic adapter
should accept:

- the generated/client-facing active `Schema`;
- a typed visible-record read result for one model;
- app-owned authorization and edit policy;
- the validated view spec;

and produce `RecordDetailPanelProps`. Field types choose default controls via a
single shared adapter; enum options come from the active schema; relation
labels/options come from trusted app/module loaders; custom fields follow the
generated custom-field contract. Writes remain opaque callbacks compiled by
the host into the existing draft/apply lifecycle.

### Test ladder

1. **Static contract tests:** compile representative view specs against the
   generated TypeScript schema types. Prove unknown models/fields, duplicate
   placement, unsupported controls, mismatched field types, and unauthorized
   edit hints fail.
2. **Runtime boundary tests:** send trusted and adversarial JSON through the
   composition registry's `agent` trust tier. Prove size limits,
   serializability, option/value compatibility, and display-only behavior.
3. **Adapter fixtures:** for text, decimal number, bool, date/datetime, enum,
   relation, text list, money rate, orphaned enum, null, and custom fields,
   assert the exact props produced from schema plus record DTO fixtures.
4. **Controlled-host tests:** render the resulting panel with a real test host.
   Prove value changes, validation errors, dirty/original values, revert,
   cancellation, and opaque save actions round-trip without internal panel
   state becoming persistence authority.
5. **Data integration test:** materialize a small schema and records through the
   kernel/client fixture, read them through the generated client, adapt them,
   render the panel, propose an edit, and assert the host produces the expected
   `ApplyChangeSet` or draft input. The panel itself never calls the kernel.
6. **Agent evaluation corpus:** give an agent several schemas and user requests
   (“show compensation without editable sensitive fields”, “put manager and
   department first”, “include recent related rows”). Score valid-spec rate,
   unknown-field rate, policy violations, deterministic render success, and
   whether a repair pass can correct validator diagnostics.
7. **Browser and accessibility matrix:** Playwright at narrow Sheet, split pane,
   and page widths; keyboard-only editing; automated accessibility scan;
   screenshots for long text, tables, errors, dirty values, listboxes, and
   viewport edges.

The key success criterion is not that an agent can emit plausible JSX. It is
that an agent can select from a bounded vocabulary, reference real schema IDs,
survive deterministic validation, and produce a panel whose data and writes are
owned by trusted repository contracts.
