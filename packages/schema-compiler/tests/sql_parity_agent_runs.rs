mod support;

use support::agent_run_scenarios::{
    agent_run_provenance_fails_closed_when_schema_is_stale,
    agent_run_replay_survives_later_schema_activation,
    agent_run_status_updates_are_terminal_and_idempotent,
    agent_runs_are_recorded_and_required_for_agent_writes,
    concurrent_agent_run_records_are_idempotent_or_conflicting,
    materialize_schema_upgrades_agent_run_status_check_for_budget_exhausted,
};
use support::generated_sql_backend::GeneratedSqlBackend;

#[test]
fn agent_runs_are_recorded_and_required_for_agent_writes_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    agent_runs_are_recorded_and_required_for_agent_writes(&mut backend);
}

#[test]
fn agent_run_status_updates_are_terminal_and_idempotent_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    agent_run_status_updates_are_terminal_and_idempotent(&mut backend);
}

#[test]
fn materialize_schema_upgrades_agent_run_status_check_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    materialize_schema_upgrades_agent_run_status_check_for_budget_exhausted(&mut backend);
}

#[test]
fn agent_run_replay_survives_later_schema_activation_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    agent_run_replay_survives_later_schema_activation(&mut backend);
}

#[test]
fn concurrent_agent_run_records_match_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    concurrent_agent_run_records_are_idempotent_or_conflicting(&mut backend);
}

#[test]
fn agent_run_provenance_fails_closed_when_schema_is_stale_matches_generated_sql() {
    let Some(mut backend) = GeneratedSqlBackend::connect() else {
        return;
    };
    agent_run_provenance_fails_closed_when_schema_is_stale(&mut backend);
}
