package schema

manifest: #AppManifest & {
  app_id: "currency-persistence-proof"
  customer_id: "local-demo"
  version: "currency-persistence-v1"
  label: "Currency persistence proof"
  models: [{
    id: "exchange_rate", kind: "entity", label: "Exchange rate"
    fields: [
      {id: "source_currency", label: "Source currency", type: "iso_currency", required: true},
      {id: "target_currency", label: "Target currency", type: "iso_currency", required: true},
      {id: "origin", label: "Origin", type: "enum", required: true, option_set: [{id: "custom", label: "Custom"}, {id: "frankfurter", label: "Frankfurter"}]},
      {id: "rate", label: "Rate", type: "number"},
      {id: "observation_date", label: "Observation date", type: "date"},
    ]
  }]
}
