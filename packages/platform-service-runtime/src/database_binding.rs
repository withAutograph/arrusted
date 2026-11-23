//! Private log evidence from the connection the service already selected.
//! No additional connection, route, credential, grant, or installation action.

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use postgres::{config::Host, Client};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum BindingKind {
    Runtime,
    Initialization,
    SchemaAdmin,
}

impl BindingKind {
    fn name(self) -> &'static str {
        match self {
            Self::Runtime => "runtime",
            Self::Initialization => "initialization",
            Self::SchemaAdmin => "schema-admin",
        }
    }
}

static OBSERVED: OnceLock<Mutex<BTreeSet<(&'static str, BindingKind)>>> = OnceLock::new();

/// Observe each selected binding once per hosted process, after session setup.
/// An observation failure cannot replace the application's result. The log
/// contains fingerprints only: provider metadata can be compared privately
/// without exporting a URL, login name, database name, or search path.
pub fn observe_hosted_binding(
    client: &mut Client,
    app: &'static str,
    kind: BindingKind,
    selected_variable: &'static str,
    connection_string: &str,
) {
    if std::env::var("VERCEL").as_deref() != Ok("1") {
        return;
    }
    let first = OBSERVED
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert((app, kind));
    if !first {
        return;
    }
    let mut observation = binding_metadata(app, kind, selected_variable, connection_string);
    match read_connection_identity(client) {
        Ok(identity) => {
            observation["state"] = json!("observed");
            observation["identity"] = identity;
        }
        Err(_) => {
            // PostgreSQL errors may include connection parameters or server
            // detail. Never copy them into this durable diagnostic.
            observation["state"] = json!("observation-unavailable");
        }
    }
    eprintln!("{observation}");
}

fn fingerprint(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn binding_metadata(
    app: &str,
    kind: BindingKind,
    selected_variable: &str,
    connection_string: &str,
) -> Value {
    let mut value = json!({
        "event": "service-database-binding",
        "version": 1,
        "app": app,
        "binding_kind": kind.name(),
        "selected_variable": selected_variable,
        "observed_at_ms": SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|time| time.as_millis().to_string()),
        "environment": std::env::var("VERCEL_ENV").ok().filter(|environment| matches!(environment.as_str(), "production" | "preview" | "development")),
        "deployment_id": std::env::var("VERCEL_DEPLOYMENT_ID").ok().filter(|id| id.starts_with("dpl_") && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')),
    });
    if let Ok(config) = kernel::postgres_connection_config(connection_string) {
        value["configured_hosts_sha256"] = json!(config
            .get_hosts()
            .iter()
            .map(|host| match host {
                Host::Tcp(host) => fingerprint(host),
                Host::Unix(path) => fingerprint(&path.to_string_lossy()),
            })
            .collect::<Vec<_>>());
        value["configured_database_sha256"] = json!(config.get_dbname().map(fingerprint));
        value["configured_login_sha256"] = json!(config.get_user().map(fingerprint));
    }
    value
}

/// Read fingerprinted SQL identity from the caller's existing connection.
pub fn read_connection_identity(client: &mut Client) -> Result<Value, postgres::Error> {
    // This transaction uses the already-open runtime/initializer/admin client.
    // It reads built-in identity functions only and always rolls back, including
    // on error. The timeout is transaction-local and cannot affect app work.
    let mut transaction = client.build_transaction().read_only(true).start()?;
    transaction.batch_execute("set local statement_timeout = '2s'")?;
    let row = transaction.query_one(
        "select pg_catalog.current_database()::text, session_user::text, current_user::text, pg_catalog.current_schema()::text, pg_catalog.current_setting('search_path'), pg_catalog.current_setting('neon.project_id', true), pg_catalog.current_setting('neon.branch_id', true), pg_catalog.current_setting('neon.endpoint_id', true)",
        &[],
    )?;
    let fields = [
        "current_database_sha256",
        "session_user_sha256",
        "current_user_sha256",
        "current_schema_sha256",
        "search_path_sha256",
        "neon_project_id_sha256",
        "neon_branch_id_sha256",
        "neon_endpoint_id_sha256",
    ];
    let mut identity = json!({});
    for (index, name) in fields.iter().enumerate() {
        let value: Option<String> = row.get(index);
        identity[name] = json!(value
            .filter(|value| !value.is_empty())
            .map(|value| fingerprint(&value)));
    }
    transaction.rollback()?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_omits_credentials_options_and_unredacted_resource_names() {
        let metadata = binding_metadata(
            "hc", BindingKind::Runtime, "DATABASE_URL",
            "postgres://private_login:private_password@ep-example.neon.tech/private_database?application_name=private_application&sslmode=require",
        );
        let encoded = metadata.to_string();
        for private in [
            "private_login",
            "private_password",
            "ep-example.neon.tech",
            "private_database",
            "private_application",
            "postgres://",
        ] {
            assert!(!encoded.contains(private), "leaked {private}");
        }
        assert_eq!(
            metadata["configured_hosts_sha256"],
            json!([fingerprint("ep-example.neon.tech")])
        );
        assert_eq!(
            metadata["configured_database_sha256"],
            fingerprint("private_database")
        );
        assert_eq!(
            metadata["configured_login_sha256"],
            fingerprint("private_login")
        );
        assert_eq!(metadata["binding_kind"], "runtime");
    }

    #[test]
    fn invalid_connection_strings_are_never_echoed() {
        let metadata = binding_metadata(
            "vendor",
            BindingKind::Initialization,
            "DATABASE_URL_UNPOOLED",
            "invalid private_password",
        );
        assert!(!metadata.to_string().contains("private_password"));
        assert!(metadata.get("configured_hosts_sha256").is_none());
        assert_eq!(metadata["binding_kind"], "initialization");
    }

    #[test]
    fn supported_verify_full_bindings_keep_exact_configured_fingerprints() {
        for connection in [
            "postgres://private_login:private_password@ep-example.neon.tech/private_database?sslmode=verify-full",
            "host=ep-example.neon.tech user=private_login password=private_password dbname=private_database sslmode=verify-full",
        ] {
            let metadata = binding_metadata("vendor", BindingKind::Runtime, "DATABASE_URL", connection);
            assert_eq!(metadata["configured_hosts_sha256"], json!([fingerprint("ep-example.neon.tech")]));
            assert_eq!(metadata["configured_database_sha256"], fingerprint("private_database"));
            assert_eq!(metadata["configured_login_sha256"], fingerprint("private_login"));
            assert!(!metadata.to_string().contains("private_password"));
        }
    }
}
