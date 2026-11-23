use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, Utc};
use kernel::{
    AppId, AppliedChangeSet, ApplyChangeSet, ApplyMode, ChangeSetDiff, ChangeSetDiffRequest,
    ChangeType, ChangeTypeId, CustomFieldDefinition, CustomFieldDefinitionId, CustomFieldDiff,
    CustomFieldEntry, CustomFieldType, CustomFieldValue, CustomerId, DraftRecord, EnumOption,
    EnumOptionId, ErrorEnvelope, Field, FieldHistoryEntry, FieldHistoryRequest, FieldId, FieldType,
    FieldValue, KernelError, Model, ModelId, ModelKind, MoneyRatePeriod, MoneyRateValue, RecordId,
    RecordKey, RevertChangeSet, RowVersionWrite, Schema, SchemaElementLifecycle, SchemaRevisionId,
    SchemaVersion, VisibleRecord,
};
use rust_decimal::Decimal;

/// Minimal operation seam shared by Rust-kernel and generated-SQL parity cases.
///
/// Keep scenario fixtures and assertions in this module. Backend adapters should
/// only translate these typed operations to their runtime's public API.
pub trait ParityBackend {
    fn materialize_schema(&mut self, schema: &Schema) -> Result<SchemaRevisionId, KernelError>;

    fn apply_change_set(&mut self, apply: &ApplyChangeSet)
        -> Result<AppliedChangeSet, KernelError>;

    fn validate_change_set_dry_run(
        &mut self,
        apply: &ApplyChangeSet,
    ) -> Result<AppliedChangeSet, KernelError>;

    fn read_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<Vec<DraftRecord>, KernelError>;

    fn approve_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<AppliedChangeSet, KernelError>;

    fn discard_draft_change_set(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        change_set_id: i64,
    ) -> Result<AppliedChangeSet, KernelError>;

    fn revert_change_set(
        &mut self,
        request: &RevertChangeSet,
    ) -> Result<AppliedChangeSet, KernelError>;

    fn read_visible_records(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        model_id: &ModelId,
        as_of: NaiveDate,
    ) -> Result<Vec<VisibleRecord>, KernelError>;

    fn change_set_diff(
        &mut self,
        request: &ChangeSetDiffRequest,
    ) -> Result<ChangeSetDiff, KernelError>;

    fn field_history(
        &mut self,
        request: &FieldHistoryRequest,
    ) -> Result<Vec<FieldHistoryEntry>, KernelError>;

    fn invert_version_created_at(&mut self, change_set_ids: &[i64]);

    fn count_record_subjects(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        subjects: &[(ModelId, RecordId)],
    ) -> i64;

    fn count_change_sets_by_idempotency_key(
        &mut self,
        app_id: &AppId,
        customer_id: &CustomerId,
        idempotency_key: &str,
    ) -> i64;
}

pub fn explicit_new_subject_mainline_uses_exact_uuid_and_resolves_reverse_order_relation(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_explicit_new_mainline";
    let schema = test_schema(customer_id);
    let schema_revision_id = backend
        .materialize_schema(&schema)
        .expect("materialize parity schema");
    let company_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1000").unwrap();
    let employee_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1001").unwrap();

    backend
        .apply_change_set(&ApplyChangeSet {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            schema_revision_id: Some(schema_revision_id),
            actor_id: Some("tester".to_string()),
            source_kind: "test".to_string(),
            source_ref: None,
            idempotency_key: Some("explicit-new-mainline".to_string()),
            change_type_id: None,
            notes: None,
            mode: ApplyMode::Mainline,
            writes: vec![
                explicit_new_write(
                    "employee",
                    employee_id,
                    employee_values("Alice", RecordKey::RecordId(company_id)),
                ),
                explicit_new_write("company", company_id, text_values("Acme")),
            ],
        })
        .expect("apply explicit-new parity change set");

    let companies = backend
        .read_visible_records(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            &ModelId::from("company"),
            date("2026-05-15"),
        )
        .expect("read visible companies");
    let employees = backend
        .read_visible_records(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            &ModelId::from("employee"),
            date("2026-05-15"),
        )
        .expect("read visible employees");

    assert_eq!(companies[0].record_id, company_id);
    assert_eq!(employees[0].record_id, employee_id);
    assert_eq!(
        employees[0].values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(company_id)))
    );
}

pub fn explicit_new_subject_draft_ordering_approval_and_revert_preserve_exact_uuid(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_explicit_new_non_mainline";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize parity schema");
    let company_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1100").unwrap();
    let employee_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1101").unwrap();
    let source_first_writes = vec![
        explicit_new_write(
            "employee",
            employee_id,
            employee_values("Alice", RecordKey::RecordId(company_id)),
        ),
        explicit_new_write("company", company_id, text_values("Acme")),
    ];

    let mut dry_run = mainline_apply(
        customer_id,
        Some("explicit-new-dry-run"),
        source_first_writes.clone(),
    );
    backend
        .validate_change_set_dry_run(&dry_run)
        .expect("validate explicit-new dry run");
    assert!(read_visible(backend, customer_id, "company").is_empty());

    dry_run.mode = ApplyMode::Draft;
    dry_run.idempotency_key = Some("explicit-new-draft-source-first".to_string());
    let source_first = backend
        .apply_change_set(&dry_run)
        .expect_err("source-first draft relation must fail");
    assert_bare_error(
        source_first,
        "record_target_missing",
        format!("record `{company_id}` is not visible as of 2026-05-01"),
    );
    let failed_residue = backend.count_record_subjects(
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &[
            (ModelId::from("company"), company_id),
            (ModelId::from("employee"), employee_id),
        ],
    ) + backend.count_change_sets_by_idempotency_key(
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        "explicit-new-draft-source-first",
    );
    assert_eq!(failed_residue, 0);

    dry_run.writes.reverse();
    dry_run.idempotency_key = Some("explicit-new-draft-target-first".to_string());
    let draft = backend
        .apply_change_set(&dry_run)
        .expect("apply target-first draft");
    let mut records = backend
        .read_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            draft.id,
        )
        .expect("read draft records");
    records.sort_by_key(|record| record.record_id);
    assert_eq!(
        records
            .iter()
            .map(|record| record.record_id)
            .collect::<std::collections::BTreeSet<_>>(),
        std::collections::BTreeSet::from([company_id, employee_id])
    );

    let approved = backend
        .approve_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            draft.id,
        )
        .expect("approve explicit-new draft");
    assert_eq!(approved.id, draft.id);

    let companies = read_visible(backend, customer_id, "company");
    let employees = read_visible(backend, customer_id, "employee");
    assert_eq!(companies[0].record_id, company_id);
    assert_eq!(employees[0].record_id, employee_id);
    assert_eq!(
        employees[0].values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(company_id)))
    );

    backend
        .revert_change_set(&revert_request(
            customer_id,
            approved.id,
            Some("explicit-new-draft-revert"),
        ))
        .expect("revert approved explicit-new draft");
    assert!(read_visible(backend, customer_id, "company").is_empty());
    assert!(read_visible(backend, customer_id, "employee").is_empty());
    let retained_subjects = backend.count_record_subjects(
        &AppId::from("core_app"),
        &CustomerId::from(customer_id),
        &[
            (ModelId::from("company"), company_id),
            (ModelId::from("employee"), employee_id),
        ],
    );
    assert_eq!(retained_subjects, 2);
}

pub fn explicit_new_subject_can_be_reused_after_draft_discard(backend: &mut impl ParityBackend) {
    let customer_id = "customer_explicit_new_discard";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize parity schema");
    let company_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1150").unwrap();
    let draft = backend
        .apply_change_set(&draft_apply(
            customer_id,
            Some("explicit-new-discard"),
            vec![explicit_new_write(
                "company",
                company_id,
                text_values("Abandoned"),
            )],
        ))
        .expect("apply explicit-new draft");
    backend
        .discard_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            draft.id,
        )
        .expect("discard explicit-new draft");

    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("explicit-new-after-discard"),
            vec![explicit_new_write(
                "company",
                company_id,
                text_values("Accepted"),
            )],
        ))
        .expect("reuse explicit subject after discard");
    let visible = read_visible(backend, customer_id, "company");
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].record_id, company_id);
    assert_eq!(
        visible[0].values.get(&FieldId::from("name")),
        Some(&FieldValue::Text("Accepted".to_string()))
    );
}

pub fn explicit_new_subject_rejects_uuid_collision_and_cross_tenant_relation(
    backend: &mut impl ParityBackend,
) {
    let record_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1200").unwrap();
    backend
        .materialize_schema(&test_schema("customer_explicit_new_a"))
        .expect("materialize first parity schema");
    backend
        .materialize_schema(&test_schema("customer_explicit_new_b"))
        .expect("materialize second parity schema");
    backend
        .apply_change_set(&mainline_apply(
            "customer_explicit_new_a",
            Some("explicit-new-original"),
            vec![explicit_new_write(
                "company",
                record_id,
                text_values("Acme"),
            )],
        ))
        .expect("apply original explicit subject");

    let collision = backend
        .apply_change_set(&mainline_apply(
            "customer_explicit_new_a",
            Some("explicit-new-collision"),
            vec![explicit_new_write(
                "company",
                record_id,
                text_values("Other"),
            )],
        ))
        .expect_err("duplicate explicit subject must fail");
    assert_bare_error(
        collision,
        "record_key_conflict",
        format!("record_id `{record_id}` already exists"),
    );

    let cross_tenant = backend
        .apply_change_set(&mainline_apply(
            "customer_explicit_new_b",
            Some("explicit-new-cross-tenant"),
            vec![explicit_new_write(
                "employee",
                RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1201").unwrap(),
                employee_values("Mallory", RecordKey::RecordId(record_id)),
            )],
        ))
        .expect_err("cross-tenant relation must fail");
    assert_bare_error(
        cross_tenant,
        "record_target_missing",
        format!(
            "record key `{:?}` did not resolve",
            RecordKey::RecordId(record_id)
        ),
    );
}

pub fn explicit_new_subject_planned_visibility_preserves_as_of_date(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_explicit_new_visibility";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize parity schema");
    let company_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1300").unwrap();
    let employee_id = RecordId::parse_str("018f6bf3-1ea5-7812-9a5a-a1f5b04f1301").unwrap();

    let mut employee_before_company = explicit_new_write(
        "employee",
        employee_id,
        employee_values("Alice", RecordKey::RecordId(company_id)),
    );
    employee_before_company.effective_start = date("2026-04-30");
    let before_creation = backend
        .validate_change_set_dry_run(&mainline_apply(
            customer_id,
            Some("explicit-new-before-creation"),
            vec![
                employee_before_company,
                explicit_new_write("company", company_id, text_values("Acme")),
            ],
        ))
        .expect_err("relation cannot precede planned target visibility");
    assert_bare_error(
        before_creation,
        "record_target_missing",
        format!("record `{company_id}` is not visible as of 2026-04-30"),
    );
}

pub fn custom_fields_round_trip_all_supported_types_and_resolve_relations(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_custom_round_trip";
    backend
        .materialize_schema(&custom_fields_schema(customer_id))
        .expect("materialize custom-fields schema");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-company"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                None,
                false,
            )],
        ))
        .expect("apply custom-fields relation target");
    let company_id = read_visible_as_of(backend, customer_id, "company", "2026-05-15")[0].record_id;
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-employee"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey("acme".into()),
                )),
                Some(all_custom_field_entries("acme")),
                false,
            )],
        ))
        .expect("apply all supported custom-field values");

    let visible = read_visible_as_of(backend, customer_id, "employee", "2026-05-15");
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].custom_fields.len(), 9);
    assert_eq!(
        custom_value(&visible[0].custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Al".to_string()))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "score"),
        Some(&CustomFieldValue::Number(Decimal::new(42, 0)))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "remote"),
        Some(&CustomFieldValue::Bool(true))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "start_date"),
        Some(&CustomFieldValue::Date(date("2026-05-01")))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "home_company"),
        Some(&CustomFieldValue::Relation(RecordKey::RecordId(company_id)))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "skills"),
        Some(&CustomFieldValue::TextList(vec![
            "rust".to_string(),
            "sql".to_string()
        ]))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "shirt_size"),
        Some(&CustomFieldValue::Enum(EnumOptionId::from("large")))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "bonus"),
        Some(&CustomFieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(150000, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Annual,
        }))
    );
}

pub fn custom_field_enum_orphan_options_render_null_by_omission(backend: &mut impl ParityBackend) {
    let customer_id = "customer_custom_enum_orphan";
    let schema = custom_fields_schema(customer_id);
    backend
        .materialize_schema(&schema)
        .expect("materialize enum custom-field schema");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-enum-company"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                None,
                false,
            )],
        ))
        .expect("apply enum custom-field relation target");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-enum-employee"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey("acme".into()),
                )),
                Some(vec![custom_field_entry(
                    "shirt_size",
                    CustomFieldValue::Enum(EnumOptionId::from("large")),
                )]),
                false,
            )],
        ))
        .expect("apply enum custom-field value");

    let visible = read_visible_as_of(backend, customer_id, "employee", "2026-05-15");
    assert_eq!(
        custom_value(&visible[0].custom_fields, "shirt_size"),
        Some(&CustomFieldValue::Enum(EnumOptionId::from("large")))
    );

    let mut orphaning_schema = schema;
    orphaning_schema.version = SchemaVersion::from("2026-05-05");
    let shirt_size = orphaning_schema
        .custom_fields
        .iter_mut()
        .find(|definition| definition.field_id == FieldId::from("shirt_size"))
        .expect("shirt_size custom field definition exists");
    shirt_size.option_set = vec![EnumOption {
        id: EnumOptionId::from("small"),
        label: "Small".to_string(),
        aliases: vec![],
        ..Default::default()
    }];
    backend
        .materialize_schema(&orphaning_schema)
        .expect("materialize orphaning enum custom-field schema");

    let visible_after_orphan = read_visible_as_of(backend, customer_id, "employee", "2026-05-15");
    assert_eq!(
        custom_value(&visible_after_orphan[0].custom_fields, "shirt_size"),
        None
    );

    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-enum-later-mainline"),
            vec![row_write(
                "employee",
                "alice",
                "2026-06-01",
                Some(text_values("Alice Updated")),
                None,
                false,
            )],
        ))
        .expect("apply later mainline after orphaning enum option");
    let visible_after_later_write =
        read_visible_as_of(backend, customer_id, "employee", "2026-06-15");
    assert_eq!(
        custom_value(&visible_after_later_write[0].custom_fields, "shirt_size"),
        None
    );

    let draft = backend
        .apply_change_set(&draft_apply(
            customer_id,
            Some("custom-enum-later-draft"),
            vec![row_write(
                "employee",
                "alice",
                "2026-07-01",
                Some(text_values("Alice Draft")),
                None,
                false,
            )],
        ))
        .expect("apply later draft after orphaning enum option");
    let draft_records = backend
        .read_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            draft.id,
        )
        .expect("read enum custom-field draft");
    assert_eq!(
        custom_value(&draft_records[0].custom_fields, "shirt_size"),
        None
    );
}

pub fn custom_fields_reject_missing_and_cross_tenant_relation_targets(
    backend: &mut impl ParityBackend,
) {
    let customer_a = "customer_custom_relation_a";
    let customer_b = "customer_custom_relation_b";
    backend
        .materialize_schema(&custom_fields_schema(customer_a))
        .expect("materialize first custom relation schema");
    backend
        .materialize_schema(&custom_fields_schema(customer_b))
        .expect("materialize second custom relation schema");
    backend
        .apply_change_set(&mainline_apply(
            customer_b,
            Some("custom-cross-tenant-company"),
            vec![row_write(
                "company",
                "other-tenant",
                "2026-05-01",
                Some(text_values("Other Tenant")),
                None,
                false,
            )],
        ))
        .expect("apply cross-tenant custom relation target");

    backend
        .apply_change_set(&mainline_apply(
            customer_a,
            Some("custom-tombstoned-company"),
            vec![row_write(
                "company",
                "tombstoned",
                "2026-05-01",
                Some(text_values("Tombstoned")),
                None,
                false,
            )],
        ))
        .expect("apply custom relation tombstone target");
    let tombstoned_id =
        read_visible_as_of(backend, customer_a, "company", "2026-05-01")[0].record_id;
    backend
        .apply_change_set(&mainline_apply(
            customer_a,
            Some("custom-tombstone-company"),
            vec![row_write(
                "company",
                "tombstoned",
                "2026-05-15",
                None,
                None,
                true,
            )],
        ))
        .expect("tombstone custom relation target");
    let tombstoned = backend
        .apply_change_set(&mainline_apply(
            customer_a,
            Some("custom-tombstoned-relation"),
            vec![row_write(
                "employee",
                "tombstoned-target",
                "2026-05-20",
                Some(text_values("Tombstoned Target")),
                Some(vec![custom_field_entry(
                    "home_company",
                    CustomFieldValue::Relation(RecordKey::ExternalKey("tombstoned".into())),
                )]),
                false,
            )],
        ))
        .expect_err("tombstoned custom relation target must fail");
    assert_bare_error(
        tombstoned,
        "tombstoned_record",
        format!("record `{tombstoned_id}` is tombstoned as of 2026-05-20"),
    );

    for (key, target) in [
        ("custom-missing-relation", "missing"),
        ("custom-cross-tenant-relation", "other-tenant"),
    ] {
        let target_key = RecordKey::ExternalKey(target.into());
        let error = backend
            .apply_change_set(&mainline_apply(
                customer_a,
                Some(key),
                vec![row_write(
                    "employee",
                    key,
                    "2026-05-01",
                    Some(text_values("Alice")),
                    Some(vec![custom_field_entry(
                        "home_company",
                        CustomFieldValue::Relation(target_key.clone()),
                    )]),
                    false,
                )],
            ))
            .expect_err("missing custom relation target must fail");
        assert_bare_error(
            error,
            "record_target_missing",
            format!("record key `{target_key:?}` did not resolve"),
        );
    }

    let missing_key = RecordKey::ExternalKey("missing".into());
    let draft_missing = backend
        .apply_change_set(&draft_apply(
            customer_a,
            Some("custom-draft-missing-relation"),
            vec![row_write(
                "employee",
                "custom-draft-missing-relation",
                "2026-05-01",
                Some(text_values("Draft Missing")),
                Some(vec![custom_field_entry(
                    "home_company",
                    CustomFieldValue::Relation(missing_key.clone()),
                )]),
                false,
            )],
        ))
        .expect_err("missing draft custom relation target must fail");
    assert_bare_error(
        draft_missing,
        "record_target_missing",
        format!("record key `{missing_key:?}` did not resolve"),
    );
}

pub fn custom_fields_follow_draft_approval_discard_and_revert_lifecycle(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_custom_lifecycle";
    backend
        .materialize_schema(&custom_fields_schema(customer_id))
        .expect("materialize custom-field lifecycle schema");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-lifecycle-company"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                None,
                false,
            )],
        ))
        .expect("apply custom-field lifecycle relation target");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-lifecycle-base"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey("acme".into()),
                )),
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Base".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply base custom field");

    let discarded = backend
        .apply_change_set(&draft_apply(
            customer_id,
            Some("custom-lifecycle-discarded"),
            vec![row_write(
                "employee",
                "alice",
                "2026-06-01",
                None,
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Discarded".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply discarded custom-field draft");
    let draft_records = backend
        .read_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            discarded.id,
        )
        .expect("read discarded custom-field draft");
    assert_eq!(
        custom_value(&draft_records[0].custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Discarded".to_string()))
    );
    backend
        .discard_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            discarded.id,
        )
        .expect("discard custom-field draft");
    let after_discard = read_visible_as_of(backend, customer_id, "employee", "2026-06-15");
    assert_eq!(
        custom_value(&after_discard[0].custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Base".to_string()))
    );

    let approved = backend
        .apply_change_set(&draft_apply(
            customer_id,
            Some("custom-lifecycle-approved"),
            vec![row_write(
                "employee",
                "alice",
                "2026-07-01",
                None,
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Approved".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply approved custom-field draft");
    backend
        .approve_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            approved.id,
        )
        .expect("approve custom-field draft");
    let after_approval = read_visible_as_of(backend, customer_id, "employee", "2026-07-15");
    assert_eq!(
        custom_value(&after_approval[0].custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Approved".to_string()))
    );

    backend
        .revert_change_set(&revert_request(
            customer_id,
            approved.id,
            Some("custom-lifecycle-revert"),
        ))
        .expect("revert approved custom-field draft");
    let after_revert = read_visible_as_of(backend, customer_id, "employee", "2026-07-15");
    assert_eq!(
        custom_value(&after_revert[0].custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Base".to_string()))
    );
}

pub fn change_set_diff_covers_custom_field_create_update_projection_and_revert(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_custom_diff";
    backend
        .materialize_schema(&custom_fields_schema(customer_id))
        .expect("materialize custom-field diff schema");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-diff-company"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                None,
                false,
            )],
        ))
        .expect("apply custom-field diff relation target");

    let create = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-diff-create"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey("acme".into()),
                )),
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Base".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply custom-field create diff");
    let create_diff = diff(backend, customer_id, create.id, "nickname");
    assert_eq!(create_diff.records.len(), 1);
    assert_eq!(create_diff.records[0].fields, vec![]);
    assert_eq!(
        create_diff.records[0].custom_fields,
        vec![CustomFieldDiff {
            field_id: FieldId::from("nickname"),
            before: None,
            after: Some(CustomFieldValue::Text("Base".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let no_op = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-diff-noop"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-15",
                None,
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Base".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply custom-field no-op diff");
    let no_op_diff = diff(backend, customer_id, no_op.id, "nickname");
    assert_eq!(no_op_diff.records.len(), 1);
    assert_eq!(no_op_diff.records[0].custom_fields, vec![]);

    let draft = backend
        .apply_change_set(&draft_apply(
            customer_id,
            Some("custom-diff-draft"),
            vec![row_write(
                "employee",
                "alice",
                "2026-06-01",
                None,
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Draft".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply custom-field draft diff");
    let draft_diff = diff(backend, customer_id, draft.id, "nickname");
    assert_eq!(draft_diff.records.len(), 1);
    assert_eq!(draft_diff.records[0].fields, vec![]);
    assert_eq!(
        draft_diff.records[0].custom_fields,
        vec![CustomFieldDiff {
            field_id: FieldId::from("nickname"),
            before: Some(CustomFieldValue::Text("Base".to_string())),
            after: Some(CustomFieldValue::Text("Draft".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let projected_declared_field_diff = diff(backend, customer_id, draft.id, "name");
    assert_eq!(projected_declared_field_diff.records[0].fields, vec![]);
    assert_eq!(
        projected_declared_field_diff.records[0].custom_fields,
        vec![]
    );

    let target = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-diff-target"),
            vec![row_write(
                "employee",
                "alice",
                "2026-07-01",
                None,
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Mainline".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply custom-field target diff");
    let revert = backend
        .revert_change_set(&revert_request(
            customer_id,
            target.id,
            Some("custom-diff-revert"),
        ))
        .expect("revert custom-field target diff");
    let revert_diff = diff(backend, customer_id, revert.id, "nickname");
    assert_eq!(
        revert_diff.records[0].custom_fields,
        vec![CustomFieldDiff {
            field_id: FieldId::from("nickname"),
            before: Some(CustomFieldValue::Text("Mainline".to_string())),
            after: Some(CustomFieldValue::Text("Base".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );

    let tombstone = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-diff-tombstone"),
            vec![row_write(
                "employee",
                "alice",
                "2026-08-01",
                None,
                None,
                true,
            )],
        ))
        .expect("apply custom-field tombstone diff");
    let tombstone_diff = diff(backend, customer_id, tombstone.id, "nickname");
    assert_eq!(tombstone_diff.records.len(), 1);
    assert_eq!(tombstone_diff.records[0].custom_fields, vec![]);
}

pub fn custom_fields_omit_inherit_and_archived_definitions_stop_carrying_forward(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_custom_inherit";
    let mut active_schema = custom_fields_schema(customer_id);
    let old_code = active_schema
        .custom_fields
        .iter_mut()
        .find(|definition| definition.field_id == FieldId::from("old_code"))
        .expect("old_code custom field definition exists");
    old_code.archived_at = None;
    old_code.lifecycle = SchemaElementLifecycle::Active;
    backend
        .materialize_schema(&active_schema)
        .expect("materialize active custom-field schema");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-inherit-base"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-01",
                Some(text_values("Alice")),
                Some(vec![
                    custom_field_entry("score", CustomFieldValue::Number(Decimal::new(42, 0))),
                    custom_field_entry("old_code", CustomFieldValue::Text("legacy".to_string())),
                ]),
                false,
            )],
        ))
        .expect("apply inherited custom-field base");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-inherit-empty-overlay"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-15",
                Some(text_values("Alice Empty Overlay")),
                Some(vec![]),
                false,
            )],
        ))
        .expect("apply empty custom-field overlay");
    let after_empty_overlay = read_visible_as_of(backend, customer_id, "employee", "2026-05-20");
    assert_eq!(
        custom_value(&after_empty_overlay[0].custom_fields, "score"),
        Some(&CustomFieldValue::Number(Decimal::new(42, 0)))
    );
    assert_eq!(
        custom_value(&after_empty_overlay[0].custom_fields, "old_code"),
        Some(&CustomFieldValue::Text("legacy".to_string()))
    );

    let mut archived_schema = custom_fields_schema(customer_id);
    archived_schema.version = SchemaVersion::from("2026-06-01");
    backend
        .materialize_schema(&archived_schema)
        .expect("materialize archived custom-field schema");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("custom-inherit-update"),
            vec![row_write(
                "employee",
                "alice",
                "2026-06-01",
                Some(text_values("Alice Updated")),
                Some(vec![custom_field_entry(
                    "score",
                    CustomFieldValue::Number(Decimal::new(43, 0)),
                )]),
                false,
            )],
        ))
        .expect("apply update after custom-field archival");
    let visible = read_visible_as_of(backend, customer_id, "employee", "2026-06-15");
    assert_eq!(
        custom_value(&visible[0].custom_fields, "score"),
        Some(&CustomFieldValue::Number(Decimal::new(43, 0)))
    );
    assert_eq!(custom_value(&visible[0].custom_fields, "old_code"), None);
}

pub fn same_day_values_follow_application_order(backend: &mut impl ParityBackend) {
    let customer_id = "customer_same_day_values_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize same-day value schema");
    let first = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("same-day-value-first"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme")),
                None,
                false,
            )],
        ))
        .expect("apply first same-day value");
    let second = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("same-day-value-second"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Acme Updated")),
                None,
                false,
            )],
        ))
        .expect("apply second same-day value");

    let visible = read_visible_as_of(backend, customer_id, "company", "2026-05-01");
    assert_eq!(text_field(&visible[0], "name"), "Acme Updated");
    let history = field_history(
        backend,
        customer_id,
        "company",
        visible[0].record_id,
        Some(2),
    );
    assert_eq!(
        history
            .iter()
            .map(|entry| (
                entry.change_set_id,
                entry.effective_end,
                entry.value.clone()
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                first.id,
                Some(date("2026-05-01")),
                Some(FieldValue::Text("Acme".to_string())),
            ),
            (
                second.id,
                None,
                Some(FieldValue::Text("Acme Updated".to_string())),
            ),
        ]
    );
}

pub fn same_day_read_history_and_diff_share_application_order(backend: &mut impl ParityBackend) {
    let customer_id = "customer_same_day_readers_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize same-day reader schema");
    let mut change_sets = Vec::new();
    for (index, name) in ["Acme A", "Acme B", "Acme C"].into_iter().enumerate() {
        change_sets.push(
            backend
                .apply_change_set(&mainline_apply(
                    customer_id,
                    Some(&format!("same-day-reader-parity-{index}")),
                    vec![row_write(
                        "company",
                        "acme",
                        "2026-05-01",
                        Some(text_values(name)),
                        None,
                        false,
                    )],
                ))
                .expect("apply same-day reader value"),
        );
    }

    let visible = read_visible_as_of(backend, customer_id, "company", "2026-05-01");
    assert_eq!(text_field(&visible[0], "name"), "Acme C");
    let diff = backend
        .change_set_diff(&ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            change_set_id: change_sets[2].id,
            project: vec![FieldId::from("name")],
        })
        .expect("read same-day diff");
    assert_eq!(
        diff.records[0].fields,
        vec![kernel::FieldDiff {
            field_id: FieldId::from("name"),
            before: Some(FieldValue::Text("Acme B".to_string())),
            after: Some(FieldValue::Text("Acme C".to_string())),
            before_enum: None,
            after_enum: None,
        }]
    );
    let history = field_history(
        backend,
        customer_id,
        "company",
        visible[0].record_id,
        Some(2),
    );
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.change_set_id, entry.value.clone()))
            .collect::<Vec<_>>(),
        vec![
            (
                change_sets[1].id,
                Some(FieldValue::Text("Acme B".to_string())),
            ),
            (
                change_sets[2].id,
                Some(FieldValue::Text("Acme C".to_string())),
            ),
        ]
    );
}

pub fn later_date_closes_same_day_winner_despite_inverted_timestamps(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_same_day_inverted_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize inverted timestamp schema");
    let first = apply_company_name(
        backend,
        customer_id,
        "inverted-first",
        "2026-05-01",
        "First",
    );
    let winner = apply_company_name(
        backend,
        customer_id,
        "inverted-winner",
        "2026-05-01",
        "Winner",
    );
    backend.invert_version_created_at(&[first.id, winner.id]);
    let later = apply_company_name(
        backend,
        customer_id,
        "inverted-later",
        "2026-06-01",
        "Later",
    );

    let visible = read_visible_as_of(backend, customer_id, "company", "2026-06-15");
    let history = field_history(
        backend,
        customer_id,
        "company",
        visible[0].record_id,
        Some(3),
    );
    assert_eq!(
        history
            .iter()
            .map(|entry| (entry.change_set_id, entry.effective_end))
            .collect::<Vec<_>>(),
        vec![
            (first.id, Some(date("2026-05-01"))),
            (winner.id, Some(date("2026-05-31"))),
            (later.id, None),
        ]
    );
}

pub fn same_day_partial_write_carries_declared_and_custom_snapshot(
    backend: &mut impl ParityBackend,
) {
    let customer_id = "customer_same_day_overlay_parity";
    backend
        .materialize_schema(&custom_fields_schema(customer_id))
        .expect("materialize same-day overlay schema");
    apply_company_name(
        backend,
        customer_id,
        "overlay-company",
        "2026-05-01",
        "Acme",
    );
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("overlay-base"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-01",
                Some(employee_values(
                    "Alice",
                    RecordKey::ExternalKey("acme".into()),
                )),
                Some(vec![
                    custom_field_entry("nickname", CustomFieldValue::Text("Original".to_string())),
                    custom_field_entry("score", CustomFieldValue::Number(Decimal::new(42, 0))),
                ]),
                false,
            )],
        ))
        .expect("apply same-day overlay base");
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("overlay-update"),
            vec![row_write(
                "employee",
                "alice",
                "2026-05-01",
                Some(text_values("Alice Updated")),
                Some(vec![custom_field_entry(
                    "nickname",
                    CustomFieldValue::Text("Updated".to_string()),
                )]),
                false,
            )],
        ))
        .expect("apply partial same-day overlay");

    let visible = read_visible_as_of(backend, customer_id, "employee", "2026-05-15");
    assert_eq!(text_field(&visible[0], "name"), "Alice Updated");
    assert!(matches!(
        visible[0].values.get(&FieldId::from("employer")),
        Some(FieldValue::Relation(RecordKey::RecordId(_)))
    ));
    assert_eq!(
        visible[0].values.get(&FieldId::from("comp_rate")),
        Some(&FieldValue::MoneyRate(MoneyRateValue {
            amount: Decimal::new(12500, 2),
            currency: "USD".to_string(),
            period: MoneyRatePeriod::Hourly,
        }))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "nickname"),
        Some(&CustomFieldValue::Text("Updated".to_string()))
    );
    assert_eq!(
        custom_value(&visible[0].custom_fields, "score"),
        Some(&CustomFieldValue::Number(Decimal::new(42, 0)))
    );
}

pub fn same_day_successor_inherits_next_effective_boundary(backend: &mut impl ParityBackend) {
    let customer_id = "customer_same_day_boundary_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize boundary schema");
    let base = apply_company_name(backend, customer_id, "boundary-base", "2026-05-01", "Base");
    apply_company_name(
        backend,
        customer_id,
        "boundary-future",
        "2026-07-01",
        "Future",
    );
    let successor = apply_company_name(
        backend,
        customer_id,
        "boundary-successor",
        "2026-05-01",
        "Corrected",
    );
    let visible = read_visible_as_of(backend, customer_id, "company", "2026-05-15");
    let history = field_history(
        backend,
        customer_id,
        "company",
        visible[0].record_id,
        Some(3),
    );
    assert_eq!(history[0].change_set_id, base.id);
    assert_eq!(history[0].effective_end, Some(date("2026-05-01")));
    assert_eq!(history[1].change_set_id, successor.id);
    assert_eq!(history[1].effective_end, Some(date("2026-06-30")));
}

pub fn same_day_lifecycle_precedes_ordinary_values(backend: &mut impl ParityBackend) {
    let customer_id = "customer_same_day_lifecycle_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize lifecycle schema");
    let value = apply_company_name(
        backend,
        customer_id,
        "lifecycle-value",
        "2026-05-01",
        "Acme",
    );
    let tombstone = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("lifecycle-tombstone"),
            vec![row_write("company", "acme", "2026-05-01", None, None, true)],
        ))
        .expect("apply same-day tombstone");
    assert!(read_visible_as_of(backend, customer_id, "company", "2026-05-01").is_empty());
    backend
        .revert_change_set(&revert_request(
            customer_id,
            tombstone.id,
            Some("lifecycle-revert"),
        ))
        .expect("revert same-day tombstone");
    let visible = read_visible_as_of(backend, customer_id, "company", "2026-05-01");
    assert_eq!(text_field(&visible[0], "name"), "Acme");
    let history = field_history(
        backend,
        customer_id,
        "company",
        visible[0].record_id,
        Some(3),
    );
    assert_eq!(history[0].change_set_id, value.id);
}

pub fn same_day_dry_run_has_no_durable_effect(backend: &mut impl ParityBackend) {
    let customer_id = "customer_same_day_dry_run_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize dry-run schema");
    apply_company_name(backend, customer_id, "dry-run-base", "2026-05-01", "Base");
    let dry_run = backend
        .validate_change_set_dry_run(&mainline_apply(
            customer_id,
            Some("dry-run-update"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Dry")),
                None,
                false,
            )],
        ))
        .expect("validate same-day dry run");
    assert!(dry_run.id < 0);
    assert_eq!(
        backend.count_change_sets_by_idempotency_key(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            "dry-run-update",
        ),
        0
    );
    let visible = read_visible_as_of(backend, customer_id, "company", "2026-05-01");
    assert_eq!(text_field(&visible[0], "name"), "Base");
}

pub fn same_day_draft_rejection_and_promotion(backend: &mut impl ParityBackend) {
    let stale_customer = "customer_same_day_draft_stale_parity";
    backend
        .materialize_schema(&test_schema(stale_customer))
        .expect("materialize stale draft schema");
    apply_company_name(backend, stale_customer, "stale-base", "2026-04-01", "Base");
    let stale = backend
        .apply_change_set(&draft_apply(
            stale_customer,
            Some("stale-draft"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Draft")),
                None,
                false,
            )],
        ))
        .expect("save same-day draft");
    apply_company_name(
        backend,
        stale_customer,
        "stale-direct",
        "2026-05-01",
        "Direct",
    );
    let stale_error = backend
        .approve_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(stale_customer),
            stale.id,
        )
        .expect_err("stale same-day draft approval must fail");
    assert_eq!(stale_error.into_envelope().code, "stale_draft");

    let promoted_customer = "customer_same_day_draft_promote_parity";
    backend
        .materialize_schema(&test_schema(promoted_customer))
        .expect("materialize promotable draft schema");
    apply_company_name(
        backend,
        promoted_customer,
        "promote-base",
        "2026-04-01",
        "Base",
    );
    let direct = apply_company_name(
        backend,
        promoted_customer,
        "promote-direct",
        "2026-05-01",
        "Direct",
    );
    let draft = backend
        .apply_change_set(&draft_apply(
            promoted_customer,
            Some("promote-draft"),
            vec![row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Draft")),
                None,
                false,
            )],
        ))
        .expect("save promotable same-day draft");
    backend
        .approve_draft_change_set(
            &AppId::from("core_app"),
            &CustomerId::from(promoted_customer),
            draft.id,
        )
        .expect("promote same-day draft");
    let visible = read_visible_as_of(backend, promoted_customer, "company", "2026-05-15");
    assert_eq!(text_field(&visible[0], "name"), "Draft");
    let history = field_history(
        backend,
        promoted_customer,
        "company",
        visible[0].record_id,
        Some(3),
    );
    assert_eq!(history[1].change_set_id, direct.id);
    assert_eq!(history[1].effective_end, Some(date("2026-05-01")));
    assert_eq!(history[2].change_set_id, draft.id);
}

pub fn revert_same_day_walks_immediate_predecessors(backend: &mut impl ParityBackend) {
    let customer_id = "customer_revert_same_day_walk_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize same-day revert schema");
    let first = apply_company_name(backend, customer_id, "walk-first", "2026-05-01", "First");
    let second = apply_company_name(backend, customer_id, "walk-second", "2026-05-01", "Second");
    let third = apply_company_name(backend, customer_id, "walk-third", "2026-05-01", "Third");
    assert!(backend
        .revert_change_set(&revert_request(
            customer_id,
            second.id,
            Some("walk-non-tip")
        ))
        .is_err());
    backend
        .revert_change_set(&revert_request(
            customer_id,
            third.id,
            Some("walk-third-revert"),
        ))
        .expect("revert third same-day tip");
    let after_third = read_visible_as_of(backend, customer_id, "company", "2026-05-15");
    assert_eq!(text_field(&after_third[0], "name"), "Second");
    backend
        .revert_change_set(&revert_request(
            customer_id,
            second.id,
            Some("walk-second-revert"),
        ))
        .expect("revert second same-day tip");
    let after_second = read_visible_as_of(backend, customer_id, "company", "2026-05-15");
    assert_eq!(text_field(&after_second[0], "name"), "First");
    let history = field_history(
        backend,
        customer_id,
        "company",
        after_second[0].record_id,
        Some(3),
    );
    assert_eq!(history[0].change_set_id, first.id);
    assert_eq!(history[1].change_set_id, second.id);
    assert_eq!(history[2].change_set_id, third.id);
    assert!(history[1].reverted_by.is_some());
    assert!(history[2].reverted_by.is_some());
}

pub fn revert_same_day_restores_declared_and_custom_relations(backend: &mut impl ParityBackend) {
    let customer_id = "customer_revert_same_day_relations_parity";
    backend
        .materialize_schema(&custom_fields_schema(customer_id))
        .expect("materialize relation revert schema");
    for key in ["acme", "zenith"] {
        backend
            .apply_change_set(&mainline_apply(
                customer_id,
                Some(&format!("relation-{key}")),
                vec![row_write(
                    "company",
                    key,
                    "2026-05-01",
                    Some(text_values(key)),
                    None,
                    false,
                )],
            ))
            .expect("apply relation target company");
    }
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("relation-employee-acme"),
            vec![employee_relation_write("acme")],
        ))
        .expect("apply initial declared and custom relations");
    let target = backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some("relation-employee-zenith"),
            vec![employee_relation_write("zenith")],
        ))
        .expect("apply replacement declared and custom relations");
    backend
        .revert_change_set(&revert_request(
            customer_id,
            target.id,
            Some("relation-revert"),
        ))
        .expect("revert replacement relations");
    let companies = read_visible_as_of(backend, customer_id, "company", "2026-05-15");
    let acme_id = companies
        .iter()
        .find(|company| text_field(company, "name") == "acme")
        .expect("visible Acme relation target")
        .record_id;
    let employee = read_visible_as_of(backend, customer_id, "employee", "2026-05-15");
    assert_eq!(
        employee[0].values.get(&FieldId::from("employer")),
        Some(&FieldValue::Relation(RecordKey::RecordId(acme_id)))
    );
    assert_eq!(
        custom_value(&employee[0].custom_fields, "home_company"),
        Some(&CustomFieldValue::Relation(RecordKey::RecordId(acme_id)))
    );
}

pub fn duplicate_same_day_write_rolls_back_atomically(backend: &mut impl ParityBackend) {
    let customer_id = "customer_same_day_rollback_parity";
    backend
        .materialize_schema(&test_schema(customer_id))
        .expect("materialize same-day rollback schema");
    let result = backend.apply_change_set(&mainline_apply(
        customer_id,
        Some("duplicate-same-day"),
        vec![
            row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("One")),
                None,
                false,
            ),
            row_write(
                "company",
                "acme",
                "2026-05-01",
                Some(text_values("Two")),
                None,
                false,
            ),
        ],
    ));
    assert!(result.is_err());
    assert_eq!(
        backend.count_change_sets_by_idempotency_key(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            "duplicate-same-day",
        ),
        0
    );
    assert!(read_visible_as_of(backend, customer_id, "company", "2026-05-15").is_empty());
}

fn field_history(
    backend: &mut impl ParityBackend,
    customer_id: &str,
    model_id: &str,
    record_id: RecordId,
    limit: Option<i64>,
) -> Vec<FieldHistoryEntry> {
    backend
        .field_history(&FieldHistoryRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            model_id: ModelId::from(model_id),
            record_id,
            field_id: Some(FieldId::from("name")),
            as_of: None,
            limit,
            stages: vec![],
        })
        .expect("read parity field history")
}

fn apply_company_name(
    backend: &mut impl ParityBackend,
    customer_id: &str,
    idempotency_key: &str,
    effective_start: &str,
    name: &str,
) -> AppliedChangeSet {
    backend
        .apply_change_set(&mainline_apply(
            customer_id,
            Some(idempotency_key),
            vec![row_write(
                "company",
                "acme",
                effective_start,
                Some(text_values(name)),
                None,
                false,
            )],
        ))
        .expect("apply parity company value")
}

fn employee_relation_write(target: &str) -> RowVersionWrite {
    row_write(
        "employee",
        "alice",
        "2026-05-01",
        Some(employee_values(
            "Alice",
            RecordKey::ExternalKey(target.into()),
        )),
        Some(vec![custom_field_entry(
            "home_company",
            CustomFieldValue::Relation(RecordKey::ExternalKey(target.into())),
        )]),
        false,
    )
}

fn text_field<'a>(record: &'a VisibleRecord, field_id: &str) -> &'a str {
    match record.values.get(&FieldId::from(field_id)) {
        Some(FieldValue::Text(value)) => value,
        value => panic!("expected text field `{field_id}`, got {value:?}"),
    }
}

fn custom_fields_schema(customer_id: &str) -> Schema {
    let mut schema = test_schema(customer_id);
    schema
        .models
        .iter_mut()
        .find(|model| model.id == ModelId::from("employee"))
        .expect("employee model")
        .extensions
        .typed_custom_fields = true;
    schema.custom_fields = vec![
        custom_field_definition("employee_nickname", "nickname", CustomFieldType::Text),
        custom_field_definition("employee_score", "score", CustomFieldType::Number),
        custom_field_definition("employee_remote", "remote", CustomFieldType::Bool),
        custom_field_definition("employee_start_date", "start_date", CustomFieldType::Date),
        custom_field_definition(
            "employee_reviewed_at",
            "reviewed_at",
            CustomFieldType::Datetime,
        ),
        CustomFieldDefinition {
            target_model_id: Some(ModelId::from("company")),
            ..custom_field_definition(
                "employee_home_company",
                "home_company",
                CustomFieldType::Relation,
            )
        },
        custom_field_definition("employee_skills", "skills", CustomFieldType::TextList),
        CustomFieldDefinition {
            option_set: vec![
                EnumOption {
                    id: EnumOptionId::from("small"),
                    label: "Small".to_string(),
                    aliases: vec![],
                    ..Default::default()
                },
                EnumOption {
                    id: EnumOptionId::from("large"),
                    label: "Large".to_string(),
                    aliases: vec![],
                    ..Default::default()
                },
            ],
            ..custom_field_definition("employee_shirt_size", "shirt_size", CustomFieldType::Enum)
        },
        custom_field_definition("employee_bonus", "bonus", CustomFieldType::MoneyRate),
        CustomFieldDefinition {
            archived_at: Some(
                DateTime::parse_from_rfc3339("2026-06-01T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
            lifecycle: SchemaElementLifecycle::Retired,
            ..custom_field_definition("employee_old_code", "old_code", CustomFieldType::Text)
        },
    ];
    schema
}

fn custom_field_definition(
    id: &str,
    field_id: &str,
    field_type: CustomFieldType,
) -> CustomFieldDefinition {
    CustomFieldDefinition {
        id: CustomFieldDefinitionId::from(id),
        model_id: ModelId::from("employee"),
        field_id: FieldId::from(field_id),
        label: field_id.to_string(),
        field_type,
        target_model_id: None,
        option_set: vec![],
        archived_at: None,
        ..Default::default()
    }
}

fn custom_field_entry(field_id: &str, value: CustomFieldValue) -> CustomFieldEntry {
    CustomFieldEntry {
        field_id: FieldId::from(field_id),
        value,
    }
}

fn all_custom_field_entries(home_company: &str) -> Vec<CustomFieldEntry> {
    vec![
        custom_field_entry("nickname", CustomFieldValue::Text("Al".to_string())),
        custom_field_entry("score", CustomFieldValue::Number(Decimal::new(42, 0))),
        custom_field_entry("remote", CustomFieldValue::Bool(true)),
        custom_field_entry("start_date", CustomFieldValue::Date(date("2026-05-01"))),
        custom_field_entry(
            "reviewed_at",
            CustomFieldValue::Datetime(
                DateTime::parse_from_rfc3339("2026-05-01T12:34:56Z")
                    .unwrap()
                    .with_timezone(&Utc),
            ),
        ),
        custom_field_entry(
            "home_company",
            CustomFieldValue::Relation(RecordKey::ExternalKey(home_company.into())),
        ),
        custom_field_entry(
            "skills",
            CustomFieldValue::TextList(vec!["rust".to_string(), "sql".to_string()]),
        ),
        custom_field_entry(
            "shirt_size",
            CustomFieldValue::Enum(EnumOptionId::from("large")),
        ),
        custom_field_entry(
            "bonus",
            CustomFieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::new(150000, 2),
                currency: "USD".to_string(),
                period: MoneyRatePeriod::Annual,
            }),
        ),
    ]
}

fn custom_value<'a>(
    entries: &'a [CustomFieldEntry],
    field_id: &str,
) -> Option<&'a CustomFieldValue> {
    entries
        .iter()
        .find(|entry| entry.field_id == FieldId::from(field_id))
        .map(|entry| &entry.value)
}

fn row_write(
    model_id: &str,
    external_key: &str,
    effective_start: &str,
    values: Option<BTreeMap<FieldId, FieldValue>>,
    custom_fields: Option<Vec<CustomFieldEntry>>,
    tombstones_record: bool,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        new_record_id: None,
        record_key: Some(RecordKey::ExternalKey(external_key.into())),
        effective_start: date(effective_start),
        values,
        custom_fields,
        tombstones_record,
        provenance: None,
        ..Default::default()
    }
}

fn read_visible_as_of(
    backend: &mut impl ParityBackend,
    customer_id: &str,
    model_id: &str,
    as_of: &str,
) -> Vec<VisibleRecord> {
    backend
        .read_visible_records(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            &ModelId::from(model_id),
            date(as_of),
        )
        .expect("read visible custom-field records")
}

fn diff(
    backend: &mut impl ParityBackend,
    customer_id: &str,
    change_set_id: i64,
    project: &str,
) -> ChangeSetDiff {
    backend
        .change_set_diff(&ChangeSetDiffRequest {
            app_id: AppId::from("core_app"),
            customer_id: CustomerId::from(customer_id),
            change_set_id,
            project: vec![FieldId::from(project)],
        })
        .expect("read custom-field change-set diff")
}

fn test_schema(customer_id: &str) -> Schema {
    Schema {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        version: SchemaVersion::from("2026-05-04"),
        models: vec![
            Model {
                id: ModelId::from("company"),
                kind: ModelKind::Entity,
                label: "Company".to_string(),
                fields: vec![field("name", "Name", FieldType::Text, true, None)],
                ..Default::default()
            },
            Model {
                id: ModelId::from("employee"),
                kind: ModelKind::Entity,
                label: "Employee".to_string(),
                fields: vec![
                    field("name", "Name", FieldType::Text, true, None),
                    field(
                        "employer",
                        "Employer",
                        FieldType::Relation,
                        false,
                        Some("company"),
                    ),
                    field("comp_rate", "Comp Rate", FieldType::MoneyRate, false, None),
                ],
                ..Default::default()
            },
        ],
        custom_fields: vec![],
        change_types: vec![ChangeType {
            id: ChangeTypeId::from("employee_update"),
            label: "Employee Update".to_string(),
            target_model: ModelId::from("employee"),
            is_import_default: false,
            touches: vec![FieldId::from("name")],
            required: vec![FieldId::from("name")],
        }],
    }
}

fn field(
    id: &str,
    label: &str,
    field_type: FieldType,
    required: bool,
    target_model: Option<&str>,
) -> Field {
    Field {
        id: FieldId::from(id),
        label: label.to_string(),
        field_type,
        required,
        is_unique: false,
        target_model: target_model.map(ModelId::from),
        option_set: vec![],
        ..Default::default()
    }
}

fn explicit_new_write(
    model_id: &str,
    record_id: RecordId,
    values: BTreeMap<FieldId, FieldValue>,
) -> RowVersionWrite {
    RowVersionWrite {
        model_id: ModelId::from(model_id),
        new_record_id: Some(record_id),
        record_key: None,
        effective_start: date("2026-05-01"),
        values: Some(values),
        custom_fields: None,
        tombstones_record: false,
        provenance: None,
        ..Default::default()
    }
}

fn mainline_apply(
    customer_id: &str,
    idempotency_key: Option<&str>,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    ApplyChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        schema_revision_id: None,
        actor_id: Some("tester".to_string()),
        source_kind: "test".to_string(),
        source_ref: None,
        idempotency_key: idempotency_key.map(str::to_string),
        change_type_id: None,
        notes: None,
        mode: ApplyMode::Mainline,
        writes,
    }
}

fn draft_apply(
    customer_id: &str,
    idempotency_key: Option<&str>,
    writes: Vec<RowVersionWrite>,
) -> ApplyChangeSet {
    let mut apply = mainline_apply(customer_id, idempotency_key, writes);
    apply.mode = ApplyMode::Draft;
    apply
}

fn revert_request(
    customer_id: &str,
    change_set_id: i64,
    idempotency_key: Option<&str>,
) -> RevertChangeSet {
    RevertChangeSet {
        app_id: AppId::from("core_app"),
        customer_id: CustomerId::from(customer_id),
        change_set_id,
        actor_id: Some("tester".to_string()),
        idempotency_key: idempotency_key.map(str::to_string),
        notes: None,
    }
}

fn read_visible(
    backend: &mut impl ParityBackend,
    customer_id: &str,
    model_id: &str,
) -> Vec<VisibleRecord> {
    backend
        .read_visible_records(
            &AppId::from("core_app"),
            &CustomerId::from(customer_id),
            &ModelId::from(model_id),
            date("2026-05-15"),
        )
        .expect("read visible records")
}

fn assert_bare_error(error: KernelError, code: &str, message: String) {
    assert_eq!(
        error.into_envelope(),
        ErrorEnvelope {
            code: code.to_string(),
            message,
            details: vec![],
        }
    );
}

fn text_values(name: &str) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([(FieldId::from("name"), FieldValue::Text(name.to_string()))])
}

fn employee_values(name: &str, employer: RecordKey) -> BTreeMap<FieldId, FieldValue> {
    BTreeMap::from([
        (FieldId::from("name"), FieldValue::Text(name.to_string())),
        (FieldId::from("employer"), FieldValue::Relation(employer)),
        (
            FieldId::from("comp_rate"),
            FieldValue::MoneyRate(MoneyRateValue {
                amount: Decimal::new(12500, 2),
                currency: "USD".to_string(),
                period: MoneyRatePeriod::Hourly,
            }),
        ),
    ])
}

fn date(value: &str) -> NaiveDate {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
}
