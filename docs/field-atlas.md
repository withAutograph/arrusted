# Field Atlas

The reference for how the kernel models **records, identity, fields, and values**. The
**[current]** rows are the source of truth for today's code. **[planned]** and **[future]**
mark specific capabilities that have not landed; they do not refer to a pending umbrella PR.

Status tags: **[current]** = true in code today · **[current legacy]** = true in code today and
retained for existing consumers, but not the selected path for new work · **[current gap]** = code
exists today but violates or falls short of the selected contract · **[planned]** = decided target
not yet built · **[future]** = explicitly deferred capability. The completed schema-simplification
work is reflected in current code; this atlas and current contracts own present-tense field semantics.

---

## 1. Storage model (effective-dated row versions) [current]

Every model is stored as **two tables**, app- and customer-scoped:

- **`{model}_record`** — record identity. Columns: `id` (uuid, PK), `app_id`, `customer_id`, `external_key` (nullable). One row per record, ever.
- **`{model}_version`** — effective-dated full snapshots. Columns include `record_id` → record, `change_set_id`, `stage` (`draft` | `mainline` | `discarded` | `reverted`), `effective_start` / `effective_end` (inclusive business-effective boundaries), `created_at` / `applied_at` (lifecycle audit timestamps, not a transaction-validity interval), `tombstones_record` / `untombstones_record`, `custom_fields` (jsonb), `provenance`, plus one column per declared field. A write overlays the prior snapshot (omitted fields inherit).

Records are addressed by **`RecordKey`** = `RecordId(uuid)` **or** `ExternalKey(string)`.

All models use effective-dated row versions. The kernel does not expose
transaction-validity intervals or an "as recorded at" system-time query, so
this is not full bitemporal storage. The **draft → review → approve lifecycle**
is applied to _some_ models by app policy; it is not a kernel/schema property.

---

## 2. Identity & resolution

Four active concepts, different layers, different jobs. Historically conflated — do not.

| Concept                       | Layer                                    | Mutable?                  | Cardinality                 | Job                                                                                                                                                                                                              | Status    |
| ----------------------------- | ---------------------------------------- | ------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **`uuid`** (`id`/`record_id`) | kernel substrate                         | no (immutable)            | 1                           | The surrogate PK and the _only_ universal identity. The kernel can allocate it for an anonymous create, or a caller can select the permanent UUID through `new_record_id`. Relations store and may use it before the envelope is applied. | [current] |
| **`external_key`**            | kernel substrate                         | effectively set-at-create | 0..1                        | A persisted string address retained for existing consumers, including legacy within-batch create-and-reference flows. NOT business identity, NOT cross-run matching, NOT an integration id, and not the selected path for new import work. | [current legacy] |
| **`ref`**                     | app-declared field                       | **yes**                   | 0..1                        | A user-visible business identifier on models that genuinely have one. HC requires unique `Employee Ref` and `Position Ref`; this is the selected home for genuine CSV stable ids. | [current] |
| **`known_aliases`**           | field (`text_list`, type `KnownAliases`) | yes                       | 0..N                        | User-confirmed alternate strings. HC CSV accepts unique exact normalized aliases for lookup and declared entity identity; ambiguity blocks, while fuzzy matches remain advisory suggestions requiring explicit confirmation. | [current] |

### Why `external_key` ≠ `ref`

- `external_key` is legacy **authoring plumbing**: known at author-time, stored
  on the record, and resolved by existing kernel consumers. It remains
  load-bearing for those consumers, but new import work should preselect the
  permanent UUID with `new_record_id` and use ordinary `record_id` relations.
- `ref` is **visible app data**. HC's Employee Ref and Position Ref are required
  and unique. They are the correct home for stable identifiers supplied by a
  CSV, while the immutable kernel identity remains the record UUID.
- A generic kernel `integration_keys` facility is not selected for V0. Hosted
  integrations keep provider/source identity in their app-owned schema and
  delivery context; they do not overload model `external_key`.

### Resolution vs matching — two different operations

- **Addressing** (write-time): "this write/relation targets _this_ record."
  Deterministic → **`uuid`**. Existing subjects use `record_key: record_id`;
  explicit creates use `new_record_id`, and same-envelope relations use that
  UUID as an ordinary `record_id`. The kernel still resolves persisted
  `external_key` values for legacy consumers, but product/import policy must
  not treat that capability as business identity.
- **Matching** (import): "does this incoming row correspond to an existing record?" A domain-owned ordered policy over **current** values, imported unchanged by the consuming app:

  **`ref > another domain-declared identity field (for Employee, case-insensitive work email) > exact name > confirmed alias`** → resolves to a record UUID. [current for HC CSV]

  A trusted UUID is already an address, so it bypasses matching rather than
  forming a ladder rung. Declared identity fields resolve deterministically. A
  supplied stronger identity that misses does not fall through to a weaker
  rung. Exact name and confirmed aliases never silently pick among ambiguous
  records. A user confirmation binds the spelling to the selected UUID and
  stages it in `known_aliases` without replacing the canonical name, or it
  fails closed as contradictory when that confirmation disagrees with a
  stronger authored identity — including a strong miss. Confirmation never
  creates a new record. Fuzzy similarity is advisory only.

  HC CSV does not derive refs or import `external_key` values. Its re-import
  tests load existing records by the domain ladder, assert matched writes use
  UUIDs, and prove that persisted `external_key` cannot affect matching.

### `slug` [current: removed]

A declared `slug` on lookups conflated three jobs and has been removed. Legacy consumers may still address a lookup create through `external_key`, but the selected import path preselects its permanent UUID and uses `record_id` relations. Neither mechanism makes `external_key` lookup identity. Current lookup resolution uses `ref` when present, then unique/exact normalized `name`, then a unique exact normalized `known_aliases` value; ambiguity blocks. Entity identity follows the same domain-declared alias rung after stronger identities. Fuzzy suggestions never match automatically and become durable aliases only after an exact user confirmation. Display uses `name`. A visible code field (`ref`) is added only where one is genuinely needed.

---

## 3. Field types (kernel `FieldType` vocabulary) [current]

| Type           | Value shape                                 | Notes                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Text`         | string                                      |                                                                                                                                                                                                                                                                                          |
| `Number`       | decimal                                     |                                                                                                                                                                                                                                                                                          |
| `Bool`         | boolean                                     |                                                                                                                                                                                                                                                                                          |
| `Date`         | date (no time)                              |                                                                                                                                                                                                                                                                                          |
| `Datetime`     | timestamp with time zone (UTC)              | no cell editor today                                                                                                                                                                                                                                                                     |
| `Relation`     | `RecordKey` → `target_model`                | resolved to a uuid at write time                                                                                                                                                                                                                                                         |
| `TextList`     | string[]                                    |                                                                                                                                                                                                                                                                                          |
| `KnownAliases` | string[]                                    | a `text_list` _tagged_ "import-aliases field" so import-classification finds it by type, not by name. Kept.                                                                                                                                                                              |
| `Json`         | arbitrary json                              |                                                                                                                                                                                                                                                                                          |
| `IsoCountry`   | ISO 3166-1 alpha-2 string                   | text-backed declared field type; apply validates against a pinned in-repo ISO 3166-1 alpha-2 list.                                                                                                                                                                                       |
| `IsoCurrency`  | ISO 4217 alpha-3 string                     | text-backed declared field type; apply validates against the same pinned ISO 4217 tender-currency list used by `MoneyRate.currency`.                                                                                                                                                     |
| `MoneyRate`    | `{amount, currency, period}`                | structured value type; currency validates against the ISO 4217 tender-currency list.                                                                                                                                                                                                     |
| **`Enum`**     | **`EnumOptionId`** (the selected option id) | **[current]** first-class declared-field value type; option definition `{id, label, aliases}` lives on the field's `option_set`. No option archiving — a stored value whose option-id is no longer in the set renders `null` (see known-footguns). Replaces lookup models used only for inline statuses; custom-field enums remain supported separately. |

Custom fields (`CustomFieldType`, stored in the `custom_fields` jsonb array) mirror this set: text/number/bool/date/datetime/relation/text_list/**enum**/money_rate (no json). See `docs/contracts.md` + `project_custom_fields_invariants`.

---

## 4. The three kinds of schema "thing"

| Kind               | What it is                                                                                                            | Example                                                              | Identified by                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| **Model**          | A real entity with fields, identity, relations, history. _A "lookup model" is just a model_ [current]                 | employee, position, department, level, org_assignment                | uuid (+ optional external_key/ref)          |
| **Enum**           | A controlled value list **local to one field** — single-model, single-field, no own attributes, not shared. [current] | employee_status, position_status, EEO categories, custom value lists | option `id` within the field's `option_set` |
| **Reference data** | A universal external standard, not tenant-editable. [current for country/currency]                                    | country → ISO 3166, currency → ISO 4217                              | the standard code                           |

### Model vs Enum — an authored domain decision [current]

Domain libraries explicitly author whether a concept is a model or a field-local
enum. App composition preserves that choice. The kernel validates the resulting
schema shape; it does not infer, convert, or second-guess the domain decision
from reference counts.

Choose a model when the concept needs independent record identity, history,
relations, customer-managed lifecycle, or its own declared attributes. Choose an
enum when the values are truly options local to a field. These are design cues,
not a mechanical classification formula: no generic model-vs-enum classifier or
catalog drift validator is planned.

- `level` / `job_family` / `pnl_category` are authored as models because the
  domain treats them as independently identified, customer-managed vocabulary;
  that choice does not change when an app adds or removes a relation.
- `employee_status` / `position_status` are authored as field-local enums. The
  deliberate `position_status` conversion **dropped** seed-row `notes` after
  establishing that they were not durable domain attributes.

> **Seed metadata is conversion handling, not model-ness.** `sort_order` / `notes` on seed rows are **seed-row data, not declared fields/attributes**. If a domain author deliberately converts a modeled vocabulary to an enum, that metadata must be consciously **absorbed** (`sort_order` → `option_set` ordering) or **dropped** (`notes`); it does not make the decision automatically.

---

## 5. Field & definition attributes

| Attribute       | On                               | Meaning                                                                                                                                   | Status                                                     |
| --------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `id` (FieldId)  | field                            | the field's permanent slug/identity within its model                                                                                      | [current]                                                  |
| `label`         | field / enum option / definition | display string (mutable). Distinct from the _data_ field `name`.                                                                          | [current]                                                  |
| `required`      | field (`Field.required`)         | kernel materializes a DB **check constraint**; import uses it for required-field validation + generated-id fill. **Load-bearing — kept.** | [current]                                                  |
| `is_unique`     | field                            | unique constraint (e.g. `ref`, lookup `name`)                                                                                             | [current]                                                  |
| `target_model`  | relation field                   | the model a `Relation` points at                                                                                                          | [current]                                                  |
| `aliases`       | enum option `{id,label,aliases}` | per-option match strings                                                                                                                  | [current]                                                  |
| `option_set`    | enum field / custom enum def     | the list of `{id,label,aliases}` options                                                                                                  | [current]                                                  |
| `custom_fields` | version row                      | jsonb array of tenant custom-field entries `[{field_id,type,value}]`                                                                      | [current]                                                  |

`essential` / `templated` field blocks [current: flattened to one `fields` block] — were a field-selection mechanism for the catalog superset; retired with direct app composition. Canonical visual grouping is now a separate domain-library partition, not kernel schema structure and not a field-selection mechanism.

---

## 6. App / schema policy (not field shape)

| Concept             | What                                                                                                                                                       | Where                                                                                 | Status    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| `change_types`      | named mutation categories (`required`/`touches` fields) — `change_type.required` is _metadata_, not apply-time enforcement                                 | recipe → kernel                                                                       | [current] |
| `seed_rows`         | starter rows (models) / starter options (enums) — packages/domain-libs artifact metadata, applied by bootstrap via normal writes; **not** kernel `Schema` authority | packages/domain-libs                                                                           | [current] |
| field groups        | canonical ordered MCE partition compiled into generated app-artifact model metadata; selected catalog groups retain authored order and selected fields, while absent groups let the generic UI resolver supply runtime/custom fallback groups; never persisted kernel or DDL semantics | domain-library model metadata; CUE/Rust compiler extras; generic UI resolver; out of kernel `Schema` | [current for Employee, Position, Org Assignment] |
| save policy         | which models use draft lifecycle                                                                                                                           | app (`saveMode`, global today; likely per-app if it ever flexes — do not over-decide) | [current] |

---

## 7. Reserved system columns [current]

A declared `field_id` may not collide with these (`validation.rs is_system_column`):

`id`, `record_id`, `app_id`, `customer_id`, `stage`, `effective_start`, `effective_end`, `change_set_id`, `created_at`, `applied_at`, `tombstones_record`, `untombstones_record`, `custom_fields`, `provenance`, `external_key`.

---

## See also

- `docs/contracts.md` — wire DTO contract.
- `docs/known-footguns.md` — write-contract gotchas (no null/clear; etc.).
- `docs/agent-foundation.md` §8 — agent-driven enum extension on unknown import values.
