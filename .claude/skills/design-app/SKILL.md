---
name: design-app
description: Interview a builder about a workflow they want, then build a clickable prototype as pages on sample data inside app/, run it locally and iterate until they say "build this". Use when someone describes a new workflow, a new section, or an idea that is not yet clear enough to become schema. Writing real tables is the add-section skill; going live is the deploy skill.
---

# Design App

> Not yet confirmed: the shared component library (`packages/design-systems/core`)
> is not a dependency of `app/` yet. Until it is, pages use semantic HTML and
> the classes in `app/app/styles.css`, as the Overview page does.

The builder is semi-technical: good product instincts, no assumed knowledge of
databases, migrations or React. People often discover what they actually need
only by trying a version of it. So the order is always:

1. a short interview in plain language;
2. a prototype: real pages on sample data, no schema, running locally;
3. iterate on what they see;
4. only after they say **"build this"** (or an equivalent clear yes), hand off
   to the `add-section` skill to write the schema and point the pages at real
   data.

Before the first edit, start a branch with the `ship-change` skill. Finishing the
work is not approval to merge it or put it live.

## How the app is laid out

There is one Next.js app in `app/`. Run commands from `app/`.

- `app/schema/app.cue`: the tables (models). Each table automatically gets a
  navigation link and a Canvas page at `/tables/<model>`; nothing to add.
- `app/app/(sections)/`: signed-in pages. `layout.tsx` holds the navigation;
  a custom section is a folder here (the example is `overview/page.tsx`) plus a
  `<Link>` added by hand in `layout.tsx`.
- `app/features/<section>/`: the section's code that is not a page, such as
  server actions (the example is `features/notes/actions.ts`).
- `app/app/styles.css`: the app's styles (`.page`, `.primary`, `.note-form`,
  ...).

Every workflow is a **section** of this one app. Never create a second app.
Reuse tables that already exist in `app/schema/app.cue` (shared People,
Vendors, ...) rather than inventing parallel ones in the prototype.

## 1. Interview

Read `references/questions.md` before asking anything.

- If the job to be done is missing, ask one question: "What is the person
  trying to accomplish with this?" Otherwise do not ask; infer.
- Only ask a question now if the answer changes **data** (what things are
  tracked and how they relate), **permissions** (who may see or change what),
  **workflow** (what happens in what order, who acts), or **irreversible
  behavior** (anything that sends, pays, deletes or notifies). Everything else
  becomes a stated default you show in the prototype.
- One question at a time; at most three together if they concern the same
  visible decision. Say what you will assume if they have no preference.
- Never ask about tables, columns, types, migrations, components, routes or
  deployment. Translate those yourself.
- Read `app/schema/app.cue` and the navigation first, so you can say "this will
  use your existing People table" instead of asking.

Then say back, in three to six lines: who uses it, what they do first, what
things it keeps track of, and the defaults you chose. Start building
immediately; do not wait for approval of the summary.

## 2. Build the prototype

Show the smallest useful workflow early. Do not block the first screen on a
full data model, integrations, permissions or delivery choices.

Where it lives (a convention of this skill, mirroring the Note example):

- Pages in `app/app/(sections)/<section>/`, with a link added to the
  navigation in `app/app/(sections)/layout.tsx`, so the builder sees it in
  context. Do not use the `/tables` path; that belongs to Canvas.
- Sample data in `app/features/<section>/sample-data.ts`: realistic,
  internally consistent, typed with plain TypeScript types written next to it.
  These types are a sketch, not the schema.
- State in memory: a small client component or context in the section's
  `layout.tsx`, so edits survive moving between the section's pages during one
  session.

Hard limits while prototyping:

- No CUE, no change to `app/schema/`, no migrations, no database reads or
  writes, no server actions, API routes, auth changes, integrations, network
  calls or environment variables. Data comes from the sample-data file.
- No new styling system and no new visual design. Use semantic HTML (`<form>`,
  `<label>`, `<button>`, `<table>`, headings, lists) with the classes already
  in `app/app/styles.css`. Add a class there only when nothing fits, reusing
  its existing colors, spacing and radii. Do not import a component library
  that `app/package.json` does not already list.
- Desktop first: plan for resizable windows and panels, not phone layouts.

Read `references/information-composition.md` while composing any page and
`references/interactions.md` while wiring controls. In short:

- Compose around the person's task: identity, deciding evidence and the next
  action sit together; counts and sorting sit with their collection.
- Pick a structure by behavior: a list with a detail view for reviewing, a
  form for entry, an overview then detail for summarizing. A plain read-only
  table is not a review queue.
- Where a page is just "see and edit the rows of a table", say that Canvas will
  provide it once the table is real, and do not build it.
- Every enabled control does something visible on the sample data. If the
  prototype cannot support an action, disable it with a product-facing reason.
  No no-op buttons, dead links or fake "saved" messages.
- When an action changes data, every dependent count, total, badge and list
  updates in the same interaction.
- Consequential actions (send, pay, approve, notify) are clearly simulated; do
  not imply anything left the prototype.
- Include the empty, first-use and error states that make the workflow clear.

## 3. Run it and iterate

- Run `bun run dev` from `app/` and open the section in the browser pane if
  one is available. A fresh local app needs a local database, migration, and
  first-owner setup before anyone can sign in: run `bun run setup:env`,
  `bun run migrate`, `bun run owner:setup`, start `bun run dev`, then run
  `bun run owner:open` so the builder creates their own local owner account in
  the browser (see `app/README.md`). If that is not set up yet, guide them
  through it or say so.
- Click through every enabled control yourself before showing it: navigation,
  Back/Forward, forms (validate, submit, cancel), dialogs, filters. A
  successful compile is not proof that it works. Run `bun run check` for type
  errors. If you could not exercise something, say so.
- Show the builder the address, a walkthrough ("open Deals, pick one, log a
  call"), and the two or three assumptions most worth challenging.
- Anchor follow-up questions to what they can see: "Deals are grouped by
  stage here. Should each rep only see their own?" At most three per round.
- Keep a short running brief (see `references/build-brief.md`) in
  `app/features/<section>/BRIEF.md`: decisions they made, defaults you chose,
  open questions, and what each visible element will mean for real. Update it
  silently with each revision; do not ask them to approve it.
- Do not run design scoring or automatic polish loops unless asked.

## 4. Hand off on "build this"

"Build this" means: turn the prototype into real tables and real data.
Before handing off:

- Settle any remaining question that changes data, permissions, workflow or
  irreversible behavior (the build-blocking list in `references/questions.md`).
  Everything else may stay a default.
- Make sure `BRIEF.md` lists the things tracked, how they relate, which
  existing tables they map to, required versus optional fields, choice lists
  (e.g. deal stages), who can see and change what, and which visible features
  are deferred.
- Then follow the `add-section` skill. Keep the prototype's pages,
  structure and interactions; replace sample data with real data rather than
  redesigning from the brief. Delete `sample-data.ts` once nothing imports it.

If the builder only wanted to explore, stop at the prototype and keep the brief
as the record. Nothing has touched their database.

## Talking to the builder

Use product words: "sections", "pages", "things it keeps track of", "who can
see it". Keep code paths and tooling out of the conversation unless they ask.
Report what they can now do, where to click, and the next meaningful choice.
