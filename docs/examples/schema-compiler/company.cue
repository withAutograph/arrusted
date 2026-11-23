package schema

manifest: #AppManifest & {
	app_id:      "company_directory"
	customer_id: "example"
	version:     "2026-07-13"

	models: [
		{
			id:    "company"
			kind:  "entity"
			label: "Company"
			fields: [
				{
					id:        "name"
					label:     "Name"
					type:      "text"
					required:  true
					is_unique: true
				},
				{
					id:    "status"
					label: "Status"
					type:  "enum"
					option_set: [
						{id: "active", label: "Active", aliases: ["current"]},
						{id: "inactive", label: "Inactive"},
					]
				},
				{
					id:           "region"
					label:        "Region"
					type:         "relation"
					target_model: "region"
				},
				{
					id:    "annual_revenue"
					label: "Annual revenue"
					type:  "number"
				},
			]
			inverse_relations: [{
				id:      "employees"
				model:   "employee"
				through: "company"
				label:   "Employees"
			}]
			derived_fields: [{
				id:    "monthly_revenue"
				label: "Monthly revenue"
				type:  "number"
				expression: {
					type: "divide"
					left: {type: "field", field: "annual_revenue"}
					right: {type: "literal", value: {type: "number", value: "12"}}
				}
			}]
		},
		{
			id:    "employee"
			kind:  "entity"
			label: "Employee"
			fields: [
				{
					id:           "company"
					label:        "Company"
					type:         "relation"
					required:     true
					target_model: "company"
				},
				{
					id:       "name"
					label:    "Name"
					type:     "text"
					required: true
				},
			]
		},
		{
			id:    "region"
			kind:  "lookup"
			label: "Region"
			fields: [
				{
					id:       "name"
					label:    "Name"
					type:     "text"
					required: true
				},
				{
					id:    "known_aliases"
					label: "Known aliases"
					type:  "known_aliases"
				},
			]
		},
	]

	change_types: [
		{
			id:       "company_update"
			label:    "Update company"
			model:    "company"
			touches:  ["name", "status", "region", "annual_revenue"]
			required: ["name"]
		},
		{
			id:    "region_update"
			label: "Update region"
			model: "region"
		},
	]

	constraints: [{
		id:        "company_revenue_nonnegative"
		label:     "Company revenue is nonnegative"
		model:     "company"
		authority: "authoritative"
		expression: {
			type:  "compare_literal"
			field: "annual_revenue"
			op:    "gte"
			value: {type: "number", value: "0"}
		}
		message: "Annual revenue cannot be negative"
	}]

	seed_change_sets: [{
		id:              "seed_region_north_america"
		effective_start: "2024-01-01"
		change_type:     "region_update"
		actor_id:        "company example seed"
		source_kind:     "example_seed"
		idempotency_key: "company-example-region-north-america"
		writes: [{
			model:      "region"
			record_key: {type: "external_key", value: "north_america"}
			values: {
				name:          "North America"
				known_aliases: ["NA", "North America"]
			}
		}]
	}]
}
