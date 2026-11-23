# Rules Engine

The rules engine is a small, generic event router. It centralizes "when this
event happens, run these deterministic handlers" logic without encoding any
application lifecycle or status vocabulary.

Rules are ordinary TypeScript objects:

- `eventTypes` selects events by string type.
- `when` is an optional predicate.
- `run` performs the handler and may emit follow-up events.

The engine is deliberately persistence-free and UI-free. Apps or modules own
where rules are declared, how events are stored, and which side effects are
allowed.
