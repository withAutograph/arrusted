use kernel::{
    connect_postgres, AppId, ChangeType, ChangeTypeId, CustomFieldDefinition,
    CustomFieldDefinitionId, CustomFieldType, CustomerId, EnumOption, EnumOptionId, Field, FieldId,
    FieldType, Model, ModelId, ModelKind, Schema, SchemaVersion,
};
use schema_compiler::{
    compile_sql_artifact_manifest, render_sql_artifact_bundle, CompiledManifest,
    NormalizedManifestExtras, SqlArtifactKind,
};
use serde_json::{json, Value};
use uuid::Uuid;

macro_rules! install_fixture {
    () => {{
        match std::env::var("KERNEL_TEST_DATABASE_URL") {
            Err(std::env::VarError::NotPresent) => {
                eprintln!("skipping generated draft SQL test: KERNEL_TEST_DATABASE_URL is absent");
                None
            }
            Err(error) => panic!("KERNEL_TEST_DATABASE_URL is invalid: {error}"),
            Ok(database_url) => {
                let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
                let bundle = render_sql_artifact_bundle(&manifest);
                let mut client = connect_postgres(&database_url).expect("connect to PostgreSQL");
                let schema_name = format!("kernel_drafts_{}", Uuid::new_v4().simple());
                client
                    .batch_execute(&format!(
                        "create schema \"{schema_name}\"; set search_path to \"{schema_name}\"; {bundle}"
                    ))
                    .expect("install generated bundle");
                let schema_json = serde_json::to_value(&compiled_schema().schema).unwrap();
                let revision_id: i64 = client
                    .query_one(
                        "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values('draft_app','tenant_a','fixture',$1,'{}',$1,now()) returning id",
                        &[&schema_json],
                    )
                    .expect("insert tenant A revision")
                    .get(0);
                client
                    .execute(
                        "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values('draft_app','tenant_b','fixture',$1,'{}',$1,now())",
                        &[&schema_json],
                    )
                    .expect("insert tenant B revision");
                client
                    .batch_execute("do $$ begin execute format('grant %I to %I', kernel_installer_capability_role('runtime'), session_user); end $$; set kernel.actor_id='draft-reviewer'")
                    .expect("grant draft fixture runtime capability and bind trusted actor");
                for customer in ["tenant_a", "tenant_b"] {
                    for (function, binding) in [
                        ("kernel_bind_principal_scope", json!({"capability":"runtime","app_id":"draft_app","customer_id":customer})),
                        ("kernel_bind_actor_membership", json!({"app_id":"draft_app","customer_id":customer,"actor_id":"draft-reviewer","actor_kind":"human","role":"reviewer"})),
                    ] {
                        let principal: String = client.query_one("select session_user::text", &[]).unwrap().get(0);
                        let mut binding = binding;
                        binding["principal_name"] = json!(principal);
                        let result: Value = client.query_one(&format!("select {function}($1::jsonb)"), &[&binding]).unwrap().get(0);
                        assert_eq!(result["ok"], true, "{result}");
                    }
                }
                Some((client, schema_name, revision_id))
            }
        }
    }};
}

macro_rules! call_sql {
    ($client:expr, $function:literal, $request:expr) => {{
        let mut request = $request;
        if matches!(
            $function,
            "kernel_apply_change_set"
                | "kernel_approve_draft_change_set"
                | "kernel_revert_change_set"
        ) && request.get("actor_id").is_none()
        {
            request["actor_id"] = json!("draft-reviewer");
        }
        $client
            .query_one(concat!("select ", $function, "($1::jsonb)"), &[&request])
            .map(|row| row.get::<_, Value>(0))
    }};
}

macro_rules! insert_change_set {
    ($client:expr, $revision:expr, $customer:expr, $created_mode:expr, $status:expr, $created:expr, $applied:expr) => {{
        let created_order: i64 = $created;
        let applied_order: Option<i64> = $applied;
        $client
            .query_one(
                "insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,created_order,applied_order,applied_at) values('draft_app',$1,$2,$3,$4,'fixture',$5,$6,case when $4='mainline' then now() else null end) returning id",
                &[&$customer, &$revision, &$created_mode, &$status, &created_order, &applied_order],
            )
            .unwrap()
            .get::<_, i64>(0)
    }};
}

macro_rules! insert_record {
    ($client:expr, $id:expr, $key:expr) => {{
        $client
            .execute(
                "insert into company_record(id,app_id,customer_id,external_key) values($1,'draft_app','tenant_a',$2)",
                &[&$id, &$key],
            )
            .unwrap();
    }};
}

macro_rules! insert_version {
    ($client:expr, $record:expr, $change_set:expr, $stage:expr, $start:expr, $end:expr, $name:expr) => {{
        $client
            .execute(
                "insert into company_version(id,record_id,app_id,customer_id,stage,effective_start,effective_end,change_set_id,applied_at,name) values($1,$2,'draft_app','tenant_a',$3,$4::text::date,$5::text::date,$6,case when $3='mainline' then now() else null end,$7)",
                &[&Uuid::new_v4(), &$record, &$stage, &$start, &$end, &$change_set, &$name],
            )
            .unwrap();
    }};
}

fn compiled_schema() -> CompiledManifest {
    let field = |id: &str, field_type: FieldType| Field {
        id: FieldId::from(id),
        label: id.to_string(),
        field_type,
        required: false,
        is_unique: false,
        target_model: None,
        option_set: vec![],
        ..Default::default()
    };
    let mut name = field("name", FieldType::Text);
    name.required = true;
    name.is_unique = true;
    let mut parent = field("parent", FieldType::Relation);
    parent.target_model = Some(ModelId::from("company"));
    let mut status = field("status", FieldType::Enum);
    status.option_set = vec![EnumOption {
        id: EnumOptionId::from("active"),
        label: "Active".to_string(),
        aliases: vec![],
        ..Default::default()
    }];
    CompiledManifest {
        schema: Schema {
            app_id: AppId::from("draft_app"),
            customer_id: CustomerId::from("tenant_a"),
            version: SchemaVersion::from("2026-08-04"),
            models: vec![
                Model {
                    id: ModelId::from("company"),
                    kind: ModelKind::Entity,
                    label: "Company".to_string(),
                    fields: vec![
                        name,
                        field("score", FieldType::Number),
                        field("active", FieldType::Bool),
                        field("founded", FieldType::Date),
                        field("observed_at", FieldType::Datetime),
                        parent,
                        field("tags", FieldType::TextList),
                        field("payload", FieldType::Json),
                        status,
                        field("rate", FieldType::MoneyRate),
                    ],
                    ..Default::default()
                },
                Model {
                    id: ModelId::from("employee"),
                    kind: ModelKind::Entity,
                    label: "Employee".to_string(),
                    fields: vec![
                        Field {
                            required: true,
                            ..field("name", FieldType::Text)
                        },
                        Field {
                            target_model: Some(ModelId::from("company")),
                            ..field("employer", FieldType::Relation)
                        },
                    ],
                    extensions: kernel::EntityExtensionCapabilities {
                        typed_custom_fields: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            ],
            custom_fields: vec![CustomFieldDefinition {
                id: CustomFieldDefinitionId::from("employee_home_company"),
                model_id: ModelId::from("employee"),
                field_id: FieldId::from("home_company"),
                label: "Home Company".to_string(),
                field_type: CustomFieldType::Relation,
                target_model_id: Some(ModelId::from("company")),
                option_set: vec![],
                archived_at: None,
                ..Default::default()
            }],
            change_types: vec![ChangeType {
                id: ChangeTypeId::from("company_update"),
                label: "Company update".to_string(),
                target_model: ModelId::from("company"),
                is_import_default: true,
                touches: vec![],
                required: vec![],
            }],
        },
        extras: NormalizedManifestExtras {
            model_metadata: vec![],
            field_metadata: vec![],
            inverse_relations: vec![],
            many_relations: vec![],
            constraints: vec![],
            derived_fields: vec![],
            authorization_policy: None,
            seed_change_sets: vec![],
        },
    }
}

#[test]
fn draft_runtime_artifacts_are_family_scoped_and_use_shared_canonical_json() {
    let manifest = compile_sql_artifact_manifest(&compiled_schema()).unwrap();
    let functions = manifest
        .artifacts
        .iter()
        .filter(|artifact| artifact.kind == SqlArtifactKind::Function)
        .collect::<Vec<_>>();
    for name in [
        "kernel_list_draft_change_sets(jsonb)",
        "kernel_read_draft_change_set(jsonb)",
        "kernel_update_draft_notes(jsonb)",
        "kernel_discard_draft_change_set(jsonb)",
        "kernel_approve_draft_change_set(jsonb)",
        "kernel_revert_change_set(jsonb)",
    ] {
        let function = functions
            .iter()
            .find(|artifact| artifact.name == name)
            .unwrap_or_else(|| panic!("missing {name}"));
        let body = if name == "kernel_list_draft_change_sets(jsonb)"
            || name == "kernel_read_draft_change_set(jsonb)"
        {
            function
        } else {
            let operation = name.trim_end_matches("(jsonb)");
            assert!(function.sql.contains(&format!(
                "kernel_http_mutation_guard(request,'{operation}')"
            )));
            let body_name = format!(
                "kernel_http_body_{}",
                operation.trim_start_matches("kernel_")
            );
            assert_eq!(
                function
                    .sql
                    .matches(&format!("{body_name}(request)"))
                    .count(),
                1
            );
            functions
                .iter()
                .find(|artifact| artifact.name == format!("{body_name}(jsonb)"))
                .unwrap_or_else(|| panic!("missing private draft body for {name}"))
        };
        assert!(body.sql.contains("kernel_draft_ok"));
        assert!(body.sql.contains("kernel_draft_error"));
    }
    let helper = functions
        .iter()
        .find(|artifact| artifact.name == "kernel_draft_runtime_helpers")
        .expect("draft helper artifact");
    assert!(!helper.sql.contains("kernel_draft_canonical_json"));
    assert!(helper.sql.contains("kernel_canonical_json"));
    let approval = functions
        .iter()
        .find(|artifact| artifact.name == "kernel_http_body_approve_draft_change_set(jsonb)")
        .expect("private draft approval preserves serialization contract");
    assert!(approval
        .sql
        .contains("when serialization_failure then raise;"));
}

#[test]
fn generated_draft_approval_rethrows_every_serialization_failure() {
    let Some((mut client, schema_name, revision_id)) = install_fixture!() else {
        return;
    };
    let record_id = Uuid::new_v4();
    insert_record!(client, record_id, "approval-40001");
    let draft_id = insert_change_set!(
        client,
        revision_id,
        "tenant_a",
        "draft",
        "draft",
        1,
        None::<i64>
    );
    insert_version!(
        client,
        record_id,
        draft_id,
        "draft",
        "2026-08-01",
        None::<&str>,
        "Approval 40001"
    );
    client
        .batch_execute(
            r#"
            create function reject_draft_approval_with_40001()
            returns trigger language plpgsql as $$
            declare failure_message text;
            begin
              failure_message := current_setting('kernel.test_40001_message');
              raise exception using errcode='40001', message=failure_message;
            end
            $$;
            create trigger reject_draft_approval_with_40001
            before update on change_set
            for each row
            when (old.status='draft' and new.status='mainline')
            execute function reject_draft_approval_with_40001();
            "#,
        )
        .unwrap();

    let request = json!({
        "app_id":"draft_app",
        "customer_id":"tenant_a",
        "actor_id":"draft-reviewer",
        "change_set_id":draft_id
    });
    for message in [
        "record apply dependency drift",
        "unrelated serialization failure",
    ] {
        client
            .query_one(
                "select set_config('kernel.test_40001_message',$1,false)",
                &[&message],
            )
            .unwrap();
        let error = client
            .query_one(
                "select kernel_approve_draft_change_set($1::jsonb)",
                &[&request],
            )
            .unwrap_err();
        let database_error = error.as_db_error().unwrap();
        assert_eq!(database_error.code().code(), "40001");
        assert_eq!(database_error.message(), message);
        let status: String = client
            .query_one("select status from change_set where id=$1", &[&draft_id])
            .unwrap()
            .get(0);
        assert_eq!(status, "draft");
    }

    client
        .batch_execute(&format!("drop schema \"{schema_name}\" cascade"))
        .expect("drop fixture");
}

#[test]
fn generated_draft_crud_preserves_typed_rows_scope_status_and_rollback() {
    let Some((mut client, schema_name, revision_id)) = install_fixture!() else {
        return;
    };
    let result = (|| {
        let record_id = Uuid::new_v4();
        let draft_id = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "draft",
            "draft",
            10,
            None::<i64>
        );
        insert_record!(client, record_id, "acme");
        client.execute(
            r#"insert into company_version(
              id,record_id,app_id,customer_id,stage,effective_start,change_set_id,
              name,score,active,founded,observed_at,tags,payload,status,
              rate_amount,rate_currency,rate_period
            ) values($1,$2,'draft_app','tenant_a','draft','2026-05-01',$3,
              'Acme','12.50',true,'2020-01-02','2026-05-01T12:30:00Z',array['a','b'],
              '{"source":"test"}','active','100.25','USD','hourly')"#,
            &[&Uuid::new_v4(), &record_id, &draft_id],
        )?;

        let listed = call_sql!(
            client,
            "kernel_list_draft_change_sets",
            json!({"app_id":"draft_app","customer_id":"tenant_a"})
        )?;
        assert_eq!(listed["data"][0]["id"], draft_id);
        let read = call_sql!(
            client,
            "kernel_read_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":draft_id})
        )?;
        let values = &read["data"][0]["values"];
        assert_eq!(values["name"], json!({"type":"text","value":"Acme"}));
        assert_eq!(values["score"], json!({"type":"number","value":"12.50"}));
        assert_eq!(
            values["tags"],
            json!({"type":"text_list","value":["a","b"]})
        );
        assert_eq!(
            values["payload"],
            json!({"type":"json","value":{"source":"test"}})
        );
        assert_eq!(
            values["rate"],
            json!({"type":"money_rate","value":{"amount":"100.25","currency":"USD","period":"hourly"}})
        );

        let isolated = call_sql!(
            client,
            "kernel_read_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_b","change_set_id":draft_id})
        )?;
        assert_error(
            &isolated,
            "record_target_missing",
            &format!("change_set `{draft_id}` did not resolve"),
        );
        assert_eq!(
            call_sql!(
                client,
                "kernel_update_draft_notes",
                json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":draft_id,"notes":"reviewed"})
            )?,
            json!({"ok":true,"data":null})
        );
        let discarded = call_sql!(
            client,
            "kernel_discard_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":draft_id})
        )?;
        assert_eq!(
            call_sql!(
                client,
                "kernel_discard_draft_change_set",
                json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":draft_id})
            )?,
            discarded
        );
        // The default list holds pending drafts only; `discarded` lists
        // rejected drafts with their notes.
        let pending = call_sql!(
            client,
            "kernel_list_draft_change_sets",
            json!({"app_id":"draft_app","customer_id":"tenant_a"})
        )?;
        assert_eq!(pending, json!({"ok":true,"data":[]}));
        let rejected = call_sql!(
            client,
            "kernel_list_draft_change_sets",
            json!({"app_id":"draft_app","customer_id":"tenant_a","status":"discarded"})
        )?;
        assert_eq!(rejected["data"].as_array().unwrap().len(), 1);
        assert_eq!(rejected["data"][0]["id"], draft_id);
        assert_eq!(rejected["data"][0]["notes"], "reviewed");
        let other_tenant = call_sql!(
            client,
            "kernel_list_draft_change_sets",
            json!({"app_id":"draft_app","customer_id":"tenant_b","status":"discarded"})
        )?;
        assert_eq!(other_tenant, json!({"ok":true,"data":[]}));
        let invalid_status = call_sql!(
            client,
            "kernel_list_draft_change_sets",
            json!({"app_id":"draft_app","customer_id":"tenant_a","status":"mainline"})
        )?;
        assert_eq!(
            invalid_status["error"]["code"],
            "contract_validation_failed"
        );
        let invalid = call_sql!(
            client,
            "kernel_update_draft_notes",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":draft_id})
        )?;
        assert_error(
            &invalid,
            "draft_status_conflict",
            &format!("cannot update notes for change_set `{draft_id}` with status `discarded`"),
        );
        Ok::<_, Box<dyn std::error::Error>>(())
    })();
    client
        .batch_execute(&format!("drop schema \"{schema_name}\" cascade"))
        .expect("drop fixture");
    result.unwrap();
}

#[test]
fn generated_approval_and_revert_preserve_same_day_order_idempotency_and_atomicity() {
    let Some((mut client, schema_name, revision_id)) = install_fixture!() else {
        return;
    };
    let result = (|| {
        let record_id = Uuid::new_v4();
        insert_record!(client, record_id, "same-day");
        let first = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            1,
            Some(1)
        );
        let second = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            2,
            Some(2)
        );
        let draft = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "draft",
            "draft",
            3,
            None::<i64>
        );
        insert_version!(
            client,
            record_id,
            first,
            "mainline",
            "2026-05-01",
            Some("2026-05-01"),
            "One"
        );
        insert_version!(
            client,
            record_id,
            second,
            "mainline",
            "2026-05-01",
            None::<&str>,
            "Two"
        );
        insert_version!(
            client,
            record_id,
            draft,
            "draft",
            "2026-05-01",
            None::<&str>,
            "Three"
        );
        client.query_one(
            "select setval('change_set_lifecycle_order_seq',100,false)",
            &[],
        )?;
        let approved = call_sql!(
            client,
            "kernel_approve_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":draft})
        )?;
        assert_eq!(approved["data"]["id"], draft, "{approved}");
        let prior_end: Option<chrono::NaiveDate> = client
            .query_one(
                "select effective_end from company_version where change_set_id=$1",
                &[&second],
            )?
            .get(0);
        assert_eq!(prior_end.unwrap().to_string(), "2026-05-01");

        let request = json!({
            "app_id":"draft_app","customer_id":"tenant_a","change_set_id":draft,
            "actor_id":"draft-reviewer","idempotency_key":"revert-three","notes":"undo"
        });
        let reverted = call_sql!(client, "kernel_revert_change_set", request.clone())?;
        assert_eq!(reverted["ok"], true, "{reverted}");
        assert_eq!(
            call_sql!(client, "kernel_revert_change_set", request)?,
            reverted
        );
        let restored_end: Option<chrono::NaiveDate> = client
            .query_one(
                "select effective_end from company_version where change_set_id=$1",
                &[&second],
            )?
            .get(0);
        assert_eq!(restored_end, None);
        let audit = client.query_one(
            "select source_kind,source_ref,actor_id,created_order=applied_order as same_order,request_fingerprint from change_set where id=$1",
            &[&reverted["data"]["id"].as_i64().unwrap()],
        )?;
        assert_eq!(audit.get::<_, String>("source_kind"), "revert");
        assert_eq!(audit.get::<_, String>("source_ref"), draft.to_string());
        assert!(audit.get::<_, bool>("same_order"));
        let fingerprint_input = json!({
            "app_id":"draft_app","customer_id":"tenant_a","schema_revision_id":revision_id,
            "actor_id":"draft-reviewer","source_kind":"revert","source_ref":draft.to_string(),
            "idempotency_key":"revert-three","change_type_id":null,"notes":"undo",
            "mode":"mainline","revert_target_change_set_id":draft
        });
        let expected_fingerprint: String = client
            .query_one(
                "select kernel_canonical_json($1::jsonb)",
                &[&fingerprint_input],
            )?
            .get(0);
        assert_eq!(
            audit.get::<_, String>("request_fingerprint"),
            expected_fingerprint
        );

        let ordinary_approval = call_sql!(
            client,
            "kernel_approve_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":first})
        )?;
        assert_error(
            &ordinary_approval,
            "draft_status_conflict",
            &format!("cannot approve change_set `{first}` with status `mainline`"),
        );

        let relation_target = Uuid::new_v4();
        let relation_source = Uuid::new_v4();
        insert_record!(client, relation_target, "draft-target");
        insert_record!(client, relation_source, "draft-source");
        let relation_draft = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "draft",
            "draft",
            10,
            None::<i64>
        );
        insert_version!(
            client,
            relation_target,
            relation_draft,
            "draft",
            "2026-06-01",
            None::<&str>,
            "Target"
        );
        client.execute(
            "insert into company_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,name,parent) values($1,$2,'draft_app','tenant_a','draft','2026-06-01',$3,'Source',$4)",
            &[&Uuid::new_v4(),&relation_source,&relation_draft,&relation_target],
        )?;
        let relation_approved = call_sql!(
            client,
            "kernel_approve_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":relation_draft})
        )?;
        assert_eq!(
            relation_approved["data"]["id"], relation_draft,
            "{relation_approved}"
        );

        let duplicate_left = Uuid::new_v4();
        let duplicate_right = Uuid::new_v4();
        insert_record!(client, duplicate_left, "duplicate-left");
        insert_record!(client, duplicate_right, "duplicate-right");
        let duplicate_draft = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "draft",
            "draft",
            15,
            None::<i64>
        );
        insert_version!(
            client,
            duplicate_left,
            duplicate_draft,
            "draft",
            "2026-08-01",
            None::<&str>,
            "Duplicate"
        );
        insert_version!(
            client,
            duplicate_right,
            duplicate_draft,
            "draft",
            "2026-08-01",
            None::<&str>,
            "Duplicate"
        );
        let duplicate = call_sql!(
            client,
            "kernel_approve_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":duplicate_draft})
        )?;
        assert_eq!(duplicate["error"]["code"], "unique_field_conflict");
        assert_eq!(duplicate["error"]["details"][0]["message"], "company");
        let duplicate_stages: Vec<String> = client
            .query(
                "select stage from company_version where change_set_id=$1 order by record_id",
                &[&duplicate_draft],
            )?
            .into_iter()
            .map(|row| row.get(0))
            .collect();
        assert_eq!(duplicate_stages, vec!["draft", "draft"]);

        let stale_record = Uuid::new_v4();
        insert_record!(client, stale_record, "stale");
        let stale_draft = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "draft",
            "draft",
            20,
            None::<i64>
        );
        insert_version!(
            client,
            stale_record,
            stale_draft,
            "draft",
            "2026-06-01",
            None::<&str>,
            "Draft"
        );
        let later = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            21,
            Some(21)
        );
        insert_version!(
            client,
            stale_record,
            later,
            "mainline",
            "2026-05-01",
            None::<&str>,
            "Later"
        );
        let stale = call_sql!(
            client,
            "kernel_approve_draft_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":stale_draft})
        )?;
        assert_eq!(stale["error"]["code"], "stale_draft");
        let status: String = client
            .query_one("select status from change_set where id=$1", &[&stale_draft])?
            .get(0);
        assert_eq!(status, "draft");
        let invalid_revert = call_sql!(
            client,
            "kernel_revert_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":stale_draft})
        )?;
        assert_error(
            &invalid_revert,
            "revert_conflict",
            &format!("change_set `{stale_draft}` has status `draft`, not `mainline`"),
        );

        let conflict_record = Uuid::new_v4();
        insert_record!(client, conflict_record, "conflict");
        let target = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            30,
            Some(30)
        );
        let tip = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            31,
            Some(31)
        );
        insert_version!(
            client,
            conflict_record,
            target,
            "mainline",
            "2026-06-01",
            Some("2026-06-30"),
            "Target"
        );
        insert_version!(
            client,
            conflict_record,
            tip,
            "mainline",
            "2026-07-01",
            None::<&str>,
            "Tip"
        );
        let conflict = call_sql!(
            client,
            "kernel_revert_change_set",
            json!({"app_id":"draft_app","customer_id":"tenant_a","change_set_id":target,"idempotency_key":"reject-target"})
        )?;
        assert_eq!(conflict["error"]["code"], "revert_conflict");
        let target_stage: String = client
            .query_one(
                "select stage from company_version where change_set_id=$1",
                &[&target],
            )?
            .get(0);
        assert_eq!(target_stage, "mainline");
        let residue: i64 = client
            .query_one(
                "select count(*) from change_set where idempotency_key='reject-target'",
                &[],
            )?
            .get(0);
        assert_eq!(residue, 0);
        Ok::<_, Box<dyn std::error::Error>>(())
    })();
    client
        .batch_execute(&format!("drop schema \"{schema_name}\" cascade"))
        .expect("drop fixture");
    result.unwrap();
}

#[test]
fn generated_revert_restores_same_day_declared_and_custom_relations() {
    let Some((mut client, schema_name, revision_id)) = install_fixture!() else {
        return;
    };
    let result = (|| {
        let acme_id = Uuid::new_v4();
        let zenith_id = Uuid::new_v4();
        let employee_id = Uuid::new_v4();
        insert_record!(client, acme_id, "acme");
        insert_record!(client, zenith_id, "zenith");
        client.execute(
            "insert into employee_record(id,app_id,customer_id,external_key) values($1,'draft_app','tenant_a','alice')",
            &[&employee_id],
        )?;

        let company_change = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            1,
            Some(1)
        );
        insert_version!(
            client,
            acme_id,
            company_change,
            "mainline",
            "2026-05-01",
            None::<&str>,
            "Acme"
        );
        insert_version!(
            client,
            zenith_id,
            company_change,
            "mainline",
            "2026-05-01",
            None::<&str>,
            "Zenith"
        );

        let first = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            2,
            Some(2)
        );
        let second = insert_change_set!(
            client,
            revision_id,
            "tenant_a",
            "mainline",
            "mainline",
            3,
            Some(3)
        );
        let acme_custom = json!([{
            "field_id":"home_company",
            "type":"relation",
            "value":{"type":"record_id","value":acme_id}
        }]);
        let zenith_custom = json!([{
            "field_id":"home_company",
            "type":"relation",
            "value":{"type":"record_id","value":zenith_id}
        }]);
        client.execute(
            r#"insert into employee_version(
              id,record_id,app_id,customer_id,stage,effective_start,effective_end,
              change_set_id,applied_at,name,employer,custom_fields
            ) values($1,$2,'draft_app','tenant_a','mainline','2026-05-01','2026-05-01',$3,now(),'Alice',$4,$5)"#,
            &[&Uuid::new_v4(), &employee_id, &first, &acme_id, &acme_custom],
        )?;
        client.execute(
            r#"insert into employee_version(
              id,record_id,app_id,customer_id,stage,effective_start,effective_end,
              change_set_id,applied_at,name,employer,custom_fields
            ) values($1,$2,'draft_app','tenant_a','mainline','2026-05-01',null,$3,now(),'Alice',$4,$5)"#,
            &[
                &Uuid::new_v4(),
                &employee_id,
                &second,
                &zenith_id,
                &zenith_custom,
            ],
        )?;
        client.query_one(
            "select setval('change_set_lifecycle_order_seq',100,false)",
            &[],
        )?;

        let reverted = call_sql!(
            client,
            "kernel_revert_change_set",
            json!({
                "app_id":"draft_app",
                "customer_id":"tenant_a",
                "change_set_id":second,
                "idempotency_key":"revert-employee-home-company"
            })
        )?;
        assert_eq!(reverted["ok"], true, "{reverted:#}");

        let restored = client.query_one(
            "select effective_end,employer,custom_fields from employee_version where change_set_id=$1 and stage='mainline'",
            &[&first],
        )?;
        assert_eq!(restored.get::<_, Option<chrono::NaiveDate>>(0), None);
        assert_eq!(restored.get::<_, Uuid>(1), acme_id);
        assert_eq!(restored.get::<_, Value>(2), acme_custom);
        let reverted_stage: String = client
            .query_one(
                "select stage from employee_version where change_set_id=$1",
                &[&second],
            )?
            .get(0);
        assert_eq!(reverted_stage, "reverted");
        Ok::<_, Box<dyn std::error::Error>>(())
    })();
    client
        .batch_execute(&format!("drop schema \"{schema_name}\" cascade"))
        .expect("drop fixture");
    result.unwrap();
}

fn assert_error(value: &Value, code: &str, message: &str) {
    assert_eq!(
        value,
        &json!({"ok":false,"error":{"code":code,"message":message,"details":[]}})
    );
}
