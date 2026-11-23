---
name: add-section
description: Turn an approved prototype or a plain request ("track deals", "add a source field", "rename amount to value", "I want a pipeline board") into real tables and pages in the one app. Writes CUE in app/schema/app.cue, refuses unsafe changes with a safe alternative, compiles, rehearses the migration locally, shows which sections and pages a change touches, and checks the table in Canvas or builds a custom page. Use after the builder says "build this", or for any later schema or page change.
---

# Add Section

> Not yet confirmed: extending a `packages/domain-libs` starter table from
> `app.cue` (no ready-made path yet; see `references/cue-patterns.md`).

A **section** is one workflow in the team's one app. Tables are shared across
sections: there is one People table and one Vendors table, and any section may
reference them. Run every command below from `app/`.

The schema is CUE in `app/schema/app.cue` (`manifest: #AppManifest & {...}`,
checked against `packages/schema-compiler/cue/app-manifest.cue`). `bun run
compile` turns it into SQL and TypeScript operations under the git-ignored
`app/.generated/`; the separate `migrate` step applies it. **Never hand-write
SQL or migrations, never edit `app/.generated/`, and never commit it.** Safety
comes from the compiler and the migrator, not from the builder reading a plan.

## 0. Know what exists

- Read `app/schema/app.cue`, `app/app/(sections)/` and `app/features/`, so you
  reuse tables and pages instead of duplicating them.
- If this comes from `design-app`, read `app/features/<section>/BRIEF.md`.
- For a people-, company- or vendor-like table, look in
  `packages/domain-libs/catalog.json` for a matching starter and reuse its
  field ids, labels and types (see `references/cue-patterns.md`).

## 1. Decide the tables

For each thing the section keeps track of:

1. **Already a table in the app?** Reference it, and add fields only if this
   workflow needs them.
2. **A domain-libs starter fits?** Model it on the starter's fields (same ids,
   labels and types), keeping only what the workflow needs.
3. **Otherwise** a new table.

Prefer a link (`relation`) to a shared table over a free-text copy: a deal's
company is a link to the companies table, not a company-name string. Choice
lists (stages, statuses) are `enum` fields with `option_set` in display order.
Set `display_field_id` so Canvas and Claude show a readable name for each row.
Fields are optional unless the workflow cannot act without them.

## 2. Change rules (enforced by the compiler and migrator)

Apply these to new requests and later edits. Explain refusals in plain words
and offer the safe alternative in the same message.

| Request | Do |
| --- | --- |
| New table | Add it. Its fields may be required. |
| New field on an existing table | Add it **optional**. A new required field on an existing table is refused. If they need it required, add it optional, fill existing rows through the normal record write path, then make it required and rehearse. |
| Remove a field | Delete it from `app.cue`. The migrator retires it: hidden, data kept. Say so. |
| Rename a field | Keep its `id` and set a new public `name` (and `label`). Keep every earlier name in `aliases` after successive renames, including renaming back. The old names keep working for reads. Never change an existing `id`. |
| Change a field's type | **Refuse.** Types are immutable; archived fields cannot return. Offer: a new field (new `id`) with the new type, copy values across, switch pages to it, then remove the old one. |
| Change a relation's target, or an enum option's meaning | Treat as a type change: new field, copy, remove. Adding enum options is fine. |
| Rename a table or choice option | Keep the stable `id`, change `name`, and retain earlier names in `aliases`. |
| Bring back a field/table | Refuse: archived IDs and names cannot be reused. Create a new field/table with a different ID and name. |
| Make a field required/unique | Rehearse. Existing current rows must pass; the migrator lists failing record ids. Fill or correct those rows through ordinary writes, then retry. |
| Remove a table | Remove it from the schema; it is archived with data kept. Rehearse and explain affected sections. |
| Delete archived data permanently | Refuse; permanent deletion is not supported. |

Prefer adding over renaming, and renaming over removing. If a rename or
removal is "just to tidy up", show what it touches (step 4) and suggest
leaving it.

**Copying values** for a type change is a records change, not a migration:
after the new field is live, prepare a CSV keyed by the records’ external keys
and run `bun run records:import <table> <file.csv> --key <column>` with
`MIGRATION_DATABASE_URL` set to the deployment owner connection in the builder terminal.
Headers name fields; the key column also writes its value when it names a field.
The key addresses existing rows, omitted/empty
fields stay unchanged, and up to 100 rows / 512 KiB are accepted. The command
acts as the deployment’s first member (the builder’s initial signup) and writes
through the kernel. Use stable keys on the initial contact/company imports so
later copy/fill imports update those records. Without `--key`, each run creates
new records. MCP proposals remain unpersisted. Alternatively, copy through generated operations
(`createOperations`) or Claude's `stage_changes`/`create_rule` tools for existing
rows; a member reviews and saves staged edits. Preview converted values and list
rows that cannot convert. The generic create/import controls use the same kernel
write path. Never write SQL to copy or fill records.

## 3. Write the CUE, then compile and check

- Edit `app/schema/app.cue` following `references/cue-patterns.md`.
- Run `bun run compile`. It rejects invalid schemas. Fix errors yourself; do
  not change the compiler or its CUE definitions to make an error go away.
- Run `bun run check` for type errors in pages that use the generated
  operations (a rename or removal shows up here).
- The generated operations for each table are described in
  `app/.generated/release/data-operations.md`.

## 4. Show what the change touches

Because tables are shared, a change can affect other sections. There is no
usage report from the compiler yet, so search `app/app/` and `app/features/`
for the table and field names (and `createOperations(...).<table>`), and tell
the builder which **sections and pages** use them, not file paths. Every table
also appears in Canvas and to Claude over MCP; mention that for renames and
removals. For a pure addition one line is enough ("New field; nothing else
uses Deals yet").

## 5. Apply locally, then rehearse

- Apply to the local database:
  `bun --env-file=.env.local --env-file=.env.migrate run migrate`.
  It takes a restore point, applies under a lock, and records the applied
  schema. Owner credentials live only in `.env.migrate`, never in
  `.env.local`.
- Rehearse against an isolated database, never the real database. Set
  `MIGRATION_DATABASE_URL` to its owner connection,
  `APP_DATABASE_URL` to its restricted runtime login, and
  `PRODUCTION_APP_DATABASE_URL` to production’s runtime URL for the isolation check. Then run
  `bun run migrate:rehearse`. It applies the migration and runs every table's
  list query as the runtime login. This rehearsal is optional for the spike.
- If either fails, read the message, fix the schema, and try again. If the fix
  would be an unsafe change, go back to step 2. Never work around a refusal.
- Explain the result in plain words ("adds a Source field to Deals; existing
  deals keep their data").

Production is migrated only through the `deploy` skill.

## 6. Use it in the app

**Canvas is the default.** Each table automatically gets a navigation link and
a page at `/tables/<model>` that opens a Canvas session: grids, editing
existing rows, draft review and history, for people and for Claude over MCP.
Run `bun run dev`, open the table, and check rows show the right name and
fields.

Every table and Canvas session has Create and CSV import controls. Map columns,
preview, then apply directly or save native drafts for review. Map an external
key column to update existing rows without duplicating them; repeated keys in
one file are refused so the member can resolve the ambiguity.

**Add a page** when Canvas is not enough (a pipeline board, a dashboard, a
guided form, adding records). See `references/add-page.md`. If a prototype
exists, keep its pages and structure and replace the sample data with the
generated operations.

Then click through the section's pages on real local data, confirm the
sections listed in step 4 still load, and delete sample data nothing imports.

## 7. Hand off to deploy

Summarize for the builder in a few lines: what the section now does, what
changed in shared tables, anything renamed or retired, and anything refused
with the alternative taken. Then follow the `deploy` skill. Do not commit,
push or merge without the builder's go-ahead.

## The comparison brief's requests

- "Add an optional source field to Deal": add, compile, migrate, rehearse.
- "Rename amount to value": keep `id: "amount"`, set `name: "value"`; list pages.
- "Change value from a number to text": refuse; offer a new text field + copy.
- "Remove source": delete the field; it is retired with its data kept.
- "A pipeline board grouped by stage": custom page (`references/add-page.md`).
