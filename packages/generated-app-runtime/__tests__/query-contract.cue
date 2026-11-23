package schema

manifest: #AppManifest & {
  app_id: "query-contract"
  customer_id: "local-demo"
  version: "query-contract-v1"
  label: "Query contract"
  models: [{
    id: "asset"
    kind: "entity"
    label: "Asset"
    extensions: {typed_custom_fields: true}
    fields: [{id: "title", label: "Title", type: "text", required: true}]
  }]
  custom_fields: [
    {id: "asset_state", model: "asset", field: "state", label: "State", type: "enum", option_set: [{id: "active", label: "Active"}]},
    {id: "asset_legacy", model: "asset", field: "legacy", label: "Legacy", type: "text", lifecycle: "retired", archived_at: "2026-09-01T00:00:00Z"},
  ]
}
