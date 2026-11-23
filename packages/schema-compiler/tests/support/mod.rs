pub mod generated_sql_backend;
#[path = "trusted_human.rs"]
pub mod trusted_human;

use postgres::Client;

// Integration-test crates share this cleanup helper, though not every crate
// allocates a generated SQL fixture that needs teardown.
#[allow(dead_code)]
pub fn drop_generated_sql_fixture(client: &mut Client, schema_name: &str) {
    let _ = trusted_human::drop_fixture(client, schema_name);
}

#[path = "../../../kernel/tests/support/agent_run_scenarios.rs"]
#[allow(dead_code)]
pub mod agent_run_scenarios;

#[path = "../../../kernel/tests/support/parity_scenarios.rs"]
#[allow(dead_code)]
pub mod parity_scenarios;
