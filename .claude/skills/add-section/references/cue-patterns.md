# CUE patterns for `app/schema/app.cue`

The shapes below follow `app/schema/app.cue` and `#AppManifest` /
`#ModelManifest` / `#FieldManifest` in
`packages/schema-compiler/cue/app-manifest.cue`. When in doubt, read that file;
compiler errors are the final word.

## The file

```cue
package schema

manifest: #AppManifest & {
	app_id: "starter"
	customer_id: "starter"
	version: "v1"
	label: "Starter"
	models: [
		{id: "note", kind: "entity", label: "Note", fields: [
			{id: "title", label: "Title", type: "text", required: true},
			{id: "body", label: "Body", type: "text"},
		]},
		// add new models here
	]
}
```

Never change `app_id` or `customer_id`: the migrator refuses a change of
application or organization identity.

Field types: `text`, `number`, `bool`, `date`, `datetime`, `relation`,
`text_list`, `enum`, `json`, `iso_country`, `iso_currency`, `money_rate`,
`known_aliases`. A model's `kind` is `entity` (ordinary records) or `lookup`
(a small reference list).

## A new table with links and a choice list

```cue
{
	id: "company", kind: "entity", label: "Company"
	display_field_id: "name"
	fields: [
		{id: "name", label: "Name", type: "text", required: true},
		{id: "website", label: "Website", type: "text"},
	]
},
{
	id: "deal", kind: "entity", label: "Deal"
	display_field_id: "name"
	fields: [
		{id: "name", label: "Deal name", type: "text", required: true},
		{id: "company", label: "Company", type: "relation", target_model: "company", required: true},
		{id: "owner", label: "Owner", type: "relation", target_model: "person"},
		{id: "amount", label: "Amount", type: "number"},
		{id: "stage", label: "Stage", type: "enum", required: true, option_set: [
			{id: "lead", label: "Lead"},
			{id: "qualified", label: "Qualified"},
			{id: "proposal", label: "Proposal"},
			{id: "won", label: "Won"},
			{id: "lost", label: "Lost"},
		]},
	]
},
```

Required fields are allowed on a **new** table. On an existing table, new
fields must be optional.

## Add an optional field to an existing table

```cue
{id: "source", label: "Source", type: "text"},
```

## Rename a field (public name, immutable id)

```cue
// before: {id: "amount", label: "Amount", type: "number"}
{id: "amount", name: "value", label: "Value", type: "number"},
```

The `id` never changes. `name` is the new public name used by generated
operations, Canvas and Claude; the previous name remains a read alias. Update
custom pages to the new name (`bun run check` finds them). After another rename,
retain all earlier public names explicitly, including when renaming back:

```cue
{id: "amount", name: "total", aliases: ["value"], label: "Total", type: "number"},
```

Tables use the same `name` and `aliases` properties while keeping their stable
`id`. For a choice option, keep its `id`, update its `label` and retain earlier
labels in `aliases`, for example `{id: "open", label: "Ready", aliases: ["Open"]}`.

To make an existing optional field required or unique, set `required: true` or
`is_unique: true` and rehearse. The migration reports failing row ids. Fill or
correct those rows through ordinary writes before retrying; archived history
is kept. A newly added field must first be optional.

## Retire a field

Delete its entry from `fields`. The migrator retires it: hidden from Canvas and
generated operations, its historical data kept in the database. Reusing an
archived ID, name or alias is refused. Give the new field a different ID and name.

## Type change: never in place

```cue
// amount stays a number. Add a new field with its own id:
{id: "amount_text", name: "value_text", label: "Value (text)", type: "text"},
```

Make it live, copy values through the generated operations, switch pages, then
delete the old field's entry to retire it. Reusing a retired field's `id` with
a different type is also refused.

## Starter tables from `packages/domain-libs`

`bun run compile` already passes `packages/domain-libs/catalog.json` and
`packages/schema-compiler/cue/app-selection.cue` to the compiler, so
`domain_catalog.models.<id>` is visible from `app.cue`. **But the starter app
has no ready-made way to turn a catalog selection into a model yet**: on
`main` that lowering lived in an app-specific spec
(`.config/app-specs/comp-canvas.cue`), not in `app/`. Until a supported
"extend a starter" pattern lands:

- look up the closest starter in `catalog.json` (for example `employee`,
  `customer`, `vendor`, `contractor`, `department`, `location`);
- write a normal model whose fields reuse the starter's field `id`, `label`
  and `type` for the fields this workflow needs, plus the builder's own fields;
- tell the builder it is modeled on the starter rather than linked to it.

Do not write a new CUE lowering for catalog selections as part of a section
change.
