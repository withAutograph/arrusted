# Compiler-owned regression inputs

These inputs preserve compiler and generated PostgreSQL behavior after the example
applications were removed. They are fixed test data, not application manifests or
release selectors. Tests must not resolve an application checkout or its current
release to run.

- `catalog-selection/selection.cue` exercises catalog selection, ordering, seed
  projection, validation, local models, and inverse relations. Its original
  Vendor vocabulary is test data; changes should serve those compiler cases.
- `lookup-schemas/{hc,vendor}.json` are normalized schema/extras inputs for lookup
  metadata, deterministic SQL, lookup history migration, and organization
  assignment constraint tests. They contain no application implementation or
  deployment metadata. The historical names distinguish the two schema shapes.
- `historical-sql/*.sql` are exact predecessor compiler outputs. The v52 bundle
  exercises actor-membership fence protection after a legacy release replay.
  The v78, v82, v83, and v115 bundles exercise real work-session upgrades; v82
  also supplies the predecessor table definitions. Do not regenerate these
  historical inputs with the current compiler: their old SQL is the regression
  condition. Current SQL is compiled from test-owned manifests.

No application source, complete release directory, or current release selector
is retained. New cases should use a minimal test-owned manifest and compile it
with the compiler under test; retain an old SQL bundle only when its historical
shape is necessary to reproduce an upgrade or replay condition.
