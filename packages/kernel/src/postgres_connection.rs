use std::sync::Arc;
use std::{error::Error, fmt};

use postgres::config::{Host, SslMode};
use postgres::{Client, Config, NoTls};
use postgres_rustls::{set_postgresql_alpn, MakeTlsConnector};
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostgresConnectionTarget {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub sslmode: String,
}

#[derive(Debug)]
pub enum PostgresConnectionError {
    Configuration(&'static str),
    Postgres(postgres::Error),
}

impl fmt::Display for PostgresConnectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) => formatter.write_str(message),
            Self::Postgres(error) => error.fmt(formatter),
        }
    }
}

impl Error for PostgresConnectionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Configuration(_) => None,
            Self::Postgres(error) => Some(error),
        }
    }
}

impl From<postgres::Error> for PostgresConnectionError {
    fn from(error: postgres::Error) -> Self {
        Self::Postgres(error)
    }
}

pub fn connect_postgres(database_url: &str) -> Result<Client, PostgresConnectionError> {
    let config = postgres_connection_config(database_url)?;
    if config.get_ssl_mode() == SslMode::Disable {
        return config.connect(NoTls).map_err(Into::into);
    }

    let root_store = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut tls_config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    set_postgresql_alpn(&mut tls_config);

    config
        .connect(MakeTlsConnector::new(Arc::new(tls_config).into()))
        .map_err(Into::into)
}

/// Parse the exact configuration used by `connect_postgres`, including its
/// supported libpq TLS-policy normalization. Credentials stay transient in the
/// returned configuration; callers must not log or serialize it.
pub fn postgres_connection_config(database_url: &str) -> Result<Config, PostgresConnectionError> {
    parse_postgres_config(database_url).map(|(config, _)| config)
}

pub fn describe_postgres_connection_target(database_url: &str) -> PostgresConnectionTarget {
    let Some(target) = parsed_postgres_connection_target(database_url) else {
        return PostgresConnectionTarget {
            host: "unknown".to_string(),
            port: 0,
            database: "unknown".to_string(),
            sslmode: "unknown".to_string(),
        };
    };
    target
}

pub fn postgres_connection_targets_match(left: &str, right: &str) -> bool {
    let (Some(left), Some(right)) = (
        parsed_postgres_connection_target(left),
        parsed_postgres_connection_target(right),
    ) else {
        return false;
    };
    normalize_pooler_host(&left.host) == normalize_pooler_host(&right.host)
        && left.port == right.port
        && left.database == right.database
        && left.sslmode == right.sslmode
}

fn parsed_postgres_connection_target(database_url: &str) -> Option<PostgresConnectionTarget> {
    let (config, declared_sslmode) = parse_postgres_config(database_url).ok()?;
    Some(PostgresConnectionTarget {
        host: config
            .get_hosts()
            .first()
            .map(host_label)
            .unwrap_or_else(|| "unspecified".to_string()),
        port: config.get_ports().first().copied().unwrap_or(5432),
        database: config.get_dbname().unwrap_or("unspecified").to_string(),
        sslmode: declared_sslmode
            .unwrap_or_else(|| ssl_mode_label(config.get_ssl_mode()).to_string()),
    })
}

/// `tokio-postgres` does not accept libpq's `verify-full` label. The rustls
/// connector below already verifies both the certificate chain and the server
/// name, so translate only the parser-facing value while preserving the
/// declared policy for diagnostics and target comparison.
fn parse_postgres_config(
    database_url: &str,
) -> Result<(Config, Option<String>), PostgresConnectionError> {
    let (normalized, declared_sslmode) = normalize_verify_full(database_url)?;
    normalized
        .parse::<Config>()
        .map(|config| (config, declared_sslmode))
        .map_err(Into::into)
}

fn normalize_verify_full(
    database_url: &str,
) -> Result<(String, Option<String>), PostgresConnectionError> {
    if database_url.starts_with("postgres://") || database_url.starts_with("postgresql://") {
        let Some((base, query_and_fragment)) = database_url.split_once('?') else {
            return Ok((database_url.to_string(), None));
        };
        let (query, fragment) = query_and_fragment
            .split_once('#')
            .map_or((query_and_fragment, None), |(query, fragment)| {
                (query, Some(fragment))
            });
        let sslmode_count = query
            .split('&')
            .filter(|parameter| {
                parameter
                    .split_once('=')
                    .is_some_and(|(key, _)| key == "sslmode")
            })
            .count();
        if sslmode_count > 1 {
            return Err(PostgresConnectionError::Configuration(
                "Postgres connection string must declare sslmode exactly once",
            ));
        }
        let mut verify_full = false;
        let query = query
            .split('&')
            .map(|parameter| {
                if parameter == "sslmode=verify-full" {
                    verify_full = true;
                    "sslmode=require"
                } else {
                    parameter
                }
            })
            .collect::<Vec<_>>()
            .join("&");
        if verify_full {
            let fragment = fragment.map_or(String::new(), |value| format!("#{value}"));
            return Ok((
                format!("{base}?{query}{fragment}"),
                Some("verify-full".to_string()),
            ));
        }
        return Ok((database_url.to_string(), None));
    }

    let sslmode_count = database_url
        .split_whitespace()
        .filter(|part| part.starts_with("sslmode="))
        .count();
    if sslmode_count > 1 {
        return Err(PostgresConnectionError::Configuration(
            "Postgres connection string must declare sslmode exactly once",
        ));
    }
    let mut verify_full = false;
    let normalized = database_url
        .split_whitespace()
        .map(|part| {
            if part == "sslmode=verify-full" {
                verify_full = true;
                "sslmode=require"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    Ok((normalized, verify_full.then(|| "verify-full".to_string())))
}

fn normalize_pooler_host(host: &str) -> String {
    let Some((prefix, suffix)) = host.split_once('.') else {
        return host.to_string();
    };
    if !suffix.ends_with(".neon.tech") {
        return host.to_string();
    }
    let Some(prefix) = prefix.strip_suffix("-pooler") else {
        return host.to_string();
    };
    format!("{prefix}.{suffix}")
}

fn host_label(host: &Host) -> String {
    match host {
        Host::Tcp(host) => host.clone(),
        #[cfg(unix)]
        Host::Unix(_) => "unix_socket".to_string(),
    }
}

fn ssl_mode_label(ssl_mode: SslMode) -> &'static str {
    match ssl_mode {
        SslMode::Disable => "disable",
        SslMode::Prefer => "prefer",
        SslMode::Require => "require",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        describe_postgres_connection_target, parse_postgres_config,
        postgres_connection_targets_match,
    };

    #[test]
    fn describes_connection_target_without_credentials() {
        let target = describe_postgres_connection_target(
            "postgres://user:secret@example.neon.tech/neondb?sslmode=require",
        );

        assert_eq!(target.host, "example.neon.tech");
        assert_eq!(target.port, 5432);
        assert_eq!(target.database, "neondb");
        assert_eq!(target.sslmode, "require");
    }

    #[test]
    fn describes_ipv6_connection_target() {
        let target = describe_postgres_connection_target(
            "postgres://user:secret@[::1]:5432/postgres?sslmode=disable",
        );

        assert_eq!(target.host, "::1");
        assert_eq!(target.port, 5432);
        assert_eq!(target.database, "postgres");
        assert_eq!(target.sslmode, "disable");
    }

    #[test]
    fn describes_key_value_connection_target_without_echoing_secret() {
        let target = describe_postgres_connection_target(
            "host=db.example.test password=secret dbname=platform sslmode=require",
        );

        assert_eq!(target.host, "db.example.test");
        assert_eq!(target.port, 5432);
        assert_eq!(target.database, "platform");
        assert_eq!(target.sslmode, "require");
    }

    #[test]
    fn accepts_verify_full_while_preserving_the_declared_policy() {
        let target = describe_postgres_connection_target(
            "postgres://user:secret@example.neon.tech/neondb?sslmode=verify-full",
        );

        assert_eq!(target.host, "example.neon.tech");
        assert_eq!(target.sslmode, "verify-full");
    }

    #[test]
    fn accepts_verify_full_in_key_value_connection_strings() {
        let target = describe_postgres_connection_target(
            "host=db.example.test password=secret dbname=platform sslmode=verify-full",
        );

        assert_eq!(target.host, "db.example.test");
        assert_eq!(target.sslmode, "verify-full");
    }

    #[test]
    fn treats_a_uri_like_password_as_key_value_conninfo() {
        let target = describe_postgres_connection_target(
            "host=db.example.test password='value://fragment' dbname=platform sslmode=verify-full",
        );

        assert_eq!(target.host, "db.example.test");
        assert_eq!(target.database, "platform");
        assert_eq!(target.sslmode, "verify-full");
    }

    #[test]
    fn rejects_duplicate_sslmode_in_url_and_key_value_connections() {
        assert!(parse_postgres_config(
            "postgres://user:secret@example.neon.tech/neondb?sslmode=verify-full&sslmode=disable",
        )
        .is_err());
        assert!(parse_postgres_config(
            "host=db.example.test dbname=platform sslmode=verify-full sslmode=disable",
        )
        .is_err());
    }

    #[test]
    fn fails_closed_for_unparseable_connection_target() {
        let target = describe_postgres_connection_target("not a valid connection string");

        assert_eq!(target.host, "unknown");
        assert_eq!(target.port, 0);
        assert_eq!(target.database, "unknown");
        assert_eq!(target.sslmode, "unknown");
    }

    #[test]
    fn unparseable_targets_never_match_each_other() {
        assert!(!postgres_connection_targets_match(
            "invalid left",
            "invalid right"
        ));
    }

    #[test]
    fn matches_neon_pooler_and_direct_hosts_for_same_endpoint() {
        assert!(postgres_connection_targets_match(
            "postgres://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
            "postgres://user:secret@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require",
        ));
    }

    #[test]
    fn rejects_different_postgres_targets() {
        assert!(!postgres_connection_targets_match(
            "postgres://user:secret@ep-one.us-east-2.aws.neon.tech/neondb?sslmode=require",
            "postgres://user:secret@ep-two.us-east-2.aws.neon.tech/neondb?sslmode=require",
        ));
    }

    #[test]
    fn rejects_different_postgres_target_ports() {
        assert!(!postgres_connection_targets_match(
            "postgres://user:secret@localhost:6432/neondb?sslmode=disable",
            "postgres://user:secret@localhost:5432/neondb?sslmode=disable",
        ));
    }

    #[test]
    fn does_not_normalize_non_neon_pooler_hosts() {
        assert!(!postgres_connection_targets_match(
            "postgres://user:secret@db-pooler.example.test/neondb?sslmode=require",
            "postgres://user:secret@db.example.test/neondb?sslmode=require",
        ));
    }
}
