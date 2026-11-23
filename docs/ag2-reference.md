# AG2 Reference

AG2 is product evidence. It is not the implementation base.

## Lessons To Keep

- Operational apps need effective dating, approvals, imports, relation lookup, provenance, and activity/history. This is a product lesson, not a requirement that every restart slice include every surface.
- Review flows must be explicit and auditable.
- Agents need deterministic write receipts.
- Product workflows should be fast to stand up with opinionated default surfaces.
- App-owned semantics should stay close to the app, not hidden in platform code.

## Concepts Not To Port

These terms come from AG2 or earlier Autograph work. They are listed here so they do not leak into core contracts.

- Per-cell value storage: a field-value substrate parallel to typed model tables.
- Field-level draft overlay reads: query-time merge of mainline rows plus sparse draft fields.
- `change_event` as canonical causal storage: event rows parallel to version rows and change_set metadata.
- Runtime translators from AG2 request shapes.
- Omnibus app shell.
- Per-field metadata flags layered on the value store (e.g. override markers, priority scores, inert flags) that produce conditional read semantics.
- Extensive machinery for analytics, projections from the EAV / AFV system to standard tables, etc.
- Wizard choreography as correctness authority.
- Duplicate lifecycle, schema, or import-state authorities.
- Mode system: reusable pages with route/state/manifest baggage. Apps own routes; reusable workflow surfaces are job-shaped modules instead. See `frontend-architecture.md`.
- Runtime app manifests (DB-defined apps with extensions/slots): code-built apps are typed code, not data. See `frontend-architecture.md`.
- First-class extension system: code-built apps use slots, render props, custom renderers, and app services as normal code. See `frontend-architecture.md`.
- Multiverse / budget plan context: parallel-world plan state as a runtime concept. Drafts and effective-time are the substrate's authority for "what-if" reads.
- Plan canvas authority: a separate read/write surface for plan-mode editing. Apps render editable surfaces directly against the row-version substrate.
- AG2 command/save adapters: the indirection layer between UI actions and AG2 storage. Apps call the kernel client directly.
- Label-inferred semantics: deriving change-type or stage meaning from UI strings. Use typed `change_type_id` and kernel stage values.
- Install / seeding scaffolding as runtime authority: app boot must not
  materialize schemas or seed through the kernel apply path. Deploy/setup
  materialization owns schema, app storage, and required seed rows before
  runtime traffic starts.

## How To Use AG2

Use AG2 to answer concrete questions:

- What user workflow was painful?
- What edge case did the old system encounter?
- What validation should be deterministic?
- What UI surface made review easier?

Do not copy code unless the copied unit is independent of storage shape and has a clear contract in these docs.
