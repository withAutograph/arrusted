mod support;

use support::generated_sql_backend::GeneratedSqlBackend;
use support::parity_scenarios::{
    change_set_diff_covers_custom_field_create_update_projection_and_revert,
    custom_field_enum_orphan_options_render_null_by_omission,
    custom_fields_follow_draft_approval_discard_and_revert_lifecycle,
    custom_fields_omit_inherit_and_archived_definitions_stop_carrying_forward,
    custom_fields_reject_missing_and_cross_tenant_relation_targets,
    custom_fields_round_trip_all_supported_types_and_resolve_relations,
    duplicate_same_day_write_rolls_back_atomically,
    explicit_new_subject_can_be_reused_after_draft_discard,
    explicit_new_subject_draft_ordering_approval_and_revert_preserve_exact_uuid,
    explicit_new_subject_mainline_uses_exact_uuid_and_resolves_reverse_order_relation,
    explicit_new_subject_planned_visibility_preserves_as_of_date,
    explicit_new_subject_rejects_uuid_collision_and_cross_tenant_relation,
    later_date_closes_same_day_winner_despite_inverted_timestamps,
    revert_same_day_restores_declared_and_custom_relations,
    revert_same_day_walks_immediate_predecessors, same_day_draft_rejection_and_promotion,
    same_day_dry_run_has_no_durable_effect, same_day_lifecycle_precedes_ordinary_values,
    same_day_partial_write_carries_declared_and_custom_snapshot,
    same_day_read_history_and_diff_share_application_order,
    same_day_successor_inherits_next_effective_boundary, same_day_values_follow_application_order,
};

#[test]
fn explicit_new_subject_mainline_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    explicit_new_subject_mainline_uses_exact_uuid_and_resolves_reverse_order_relation(&mut backend);
}

#[test]
fn explicit_new_subject_draft_lifecycle_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    explicit_new_subject_draft_ordering_approval_and_revert_preserve_exact_uuid(&mut backend);
}

#[test]
fn explicit_new_subject_reuse_after_discard_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    explicit_new_subject_can_be_reused_after_draft_discard(&mut backend);
}

#[test]
fn explicit_new_subject_rejections_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    explicit_new_subject_rejects_uuid_collision_and_cross_tenant_relation(&mut backend);
}

#[test]
fn explicit_new_subject_planned_visibility_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    explicit_new_subject_planned_visibility_preserves_as_of_date(&mut backend);
}

#[test]
fn custom_fields_all_supported_types_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    custom_fields_round_trip_all_supported_types_and_resolve_relations(&mut backend);
}

#[test]
fn custom_field_enum_orphans_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    custom_field_enum_orphan_options_render_null_by_omission(&mut backend);
}

#[test]
fn custom_field_relation_rejections_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    custom_fields_reject_missing_and_cross_tenant_relation_targets(&mut backend);
}

#[test]
fn custom_field_draft_and_revert_lifecycle_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    custom_fields_follow_draft_approval_discard_and_revert_lifecycle(&mut backend);
}

#[test]
fn custom_field_change_set_diff_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    change_set_diff_covers_custom_field_create_update_projection_and_revert(&mut backend);
}

#[test]
fn custom_field_inheritance_and_archival_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };

    custom_fields_omit_inherit_and_archived_definitions_stop_carrying_forward(&mut backend);
}

#[test]
fn same_day_values_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    same_day_values_follow_application_order(&mut backend);
}

#[test]
fn same_day_read_history_and_diff_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    same_day_read_history_and_diff_share_application_order(&mut backend);
}

#[test]
fn same_day_inverted_timestamps_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    later_date_closes_same_day_winner_despite_inverted_timestamps(&mut backend);
}

#[test]
fn same_day_partial_snapshot_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    same_day_partial_write_carries_declared_and_custom_snapshot(&mut backend);
}

#[test]
fn same_day_successor_boundary_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    same_day_successor_inherits_next_effective_boundary(&mut backend);
}

#[test]
fn same_day_lifecycle_precedence_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    same_day_lifecycle_precedes_ordinary_values(&mut backend);
}

#[test]
fn same_day_dry_run_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    same_day_dry_run_has_no_durable_effect(&mut backend);
}

#[test]
fn same_day_draft_rejection_and_promotion_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    same_day_draft_rejection_and_promotion(&mut backend);
}

#[test]
fn same_day_revert_predecessor_walk_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    revert_same_day_walks_immediate_predecessors(&mut backend);
}

#[test]
fn same_day_relation_restoration_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    revert_same_day_restores_declared_and_custom_relations(&mut backend);
}

#[test]
fn same_day_atomic_rollback_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    duplicate_same_day_write_rolls_back_atomically(&mut backend);
}
