use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use postgres::{Client, GenericClient};
use rust_auth::{
    require_trusted_app_auth_context, trusted_app_auth_body_sha256,
    trusted_app_auth_secret_from_environment, TrustedAppAuthRequest,
    TRUSTED_APP_AUTH_BODY_SHA256_HEADER, TRUSTED_APP_AUTH_SIGNATURE_HEADER,
    TRUSTED_APP_AUTH_TIMESTAMP_HEADER,
};
use serde_json::json;

use http_transport::{ApplicationRequest as Request, ApplicationResponse as Response};

const INTERNAL_REQUEST_TARGET: &str = "__platform_request_target";
pub const AUTH_APP_ID_HEADER: &str = "x-platform-auth-app-id";
pub const AUTH_CUSTOMER_ID_HEADER: &str = "x-platform-auth-customer-id";
pub const AUTH_ACTOR_ID_HEADER: &str = "x-platform-auth-actor-id";
pub const AUTH_PERMISSIONS_HEADER: &str = "x-platform-auth-permissions";
pub const AUTH_ORGANIZATION_ROLE_HEADER: &str = "x-platform-auth-organization-role";
const TRUSTED_APP_AUTH_MAX_CLOCK_SKEW_MS: u128 = 5 * 60 * 1_000;
const TRUSTED_MUTATION_REPLAY_RETENTION_MS: u128 = 2 * TRUSTED_APP_AUTH_MAX_CLOCK_SKEW_MS;
const TRUSTED_MUTATION_REPLAY_CLEANUP_LIMIT: i64 = 100;

pub type ClaimTrustedMutation =
    fn(app_id: &str, principal_jti: &str, expires_at_ms: i64) -> Result<bool, String>;

#[derive(Clone, Copy)]
pub struct AuthScope<'a> {
    pub app_id: &'static str,
    pub customer_id: Option<&'a str>,
    pub claim_trusted_mutation: ClaimTrustedMutation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthenticatedScope {
    pub app_id: String,
    pub customer_id: String,
    pub actor_id: String,
    pub organization_role: Option<String>,
    pub permissions: BTreeSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct AuthFailure {
    status: u16,
    code: &'static str,
    message: String,
}

pub fn authorize_request(request: &mut Request, scope: AuthScope<'_>) -> Option<Response> {
    if !is_app_api_path(&request.path) {
        return None;
    }
    match authorize_api_request(request, scope) {
        Ok(authenticated_scope) => {
            attach_authenticated_scope_headers(request, &authenticated_scope);
            None
        }
        Err(failure) => Some(auth_failure_response(failure)),
    }
}

fn attach_authenticated_scope_headers(
    request: &mut Request,
    authenticated_scope: &AuthenticatedScope,
) {
    request.headers.insert(
        AUTH_APP_ID_HEADER.to_string(),
        authenticated_scope.app_id.clone(),
    );
    request.headers.insert(
        AUTH_CUSTOMER_ID_HEADER.to_string(),
        authenticated_scope.customer_id.clone(),
    );
    request.headers.insert(
        AUTH_ACTOR_ID_HEADER.to_string(),
        authenticated_scope.actor_id.clone(),
    );
    request.headers.insert(
        AUTH_PERMISSIONS_HEADER.to_string(),
        authenticated_scope
            .permissions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(","),
    );
    if let Some(role) = &authenticated_scope.organization_role {
        request
            .headers
            .insert(AUTH_ORGANIZATION_ROLE_HEADER.to_string(), role.clone());
    } else {
        request.headers.remove(AUTH_ORGANIZATION_ROLE_HEADER);
    }
}

fn is_app_api_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

fn authorize_api_request(
    request: &Request,
    scope: AuthScope<'_>,
) -> Result<AuthenticatedScope, AuthFailure> {
    if !request
        .headers
        .contains_key(TRUSTED_APP_AUTH_SIGNATURE_HEADER)
    {
        return Err(missing_session_failure());
    }
    let secret = trusted_app_auth_secret_from_environment(scope.app_id)
        .map_err(|_| auth_config_failure("Trusted app identity is not configured"))?;
    authorize_trusted_api_request_with_secret(request, scope, &secret)
}

fn authorize_trusted_api_request_with_secret(
    request: &Request,
    scope: AuthScope<'_>,
    secret: &str,
) -> Result<AuthenticatedScope, AuthFailure> {
    let context = require_trusted_app_auth_context(&TrustedRequest(request), secret)
        .map_err(|_| missing_session_failure())?;
    if context.app_id.as_deref() != Some(scope.app_id) {
        return Err(missing_session_failure());
    }
    if scope
        .customer_id
        .is_some_and(|customer_id| customer_id != context.customer_id)
    {
        return Err(tenant_scope_failure(
            "Authenticated customer scope does not match the request.".to_string(),
        ));
    }
    let (_, accepted_at_ms) = require_trusted_timestamp(request)?;
    let expected_body = request
        .headers
        .get(TRUSTED_APP_AUTH_BODY_SHA256_HEADER)
        .map(String::as_str)
        .unwrap_or_default();
    if expected_body != trusted_app_auth_body_sha256(&request.body) {
        return Err(missing_session_failure());
    }
    require_fresh_mutation_principal(
        request,
        scope,
        context.principal_jti.as_deref(),
        accepted_at_ms,
    )?;
    Ok(AuthenticatedScope {
        app_id: scope.app_id.to_string(),
        customer_id: context.customer_id,
        actor_id: context.actor_id,
        organization_role: context.organization_role,
        permissions: context.permissions,
    })
}

fn require_trusted_timestamp(request: &Request) -> Result<(u128, u128), AuthFailure> {
    let timestamp = request
        .headers
        .get(TRUSTED_APP_AUTH_TIMESTAMP_HEADER)
        .and_then(|value| value.trim().parse::<u128>().ok())
        .ok_or_else(missing_session_failure)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| auth_config_failure("System clock is before Unix epoch"))?
        .as_millis();
    if now.abs_diff(timestamp) > TRUSTED_APP_AUTH_MAX_CLOCK_SKEW_MS {
        return Err(missing_session_failure());
    }
    Ok((timestamp, now))
}

fn require_fresh_mutation_principal(
    request: &Request,
    scope: AuthScope<'_>,
    principal_jti: Option<&str>,
    accepted_at_ms: u128,
) -> Result<(), AuthFailure> {
    if !is_mutation_method(&request.method) {
        return Ok(());
    }
    let principal_jti = principal_jti
        .filter(|value| {
            value.len() <= 128
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                })
        })
        .ok_or_else(missing_session_failure)?;
    let expires_at_ms = accepted_at_ms
        .checked_add(TRUSTED_MUTATION_REPLAY_RETENTION_MS)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(missing_session_failure)?;
    match (scope.claim_trusted_mutation)(scope.app_id, principal_jti, expires_at_ms) {
        Ok(true) => Ok(()),
        Ok(false) => Err(missing_session_failure()),
        Err(message) => Err(auth_config_failure(message)),
    }
}

pub fn ensure_trusted_mutation_replay_table(client: &mut Client) -> Result<(), postgres::Error> {
    let mut transaction = client.transaction()?;
    let schema_name: String = transaction
        .query_one("select current_schema()", &[])?
        .get(0);
    let lock_name =
        format!("postgres-schema:{schema_name}:trusted-mutation-replay-table-materialization");
    transaction.query_one(
        "select pg_advisory_xact_lock(hashtext($1)::bigint)",
        &[&lock_name],
    )?;
    transaction.batch_execute(
        r#"
        create table if not exists trusted_mutation_replay (
            app_id text not null,
            principal_jti text not null,
            expires_at timestamptz not null,
            primary key (app_id, principal_jti),
            check (length(app_id) between 1 and 64),
            check (length(principal_jti) between 1 and 128)
        );
        "#,
    )?;
    transaction.commit()
}

pub fn claim_trusted_mutation_in_postgres(
    client: &mut impl GenericClient,
    app_id: &str,
    principal_jti: &str,
    expires_at_ms: i64,
) -> Result<bool, postgres::Error> {
    let claimed = client.query_opt(
        r#"
        with expired as (
            select ctid
            from trusted_mutation_replay
            where expires_at < now() - interval '5 minutes'
              and not (app_id = $1 and principal_jti = $2)
            order by expires_at
            limit $4
            for update skip locked
        ),
        cleanup as (
            delete from trusted_mutation_replay
            where ctid in (select ctid from expired)
        )
        insert into trusted_mutation_replay (app_id, principal_jti, expires_at)
        values ($1, $2, to_timestamp($3::bigint / 1000.0))
        on conflict (app_id, principal_jti) do update
        set expires_at = excluded.expires_at
        where trusted_mutation_replay.expires_at < now() - interval '5 minutes'
        returning 1
        "#,
        &[
            &app_id,
            &principal_jti,
            &expires_at_ms,
            &TRUSTED_MUTATION_REPLAY_CLEANUP_LIMIT,
        ],
    )?;
    Ok(claimed.is_some())
}

struct TrustedRequest<'a>(&'a Request);

impl TrustedAppAuthRequest for TrustedRequest<'_> {
    fn method(&self) -> &str {
        &self.0.method
    }

    fn path(&self) -> &str {
        self.0
            .headers
            .get(INTERNAL_REQUEST_TARGET)
            .map(String::as_str)
            .unwrap_or(&self.0.path)
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.0.headers.get(name).map(String::as_str)
    }
}

fn is_mutation_method(method: &str) -> bool {
    matches!(
        method.to_ascii_uppercase().as_str(),
        "POST" | "PUT" | "PATCH" | "DELETE"
    )
}

fn missing_session_failure() -> AuthFailure {
    AuthFailure {
        status: 401,
        code: "auth_required",
        message: "Authentication is required.".to_string(),
    }
}

fn tenant_scope_failure(message: String) -> AuthFailure {
    AuthFailure {
        status: 403,
        code: "tenant_required",
        message,
    }
}

fn auth_config_failure(message: impl Into<String>) -> AuthFailure {
    AuthFailure {
        status: 500,
        code: "auth_not_configured",
        message: message.into(),
    }
}

fn auth_failure_response(failure: AuthFailure) -> Response {
    let message = if failure.status >= 500 {
        "Authentication service is unavailable."
    } else {
        failure.message.as_str()
    };
    Response::json(
        failure.status,
        &json!({
            "code": failure.code,
            "message": message
        }),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rust_auth::{
        sign_trusted_app_auth_context, trusted_app_auth_body_sha256,
        TRUSTED_APP_AUTH_ACTOR_ID_HEADER, TRUSTED_APP_AUTH_APP_ID_HEADER,
        TRUSTED_APP_AUTH_BODY_SHA256_HEADER, TRUSTED_APP_AUTH_CUSTOMER_ID_HEADER,
        TRUSTED_APP_AUTH_PERMISSIONS_HEADER, TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER,
        TRUSTED_APP_AUTH_SIGNATURE_HEADER, TRUSTED_APP_AUTH_TIMESTAMP_HEADER,
    };

    use super::{
        attach_authenticated_scope_headers, authorize_trusted_api_request_with_secret, AuthScope,
        AuthenticatedScope, TrustedRequest, AUTH_PERMISSIONS_HEADER,
    };
    use http_transport::ApplicationRequest as Request;

    const SECRET: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const HC_SCOPE: AuthScope = AuthScope {
        app_id: "hc",
        customer_id: None,
        claim_trusted_mutation: claim_test_mutation,
    };
    static REQUEST_SEQUENCE: AtomicUsize = AtomicUsize::new(1);

    fn claim_test_mutation(
        app_id: &str,
        principal_jti: &str,
        _expires_at_ms: i64,
    ) -> Result<bool, String> {
        static CLAIMS: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
        Ok(CLAIMS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| "test replay claim lock is unavailable".to_string())?
            .insert((app_id.to_string(), principal_jti.to_string())))
    }

    #[test]
    fn unsigned_browser_credentials_do_not_enter_the_product_auth_path() {
        let mut request = api_request("GET");
        request.headers.insert(
            "cookie".to_string(),
            "better-auth.session_token=browser-session".to_string(),
        );

        let failure =
            authorize_trusted_api_request_with_secret(&request, HC_SCOPE, SECRET).unwrap_err();

        assert_eq!(failure.status, 401);
        assert_eq!(failure.code, "auth_required");
    }

    #[test]
    fn signed_reads_are_reusable_but_mutations_are_single_use() {
        let read = signed_request("GET", true);
        authorize_trusted_api_request_with_secret(&read, HC_SCOPE, SECRET).unwrap();
        authorize_trusted_api_request_with_secret(&read, HC_SCOPE, SECRET).unwrap();

        let mutation = signed_request("POST", true);
        authorize_trusted_api_request_with_secret(&mutation, HC_SCOPE, SECRET).unwrap();
        let replay =
            authorize_trusted_api_request_with_secret(&mutation, HC_SCOPE, SECRET).unwrap_err();

        assert_eq!(replay.status, 401);
        assert_eq!(replay.code, "auth_required");
    }

    #[test]
    fn signed_mutations_require_a_bound_principal_jti() {
        let request = signed_request("POST", false);

        let failure =
            authorize_trusted_api_request_with_secret(&request, HC_SCOPE, SECRET).unwrap_err();

        assert_eq!(failure.status, 401);
        assert_eq!(failure.code, "auth_required");
    }

    #[test]
    fn principal_jti_is_covered_by_the_api_signature() {
        let mut request = signed_request("POST", true);
        request.headers.insert(
            TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER.to_string(),
            "attacker-replacement".to_string(),
        );

        let failure =
            authorize_trusted_api_request_with_secret(&request, HC_SCOPE, SECRET).unwrap_err();

        assert_eq!(failure.status, 401);
        assert_eq!(failure.code, "auth_required");
    }

    #[test]
    fn signed_mutation_rejects_body_bytes_changed_after_signing() {
        let mut request = signed_request("POST", true);
        request.body = br#"{"ok":false}"#.to_vec();

        let failure =
            authorize_trusted_api_request_with_secret(&request, HC_SCOPE, SECRET).unwrap_err();

        assert_eq!(failure.status, 401);
        assert_eq!(failure.code, "auth_required");
    }

    #[test]
    fn authenticated_scope_overwrites_incoming_permission_headers() {
        let mut request = api_request("GET");
        request.headers.insert(
            AUTH_PERMISSIONS_HEADER.to_string(),
            "dev:access".to_string(),
        );
        attach_authenticated_scope_headers(
            &mut request,
            &AuthenticatedScope {
                app_id: "hc".to_string(),
                customer_id: "customer_1".to_string(),
                actor_id: "actor_1".to_string(),
                organization_role: None,
                permissions: ["records:read".to_string()].into_iter().collect(),
            },
        );

        assert_eq!(
            request
                .headers
                .get(AUTH_PERMISSIONS_HEADER)
                .map(String::as_str),
            Some("records:read")
        );
    }

    fn signed_request(method: &str, include_jti: bool) -> Request {
        let mut request = api_request(method);
        request.body = br#"{"ok":true}"#.to_vec();
        for (name, value) in [
            (TRUSTED_APP_AUTH_ACTOR_ID_HEADER, "actor_1".to_string()),
            (TRUSTED_APP_AUTH_APP_ID_HEADER, "hc".to_string()),
            (
                TRUSTED_APP_AUTH_CUSTOMER_ID_HEADER,
                "customer_1".to_string(),
            ),
            (
                TRUSTED_APP_AUTH_PERMISSIONS_HEADER,
                "records:read records:write".to_string(),
            ),
            (
                TRUSTED_APP_AUTH_BODY_SHA256_HEADER,
                trusted_app_auth_body_sha256(&request.body),
            ),
            (
                TRUSTED_APP_AUTH_TIMESTAMP_HEADER,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    .to_string(),
            ),
        ] {
            request.headers.insert(name.to_string(), value);
        }
        if include_jti {
            request.headers.insert(
                TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER.to_string(),
                format!(
                    "auth-test-{}",
                    REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
                ),
            );
        }
        let signature = sign_trusted_app_auth_context(&TrustedRequest(&request), SECRET).unwrap();
        request
            .headers
            .insert(TRUSTED_APP_AUTH_SIGNATURE_HEADER.to_string(), signature);
        request
    }

    fn api_request(method: &str) -> Request {
        Request {
            method: method.to_string(),
            path: "/api/schema".to_string(),
            headers: BTreeMap::new(),
            query: BTreeMap::new(),
            body: Vec::new(),
        }
    }
}
