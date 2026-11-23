//! Application-facing projections. PostgreSQL remains the persistence authority.
use crate::CompiledManifest;

pub(crate) mod predecessor;
pub use predecessor::DataPlanePredecessor;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

// These names are either re-exported by the app-owned bridge or imported into
// generated data-operations.ts. A model record alias cannot redeclare either.
const RESERVED_RECORD_TYPE_NAMES: &[&str] = &[
    "CanonicalRecordKey",
    "QueryInput",
    "WriteOptions",
    "DataWrite",
    "FormError",
    "FormErrorCode",
    "FormActionResult",
    "DataContext",
    "DataDefinition",
    "ModelCreateField",
    "ModelRecord",
    "ModelUpdateField",
];

pub fn compile(compiled: &CompiledManifest) -> Result<Value, String> {
    compile_with_predecessors(compiled, &[])
}

pub fn compile_with_predecessors(
    compiled: &CompiledManifest,
    predecessors: &[DataPlanePredecessor],
) -> Result<Value, String> {
    let policy_enabled = compiled.extras.authorization_policy.is_some();
    let schema = serde_json::to_value(&compiled.schema).map_err(|e| e.to_string())?;
    let active_custom_fields = schema["custom_fields"]
        .as_array()
        .ok_or("missing custom fields")?
        .iter()
        .filter(|field| field["archived_at"].is_null() && field["lifecycle"] != "retired")
        .cloned()
        .collect::<Vec<_>>();
    let constraints = compiled
        .extras
        .constraints
        .iter()
        .map(|constraint| {
            let mut value = serde_json::to_value(constraint).map_err(|error| error.to_string())?;
            let object = value
                .as_object_mut()
                .ok_or("constraint did not serialize as an object")?;
            object.insert(
                "referencedFieldIds".to_string(),
                json!(crate::sql::constraint_expression_field_ids(
                    &constraint.expression
                )),
            );
            Ok(value)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut symbols = BTreeSet::new();
    let mut public_type_symbols = BTreeSet::new();
    let mut models = Vec::new();
    let mut static_fields = BTreeMap::<String, Vec<String>>::new();
    let mut static_options = BTreeMap::<String, Vec<String>>::new();
    let mut docs = String::from("# Generated data operations\n\nGenerated from CUE; do not edit. Next application bindings run reads on the server; neutral generated operations remain transport-independent. Browser mutations are explicitly exported by app-owned Server Actions. Delete writes an audited tombstone. Numbers are decimal strings. `aggregate` returns bounded key tuples and exact decimal-string or null metric slots and totals (null for mixed-unit money totals or empty non-count metrics). The response header includes `as_of`, the effective read date, and `units`, one entry per metric: `{ currency, period }` for a money metric with exactly one non-null unit among eligible rows, otherwise null (including non-money metrics and empty sets); `count` and `countBy` use that same aggregate SQL path. `count` returns a decimal integer string; `countBy` returns bounded `{ value, count }` groups where `value` has the selected supported group field's generated read type and `count` remains a decimal integer string. Omitted fields inherit; clear is explicit. `parseForm(form, { fields, mode })` reads only its writable field allowlist and returns `{ values, clear }`; it validates form codecs but does not authorize or persist. `toFormError(error, { fields })` requires a non-empty, distinct writable field allowlist and returns a browser-safe `{ ok: false, code, message, fieldErrors }` result for supported failures. A matching parser validation failure maps to `invalid_input` on its selected field. A matching declared unique-field conflict maps to `conflict` on its selected unique field. An authoritative declared constraint (a row CHECK or a cross-record interval rule) with exactly its generated `referencedFieldIds` maps to `constraint_violation` on the selected referenced fields. A `version_conflict` maps to `conflict` with the fixed message \"This record has changed. Reload and try again.\" and empty `fieldErrors` only when the definition supports version preconditions and the failure has no details; legacy definitions and conflicts with details return `undefined`. `authorization_denied` and `forbidden` map to `forbidden` with a fixed permission-denial message and empty `fieldErrors`. Unknown, mismatched, malformed, or invalid-allowlist failures return `undefined`; raw database diagnostics are never exposed. Create requires only selected required fields. Update omission is unchanged; `clear:<field>=true` is available for selected optional fields. Lists and canonical relations use one JSON control, so `[]` remains distinct from omission. PostgreSQL remains authoritative for complete-record constraints, uniqueness, and cross-field rules. `get`, `list`, and inverse relation `list` accept an optional non-empty readonly `select` tuple of `id`, `externalKey`, `$version` (when supported), and generated business, custom, or many-relation fields. A literal tuple returns exactly those fields; a dynamic array or tuple with an uncertain union-valued field returns a partial selected shape; an optional selection returns the full-or-selected union. Selected reads are unbranded plain objects and cannot serve as record references. Omit `select` for the full generated record. Capable full records expose a readonly UUID `$version`; acquire it by omitting `select`, or explicitly select `[\"id\", \"$version\"]`, then pass `{ ifVersion: record.$version }` to guarded update or delete. With a selected object, use its `id` as the mutation target; the selected object itself is not a record reference. Legacy definitions reject `$version` and `ifVersion`, and creates or draft writes cannot use version guards.\n\n");
    docs.push_str("The app-owned server integration imports `createOperations(context)` and types from `@/schema`, which resolves the app-owned generated `schema/index.ts` through the standard Next `@/*` alias (`${configDir}/*`). For another host, use its explicitly configured project alias to that same app-owned pointer. The integration supplies its authenticated server-only `DataContext`, and exposes the resulting operations through its own server boundary. Ordinary feature modules use that app-owned boundary; its module path and exported accessor are chosen by the app. Feature modules do not import `@autograph/generated-app-runtime/*` directly. The generated `schema/index.ts` pointer and release `data-server.ts` retain the runtime implementation dependency and shared type exports. Each model also exports `<Model>CreateField` and `<Model>UpdateField`; both are the writable business and form field vocabulary shared by create, update, and `parseForm`, excluding readonly, derived, and retired fields.\n\n");
    for model in schema["models"].as_array().ok_or("missing models")? {
        let id = model["id"].as_str().ok_or("missing model id")?;
        let original_symbol = model_symbol(id);
        let metadata = compiled
            .extras
            .model_metadata
            .iter()
            .find(|entry| entry.model == id);
        let symbol = metadata
            .and_then(|entry| entry.name.clone())
            .unwrap_or_else(|| original_symbol.clone());
        let mut model_aliases = metadata
            .map(|entry| entry.aliases.clone())
            .unwrap_or_default();
        if symbol != original_symbol {
            model_aliases.push(original_symbol);
        }
        model_aliases.sort();
        model_aliases.dedup();
        model_aliases.retain(|alias| alias != &symbol);
        for name in std::iter::once(&symbol).chain(model_aliases.iter()) {
            if !valid_public_field_name(name) || matches!(name.as_str(), "apply" | "workSessions") {
                return Err(format!("invalid data model name: {name}"));
            }
        }
        let record_type = model_record_type(&symbol);
        let create_field_type = format!("{record_type}CreateField");
        let update_field_type = format!("{record_type}UpdateField");
        if RESERVED_RECORD_TYPE_NAMES.contains(&record_type.as_str()) {
            return Err(format!(
                "data record type collides with reserved generated type: {record_type}"
            ));
        }
        for field_type in [&create_field_type, &update_field_type] {
            if RESERVED_RECORD_TYPE_NAMES.contains(&field_type.as_str()) {
                return Err(format!(
                    "data generated field type collides with reserved generated type: {field_type}"
                ));
            }
        }
        if !symbols.insert(symbol.clone())
            || model_aliases
                .iter()
                .any(|alias| !symbols.insert(alias.clone()))
        {
            return Err(format!("data operation symbol collision: {symbol}"));
        }
        for public_type in [&record_type, &create_field_type, &update_field_type] {
            if !public_type_symbols.insert(public_type.clone()) {
                return Err(format!("data public type symbol collision: {public_type}"));
            }
        }
        let mut fields = model["fields"].as_array().ok_or("missing fields")?.clone();
        let mut field_ids = Vec::new();
        for field in &mut fields {
            let field_id = field["id"].as_str().ok_or("missing field id")?;
            let value_kind = field["type"].as_str().ok_or("missing field type")?;
            if !matches!(
                value_kind,
                "text"
                    | "number"
                    | "date"
                    | "datetime"
                    | "bool"
                    | "json"
                    | "enum"
                    | "iso_country"
                    | "iso_currency"
                    | "money_rate"
                    | "relation"
                    | "text_list"
                    | "known_aliases"
            ) {
                return Err(format!(
                    "unclassified generated client field type: {id}.{field_id}: {value_kind}"
                ));
            }
            field_ids.push(field_id.to_string());
            if value_kind == "enum" {
                static_options.insert(
                    format!("{id}.{field_id}"),
                    field["option_set"]
                        .as_array()
                        .ok_or("missing enum options")?
                        .iter()
                        .map(|option| {
                            option["id"]
                                .as_str()
                                .ok_or("missing enum option id")
                                .map(str::to_string)
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            field["storage"] = json!("declared");
        }
        static_fields.insert(id.to_string(), field_ids);
        for custom in active_custom_fields
            .iter()
            .filter(|f| f["model_id"].as_str() == Some(id))
        {
            let custom_id = custom["field_id"]
                .as_str()
                .ok_or("missing custom field id")?;
            let value_kind = custom["type"].as_str().ok_or("missing custom field type")?;
            if !matches!(
                value_kind,
                "text"
                    | "number"
                    | "date"
                    | "datetime"
                    | "bool"
                    | "json"
                    | "enum"
                    | "iso_country"
                    | "iso_currency"
                    | "money_rate"
                    | "relation"
                    | "text_list"
                    | "known_aliases"
            ) {
                return Err(format!("unclassified generated client custom field type: {id}.{custom_id}: {value_kind}"));
            }
            static_fields
                .get_mut(id)
                .expect("model fields classified")
                .push(custom_id.to_string());
            if value_kind == "enum" {
                static_options.insert(
                    format!("{id}.{custom_id}"),
                    custom["option_set"]
                        .as_array()
                        .ok_or("missing custom enum options")?
                        .iter()
                        .map(|option| {
                            option["id"]
                                .as_str()
                                .ok_or("missing custom enum option id")
                                .map(str::to_string)
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            let mut field = custom.clone();
            field["id"] = custom["field_id"].clone();
            field["required"] = json!(false);
            field["target_model"] = custom["target_model_id"].clone();
            field["storage"] = json!("custom");
            fields.push(field);
        }
        for relation in model["many_relations"].as_array().into_iter().flatten() {
            let mut field = relation.clone();
            field["type"] = json!("relation_list");
            field["required"] = json!(false);
            field["storage"] = json!("many");
            fields.push(field);
        }
        let mut names = BTreeSet::from([
            "id".to_string(),
            "externalKey".to_string(),
            "effectiveStart".to_string(),
            "effectiveEnd".to_string(),
            "customFields".to_string(),
            "metadata".to_string(),
            "manyRelations".to_string(),
        ]);
        for field in &mut fields {
            let field_id = field["id"].as_str().ok_or("missing field id")?.to_string();
            let base = camel(&field_id);
            let name = if field["storage"] == "custom" {
                format!("custom{}{}", base[..1].to_uppercase(), &base[1..])
            } else if names.contains(&base) {
                format!("field{}{}", base[..1].to_uppercase(), &base[1..])
            } else {
                base
            };
            if !names.insert(name.clone()) {
                return Err(format!("data field symbol collision: {id}.{name}"));
            }
            field["name"] = json!(name);
            // Derived values are readable and aggregatable but never written.
            field["readOnly"] =
                json!(field["storage"] == "custom" && !field["expression"].is_null());
        }
        // Public names may evolve while persisted field IDs remain immutable. The
        // original generated name and explicitly retained names are readable aliases.
        let mut aliases = Vec::new();
        for field in &mut fields {
            if field["storage"] != "declared" {
                continue;
            }
            let Some(metadata) = compiled.extras.field_metadata.iter().find(|metadata| {
                metadata.model == id && Some(metadata.field.as_str()) == field["id"].as_str()
            }) else {
                continue;
            };
            let original = field["name"].as_str().unwrap().to_string();
            let primary = metadata.name.clone().unwrap_or_else(|| original.clone());
            let mut retained = metadata.aliases.clone();
            if primary != original {
                retained.push(original.clone());
            }
            if primary != original {
                if !valid_public_field_name(&primary) || !names.insert(primary.clone()) {
                    return Err(format!(
                        "data field symbol collision or invalid name: {id}.{primary}"
                    ));
                }
                field["name"] = json!(primary);
            }
            for alias in retained.into_iter().collect::<BTreeSet<_>>() {
                if alias == primary {
                    continue;
                }
                if !valid_public_field_name(&alias)
                    || (alias != original && !names.insert(alias.clone()))
                {
                    return Err(format!(
                        "data field alias collision or invalid name: {id}.{alias}"
                    ));
                }
                let mut alias_field = field.clone();
                alias_field["name"] = json!(alias);
                alias_field["readOnly"] = json!(true);
                alias_field["aliasOf"] = json!(primary);
                aliases.push(alias_field);
            }
        }
        fields.extend(aliases);
        let selection = json!({
            "allowedFields": std::iter::once(json!("id"))
                .chain(std::iter::once(json!("externalKey")))
                .chain(std::iter::once(json!("$version")))
                .chain(fields.iter().map(|field| field["name"].clone()))
                .collect::<Vec<_>>(),
            "minItems": 1,
            "uniqueItems": true,
            "resultProvenance": "none"
        });
        let relations: Vec<_> = compiled
            .extras
            .inverse_relations
            .iter()
            .filter(|r| r.owner_model == id)
            .map(|r| json!({"id":r.id,"name":camel(&r.id),"model":r.model,"through":r.through}))
            .collect();
        let constraints = compiled
            .extras
            .constraints
            .iter()
            .filter(|constraint| constraint.model == id)
            .collect::<Vec<_>>();
        let mut operations: Vec<_> = ["create", "get", "list", "update", "delete", "count", "countBy", "aggregate", "history"].iter().map(|verb| {
            let result = match *verb {
                "get" => json!({"kind":"record_or_null","model":id}),
                "list" => json!({"kind":"record_array","model":id}),
                "count" => json!({"kind":"decimal_integer_string","model":id}),
                "aggregate" => json!({"kind":"bounded_aggregate","model":id,"keyType":"group_field_read_value_tuple","metricType":"decimal_string_or_null"}),
                "countBy" => json!({"kind":"bounded_group_counts","model":id,"valueType":"group_field_read_value","countType":"decimal_integer_string"}),
                "history" => json!({"kind":"field_history_array","model":id}),
                _ => json!({"kind":"audited_change_set_receipt","model":id}),
            };
            json!({
            "id":format!("{id}.{verb}"), "name":format!("{symbol}.{verb}"),
            "description":format!("{verb} {} using the canonical audited data lifecycle{}",model["label"].as_str().unwrap_or(id),match *verb { "update" | "delete" => "; options.ifVersion accepts the selected $version and a mismatch returns version_conflict", _ => "" }),
            "permission":format!("{id}.{}",if *verb == "countBy" { "count" } else { verb }), "exposed":false,
            "lifecycleEffect": match *verb { "create"=>"reserve_new_identity_and_append_mainline_assertion", "update"=>"append_assertion_to_existing_identity", "delete"=>"append_audited_tombstone", _=>"none" },
            "constraints":constraints,
            "input":{"operation":verb,"model":id,"fields":fields.iter().map(|f|f["name"].clone()).collect::<Vec<_>>(),"select":if ["get","list"].contains(verb) {selection.clone()} else {Value::Null},"options":match *verb { "update" | "delete" => json!({"ifVersion":{"type":"uuid","source":"$version","optional":true,"existingRecordOnly":true,"mainlineOnly":true}}), _ => Value::Null },"trustedContext":"server_only"}, "result":result,
            "errors":match *verb { "aggregate" => json!(["contract_validation_failed","authorization_denied","forbidden","schema_drift","query_rejected"]), "update" | "delete" => json!(["contract_validation_failed","record_target_missing","unique_field_conflict","version_conflict","forbidden","schema_drift"]), _ => json!(["contract_validation_failed","record_target_missing","unique_field_conflict","forbidden","schema_drift"]) },
            "errorContracts":match *verb { "update" | "delete" => json!({"version_conflict":{"message":"This record has changed. Reload and try again.","details":"empty"}}), _ => Value::Null },
            "example":format!("operations.{symbol}.{verb}({})",match *verb { "create" => "values, options", "update" => "recordOrId, changes, options", "delete" => "recordOrId, options", _ => "input" }),
            "arguments":match *verb { "create" => json!(["values","options"]), "update" => json!(["recordOrId","changes","options"]), "delete" => json!(["recordOrId","options"]), _ => json!(["input"]) },
            "idempotency":if ["create","update","delete"].contains(verb) {"required"} else {"not_applicable"}
        })}).collect();
        for relation in &relations {
            operations.push(json!({
                "id":format!("{id}.relations.{}.list",relation["id"].as_str().unwrap()),
                "name":format!("{symbol}.relations.{}.list",relation["name"].as_str().unwrap()),
                "description":format!("List related {} records through {}",relation["model"],relation["through"]),
                "permission":if policy_enabled {
                    format!("{id}.relations.{}.list",relation["id"].as_str().unwrap())
                } else {
                    format!("{}.list",relation["model"].as_str().unwrap())
                },
                "exposed":false,"lifecycleEffect":"none",
                "input":{"id":"owner_record_uuid","asOf":"calendar_date","query":"bounded_target_model_query","select":Value::Null},
                "result":{"kind":"record_array","model":relation["model"]},
                "errors":["contract_validation_failed","authorization_denied","schema_drift"],
                "example":format!("operations.{symbol}.relations.{}.list({{ id: \"00000000-0000-0000-0000-000000000001\", asOf: \"2026-09-15\" }})",relation["name"].as_str().unwrap())
            }));
        }
        docs.push_str(&format!(
            "## {} (`{symbol}`)\n\n",
            model["label"].as_str().unwrap_or(id)
        ));
        for operation in &operations {
            let example = operation["example"]
                .as_str()
                .ok_or("generated operation example must be a string")?;
            docs.push_str(&format!(
                "- `{}`: {}. Example: `{}`.\n",
                operation["name"].as_str().unwrap(),
                operation["description"].as_str().unwrap(),
                example
            ));
        }
        let form_fields = fields
            .iter()
            .filter(|field| field["readOnly"] != true && field["lifecycle"] != "retired")
            .map(|field| field["name"].clone())
            .collect::<Vec<_>>();
        let form_example = form_fields
            .first()
            .cloned()
            .unwrap_or_else(|| json!("field"));
        models.push(json!({"id":id,"name":symbol,"aliases":model_aliases,"kind":model["kind"],"label":model["label"],"display_field_id":model["display_field_id"],"fields":fields,"form":{"method":"parseForm","modes":["create","update"],"fieldTypes":{"create":create_field_type,"update":update_field_type},"allowedFields":form_fields,"allowlist":{"minItems":1,"uniqueItems":true,"rejectsUnknownOrReadOnly":true},"controls":{"onePerSelectedField":true,"composites":"single_json_control","rejectsFile":true},"clear":{"prefix":"clear:","value":"true","updateOptionalSelectedOnly":true,"rejectsValueConflict":true},"errorMapping":{"method":"toFormError","allowlist":"same_writable_selected_fields","codes":["invalid_input","conflict","constraint_violation","forbidden"],"constraintIdentity":"authoritative_declared_constraint_with_exact_referencedFieldIds","unknownOrMalformed":"undefined","diagnostics":"never_exposed"},"authorization":"none","persistence":"none","example":format!("operations.{symbol}.parseForm(form, {{ fields: [{form_example}] as const, mode: \"create\" }})" )},"relations":relations,"operations":operations,"extensions":model["extensions"],"many_relations":model["many_relations"]}));
    }
    let selection_by_model = models
        .iter()
        .map(|model| {
            let allowed_fields = std::iter::once(json!("id"))
                .chain(std::iter::once(json!("externalKey")))
                .chain(std::iter::once(json!("$version")))
                .chain(
                    model["fields"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|field| field["name"].clone()),
                )
                .collect::<Vec<_>>();
            (
                model["id"].as_str().unwrap().to_owned(),
                json!({"allowedFields":allowed_fields,"minItems":1,"uniqueItems":true,"resultProvenance":"none"}),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for model in &mut models {
        for operation in model["operations"].as_array_mut().into_iter().flatten() {
            if operation["id"]
                .as_str()
                .is_some_and(|id| id.contains(".relations.") && id.ends_with(".list"))
            {
                let target = operation["result"]["model"].as_str().unwrap();
                operation["input"]["select"] = selection_by_model
                    .get(target)
                    .ok_or_else(|| format!("unknown inverse relation target model: {target}"))?
                    .clone();
            }
        }
    }
    let mut capabilities = json!({"versionPreconditions": true, "workSessions": true});
    let authorization = if policy_enabled {
        capabilities["authorization"] = json!(true);
        docs.push_str("## Authorization policy contract\n\nPolicy-enabled operations require the current trusted actor membership and role grants. Field grants are evaluated for each matching record predicate before filtering, ordering, grouping, pagination, or history output. History uses the current policy against each temporal image and returns all-or-error.\n\nGenerated CRUD, selected queries, aggregate queries, inverse relation lists, and history are supported. Legacy raw SQL or prepared-query access, native request endpoints, draft approval/read/discard or revert lifecycle operations, lookup lifecycle/hydration/reference-count endpoints, and agent-run endpoints are explicitly unsupported while a policy is active.\n\n");
        json!({
            "version": 1,
            "membership": {"required": true, "identity": "exact_principal_app_customer_actor_role", "roles": "current_active_memberships"},
            "grants": {"fieldEvaluation": "per_matching_record_predicate", "recordPredicates": ["all", "actor_equals_field"], "history": "current_policy_all_or_error_temporal_images"},
            "supported": ["create", "get", "list", "update", "delete", "count", "countBy", "aggregate", "history", "relation_list", "work_sessions"],
            "unsupported": [
                "legacy_raw_sql", "legacy_prepared_query", "legacy_external_key_write_subjects", "native_request_endpoints",
                "draft_lifecycle", "revert_lifecycle", "lookup_lifecycle",
                "lookup_hydration", "lookup_reference_count", "agent_run_endpoints"
            ]
        })
    } else {
        Value::Null
    };
    docs.push_str("## Working sessions\n\n`operations.workSessions.request(input)` calls the compiler-owned `kernel_work_session` entrypoint. The discriminated request covers sessions, duplication, staging, rules, threads, proposals, and Save. Edits (`stage`, `unstage`, `discard_source`, `discard_turn` and `update`) are last-write-wins: they supply only `session_id` and take no `expected_revision` or `request_id`. Every other mutation supplies `session_id`, `expected_revision`, and replay-safe `request_id`; create and duplicate use revision zero. Mutations answer with the new `revision` and only the entries, targets and objects they touched or produced; only get returns the session. A replayed request answers in the same shape from current state without repeating its effect. `helpers.workSession(input)` builds the same scoped wire request without executing it. Sessions are owner-only platform working state, outside business history. A session holds one overlay: one staged entry per record field with its provenance; a scenario is a duplicated session. Humans and agents change any staged entry; an entry an agent overwrites keeps the human's value as `replaced` for restore. A human unstages any entry; an agent never removes a person's edit: it may not unstage a person's entry, unstaging its own entry restores a person's value it replaced, and its change back to the saved value over a person's entry stays staged with the person's value as `replaced`. Rules skip fields holding a manual edit. Rules are derived expressions (`value`, optional boolean `condition`, typed `parameters`) with derived-field arithmetic; rule responses report `overlaps` where another rule already held a field. List returns headers; get returns staged changes, rules and threads under current authorization, and `get` with `overlay: false` returns the header, rules and threads without the staged changes. `entries` reads staged changes in key-ordered pages (`limit` 1-1000, default 200; optional `model_id`, `source`, `turn_id` and `after`), omits changes a fresh authorized read would not show, and answers with `revision`, `has_more` and `next`, the last returned key. A context marked as agent (`kernel.actor_kind = 'agent'`) is an agent whatever its membership says, never writes canonical data, and stamps its staged changes with its `kernel.turn_id`; `discard_turn` removes one turn's staged changes. `list`, `aggregate`, `count`, and `countBy` accept `work: { sessionId }`; the existing `kernel_data_query` applies those staged values before filters and metrics. Wire requests use `work: { session_id }`. Save, pull and dismiss act on what the expected revision identifies; Save rejects agent actors, requires confirmation of stale and gone entries, and always creates one draft change set through ordinary apply; an approver publishes it through draft approval, a separate human act. A confirmed all-gone Save clears the overlay, performs no canonical write, and returns `change_set: null`. Under a declared authorization policy Save is refused without changing the overlay (policy-aware drafts are a follow-up). Staged entries and proposals retain the trusted author principal and actor kind separately from session ownership. No application consumes sessions automatically.\n\n");
    let static_ids = json!({
        "models": schema["models"].as_array().ok_or("missing models")?.iter().map(|model| model["id"].as_str().ok_or("missing model id").map(str::to_string)).collect::<Result<Vec<_>, _>>()?,
        "fields": static_fields,
        "enumOptions": static_options,
        "changeTypes": schema["change_types"].as_array().ok_or("missing change types")?.iter().map(|change| change["id"].as_str().ok_or("missing change type id").map(str::to_string)).collect::<Result<Vec<_>, _>>()?,
        "constraints": compiled.extras.constraints.iter().map(|constraint| constraint.id.as_str()).collect::<Vec<_>>()
    });
    let mut manifest = json!({"formatVersion":1,"appId":schema["app_id"],"schemaVersion":schema["version"],"models":models,"staticIds":static_ids,
        "writeApiVersion":2,"capabilities":capabilities,"authorization":authorization,"relationInputs":["generated_record","pending_create_in_same_batch","canonical_record_key"],
        "customFields":active_custom_fields,"constraints":constraints,
        "limits":{"pageSize":100,"defaultPageSize":50,"maxOffset":10000,"filters":20,"orderFields":5,"groups":100,"batchSize":100,"payloadBytes":1048576},
        "operators":["eq","ne","lt","lte","gt","gte","contains","isNull"],
        "derivedFields":compiled.extras.derived_fields,
        "unsupportedCapabilities":["restore","draft","revert","schema_administration"]});
    if manifest["authorization"].is_null() {
        manifest
            .as_object_mut()
            .expect("operation manifest object")
            .remove("authorization");
    }
    if let Some(compatibility) = predecessor::compatibility(compiled, predecessors) {
        manifest["predecessorCompatibility"] = compatibility;
    }
    let literal = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    let mut typescript = format!(
        r#"// Generated by schema-compiler. Do not edit.
import {{ createDataClient, type DataContext, type DataDefinition, type ModelCreateField, type ModelRecord, type ModelUpdateField }} from "@autograph/generated-app-runtime/data";
import {{ createArtifactHelpers, type RuntimeModelId, type RuntimeFieldId, type RuntimeRecordId, type RuntimeSchemaRevisionId, type KernelResult, type KernelError }} from "@autograph/generated-app-runtime/artifact-helpers";
export const definition = {literal} as const satisfies DataDefinition;
export function createOperations(context: DataContext) {{ return createDataClient(definition, context); }}
export const ids = definition.staticIds;
export const helpers = createArtifactHelpers(definition);
export type ModelId = typeof ids.models[number];
export type FieldId<M extends ModelId> = typeof ids.fields[M][number];
export type ChangeTypeId = typeof ids.changeTypes[number];
export type ConstraintId = typeof ids.constraints[number];
export type {{ RuntimeModelId, RuntimeFieldId, RuntimeRecordId, RuntimeSchemaRevisionId, KernelResult, KernelError }};
"#
    );
    docs.push_str("## Typed client reference\n\n`ids` exposes CUE-known model, field, enum-option, change-type, and constraint IDs as literal values. `ModelId`, `FieldId<M>`, `ChangeTypeId`, and `ConstraintId` are derived from the same checked artifact. `helpers.recordId` validates and brands a runtime-discovered UUID; `helpers.runtimeModelId` and `helpers.runtimeFieldId` brand IDs discovered from an active tenant schema, which are distinct from static CUE IDs. `helpers.schemaRevisionId` brands a positive decimal revision after validation. `helpers.value` builds tagged scalar and relation values, and `helpers.runtimeValue` combines runtime IDs with a tagged value. `helpers.dataQuery` and `helpers.schemaAdmin` build JSON requests for the generated PostgreSQL functions without executing them; the caller must use the appropriate runtime or schema-admin principal. `KernelResult<T>` and `KernelError` describe the `{ ok, data }` or `{ ok, error }` response envelope. PostgreSQL performs authoritative validation.\n\n```ts\nconst model = ids.models[0];\nconst request = helpers.dataQuery({ kind: \"list\", model_id: model, customer_id: \"tenant\", as_of: \"2026-09-28\", limit: 20 });\nconst record = helpers.recordId(\"00000000-0000-0000-0000-000000000001\");\nconst tagged = helpers.value.relation(record);\n// Pass requests to the server-side generated PostgreSQL transport.\n```\n\nSchema administration is a separate capability: `helpers.schemaAdmin.dryRunTenantSchemaRevision(input)` and `helpers.schemaAdmin.commitTenantSchemaRevision(input)` build requests for `kernel_dry_run_tenant_schema_revision` and `kernel_commit_tenant_schema_revision`. They do not grant schema-admin authorization. Both require the active revision/hash, actor, reason, idempotency key, and typed operations supplied by an authorized admin flow.\n\n");
    for model in manifest["models"].as_array().unwrap() {
        let name = model["name"].as_str().unwrap();
        let title = model_record_type(name);
        typescript.push_str(&format!(
            "/** Schema-derived {} record. Decimal values remain strings; identity is a canonical UUID. */\nexport type {title} = ModelRecord<typeof definition, {}>;\n",
            model["label"].as_str().unwrap_or(name).replace("*/", "* /"), model["id"]
        ));
        typescript.push_str(&format!(
            "/** Writable {} fields accepted by create and parseForm. */\nexport type {title}CreateField = ModelCreateField<typeof definition, {}>;\n/** Writable {} fields accepted by update and parseForm. */\nexport type {title}UpdateField = ModelUpdateField<typeof definition, {}>;\n",
            model["label"].as_str().unwrap_or(name).replace("*/", "* /"),
            model["id"],
            model["label"].as_str().unwrap_or(name).replace("*/", "* /"),
            model["id"],
        ));
    }
    Ok(json!({"manifest":manifest,"typescript":typescript,"documentation":docs}))
}

fn camel(id: &str) -> String {
    let mut result = String::new();
    let mut upper = false;
    for c in id.chars() {
        if c == '_' || c == '-' || c.is_whitespace() {
            upper = true;
        } else {
            result.push(if upper { c.to_ascii_uppercase() } else { c });
            upper = false;
        }
    }
    result
}

fn model_record_type(symbol: &str) -> String {
    let mut characters = symbol.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    first.to_uppercase().collect::<String>() + characters.as_str()
}

fn model_symbol(id: &str) -> String {
    let symbol = camel(id);
    if symbol == "apply" {
        "modelApply".into()
    } else if symbol == "workSessions" {
        "modelWorkSessions".into()
    } else {
        symbol
    }
}

fn valid_public_field_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !matches!(name, "__proto__" | "constructor" | "prototype")
}
