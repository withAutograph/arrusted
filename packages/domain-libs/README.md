# Domain Libs

Domain libs are app-domain accelerants: declarative schema vocabulary, lookup
seeds, and declarative identity/reconciliation shape metadata that can be
borrowed by more than one app.
They are not generic substrate and they are not runtime persistence authority.
An app-owned manifest selects and augments their vocabulary; the Rust compiler
normalizes it and generated PostgreSQL remains persisted correctness authority.

`mise run schema:compile` deterministically refreshes the catalog and app schema artifacts. The catalog exporter flattens all
37 blocks into the checked `packages/domain-libs/catalog.json`, including source-package
provenance, normalized relation types, enum option order, seed order, labels,
and notes. App CUE packages consume that data; they do not import TypeScript at
compile time. `--check` is part of the repository contract gate.

Membership test: keep a file here only when at least two real apps could borrow
the vocabulary or declarative identity/reconciliation shape metadata without
importing an app shell. Single-app workflow behavior, route metadata, view
state, prompts, and runtime action-loop state stay in `apps/`.

Dependency rules:

- `packages/` never imports across domain-library package boundaries except through declared package exports.
- Domain libs may import pure `@engines/*` helpers and type contracts; they may
  not import modules, app shells, UI, kernel clients, or agent foundation code.
- Entity domains import only `_shared` inside `packages/domain-libs/`.
- `_shared` does not import entity domains.
- App-owned schema catalogs may import multiple domain libs to select and order
  blocks; fan-in composition does not live in `packages/domain-libs/`.
- Cross-domain references are data (`target_model` strings), not TypeScript
  imports.

Tenant invariant: domain libs are append-only source vocabulary. Tenant-specific
runtime normalization, aliases, memoization, lookup creation choices, and
matching decisions live in app-owned code or persisted tenant data, not here.

Compiler invariant: every authored catalog property must have an explicit
lowering or a structured rejection. App generators and the SQL compiler may not
silently discard properties such as `is_multi_value`, `formula`, validation
rules, `seed_rows`, enum options, relation targets, labels, or notes.

- `seed_rows` compile to idempotent audited change-set manifests, not raw SQL
  inserts.
- Enum option sets compile to revision-scoped metadata and `text` values, not
  PostgreSQL enum types.
- `is_multi_value` is an inverse read relation only when it names the scalar
  child edge through which the collection is derived; it never becomes a
  stored array. True many-to-many state uses an explicit model.
- Authoritative domain constraints compile into PostgreSQL. Advisory validation
  remains generated client metadata. The declaration must name which it is.
- Derived values require a typed expression and declared read/materialization
  mode. Notes that describe a value as derived do not create formula semantics.

Formerly provisional lookup buckets have been regrouped by owner:
`lookup-equity` lives with `compensation`, `lookup-performance` and
`lookup-capacity` live with `employee`, vendor pricing lives with `vendor`, and
`_shared/lookup-other` retains the shared `business_unit` / `geography`
lookups.
