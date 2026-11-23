use std::collections::BTreeSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::digest;
use ring::hmac;

use kernel::ErrorEnvelope;

pub const TRUSTED_APP_AUTH_ACTOR_ID_HEADER: &str = "x-platform-actor-id";
pub const TRUSTED_APP_AUTH_ACTOR_NAME_HEADER: &str = "x-platform-actor-name";
pub const TRUSTED_APP_AUTH_APP_ID_HEADER: &str = "x-platform-app-id";
pub const TRUSTED_APP_AUTH_BODY_SHA256_HEADER: &str = "x-platform-body-sha256";
pub const TRUSTED_APP_AUTH_CUSTOMER_ID_HEADER: &str = "x-platform-customer-id";
pub const TRUSTED_APP_AUTH_CUSTOMER_NAME_HEADER: &str = "x-platform-customer-name";
pub const TRUSTED_APP_AUTH_ORGANIZATION_ROLE_HEADER: &str = "x-platform-organization-role";
pub const TRUSTED_APP_AUTH_PERMISSIONS_HEADER: &str = "x-platform-permissions";
pub const TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER: &str = "x-platform-principal-jti";
pub const TRUSTED_APP_AUTH_SIGNATURE_HEADER: &str = "x-platform-auth-context-signature";
pub const TRUSTED_APP_AUTH_TIMESTAMP_HEADER: &str = "x-platform-auth-context-timestamp";

pub fn trusted_app_auth_secret_environment(app_id: &str) -> Result<String, ErrorEnvelope> {
    let normalized = app_id
        .trim()
        .chars()
        .map(|character| match character {
            'a'..='z' => character.to_ascii_uppercase(),
            'A'..='Z' | '0'..='9' => character,
            '-' => '_',
            _ => '\0',
        })
        .collect::<String>();
    if normalized.is_empty() || normalized.contains('\0') {
        return Err(error_envelope(
            "auth_not_configured",
            "Trusted app identity has an invalid application identifier.",
        ));
    }
    Ok(format!("PLATFORM_MFE_{normalized}_TRUSTED_AUTH_SECRET"))
}

pub fn trusted_app_auth_secret_from_environment(app_id: &str) -> Result<String, ErrorEnvelope> {
    let variable = trusted_app_auth_secret_environment(app_id)?;
    std::env::var(variable)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            error_envelope(
                "auth_not_configured",
                "Trusted app identity is not configured.",
            )
        })
}

pub trait TrustedAppAuthRequest {
    fn method(&self) -> &str;
    fn path(&self) -> &str;
    fn header(&self, name: &str) -> Option<&str>;
}

impl TrustedAppAuthRequest for http_transport::ApplicationRequest {
    fn method(&self) -> &str {
        &self.method
    }

    fn path(&self) -> &str {
        self.headers
            .get(http_transport::REQUEST_TARGET_HEADER)
            .map(String::as_str)
            .unwrap_or(&self.path)
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.header(name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedAppAuthContext {
    pub actor_id: String,
    pub actor_name: Option<String>,
    pub app_id: Option<String>,
    pub customer_id: String,
    pub customer_name: Option<String>,
    pub organization_role: Option<String>,
    pub permissions: BTreeSet<String>,
    pub principal_jti: Option<String>,
}

struct TrustedAppAuthFields<'a> {
    actor_id: &'a str,
    actor_name: Option<&'a str>,
    app_id: Option<&'a str>,
    body_sha256: Option<&'a str>,
    timestamp: Option<&'a str>,
    customer_id: &'a str,
    customer_name: Option<&'a str>,
    organization_role: Option<&'a str>,
    permissions: &'a str,
    principal_jti: Option<&'a str>,
}

impl TrustedAppAuthContext {
    pub fn has_permission(&self, permission: &str) -> bool {
        let permission = permission.trim();
        !permission.is_empty() && self.permissions.contains(permission)
    }

    pub fn require_permission(
        &self,
        permission: &str,
        error_code: impl Into<String>,
        error_message: impl Into<String>,
    ) -> Result<(), ErrorEnvelope> {
        if self.has_permission(permission) {
            return Ok(());
        }
        Err(error_envelope(error_code, error_message))
    }

    pub fn require_any_permission<'a>(
        &self,
        permissions: impl IntoIterator<Item = &'a str>,
        error_code: impl Into<String>,
        error_message: impl Into<String>,
    ) -> Result<(), ErrorEnvelope> {
        if permissions
            .into_iter()
            .any(|permission| self.has_permission(permission))
        {
            return Ok(());
        }
        Err(error_envelope(error_code, error_message))
    }

    pub fn require_customer_scope(
        &self,
        expected_customer_id: &str,
        error_code: impl Into<String>,
        error_message: impl Into<String>,
    ) -> Result<(), ErrorEnvelope> {
        if self.customer_id == expected_customer_id {
            return Ok(());
        }
        Err(error_envelope(error_code, error_message))
    }
}

pub fn require_trusted_app_auth_context<R: TrustedAppAuthRequest + ?Sized>(
    request: &R,
    secret: &str,
) -> Result<TrustedAppAuthContext, ErrorEnvelope> {
    let secret = trusted_auth_secret(secret)?;
    let actor_id = required_trimmed_header(
        request,
        TRUSTED_APP_AUTH_ACTOR_ID_HEADER,
        "auth_required",
        "Authentication is required",
    )?;
    let actor_name = optional_trimmed_header(request, TRUSTED_APP_AUTH_ACTOR_NAME_HEADER);
    let app_id = optional_trimmed_header(request, TRUSTED_APP_AUTH_APP_ID_HEADER);
    let customer_id = required_trimmed_header(
        request,
        TRUSTED_APP_AUTH_CUSTOMER_ID_HEADER,
        "tenant_required",
        "Authenticated customer scope is required",
    )?;
    let customer_name = optional_trimmed_header(request, TRUSTED_APP_AUTH_CUSTOMER_NAME_HEADER);
    let organization_role =
        optional_trimmed_header(request, TRUSTED_APP_AUTH_ORGANIZATION_ROLE_HEADER);
    let principal_jti = optional_trimmed_header(request, TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER);
    let body_sha256 = optional_trimmed_header(request, TRUSTED_APP_AUTH_BODY_SHA256_HEADER);
    let timestamp = optional_trimmed_header(request, TRUSTED_APP_AUTH_TIMESTAMP_HEADER);
    let raw_permissions = request
        .header(TRUSTED_APP_AUTH_PERMISSIONS_HEADER)
        .map(str::trim)
        .unwrap_or_default();

    let fields = TrustedAppAuthFields {
        actor_id,
        actor_name,
        app_id,
        body_sha256,
        timestamp,
        customer_id,
        customer_name,
        organization_role,
        permissions: raw_permissions,
        principal_jti,
    };

    verify_trusted_app_auth_context_signature(request, secret, &fields)?;

    Ok(TrustedAppAuthContext {
        actor_id: actor_id.to_string(),
        actor_name: actor_name.map(ToOwned::to_owned),
        app_id: app_id.map(ToOwned::to_owned),
        customer_id: customer_id.to_string(),
        customer_name: customer_name.map(ToOwned::to_owned),
        organization_role: organization_role.map(ToOwned::to_owned),
        permissions: parse_permissions(raw_permissions),
        principal_jti: principal_jti.map(ToOwned::to_owned),
    })
}

pub fn sign_trusted_app_auth_context<R: TrustedAppAuthRequest + ?Sized>(
    request: &R,
    secret: &str,
) -> Result<String, ErrorEnvelope> {
    let secret = trusted_auth_secret(secret)?;
    let actor_id = required_trimmed_header(
        request,
        TRUSTED_APP_AUTH_ACTOR_ID_HEADER,
        "auth_required",
        "Authentication is required",
    )?;
    let actor_name = optional_trimmed_header(request, TRUSTED_APP_AUTH_ACTOR_NAME_HEADER);
    let app_id = optional_trimmed_header(request, TRUSTED_APP_AUTH_APP_ID_HEADER);
    let customer_id = required_trimmed_header(
        request,
        TRUSTED_APP_AUTH_CUSTOMER_ID_HEADER,
        "tenant_required",
        "Authenticated customer scope is required",
    )?;
    let customer_name = optional_trimmed_header(request, TRUSTED_APP_AUTH_CUSTOMER_NAME_HEADER);
    let organization_role =
        optional_trimmed_header(request, TRUSTED_APP_AUTH_ORGANIZATION_ROLE_HEADER);
    let principal_jti = optional_trimmed_header(request, TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER);
    let body_sha256 = optional_trimmed_header(request, TRUSTED_APP_AUTH_BODY_SHA256_HEADER);
    let timestamp = optional_trimmed_header(request, TRUSTED_APP_AUTH_TIMESTAMP_HEADER);
    let raw_permissions = request
        .header(TRUSTED_APP_AUTH_PERMISSIONS_HEADER)
        .map(str::trim)
        .unwrap_or_default();
    let fields = TrustedAppAuthFields {
        actor_id,
        actor_name,
        app_id,
        body_sha256,
        timestamp,
        customer_id,
        customer_name,
        organization_role,
        permissions: raw_permissions,
        principal_jti,
    };
    let payload = trusted_app_auth_payload(request, &fields);
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(hmac::sign(&key, payload.as_bytes()).as_ref()))
}

pub fn trusted_app_auth_body_sha256(body: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, body).as_ref())
}

fn verify_trusted_app_auth_context_signature<R: TrustedAppAuthRequest + ?Sized>(
    request: &R,
    secret: &str,
    fields: &TrustedAppAuthFields<'_>,
) -> Result<(), ErrorEnvelope> {
    let signature = request
        .header(TRUSTED_APP_AUTH_SIGNATURE_HEADER)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(auth_required)?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature.as_bytes())
        .map_err(|_| auth_required())?;
    let payload = trusted_app_auth_payload(request, fields);
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hmac::verify(&key, payload.as_bytes(), &signature_bytes).map_err(|_| auth_required())
}

fn trusted_app_auth_payload<R: TrustedAppAuthRequest + ?Sized>(
    request: &R,
    fields: &TrustedAppAuthFields<'_>,
) -> String {
    let mut payload_fields = vec![("method", request.method()), ("path", request.path())];
    if let Some(app_id) = fields.app_id {
        payload_fields.push(("app_id", app_id));
    }
    payload_fields.extend([
        ("actor_id", fields.actor_id),
        ("actor_name", fields.actor_name.unwrap_or_default()),
    ]);
    if let Some(body_sha256) = fields.body_sha256 {
        payload_fields.push(("body_sha256", body_sha256));
    }
    if let Some(timestamp) = fields.timestamp {
        payload_fields.push(("timestamp", timestamp));
    }
    payload_fields.extend([
        ("customer_id", fields.customer_id),
        ("customer_name", fields.customer_name.unwrap_or_default()),
    ]);
    if let Some(organization_role) = fields.organization_role {
        payload_fields.push(("organization_role", organization_role));
    }
    payload_fields.push(("permissions", fields.permissions));
    if let Some(principal_jti) = fields.principal_jti {
        payload_fields.push(("principal_jti", principal_jti));
    }
    let mut payload = String::new();
    for (name, value) in payload_fields {
        payload.push_str(name);
        payload.push(':');
        payload.push_str(&value.len().to_string());
        payload.push('\n');
        payload.push_str(value);
        payload.push('\n');
    }
    payload
}

fn parse_permissions(raw_permissions: &str) -> BTreeSet<String> {
    raw_permissions
        .split(|character: char| character == ',' || character.is_ascii_whitespace())
        .map(str::trim)
        .filter(|permission| !permission.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn required_trimmed_header<'a, R: TrustedAppAuthRequest + ?Sized>(
    request: &'a R,
    header_name: &str,
    error_code: &'static str,
    error_message: &'static str,
) -> Result<&'a str, ErrorEnvelope> {
    request
        .header(header_name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error_envelope(error_code, error_message))
}

fn optional_trimmed_header<'a, R: TrustedAppAuthRequest + ?Sized>(
    request: &'a R,
    header_name: &str,
) -> Option<&'a str> {
    request
        .header(header_name)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn trusted_auth_secret(secret: &str) -> Result<&str, ErrorEnvelope> {
    let secret = secret.trim();
    let decoded = URL_SAFE_NO_PAD.decode(secret).ok();
    if decoded.as_ref().is_none_or(|bytes| bytes.len() < 32)
        || decoded
            .as_ref()
            .is_some_and(|bytes| URL_SAFE_NO_PAD.encode(bytes) != secret)
    {
        return Err(error_envelope(
            "auth_not_configured",
            "Trusted auth context signing secret must be canonical base64url with 256 bits",
        ));
    }
    Ok(secret)
}

fn auth_required() -> ErrorEnvelope {
    error_envelope("auth_required", "Authentication is required")
}

fn error_envelope(code: impl Into<String>, message: impl Into<String>) -> ErrorEnvelope {
    ErrorEnvelope {
        code: code.into(),
        message: message.into(),
        details: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        require_trusted_app_auth_context, sign_trusted_app_auth_context,
        trusted_app_auth_secret_environment, TrustedAppAuthRequest,
        TRUSTED_APP_AUTH_ACTOR_ID_HEADER, TRUSTED_APP_AUTH_ACTOR_NAME_HEADER,
        TRUSTED_APP_AUTH_APP_ID_HEADER, TRUSTED_APP_AUTH_CUSTOMER_ID_HEADER,
        TRUSTED_APP_AUTH_CUSTOMER_NAME_HEADER, TRUSTED_APP_AUTH_ORGANIZATION_ROLE_HEADER,
        TRUSTED_APP_AUTH_PERMISSIONS_HEADER, TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER,
        TRUSTED_APP_AUTH_SIGNATURE_HEADER,
    };
    use std::collections::BTreeMap;

    const SECRET: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn application_requests_bind_auth_to_the_retained_target() {
        let request = http_transport::ApplicationRequest::from_target(
            "GET".to_string(),
            "/api/records?as_of=2026-08-26".to_string(),
            BTreeMap::new(),
            Vec::new(),
        );

        assert_eq!(
            TrustedAppAuthRequest::path(&request),
            "/api/records?as_of=2026-08-26"
        );
    }

    #[test]
    fn app_auth_secret_environment_is_app_namespaced() {
        assert_eq!(
            trusted_app_auth_secret_environment("customer-success").unwrap(),
            "PLATFORM_MFE_CUSTOMER_SUCCESS_TRUSTED_AUTH_SECRET"
        );
        assert!(trusted_app_auth_secret_environment("../example").is_err());
    }

    #[test]
    fn app_auth_guard_rejects_missing_auth() {
        let request = TestRequest::new("POST", "/api/app-management/token");

        let error = require_trusted_app_auth_context(&request, SECRET).unwrap_err();

        assert_eq!(error.code, "auth_required");
    }

    #[test]
    fn app_auth_guard_rejects_weak_shared_secrets() {
        let request = TestRequest::new("POST", "/api/app-management/token");

        let error = require_trusted_app_auth_context(&request, "x").unwrap_err();

        assert_eq!(error.code, "auth_not_configured");
    }

    #[test]
    fn app_auth_context_requires_named_permission() {
        let request = signed_request("POST", "/api/app-management/token", "demo", "");
        let context = require_trusted_app_auth_context(&request, SECRET).unwrap();

        let error = context
            .require_permission(
                "integrations:manage",
                "integration_management_forbidden",
                "Integration management permission is required",
            )
            .unwrap_err();

        assert_eq!(error.code, "integration_management_forbidden");
    }

    #[test]
    fn app_auth_context_requires_any_permission() {
        let request = signed_request(
            "POST",
            "/api/app-management/token",
            "demo",
            "records:read records:approve",
        );
        let context = require_trusted_app_auth_context(&request, SECRET).unwrap();

        context
            .require_any_permission(
                ["integrations:manage", "records:approve"],
                "integration_management_forbidden",
                "Integration management permission is required",
            )
            .unwrap();
        let error = context
            .require_any_permission(
                ["integrations:manage", "records:write"],
                "integration_management_forbidden",
                "Integration management permission is required",
            )
            .unwrap_err();

        assert_eq!(error.code, "integration_management_forbidden");
    }

    #[test]
    fn app_auth_context_rejects_mismatched_customer_scope() {
        let request = signed_request(
            "POST",
            "/api/app-management/token",
            "other_customer",
            "integrations:manage",
        );
        let context = require_trusted_app_auth_context(&request, SECRET).unwrap();

        let error = context
            .require_customer_scope(
                "demo",
                "integration_customer_scope_mismatch",
                "Authenticated customer scope does not match",
            )
            .unwrap_err();

        assert_eq!(error.code, "integration_customer_scope_mismatch");
    }

    #[test]
    fn app_auth_guard_parses_valid_context() {
        let request = signed_request(
            "POST",
            "/api/app-management/token",
            "demo",
            "integrations:manage, records:approve",
        );

        let context = require_trusted_app_auth_context(&request, SECRET).unwrap();

        assert_eq!(context.actor_id, "user_1");
        assert_eq!(context.actor_name.as_deref(), Some("User One"));
        assert_eq!(context.app_id, None);
        assert_eq!(context.customer_id, "demo");
        assert_eq!(context.customer_name.as_deref(), Some("Demo Customer"));
        assert!(context.has_permission("integrations:manage"));
        assert!(context.has_permission("records:approve"));
        context
            .require_permission(
                "integrations:manage",
                "integration_management_forbidden",
                "Integration management permission is required",
            )
            .unwrap();
        context
            .require_customer_scope(
                "demo",
                "integration_customer_scope_mismatch",
                "Authenticated customer scope does not match",
            )
            .unwrap();
    }

    #[test]
    fn app_auth_context_cryptographically_binds_an_optional_app_id() {
        let mut request = auth_request("GET", "/api/schema", "demo", "records:read");
        request.headers.insert(
            TRUSTED_APP_AUTH_APP_ID_HEADER.to_string(),
            "sample-app".to_string(),
        );
        let signature = sign_trusted_app_auth_context(&request, SECRET).unwrap();
        request
            .headers
            .insert(TRUSTED_APP_AUTH_SIGNATURE_HEADER.to_string(), signature);

        let context = require_trusted_app_auth_context(&request, SECRET).unwrap();
        assert_eq!(context.app_id.as_deref(), Some("sample-app"));
        assert_eq!(context.organization_role.as_deref(), Some("admin"));

        request.headers.insert(
            TRUSTED_APP_AUTH_APP_ID_HEADER.to_string(),
            "other".to_string(),
        );
        let error = require_trusted_app_auth_context(&request, SECRET).unwrap_err();
        assert_eq!(error.code, "auth_required");
    }

    #[test]
    fn app_auth_context_cryptographically_binds_an_optional_principal_jti() {
        let mut request = auth_request("POST", "/api/records", "demo", "records:write");
        request.headers.insert(
            TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER.to_string(),
            "gateway-request-1".to_string(),
        );
        let signature = sign_trusted_app_auth_context(&request, SECRET).unwrap();
        request
            .headers
            .insert(TRUSTED_APP_AUTH_SIGNATURE_HEADER.to_string(), signature);

        let context = require_trusted_app_auth_context(&request, SECRET).unwrap();
        assert_eq!(context.principal_jti.as_deref(), Some("gateway-request-1"));

        request.headers.insert(
            TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER.to_string(),
            "gateway-request-2".to_string(),
        );
        let error = require_trusted_app_auth_context(&request, SECRET).unwrap_err();
        assert_eq!(error.code, "auth_required");
    }

    #[test]
    fn app_auth_guard_rejects_unsigned_client_headers() {
        let request = auth_request(
            "POST",
            "/api/app-management/token",
            "demo",
            "integrations:manage",
        );

        let error = require_trusted_app_auth_context(&request, SECRET).unwrap_err();

        assert_eq!(error.code, "auth_required");
    }

    fn signed_request(
        method: &str,
        path: &str,
        customer_id: &str,
        permissions: &str,
    ) -> TestRequest {
        let mut request = auth_request(method, path, customer_id, permissions);
        let signature = sign_trusted_app_auth_context(&request, SECRET).unwrap();
        request
            .headers
            .insert(TRUSTED_APP_AUTH_SIGNATURE_HEADER.to_string(), signature);
        request
    }

    fn auth_request(method: &str, path: &str, customer_id: &str, permissions: &str) -> TestRequest {
        let mut headers = BTreeMap::from([
            (
                TRUSTED_APP_AUTH_ACTOR_ID_HEADER.to_string(),
                " user_1 ".to_string(),
            ),
            (
                TRUSTED_APP_AUTH_ACTOR_NAME_HEADER.to_string(),
                " User One ".to_string(),
            ),
            (
                TRUSTED_APP_AUTH_CUSTOMER_ID_HEADER.to_string(),
                format!(" {customer_id} "),
            ),
            (
                TRUSTED_APP_AUTH_CUSTOMER_NAME_HEADER.to_string(),
                " Demo Customer ".to_string(),
            ),
            (
                TRUSTED_APP_AUTH_ORGANIZATION_ROLE_HEADER.to_string(),
                " admin ".to_string(),
            ),
        ]);
        if !permissions.is_empty() {
            headers.insert(
                TRUSTED_APP_AUTH_PERMISSIONS_HEADER.to_string(),
                permissions.to_string(),
            );
        }
        TestRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers,
        }
    }

    struct TestRequest {
        method: String,
        path: String,
        headers: BTreeMap<String, String>,
    }

    impl TestRequest {
        fn new(method: &str, path: &str) -> Self {
            Self {
                method: method.to_string(),
                path: path.to_string(),
                headers: BTreeMap::new(),
            }
        }
    }

    impl TrustedAppAuthRequest for TestRequest {
        fn method(&self) -> &str {
            &self.method
        }

        fn path(&self) -> &str {
            &self.path
        }

        fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name).map(String::as_str)
        }
    }
}
