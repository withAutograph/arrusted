# Core Design System

This package is the reusable, source-level UI substrate.

It intentionally excludes runtime mode systems, runtime app manifests, extension
registries, external data hooks, and app-specific product assumptions.

## Folders

- `tokens/` — semantic CSS custom properties backed by neutral value tokens.
- `components/` — small reusable React components.
- `compositions/` — spec-driven assembled UI renderers.
- `stories/` — terminal Storybook examples and fixture-like specs that document
  component and composition states. The composition spec, not Storybook, is the
  saved-view and agent-rendering contract.

## Boundary Rules

Anything in this package must be domain-agnostic. It must not import kernel,
modules, app code, or mention app/model-specific product nouns.

Product names, marks, metadata, and other brand assets belong to consuming app
brand layers. The frontend boundary scanner rejects product identity anywhere
under this package, including binary asset pathnames.

`stories/` is terminal example code. Runtime packages must not import stories or
fixtures from stories. If example data becomes useful at runtime, move the
generic helper into an engine or composition and keep the story as a caller.

## Fixture Naming

Stories and examples are scanned for domain leakage, including string literals.
Use deliberately generic vocabulary:

- Records: `Acme`, `Beta Corp`, `Item Alpha`, `Item Beta`
- Fields: `name`, `label`, `value`, `created_at`, `status`
- Statuses: `enabled`, `pending`, `archived`
- Categories: `Group A`, `Group B`, `Segment 1`

Do not use domain nouns such as employee, company, hiring, compensation,
headcount, org design, app ids, customer ids, or dev seed tenant names in this
design system. Domain examples belong in an app story, not in the shared design
system.
