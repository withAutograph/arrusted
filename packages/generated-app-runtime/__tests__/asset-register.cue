package schema

manifest: #AppManifest & {
  app_id: "asset-register"
  customer_id: "local-demo"
  version: "data-plane-test-v1"
  label: "Asset Register"
  models: [
    {
      id: "asset", kind: "entity", label: "Asset"
      extensions: {typed_custom_fields: true, record_metadata: {max_bytes:1024,max_depth:4,max_keys:16,max_key_bytes:64,max_scalar_bytes:128,max_array_items:16}}
      fields: [
        {id: "title", label: "Title", type: "text", required: true, is_unique: true},
        {id: "cost", label: "Cost", type: "number"},
        {id: "active", label: "Active", type: "bool"},
        {id: "placed_on", label: "Placed on", type: "date"},
        {id: "changed_at", label: "Changed at", type: "datetime"},
        {id: "owner", label: "Owner", type: "relation", target_model: "employee"},
        {id: "tags", label: "Tags", type: "text_list"},
        {id: "aliases", label: "Aliases", type: "known_aliases"},
        {id: "attributes", label: "Attributes", type: "json"},
        {id: "status", label: "Status", type: "enum", option_set: [{id:"available",label:"Available"},{id:"assigned",label:"Assigned"}]},
        {id: "country", label: "Country", type: "iso_country"},
        {id: "currency", label: "Currency", type: "iso_currency"},
        {id: "rate", label: "Rate", type: "money_rate"},
        {id: "legacy_note", label: "Legacy note", type: "text", required: true, lifecycle: "retired"},
      ]
    },
    {
      id: "employee", kind: "entity", label: "Employee"
      fields: [
        {id:"name",label:"Name",type:"text",required:true},
        {id:"primary_asset",label:"Primary asset",type:"relation",target_model:"asset"},
      ]
      inverse_relations: [{id:"assets",model:"asset",through:"owner",label:"Assigned assets"}]
    },
    {
      id:"category",kind:"lookup",label:"Category"
      fields:[{id:"name",label:"Name",type:"text",required:true}]
      many_relations:[{id:"related_assets",label:"Related assets",target_model:"asset"}]
    },
  ]
  custom_fields: [{id:"asset_serial",model:"asset",field:"serial",label:"Serial",type:"text"}, {id:"asset_custodian",model:"asset",field:"custodian",label:"Custodian",type:"relation",target_model:"employee"}]
  constraints: [{id:"asset_cost_nonnegative",label:"Nonnegative cost",model:"asset",authority:"authoritative",expression:{type:"or",expressions:[{type:"field_absent",field:"cost"},{type:"compare_literal",field:"cost",op:"gte",value:{type:"number",value:"0"}}]},message:"Cost must not be negative"}]
}
