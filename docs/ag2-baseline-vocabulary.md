# AG2 Baseline Vocabulary Port

This branch makes AG2's baseline model catalog source evidence for Autograph
model vocabulary.

## Library Source

`packages/domain-libs/` is a TypeScript domain-model snapshot copied from
AG2's baseline model catalog in
`/Users/graphy/ag2-1/agworld/src/baseline/models` at
`b25565da6ecfff992e4d24a6d984ed05cf7e35e2`. It preserves semantic names,
field grouping, lookup fields, seed rows, and primary/lookup model structure
inside domain libraries. It intentionally drops platform/runtime
models and source-app runtime
metadata such as page tabs, sidebars, view modes, and route/rendering hints.

Autograph normalizes model ids, field ids, and reference metadata keys to
snake_case in the copied package. Instantiated app schemas should use those ids
directly; do not add a camelCase-to-snake_case translation layer.

The domain library is not runtime persistence authority and shared runtime
packages must not import it. App manifests select its vocabulary, the Rust
compiler lowers it, and the active kernel path remains the source of persisted
correctness for instantiated apps. Generated PostgreSQL becomes that path one
parity-proven operation at a time. HC uses the template as source evidence for
model vocabulary, but its local seed catalogs remain app-specific where the
current demo data needs narrower values.

## HC Instantiated Subset

The HC app now instantiates the headcount subset using this vocabulary:

- `employee`
- `position`
- `org_assignment`
- `department`
- `employee_status`
- `position_status`
- `location`
- `level`
- `business_unit`
- `job_family`
- `pnl_category`

Lookup models use AG2's standard lookup shape:

- `slug`
- `name`
- `known_aliases`

## Intentional Departures

| AG2 vocabulary | Autograph HC instantiated model |
| --- | --- |
| `employee.linkedPosition` / `position.linkedEmployee` direct inverse links | Not persisted. `org_assignment` is the canonical occupancy and org-placement record. |
| Position and employee reporting assumptions | `org_assignment` carries `reports_to_employee` and `reports_to_position`. Employee-manager edges are preferred; position-manager edges remain representable for empty-org planning. |
| AG2 user-facing `id` fields | HC instantiates them as `ref` because `id` is a reserved row-version system column in the kernel contract; `ref` participates in the entity's domain-owned ordered identity. |
| Derived comp/cost fields such as `total_cash`, `total_comp`, `annualized_cost`, and variances | Present in the copied schema template for source evidence, but not instantiated in HC until derivation ownership lands. |
| AG2 UI/runtime behavior | Not ported. Only baseline vocabulary and metadata are used as source evidence. |
| AG2 change-type ids | HC uses snake_case change-type ids aligned to current kernel/generated TypeScript conventions. Semantic parity is the goal; exact AG2 hyphenated ids are not ported in this PR. |
| AG2 seed catalogs | HC keeps app-local lookup rows for the demo company. For example, `business_unit`, `job_family`, and `level` values are narrower than the copied baseline library. |

`org_assignment` shape:

- `employee`: optional relation to `employee`
- `position`: optional relation to `position`
- `reports_to_employee`: optional relation to `employee`
- `reports_to_position`: optional relation to `position`
- `start_date`: required date
- `end_date`: optional date

Product constraints for `org_assignment`:

- at least one of `employee` / `position`
- at most one of `reports_to_employee` / `reports_to_position`
- manager target may be null for top/root org assignments

Those constraints are documented here for the baseline cutover. Enforcement
must move into HC-owned Rust apply validation or a generic kernel
schema-constraint contract before any org-assignment editing surface lands. The
current seed/build path has regression tests for the same shape so the baseline
rows cannot drift while full write-time constraint support is absent.

Filled positions in the seed data write both `position` and `employee` on their
`org_assignment` row. Open positions write `position` only, preserving the
planning-only assignment shape.
