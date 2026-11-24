# Domain catalog

`catalog.json` is a checked-in catalog of starter table definitions (employees,
vendors, customers, positions and so on), with fields, relations, enum options
and seed rows. `bun run compile` in `app/` passes it to the schema compiler, so an
app's CUE source can reuse a definition as `domain_catalog.models.<id>`.

It is plain data. Edit it directly; the Rust schema-compiler tests check that
every definition normalizes and compiles. Keep app-specific workflow, view state
and prompts in the app.
