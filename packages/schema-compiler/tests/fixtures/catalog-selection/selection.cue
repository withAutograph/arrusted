package schema

import "list"

domain_catalog: #DomainCatalog

vendor_app: #AppSelection & {
	app_id:      "vendor"
	customer_id: "vendor"
	version:     "2026-11-04.draft-records-v122"
	model_order: [
		"vendor",
		"vendor_spend_transaction",
		"vendor_settings",
		"vendor_identity_mapping",
		"vendor_review_resolution",
		"employee",
		"department",
		"chart_account",
	]
	custom_fields: []
	selections: [
		{
			model: "vendor"
			fields: [
				"name",
				"known_aliases",
				"status",
				"type",
				"department",
				"owner",
				"entity_name",
				"default_chart_account",
			]
			required: ["name"]
			deferred_fields: ["id"]
			reason: "The canonical counterparty owns identity, management segmentation, and fallback classifications without absorbing source-transaction identity."
		},
		{
			model: "employee"
			fields: ["ref", "name", "known_aliases", "work_email"]
			required: ["ref", "name"]
			deferred_fields: ["department", "location"]
			reason: "Employee is selected only as a spend-owner relation target. Workforce semantics remain outside the vendor app."
		},
		{
			model: "department"
			fields: ["name", "known_aliases"]
			required: ["name"]
			display_field_id: "name"
			management:       "tenant_managed"
			deferred_fields: ["lead", "executive"]
			reason: "Department is customer-owned organizational vocabulary selected for independent functional vendor ownership; the app does not seed it."
		},
		{
			model: "chart_account"
			fields: ["code", "name", "parent", "account_type", "known_aliases"]
			required: ["name"]
			deferred_fields: ["id"]
			reason: "Chart accounts are source-populated customer vocabulary; the app does not seed a universal spend taxonomy."
		},
	]
	local_models: [
		{
			model: {
				id: "vendor_spend_transaction", kind: "entity", label: "Vendor Spend Transaction"
				fields: [
					{id: "source_record_ref", label: "Source Record Ref", type: "text", required: true, is_unique: true},
					{id: "integration_platform_id", label: "Integration Platform ID", type: "text"},
					{id: "source_connection_id", label: "Source Connection ID", type: "text"},
					{id: "provider", label: "Provider", type: "text"},
					{id: "payload_hash", label: "Payload Hash", type: "text"},
					{id: "source_record_id", label: "Source Record ID", type: "text", required: true},
					{id: "transaction_kind", label: "Transaction Kind", type: "enum", required: true, option_set: [
						{id: "card_transaction", label: "Card Transaction", aliases: []},
						{id: "bill", label: "Bill", aliases: ["invoice"]},
						{id: "credit", label: "Credit", aliases: ["vendor credit", "credit note"]},
					]},
					{id: "vendor", label: "Vendor", type: "relation", target_model: "vendor"},
					{id: "chart_account", label: "Chart Account", type: "relation", target_model: "chart_account"},
					{id: "counterparty_name", label: "Counterparty Name", type: "text"},
					{id: "document_number", label: "Document Number", type: "text"},
					{id: "amount", label: "Transaction Amount", type: "number"},
					{id: "open_amount", label: "Open Amount", type: "number"},
					{id: "currency_code", label: "Currency", type: "iso_currency"},
					{id: "status", label: "Status", type: "text"},
					{id: "transaction_date", label: "Transaction Date", type: "date"},
					{id: "due_date", label: "Due Date", type: "date"},
					{id: "accounting_date", label: "Accounting Date", type: "date"},
					{id: "service_start_date", label: "Service Start Date", type: "date"},
					{id: "service_end_date", label: "Service End Date", type: "date"},
					{id: "settlement_date", label: "Settlement Date", type: "date"},
					{id: "source_updated_at", label: "Source Updated At", type: "datetime"},
				]
			}
			reason: "Provider-neutral AP evidence retains vendor and source chart-account relations without claiming planning-component attribution."
		},
		{
			model: {id: "vendor_settings", kind: "entity", label: "Vendor Settings", fields: [
				{id: "reporting_currency_code", label: "Reporting Currency", type: "iso_currency", required: true},
			]}
			deferred_fields: ["id"]
			reason: "One customer-scoped settings record owns the reporting currency for analytics."
		},
		{
			model: {id: "vendor_identity_mapping", kind: "entity", label: "Vendor Identity Mapping", fields: [
				{id: "source_vendor", label: "Source Vendor", type: "relation", target_model: "vendor", required: true},
				{id: "canonical_vendor", label: "Canonical Vendor", type: "relation", target_model: "vendor", required: true},
			]}
			reason: "A durable app-owned identity mapping resolves provider-owned source Vendors without rewriting integration transaction history."
		},
		{
			model: {id: "vendor_review_resolution", kind: "entity", label: "Vendor Review Resolution", fields: [
				{id: "review_kind", label: "Review Kind", type: "enum", required: true, option_set: [{id: "identity_duplicate", label: "Vendor Identity Duplicate", aliases: []}]},
				{id: "subject_key", label: "Subject Key", type: "text", required: true},
				{id: "decision", label: "Decision", type: "enum", required: true, option_set: [{id: "keep_separate", label: "Keep Separate", aliases: []}]},
				{id: "resolved_on", label: "Resolved On", type: "date", required: true},
				{id: "reviewer", label: "Reviewer", type: "text", required: true},
			]}
			reason: "Explicit review resolutions preserve keep-separate decisions that are not authoritative Vendor mutations."
		},
	]
	change_types: [
		{
			id:    "vendor_import"
			label: "Vendor Import"
			model: "vendor"
			touches: ["name", "status"]
			required: ["name"]
		},
		{
			id:    "vendor_spend_transaction_import"
			label: "Vendor Spend Transaction Import"
			model: "vendor_spend_transaction"
			touches: [
				"source_record_ref", "source_record_id", "transaction_kind", "vendor",
				"counterparty_name", "amount", "currency_code", "transaction_date",
			]
			required: ["source_record_ref", "source_record_id", "transaction_kind"]
		},
		{id: "vendor_identity_merge", label: "Merge Vendor Identity", model: "vendor_identity_mapping", touches: ["source_vendor", "canonical_vendor"]},
		{id: "vendor_identity_keep_separate", label: "Keep Vendor Identities Separate", model: "vendor_review_resolution", touches: ["review_kind", "subject_key", "decision", "resolved_on", "reviewer"]},
		{id: "vendor_type_review", label: "Assign Vendor Type", model: "vendor", touches: ["type"], required: ["type"]},
	]
	seed_change_sets: [{
		id:              "seed_vendor_settings_default", effective_start: "2024-01-01"
		actor_id:        "apps/vendor seed", source_kind:                 "vendor_seed"
		idempotency_key: "vendor-seed-vendor_settings-default"
		notes:           "Seed vendor_settings lookup row `default`"
		writes: [{
			model: "vendor_settings"
			record_key: {type: "external_key", value: "default"}
			values: {reporting_currency_code: "USD"}
			provenance: {source: "apps/vendor seed"}
		}]
	}]
	seed_defaults: {
		effective_start:    "2024-01-01"
		actor_id:           "apps/vendor seed"
		source_kind:        "vendor_seed"
		idempotency_prefix: "vendor-seed"
	}
}

_selected_models: [for selection in vendor_app.selections let source = domain_catalog.models[selection.model] {
	if len(selection.seed_rows) > 0 && source.kind != "lookup" {
		_invalid_entity_seed_selection: _|_
		id:                             _invalid_entity_seed_selection
	}
	id:    source.id
	kind:  source.kind
	label: source.label
	origin:    source.origin
	lifecycle: source.lifecycle
	if source.kind == "lookup" {
		display_field_id: (selection & {display_field_id: #NonEmptyString}).display_field_id
		management:       (selection & {management: #SchemaManagementPolicy}).management
	}
	if source.kind != "lookup" {
		management: source.management
	}
	fields: list.Concat([[for fieldID in selection.fields let field = source.fields[fieldID] if !field.is_multi_value {
		id:        fieldID
		label:     field.label
		type:      field.type
		required:  list.Contains(selection.required, fieldID)
		is_unique: field.is_unique
		origin:     field.origin
		management: field.management
		lifecycle:  field.lifecycle
		if field.notes != "" {
			notes: field.notes
		}
		if field.type == "relation" {
			target_model: field.target_model
		}
		if field.type == "enum" {
			option_set: field.option_set
		}
	}], [for fieldID in selection.required if !list.Contains(selection.fields, fieldID) {
		_invalid_required_selection: _|_
		id:                          fieldID
		label:                       domain_catalog.models[selection.model].fields[fieldID].label
		type:                        _invalid_required_selection
	}]])
	field_groups: [for group in source.field_groups let selectedFields = [for fieldID in group.fields if list.Contains(selection.fields, fieldID) {
		fieldID
	}] if len(selectedFields) > 0 {
		id:     group.id
		label:  group.label
		fields: selectedFields
	}]
	inverse_relations: [for fieldID in selection.fields let field = source.fields[fieldID] if field.is_multi_value let targetModel = (field & {target_model: #NonEmptyString}).target_model let inverseFields = [for inverseFieldID in domain_catalog.models[targetModel].field_order let inverseField = domain_catalog.models[targetModel].fields[inverseFieldID] if inverseField.type == "relation" if !inverseField.is_multi_value let inverseTarget = (inverseField & {target_model: #NonEmptyString}).target_model if inverseTarget == source.id {
		inverseFieldID
	}] {
		if list.Contains(selection.required, fieldID) {
			_required_inverse_relation_not_supported: _|_
			id:                                       _required_inverse_relation_not_supported
		}
		if len(inverseFields) != 1 {
			_ambiguous_inverse_relation: _|_
			through:                     _ambiguous_inverse_relation
		}
		id:      fieldID
		model:   targetModel
		through: inverseFields[0]
		label:   field.label
		if field.notes != "" {
			notes: field.notes
		}
	}]
}]

_model_map: {
	for model in _selected_models {
		"\(model.id)": model
	}
	for model in vendor_app.local_models {
		"\(model.model.id)": model.model
	}
}

_required_relation_target_ids: list.Concat([
	[for model in _selected_models for field in model.fields if field.type == "relation" {
		field.target_model
	}],
	[for model in _selected_models for relation in model.inverse_relations {
		relation.model
	}],
	[for localModel in vendor_app.local_models for field in localModel.model.fields if field.type == "relation" {
		field.target_model
	}],
])

_required_relation_targets: {
	for target in _required_relation_target_ids {
		"\(target)": true
	}
}

_closure_model_order: [for selection in vendor_app.selections if list.Contains(_required_relation_target_ids, selection.model) if !list.Contains(vendor_app.model_order, selection.model) {
	selection.model
}]

_remaining_selection_order: [for selection in vendor_app.selections if !list.Contains(vendor_app.model_order, selection.model) if !list.Contains(_closure_model_order, selection.model) {
	selection.model
}]

_remaining_local_model_order: [for localModel in vendor_app.local_models if !list.Contains(vendor_app.model_order, localModel.model.id) if !list.Contains(_closure_model_order, localModel.model.id) {
	localModel.model.id
}]

_resolved_model_order: list.Concat([
	vendor_app.model_order,
	_closure_model_order,
	_remaining_selection_order,
	_remaining_local_model_order,
])

_resolved_model_map: {
	for modelID in _resolved_model_order {
		"\(modelID)": _model_map[modelID]
	}
}

_resolved_field_map: {
	for modelID, model in _resolved_model_map {
		"\(modelID)": {
			for field in model.fields {
				"\(field.id)": field
			}
		}
	}
}

manifest: #AppManifest & {
	app_id:      vendor_app.app_id
	customer_id: vendor_app.customer_id
	version:     vendor_app.version
	models: list.Concat([[for modelID in _resolved_model_order {
		_resolved_model_map[modelID]
	}], [for target, _ in _required_relation_targets if !list.Contains(_resolved_model_order, target) {
		_model_map[target]
	}]])
	custom_fields: vendor_app.custom_fields
	change_types:  vendor_app.change_types
	constraints:   vendor_app.constraints
	seed_change_sets: list.Concat([[for selection in vendor_app.selections let source = domain_catalog.models[selection.model] for externalKey in selection.seed_rows let rows = [for row in source.seed_rows if row.external_key == externalKey {row}] {
		id:              "seed_\(source.id)_\(externalKey)"
		effective_start: vendor_app.seed_defaults.effective_start
		actor_id:        vendor_app.seed_defaults.actor_id
		source_kind:     vendor_app.seed_defaults.source_kind
		idempotency_key: "\(vendor_app.seed_defaults.idempotency_prefix)-\(source.id)-\(externalKey)"
		notes:           "Seed \(source.id) lookup row `\(externalKey)`"
		writes: [{
			model: source.id
			record_key: {type: "external_key", value: externalKey}
			values: {
				for fieldID, value in rows[0].values if list.Contains(selection.fields, fieldID) {
					"\(fieldID)": value
				}
			}
		}]
	}], vendor_app.seed_change_sets])
}

coverage: {
	catalog_version: domain_catalog.version
	model_order:     _resolved_model_order
	selected: [for selection in vendor_app.selections let source = domain_catalog.models[selection.model] {
		model:           source.id
		kind:            source.kind
		source_package:  source.source_package
		selected_fields: selection.fields
		deferred_fields: [for fieldID in selection.deferred_fields let field = source.fields[fieldID] if field.label != "" {
			fieldID
		}]
		reason: selection.reason
		relation_targets: [for fieldID in selection.fields let field = source.fields[fieldID] if field.type == "relation" {
			field.target_model
		}]
		lookup_targets: [for fieldID in selection.fields let field = source.fields[fieldID] if field.type == "relation" if domain_catalog.models[field.target_model].kind == "lookup" {
			field.target_model
		}]
		enum_fields: [for fieldID in selection.fields if source.fields[fieldID].type == "enum" {
			fieldID
		}]
		seed_rows: selection.seed_rows
	}]
	local: [for localModel in vendor_app.local_models {
		model:          localModel.model.id
		kind:           localModel.model.kind
		source_package: "app"
		selected_fields: [for field in localModel.model.fields {field.id}]
		deferred_fields: localModel.deferred_fields
		reason:          localModel.reason
		relation_targets: [for field in localModel.model.fields if field.type == "relation" {
			field.target_model
		}]
		lookup_targets: [for field in localModel.model.fields if field.type == "relation" if domain_catalog.models[field.target_model].kind == "lookup" {
			field.target_model
		}]
		enum_fields: [for field in localModel.model.fields if field.type == "enum" {
			field.id
		}]
		seed_rows: []
	}]
}

#VendorImportPolicy: close({
	externalKey: {kind: "model_token"}
	generatedIdTokenFallback: {kind: "default_model_token"}
	generatedIdTokens: {
		[#NonEmptyString]: #NonEmptyString
	}
	identities: [...close({
		modelId: #NonEmptyString
		identity: [...close({
			fieldId:      #NonEmptyString
			kind:         "id" | "name" | "unique" | "alias"
			aliasFieldId?: #NonEmptyString
			if kind == "alias" {
				aliasFieldId: #NonEmptyString
			}
		})]
	})]
})

_import_policy: #VendorImportPolicy & {
	externalKey: {kind: "model_token"}
	generatedIdTokenFallback: {kind: "default_model_token"}
	generatedIdTokens: {
		vendor:          "vendor"
		vendor_settings: "settings"
		employee:        "emp"
		department:      "dept"
		chart_account:   "acct"
	}
	identities: [
		{
			modelId: "vendor"
			identity: [
				{fieldId: "name", kind: "name"},
				{fieldId: "name", aliasFieldId: "known_aliases", kind: "alias"},
			]
		},
		{
			modelId: "employee"
			identity: [
				{fieldId: "ref", kind: "id"},
				{fieldId: "name", kind: "name"},
			]
		},
		{
			modelId: "vendor_spend_transaction"
			identity: [{fieldId: "source_record_ref", kind: "unique"}]
		},
	]
}

_identity_model_ids: [for identity in _import_policy.identities {identity.modelId}]

import_policy: #VendorImportPolicy & {
	externalKey:              _import_policy.externalKey
	generatedIdTokenFallback: _import_policy.generatedIdTokenFallback
	generatedIdTokens: {
		for modelID, token in _import_policy.generatedIdTokens {
			if _resolved_model_map[modelID].id == modelID {
				"\(modelID)": token
			}
		}
	}
	identities: [for entry in _import_policy.identities {
		modelId: _resolved_model_map[entry.modelId].id
		identity: [for field in entry.identity {
			fieldId: _resolved_field_map[entry.modelId][field.fieldId].id
			kind:    field.kind
			if field.kind == "alias" {
				aliasFieldId: _resolved_field_map[entry.modelId][field.aliasFieldId].id
			}
		}]
	}]
	if !list.UniqueItems(_identity_model_ids) {
		_duplicate_identity_models: _|_
		identities:                 _duplicate_identity_models
	}
}
