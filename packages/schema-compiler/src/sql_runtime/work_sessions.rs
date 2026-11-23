use super::RuntimeSqlFunction;

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    vec![
        RuntimeSqlFunction {
            signature: "kernel_work_overlay_row(jsonb,jsonb,jsonb)",
            sql: include_str!("work_overlay.sql").to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_work_helpers",
            sql: include_str!("work_helpers.sql").to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_work_rule_evaluate(jsonb,jsonb,jsonb)",
            sql: include_str!("work_rule_evaluate.sql").to_string(),
        },
        RuntimeSqlFunction {
            signature: "kernel_work_session(jsonb)",
            sql: include_str!("work_session.sql").to_string(),
        },
    ]
}
