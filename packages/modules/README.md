# Modules

Modules are job-shaped reusable workflow surfaces. They may be page-sized, but
they are not pages by default.

Modules own repetitive substrate workflow plumbing:

- preview / commit / idempotency
- draft / apply / discard
- matching / resolution
- schema-aware field selection
- error envelope and tenant propagation

Apps configure modules with schema, renderers, policies, and route context.
Modules may call app-provided clients or receive already-loaded data, but they
must not create a second business-state authority.

A write-capable module contract is not considered real until a consumer wires
it end-to-end against the substrate. Read-only visual foundations may land
earlier when they are substrate-shaped and have bounded visual/test proof.

Modules may import components, compositions, and engines. They must not import
app code or design-system stories. If a module needs demo data, keep that data in
the module's own tests/examples or in the consuming app.

## Current Modules

- `editable-grid` (`useEditableRowVersionGrid` hook + `EditableRowVersionGrid`
  surface component) hosts AG Grid Enterprise against the substrate. The hook
  owns the edit buffer, FieldValue ↔ primitive bridge, validation gate, and
  idempotent `ApplyChangeSet` dispatch; the component renders the AG Grid
  surface with no built-in chrome (apps own all toolbars / save docks /
  sheets). Three-tier `read | tweak | edit` mode contract.
- `org-chart` (`OrgChartCanvas`, `NodeCard`, `OrgChart`, and `RelationGraph`)
  provides the read-only canvas/card foundation. The canvas lays out a
  hierarchy top-to-bottom by default, or left-to-right / right-to-left.
  `RelationGraph` is a presentational one-hop neighbourhood: a non-interactive
  centre, a mirrored LEFT side, a RIGHT side, and an optional BELOW row. Sides
  wrap at four cards per column into as many brick-offset columns as needed,
  so no connector passes behind a card. A group (including its overflow card)
  is never split across columns; a group larger than four that the host did
  not cap occupies one taller column, and connectors carry no labels. The host
  decides which groups go where and supplies every card's text; it also owns
  overflow, building "first N + more" with `capRelationGroup` from a total it
  knows. A group may set `frame: { caption, onSelect? }` to draw its cards
  inside one bordered box with the host's caption in the box's top edge
  (for example a mapping table's look-through relations under that table's
  label). Each framed card keeps its own connector and activation; with
  `onSelect` the caption is a button named "Open <caption>" that precedes
  its cards in tab order. On the left and right, a side's framed groups
  always go in its outermost column, after its plain groups (stacked if
  there are several), so no other connector crosses a frame; in the below
  row a framed group keeps its place and connectors drop into it clear of
  the caption. Apps own data convergence, schema-specific adapters, naming, and
  write/edit surfaces. Module tests run through a consuming app's test config
  (HC for `org-chart`), and CI routes a change under `packages/modules/<name>`
  to every workspace package that imports `@modules/<name>`.

The `schema-browser`, `record-editor`, `draft-inbox`, and `activity-feed`
modules existed earlier in the spike to feed the now-deleted `apps/dev`
frontend exemplar; they were removed alongside that frontend because no other
consumer wired them. Re-introduce only when a second app proves the contract.
