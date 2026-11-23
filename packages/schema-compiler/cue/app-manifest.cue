package schema

#NonEmptyString: string & =~"^.+$"

#ModelKind: "entity" | "lookup"

#SchemaElementOrigin: "app" | "tenant"

#SchemaManagementPolicy: "fixed" | "tenant_managed"

#SchemaElementLifecycle: "active" | "retired"

#RecordMetadataLimits: close({
	max_bytes: uint & >0 & <=65536
	max_depth: uint & >0 & <=16
	max_keys:  uint & >0 & <=256
	max_key_bytes: uint & >0 & <=256
	max_scalar_bytes: uint & >0 & <=16384
	max_array_items: uint & >0 & <=256
})

#EntityExtensionCapabilities: close({
	typed_custom_fields: *false | bool
	record_metadata?: #RecordMetadataLimits
})

#FieldType:
	"text" |
	"number" |
	"bool" |
	"date" |
	"datetime" |
	"relation" |
	"text_list" |
	"known_aliases" |
	"json" |
	"enum" |
	"iso_country" |
	"iso_currency" |
	"money_rate"

#CustomFieldType:
	"text" |
	"number" |
	"bool" |
	"date" |
	"datetime" |
	"relation" |
	"text_list" |
	"enum" |
	"money_rate"

#AppManifest: close({
	app_id:      #NonEmptyString
	customer_id: #NonEmptyString
	version:     #NonEmptyString
	label?:      #NonEmptyString
	connectors?: _
	agents?:     _
	models: [...#ModelManifest]
	custom_fields?: [...#CustomFieldManifest]
	change_types?: [...#ChangeTypeManifest]
	constraints?: [...#ConstraintManifest]
	authorization?: #AuthorizationManifest
	seed_change_sets?: [...#SeedChangeSetManifest]
})

#ModelManifest: close({
	name?: #NonEmptyString
	aliases?: [...#NonEmptyString]
	id:     #NonEmptyString
	kind:   #ModelKind
	label:  #NonEmptyString
	origin: *"app" | #SchemaElementOrigin
	management: *"fixed" | #SchemaManagementPolicy
	lifecycle: *"active" | #SchemaElementLifecycle
	notes?: string
	fields: [...#FieldManifest]
	field_groups?: [...#FieldGroupManifest]
	many_relations?: [...#ManyRelationManifest]
	inverse_relations?: [...#InverseRelationManifest]
	derived_fields?: [...#DerivedFieldManifest]
	display_field_id?: #NonEmptyString
	extensions: *{} | #EntityExtensionCapabilities
})

#FieldGroupManifest: close({
	id:     #NonEmptyString
	label:  #NonEmptyString
	fields: [...#NonEmptyString]
})

#ManyRelationManifest: close({
	id:           #NonEmptyString
	label:        #NonEmptyString
	target_model: #NonEmptyString
	notes?:       string
	origin: *"app" | #SchemaElementOrigin
	management: *"fixed" | #SchemaManagementPolicy
	lifecycle: *"active" | #SchemaElementLifecycle
})

#FieldManifest: close({
	id:            #NonEmptyString
	name?:         #NonEmptyString
	aliases?: [...#NonEmptyString]
	label:         #NonEmptyString
	type:          #FieldType
	required?:     bool
	is_unique?:    bool
	notes?:        string
	target_model?: #NonEmptyString
	option_set?: [...#EnumOptionManifest]
	origin: *"app" | #SchemaElementOrigin
	management: *"fixed" | #SchemaManagementPolicy
	lifecycle: *"active" | #SchemaElementLifecycle
})

#EnumOptionManifest: close({
	id:    #NonEmptyString
	label: #NonEmptyString
	aliases?: [...string]
	notes?: string
	origin: *"app" | #SchemaElementOrigin
	management: *"fixed" | #SchemaManagementPolicy
	lifecycle: *"active" | #SchemaElementLifecycle
})

#CustomFieldManifest: close({
	id:            #NonEmptyString
	model:         #NonEmptyString
	field:         #NonEmptyString
	label:         #NonEmptyString
	type:          #CustomFieldType
	target_model?: #NonEmptyString
	option_set?: [...#EnumOptionManifest]
	archived_at?: #NonEmptyString
	origin: *"app" | #SchemaElementOrigin
	management: *"fixed" | #SchemaManagementPolicy
	lifecycle?: #SchemaElementLifecycle
})

#ChangeTypeManifest: close({
	id:    #NonEmptyString
	label: #NonEmptyString
	model: #NonEmptyString
	touches?: [...#NonEmptyString]
	required?: [...#NonEmptyString]
	is_import_default?: bool
})

#InverseRelationManifest: close({
	id:      #NonEmptyString
	model:   #NonEmptyString
	through: #NonEmptyString
	label?:  string
	notes?:  string
})

#AuthorizationManifest: close({
	roles?: [...#AuthorizationRoleManifest]
	grants?: [...#AuthorizationGrantManifest]
})

#AuthorizationRoleManifest: close({
	id: #NonEmptyString
	label?: #NonEmptyString
})

#AuthorizationGrantManifest: close({
	role: #NonEmptyString
	model: #NonEmptyString
	operations: [...#AuthorizationOperation]
	read_fields?: [...#NonEmptyString]
	write_fields?: [...#NonEmptyString]
	read_relations?: [...#NonEmptyString]
	record: #AuthorizationRecordPredicate
})

#AuthorizationOperation: "read" | "create" | "update" | "delete" | "history"

#AuthorizationRecordPredicate:
	close({kind: "all"}) |
	close({kind: "actor_equals_field", field: #NonEmptyString})

#ConstraintManifest: close({
	id:         #NonEmptyString
	label:      #NonEmptyString
	model:      #NonEmptyString
	authority?: "authoritative" | "advisory"
	expression: #ConstraintExpr
	message?:   string
	notes?:     string
})

#ConstraintExpr:
	close({type: "and", expressions: [...#ConstraintExpr]}) |
	close({type: "or", expressions: [...#ConstraintExpr]}) |
	close({type: "not", expression: #ConstraintExpr}) |
	close({type: "field_present", field: #NonEmptyString}) |
	close({type: "field_absent", field: #NonEmptyString}) |
	close({type: "count_present", fields: [...#NonEmptyString], min?: uint, max?: uint}) |
	close({type: "compare_fields", left: #NonEmptyString, op: #Comparison, right: #NonEmptyString}) |
	close({type: "compare_literal", field: #NonEmptyString, op: #Comparison, value: #TypedLiteral}) |
	close({type: "field_in", field: #NonEmptyString, values: [...#TypedLiteral]}) |
	close({type: "field_set_contains", field: #NonEmptyString, value: string}) |
	close({type: "text_length", field: #NonEmptyString, min?: uint, max?: uint}) |
	close({type: "text_starts_with", field: #NonEmptyString, value: #NonEmptyString}) |
	close({type: "non_overlapping_intervals", start: #NonEmptyString, end: #NonEmptyString, subjects: [...[...#NonEmptyString]]})

#Comparison: "eq" | "not_eq" | "lt" | "lte" | "gt" | "gte"

#TypedLiteral:
	close({type: "text", value: string}) |
	close({type: "number", value: string}) |
	close({type: "bool", value: bool}) |
	close({type: "date", value: string}) |
	close({type: "datetime", value: string}) |
	close({type: "enum", value: string}) |
	close({type: "iso_country", value: string}) |
	close({type: "iso_currency", value: string})

#DerivedFieldManifest: close({
	id:         #NonEmptyString
	label:      #NonEmptyString
	type:       #FieldType
	expression: #DerivedExpr
	notes?:     string
})

#DerivedExpr:
	close({type: "field", field: #NonEmptyString}) |
	close({type: "relation_field", relation: #NonEmptyString, field: #NonEmptyString}) |
	close({type: "literal", value: #TypedLiteral}) |
	close({type: "coalesce", expressions: [...#DerivedExpr]}) |
	close({type: "concat", expressions: [...#DerivedExpr]}) |
	close({type: "add", left: #DerivedExpr, right: #DerivedExpr}) |
	close({type: "subtract", left: #DerivedExpr, right: #DerivedExpr}) |
	close({type: "multiply", left: #DerivedExpr, right: #DerivedExpr}) |
	close({type: "divide", left: #DerivedExpr, right: #DerivedExpr}) |
	close({type: "inverse_aggregate", inverse_relation: #NonEmptyString, aggregate: #Aggregate, expression?: #DerivedExpr, filter?: #ConstraintExpr}) |
	close({type: "normalize_money_rate", expression: #DerivedExpr, period: #MoneyRatePeriod}) |
	close({type: "parameter", parameter: #NonEmptyString}) |
	close({type: "compare", op: #Comparison, left: #DerivedExpr, right: #DerivedExpr}) |
	close({type: "if", condition: #DerivedExpr, then: #DerivedExpr, else: #DerivedExpr}) |
	close({type: "min", left: #DerivedExpr, right: #DerivedExpr}) |
	close({type: "max", left: #DerivedExpr, right: #DerivedExpr}) |
	close({type: "clamp", expression: #DerivedExpr, min: #DerivedExpr, max: #DerivedExpr})

#Aggregate: "count" | "sum" | "min" | "max"

#MoneyRatePeriod: "hourly" | "daily" | "weekly" | "monthly" | "annual"

#SeedValue: null | string | number | bool | [...(string | number)] | {...}

#SeedRecordKey:
	close({type: "record_id", value: #NonEmptyString}) |
	close({type: "external_key", value: #NonEmptyString})

#SeedWriteManifest: close({
	model:          #NonEmptyString
	record_key?:    #SeedRecordKey
	new_record_id?: #NonEmptyString
	values: {
		[#NonEmptyString]: #SeedValue
	}
	provenance?: {...}
})

#SeedChangeSetManifest: close({
	id:              #NonEmptyString
	effective_start: #NonEmptyString
	change_type?:    #NonEmptyString
	actor_id:        #NonEmptyString
	source_kind:     #NonEmptyString
	idempotency_key: #NonEmptyString
	notes?:          string
	writes: [...#SeedWriteManifest]
})
