package schema

manifest: #AppManifest & {
	app_id: "starter"
	customer_id: "starter"
	version: "v1"
	label: "Starter"
	models: [{
		id: "note"
		kind: "entity"
		label: "Note"
		fields: [
			{id: "title", label: "Title", type: "text", required: true},
			{id: "body", label: "Body", type: "text"},
		]
	}]
}
