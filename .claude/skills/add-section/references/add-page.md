# Add a page

Use when the builder says "I want a page that stores this, shows that, and lets
me do X" and Canvas alone is not enough: a board, a dashboard, a guided form,
adding new records (Canvas cannot create records or import CSV yet), or a view
across tables.

> Not yet confirmed: the shared component library (`packages/design-systems/core`)
> is not wired into `app/`. Pages use semantic HTML with `app/app/styles.css`.

## Follow the Note example

- **Page:** `app/app/(sections)/overview/page.tsx`. A server component under
  `app/app/(sections)/`, so the data layer must authenticate and authorize every read and mutation; the layout only provides navigation gating. Add a
  `<Link>` for it in `app/app/(sections)/layout.tsx`.
- **Writes:** `app/features/notes/actions.ts`. A `"use server"` action that
  calls `withActionData` from `app/app/data/canvas.ts`, then
  `createOperations(context).<table>` from
  `app/.generated/release/data-operations`. It uses `parseForm(form, { fields,
  mode: "create" })` to read an allowlist of fields, `create(values, {
  effectiveStart, idempotencyKey })` with a request id from a hidden input so
  retries do not duplicate, `toFormError` for field-level errors, then
  `revalidatePath` and `redirect` back with a status.
- **Reads:** use the same generated operations (`list`, `get`, `count`,
  `countBy`, `aggregate`; see `app/.generated/release/data-operations.md`).
  `app/app/data/canvas.ts` exports only a write helper today; if a page needs
  reads, add a read-only helper there next to `withActionData` that builds the
  same data context with `readOnly: true`.
- Put the section's server actions and helpers in `app/features/<section>/`.

## Rules

- Read and write only through the generated operations. Never query or write
  SQL from a page, and never use the migration login at runtime.
- Access is enforced in the data layer (every signed-in member may use every
  table today). A page may hide what a person cannot use, but must not be the
  only thing stopping them.
- For editing an existing record, link to its table in Canvas
  (`/tables/<model>`) rather than rebuilding a record editor.
- Design: read `../../design-app/references/information-composition.md` and
  `../../design-app/references/interactions.md`. Use semantic HTML (labeled
  inputs, real buttons, tables for tabular data) and the existing classes in
  `app/app/styles.css`; add a class only when nothing fits.
- Status and errors as the Note page does: `role="status"` for success,
  `role="alert"` for failure, in words the builder would use.

## Pipeline board example

Columns per `stage` option in order; each column shows its count and total
amount (with currency); cards show deal name, company and owner; moving a card
calls a server action that updates the stage, so both columns' counts and
totals change; an owner filter sits above the board; opening a card goes to
Deals in Canvas. Counts come from `countBy` on `stage`, not from counting in
the page.

## Check it

Run `bun run check` and `bun run dev`, click through every enabled control on
real local data, confirm the counts agree with Canvas, and check an empty
state (a stage with no deals) and a long company name. Say plainly if anything
could not be exercised.
