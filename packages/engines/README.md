# Engines

Engines are pure non-UI logic below modules. They do not fetch, render, or own
product semantics.

Engines produce non-authoritative previews, transforms, validation hints, and
agent/UI output. The Rust substrate remains the only path to persisted kernel
apply.

Examples:

- CSV parsing
- matching/ranking
- chart-spec compilation
- config-driven rule routing
- field-value validation and adaptation

Modules and apps may import engines directly. Engines must not import modules,
kernel-client, apps, or React components.

Engines also must not import design-system stories or fixtures. If test/example
data is useful for an engine, define the data in the engine's own tests or in a
generic engine fixture, not in Storybook-facing code.
