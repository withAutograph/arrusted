package schema

#DomainCatalog: close({
	version:     1
	model_count: uint
	models: {
		[#NonEmptyString]: #CatalogModel
	}
})

#CatalogModel: close({
	id:             #NonEmptyString
	source_package: #NonEmptyString
	kind:           #ModelKind
	label:          #NonEmptyString
	origin: *"app" | #SchemaElementOrigin
	management: *"fixed" | #SchemaManagementPolicy
	lifecycle: *"active" | #SchemaElementLifecycle
	field_order: [...#NonEmptyString]
	field_groups: [...#CatalogFieldGroup]
	fields: {
		[#NonEmptyString]: #CatalogField
	}
	inverse_relations: [...#InverseRelationManifest]
	seed_rows: [...#CatalogSeedRow]
	display_field_id?: #NonEmptyString
})

#CatalogFieldGroup: close({
	id:     #NonEmptyString
	label:  #NonEmptyString
	fields: [...#NonEmptyString]
})

#CatalogField: close({
	type:           #FieldType
	label:          #NonEmptyString
	notes:          *"" | string
	is_unique:      *false | bool
	target_model?:  #NonEmptyString
	is_multi_value: *false | bool
	option_set: *[] | [...#EnumOptionManifest]
	origin: *"app" | #SchemaElementOrigin
	management: *"fixed" | #SchemaManagementPolicy
	lifecycle: *"active" | #SchemaElementLifecycle
})

#CatalogSeedRow: close({
	external_key: #NonEmptyString
	values: {
		[#NonEmptyString]: #SeedValue
	}
})

#ModelSelection: close({
	model: #NonEmptyString
	fields: [...#NonEmptyString]
	required: *[] | [...#NonEmptyString]
	seed_rows: *[] | [...#NonEmptyString]
	deferred_fields: *[] | [...#NonEmptyString]
	reason: #NonEmptyString
	display_field_id?: #NonEmptyString
	management?: #SchemaManagementPolicy
	extensions?: #EntityExtensionCapabilities
})

#SeedDefaults: close({
	effective_start:    #NonEmptyString
	actor_id:           #NonEmptyString
	source_kind:        #NonEmptyString
	idempotency_prefix: #NonEmptyString
})

#LocalModelSelection: close({
	model: #ModelManifest
	deferred_fields: *[] | [...#NonEmptyString]
	reason: #NonEmptyString
})

#AppSelection: close({
	app_id:      #NonEmptyString
	customer_id: #NonEmptyString
	version:     #NonEmptyString
	selections: [...#ModelSelection]
	local_models: *[] | [...#LocalModelSelection]
	model_order: [...#NonEmptyString]
	custom_fields: *[] | [...#CustomFieldManifest]
	change_types: *[] | [...#ChangeTypeManifest]
	constraints: *[] | [...#ConstraintManifest]
	seed_change_sets: *[] | [...#SeedChangeSetManifest]
	seed_defaults: #SeedDefaults
})
