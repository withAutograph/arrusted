use std::fmt;

use kernel::{QueryResult, QueryVisibleSql};
use serde_json::{json, Value};

const DEFAULT_QUERY_TIMEOUT_MS: u64 = 1_000;
const MAX_QUERY_TIMEOUT_MS: u64 = 5_000;

/// Driver boundary for the generated visible-query protocol.
///
/// Implementations must keep the returned transaction on the same physical
/// connection as `cleanup_visible_query`. The adapter owns the transaction
/// lifecycle and never commits caller SQL.
pub trait GeneratedQueryClient {
    type Error: fmt::Display;
    type Transaction<'a>: GeneratedQueryTransaction<Error = Self::Error>
    where
        Self: 'a;

    fn begin_generated_query(&mut self) -> Result<Self::Transaction<'_>, Self::Error>;

    fn cleanup_visible_query(&mut self, statement: &str) -> Result<(), Self::Error>;
}

/// Operations a database driver must provide inside one generated query
/// transaction. `execute_caller_query` is invoked only after validation and
/// after privileges have been reduced to the generated schema's query role.
pub trait GeneratedQueryTransaction: Sized {
    type Error: fmt::Display;

    fn call_json(&mut self, statement: &str, request: &Value) -> Result<Value, Self::Error>;

    fn batch_execute(&mut self, statement: &str) -> Result<(), Self::Error>;

    fn execute_caller_query(
        &mut self,
        request: &QueryVisibleSql,
    ) -> Result<QueryResult, GeneratedQueryExecutionError<Self::Error>>;

    fn rollback(self) -> Result<(), Self::Error>;
}

#[derive(Debug)]
pub enum GeneratedQueryExecutionError<E> {
    Rejected(String),
    Timeout(String),
    Database(E),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeneratedQueryError {
    Rejected {
        code: String,
        message: String,
    },
    Timeout {
        message: String,
    },
    Protocol {
        message: String,
    },
    Database {
        phase: &'static str,
        message: String,
    },
}

impl fmt::Display for GeneratedQueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Rejected { code, message } => write!(formatter, "{code}: {message}"),
            Self::Timeout { message } => write!(formatter, "query_timeout: {message}"),
            Self::Protocol { message } => write!(formatter, "query_protocol_error: {message}"),
            Self::Database { phase, message } => {
                write!(formatter, "generated query {phase} failed: {message}")
            }
        }
    }
}

impl std::error::Error for GeneratedQueryError {}

/// Executes arbitrary read SQL through the generated same-session protocol.
///
/// The generated functions prepare and validate tenant-scoped temporary views.
/// Caller SQL runs directly from Rust only after `SET LOCAL ROLE` assumes the
/// schema-specific role returned by the prepare API; it is never passed to a
/// `SECURITY DEFINER` executor. The transaction is always rolled back, then
/// temporary views are cleaned outside the transaction so residue from an
/// earlier interrupted request cannot survive.
pub fn query_generated_visible_sql<C>(
    client: &mut C,
    generated_schema: &str,
    request: &QueryVisibleSql,
) -> Result<QueryResult, GeneratedQueryError>
where
    C: GeneratedQueryClient,
{
    let schema = quote_identifier(generated_schema)?;
    let prepare_statement = format!("select {schema}.kernel_prepare_visible_query($1::jsonb)");
    let validate_statement = format!("select {schema}.kernel_validate_visible_query($1::jsonb)");
    let cleanup_statement = format!("select {schema}.kernel_cleanup_visible_query()");
    let timeout_ms = request
        .statement_timeout_ms
        .unwrap_or(DEFAULT_QUERY_TIMEOUT_MS)
        .clamp(1, MAX_QUERY_TIMEOUT_MS);

    client
        .cleanup_visible_query(&cleanup_statement)
        .map_err(|error| database_error("preflight cleanup", error))?;
    let mut transaction = client
        .begin_generated_query()
        .map_err(|error| database_error("begin", error))?;
    let outcome = run_query_protocol(
        &mut transaction,
        request,
        &prepare_statement,
        &validate_statement,
        timeout_ms,
    );
    let rollback = transaction
        .rollback()
        .map_err(|error| database_error("rollback", error));
    let cleanup = client
        .cleanup_visible_query(&cleanup_statement)
        .map_err(|error| database_error("cleanup", error));
    rollback?;
    cleanup?;
    outcome
}

fn run_query_protocol<T>(
    transaction: &mut T,
    request: &QueryVisibleSql,
    prepare_statement: &str,
    validate_statement: &str,
    timeout_ms: u64,
) -> Result<QueryResult, GeneratedQueryError>
where
    T: GeneratedQueryTransaction,
{
    let prepared = transaction
        .call_json(
            prepare_statement,
            &json!({
                "app_id": request.app_id,
                "customer_id": request.customer_id,
                "as_of": request.as_of,
            }),
        )
        .map_err(|error| database_error("prepare visible views", error))?;
    require_ok_envelope(&prepared)?;
    let query_role = prepared
        .pointer("/data/query_role")
        .and_then(Value::as_str)
        .ok_or_else(|| GeneratedQueryError::Protocol {
            message: "generated prepare response omitted query_role".to_string(),
        })?;
    let query_role = quote_identifier(query_role)?;

    transaction
        .batch_execute(&format!(
            "set local transaction_read_only = on; set local search_path to pg_temp, pg_catalog; set local role {query_role}; set local statement_timeout = '{timeout_ms}ms'; set local work_mem = '4MB'"
        ))
        .map_err(|error| database_error("reduce privileges", error))?;

    let validation = transaction
        .call_json(
            validate_statement,
            &json!({"sql": request.sql, "params": request.params}),
        )
        .map_err(|error| database_error("validate", error))?;
    require_ok_envelope(&validation)?;

    transaction
        .execute_caller_query(request)
        .map_err(|error| match error {
            GeneratedQueryExecutionError::Rejected(message) => GeneratedQueryError::Rejected {
                code: "query_rejected".to_string(),
                message,
            },
            GeneratedQueryExecutionError::Timeout(message) => {
                GeneratedQueryError::Timeout { message }
            }
            GeneratedQueryExecutionError::Database(error) => database_error("execute", error),
        })
}

fn require_ok_envelope(envelope: &Value) -> Result<(), GeneratedQueryError> {
    if envelope.get("ok") == Some(&Value::Bool(true)) {
        return Ok(());
    }
    let error = envelope
        .get("error")
        .and_then(Value::as_object)
        .ok_or_else(|| GeneratedQueryError::Protocol {
            message: "generated function returned an invalid result envelope".to_string(),
        })?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("query_rejected")
        .to_string();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("query rejected")
        .to_string();
    if code == "query_timeout" {
        Err(GeneratedQueryError::Timeout { message })
    } else {
        Err(GeneratedQueryError::Rejected { code, message })
    }
}

fn quote_identifier(value: &str) -> Result<String, GeneratedQueryError> {
    if value.is_empty() || value.contains('\0') {
        return Err(GeneratedQueryError::Protocol {
            message: "generated schema identifier is invalid".to_string(),
        });
    }
    Ok(format!("\"{}\"", value.replace('"', "\"\"")))
}

fn database_error(error_phase: &'static str, error: impl fmt::Display) -> GeneratedQueryError {
    GeneratedQueryError::Database {
        phase: error_phase,
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use kernel::{AppId, CustomerId};

    use super::*;

    #[derive(Clone, Copy, Debug)]
    struct FakeError(&'static str);

    impl fmt::Display for FakeError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    struct FakeClient {
        events: Rc<RefCell<Vec<&'static str>>>,
        prepare: Value,
        validation: Value,
        rollback_error: Option<FakeError>,
    }

    struct FakeTransaction {
        events: Rc<RefCell<Vec<&'static str>>>,
        responses: Vec<Value>,
        rollback_error: Option<FakeError>,
    }

    impl GeneratedQueryClient for FakeClient {
        type Error = FakeError;
        type Transaction<'a> = FakeTransaction;

        fn begin_generated_query(&mut self) -> Result<Self::Transaction<'_>, Self::Error> {
            self.events.borrow_mut().push("begin");
            Ok(FakeTransaction {
                events: Rc::clone(&self.events),
                responses: vec![self.validation.clone(), self.prepare.clone()],
                rollback_error: self.rollback_error,
            })
        }

        fn cleanup_visible_query(&mut self, _statement: &str) -> Result<(), Self::Error> {
            self.events.borrow_mut().push("cleanup");
            Ok(())
        }
    }

    impl GeneratedQueryTransaction for FakeTransaction {
        type Error = FakeError;

        fn call_json(&mut self, _statement: &str, _request: &Value) -> Result<Value, Self::Error> {
            let phase = if self.responses.len() == 2 {
                "prepare"
            } else {
                "validate"
            };
            self.events.borrow_mut().push(phase);
            Ok(self.responses.pop().expect("fake response"))
        }

        fn batch_execute(&mut self, _statement: &str) -> Result<(), Self::Error> {
            self.events.borrow_mut().push("reduce");
            Ok(())
        }

        fn execute_caller_query(
            &mut self,
            _request: &QueryVisibleSql,
        ) -> Result<QueryResult, GeneratedQueryExecutionError<Self::Error>> {
            self.events.borrow_mut().push("execute");
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
            })
        }

        fn rollback(self) -> Result<(), Self::Error> {
            self.events.borrow_mut().push("rollback");
            self.rollback_error.map_or(Ok(()), Err)
        }
    }

    #[test]
    fn protocol_reduces_privileges_and_never_commits() {
        let (mut client, events) = fake_client(json!({"ok": true}), None);
        let result = query_generated_visible_sql(&mut client, "generated", &request()).unwrap();
        assert!(result.rows.is_empty());
        assert_eq!(
            *events.borrow(),
            [
                "cleanup", "begin", "prepare", "reduce", "validate", "execute", "rollback",
                "cleanup"
            ]
        );
    }

    #[test]
    fn rejected_validation_rolls_back_and_cleans_without_executing() {
        let (mut client, events) = fake_client(
            json!({
                "ok": false,
                "error": {"code": "query_rejected", "message": "unsafe"}
            }),
            None,
        );
        assert!(matches!(
            query_generated_visible_sql(&mut client, "generated", &request()),
            Err(GeneratedQueryError::Rejected { .. })
        ));
        assert_eq!(
            *events.borrow(),
            ["cleanup", "begin", "prepare", "reduce", "validate", "rollback", "cleanup"]
        );
    }

    #[test]
    fn cleanup_is_attempted_after_a_rollback_error() {
        let (mut client, events) = fake_client(json!({"ok": true}), Some(FakeError("rollback")));
        assert!(matches!(
            query_generated_visible_sql(&mut client, "generated", &request()),
            Err(GeneratedQueryError::Database {
                phase: "rollback",
                ..
            })
        ));
        assert_eq!(events.borrow().last(), Some(&"cleanup"));
    }

    fn fake_client(
        validation: Value,
        rollback_error: Option<FakeError>,
    ) -> (FakeClient, Rc<RefCell<Vec<&'static str>>>) {
        let events = Rc::new(RefCell::new(vec![]));
        (
            FakeClient {
                events: Rc::clone(&events),
                prepare: json!({"ok": true, "data": {"query_role": "generated_query"}}),
                validation,
                rollback_error,
            },
            events,
        )
    }

    fn request() -> QueryVisibleSql {
        QueryVisibleSql {
            app_id: AppId::from("app"),
            customer_id: CustomerId::from("customer"),
            as_of: None,
            sql: "select 1".to_string(),
            params: vec![],
            statement_timeout_ms: None,
        }
    }
}
