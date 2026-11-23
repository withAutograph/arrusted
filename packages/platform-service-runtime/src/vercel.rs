use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::{Mutex, OnceLock};

use http_body_util::{BodyExt, LengthLimitError, Limited};
use rust_auth::{TRUSTED_APP_AUTH_ACTOR_ID_HEADER, TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER};
use serde_json::json;
use vercel_runtime::{
    run, service_fn, Error, Request as VercelRequest, Response as VercelResponse, ResponseBody,
};

use http_transport::{
    parse_query, url_decode, ApplicationRequest as Request, ApplicationResponse as Response,
};

// Each deployed binary selects exactly one ingress mode at compile time.
#[allow(dead_code)]
#[derive(Clone, Copy)]
pub enum VercelIngressTrust {
    PublicBrowser,
    PrivateService,
}

#[derive(Clone, Copy)]
pub struct AppVercelConfig {
    pub ingress_trust: VercelIngressTrust,
    pub internal_api_prefix: &'static str,
    pub public_api_prefix: &'static str,
    pub max_body_bytes_for_path: fn(&str) -> usize,
    pub prepare_request: fn(&mut Request, VercelIngressTrust) -> Result<(), Response>,
    pub initialize_for_path: fn(&str) -> bool,
    pub initialization_cache_key_for_request: fn(&Request) -> String,
    pub initialize: fn(&Request) -> Result<(), String>,
}

/// Vercel functions are public browser ingress, so platform identity headers
/// on those requests are always caller-controlled. Native zone servers receive
/// these headers only over their private gateway connection and do not use this
/// adapter.
// This shared module is compiled into each Vercel binary; only browser-ingress
// binaries call the helper at a given migration stage.
#[allow(dead_code)]
pub fn strip_client_platform_headers(request: &mut Request) {
    request
        .headers
        .retain(|name, _| !client_platform_header(name));
}

fn client_platform_header(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    let trusted_prefix = TRUSTED_APP_AUTH_ACTOR_ID_HEADER
        .strip_suffix("actor-id")
        .expect("trusted app header must retain its family prefix");
    normalized.starts_with(trusted_prefix) || normalized == TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER
}

static INITIALIZE_LOCK: Mutex<()> = Mutex::new(());
static INITIALIZED_KEYS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
const VERCEL_REWRITE_PATH_QUERY: &str = "__platform_path";

enum BodyReadError {
    TooLarge(usize),
    Runtime(Error),
}

pub async fn run_route(
    route: fn(Request) -> Response,
    config: AppVercelConfig,
) -> Result<(), Error> {
    run(service_fn(move |request| handle(request, route, config))).await
}

async fn handle(
    request: VercelRequest,
    route: fn(Request) -> Response,
    config: AppVercelConfig,
) -> Result<VercelResponse<ResponseBody>, Error> {
    let (parts, body) = request.into_parts();
    let method = parts.method.as_str().to_string();
    let query = parse_query(parts.uri.query());
    let path = normalize_vercel_api_path(
        rewritten_path(config.internal_api_prefix, &query).as_deref(),
        parts.uri.path(),
        config.internal_api_prefix,
        config.public_api_prefix,
    );
    let target = normalized_request_target(&path, parts.uri.query());
    let max_body_bytes = (config.max_body_bytes_for_path)(&path);
    let mut app_request = Request::from_target(
        method,
        target,
        headers_from_vercel(&parts.headers),
        Vec::new(),
    );
    // Delegated app authentication binds the request body digest. Collect the
    // bounded body before any app preparation so every body-bearing route is
    // verified against the bytes that will actually execute.
    let collect_body = async move {
        match Limited::new(body, max_body_bytes).collect().await {
            Ok(body) => Ok(body.to_bytes().to_vec()),
            Err(error) if error.downcast_ref::<LengthLimitError>().is_some() => {
                Err(BodyReadError::TooLarge(max_body_bytes))
            }
            Err(error) => Err(BodyReadError::Runtime(error)),
        }
    };
    app_request = match prepare_bounded_request(app_request, collect_body, config).await? {
        Ok(request) => request,
        Err(response) => return response_from_app_response(response),
    };
    let response = tokio::task::spawn_blocking(move || {
        if (config.initialize_for_path)(&app_request.path) {
            if let Err(message) = initialize_once(config, &app_request) {
                return Response::json(
                    500,
                    &json!({
                        "code": "vercel_app_initialization_failed",
                        "message": message
                    }),
                );
            }
        }
        route(app_request)
    })
    .await?;
    response_from_app_response(response)
}

async fn prepare_bounded_request<F>(
    mut request: Request,
    collect_body: F,
    config: AppVercelConfig,
) -> Result<Result<Request, Response>, Error>
where
    F: Future<Output = Result<Vec<u8>, BodyReadError>>,
{
    request.body = match collect_body.await {
        Ok(body) => body,
        Err(BodyReadError::TooLarge(max_body_bytes)) => {
            return Ok(Err(Response::json(
                413,
                &json!({
                    "code": "request_body_too_large",
                    "message": format!("Request body exceeds {max_body_bytes} bytes")
                }),
            )));
        }
        Err(BodyReadError::Runtime(error)) => return Err(error),
    };
    Ok(tokio::task::spawn_blocking(move || {
        (config.prepare_request)(&mut request, config.ingress_trust).map(|()| request)
    })
    .await?)
}

fn initialize_once(config: AppVercelConfig, request: &Request) -> Result<(), String> {
    let cache_key = (config.initialization_cache_key_for_request)(request);
    {
        let initialized_keys = initialized_keys()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if initialized_keys.contains(&cache_key) {
            return Ok(());
        }
    }
    let _guard = INITIALIZE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    {
        let initialized_keys = initialized_keys()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if initialized_keys.contains(&cache_key) {
            return Ok(());
        }
    }
    (config.initialize)(request)?;
    initialized_keys()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(cache_key);
    Ok(())
}

fn initialized_keys() -> &'static Mutex<BTreeSet<String>> {
    INITIALIZED_KEYS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn response_from_app_response(response: Response) -> Result<VercelResponse<ResponseBody>, Error> {
    Ok(VercelResponse::builder()
        .status(response.status)
        .header("content-type", response.content_type)
        .body(ResponseBody::from(response.body))?)
}

fn headers_from_vercel(headers: &http::HeaderMap) -> BTreeMap<String, String> {
    let mut lowered = BTreeMap::new();
    for (name, value) in headers.iter() {
        let Ok(value) = value.to_str() else {
            continue;
        };
        merge_header(&mut lowered, name.as_str().to_ascii_lowercase(), value);
    }
    lowered
}

fn merge_header(headers: &mut BTreeMap<String, String>, name: String, value: &str) {
    let separator = if name == "cookie" { "; " } else { ", " };
    headers
        .entry(name)
        .and_modify(|existing| {
            existing.push_str(separator);
            existing.push_str(value);
        })
        .or_insert_with(|| value.to_string());
}

fn normalize_vercel_api_path(
    rewritten_path: Option<&str>,
    path: &str,
    internal_api_prefix: &str,
    public_api_prefix: &str,
) -> String {
    if let Some(rewritten_path) = rewritten_path {
        return normalize_vercel_api_path(
            None,
            rewritten_path,
            internal_api_prefix,
            public_api_prefix,
        );
    }
    if let Some(suffix) = strip_route_prefix(path, internal_api_prefix) {
        return format!("/api{suffix}");
    }
    if let Some(suffix) = strip_route_prefix(path, public_api_prefix) {
        return format!("/api{suffix}");
    }
    if path == "/api" || path.starts_with("/api/") {
        return path.to_string();
    }
    format!("/api{path}")
}

fn rewritten_path(internal_api_prefix: &str, query: &BTreeMap<String, String>) -> Option<String> {
    let suffix = query.get(VERCEL_REWRITE_PATH_QUERY)?;
    if suffix.is_empty() {
        return Some(internal_api_prefix.to_string());
    }
    let suffix = if suffix.starts_with('/') {
        suffix.to_string()
    } else {
        format!("/{suffix}")
    };
    Some(format!("{internal_api_prefix}{suffix}"))
}

fn strip_route_prefix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let suffix = path.strip_prefix(prefix)?;
    if suffix.is_empty() || suffix.starts_with('/') {
        Some(suffix)
    } else {
        None
    }
}

fn normalized_request_target(path: &str, raw_query: Option<&str>) -> String {
    let query = raw_query
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter(|part| {
            let key = part.split_once('=').map_or(*part, |(key, _)| key);
            url_decode(key) != VERCEL_REWRITE_PATH_QUERY
        })
        .collect::<Vec<_>>()
        .join("&");
    if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{query}")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        client_platform_header, merge_header, normalize_vercel_api_path, normalized_request_target,
        parse_query, prepare_bounded_request, rewritten_path, strip_client_platform_headers,
        AppVercelConfig, BodyReadError, VercelIngressTrust,
    };
    use http_transport::{ApplicationRequest as Request, ApplicationResponse as Response};
    use rust_auth::TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER;
    use std::collections::BTreeMap;
    use std::future::ready;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static PREPARE_CALLS: AtomicUsize = AtomicUsize::new(0);

    fn test_prepare_request(
        request: &mut Request,
        _ingress_trust: VercelIngressTrust,
    ) -> Result<(), Response> {
        PREPARE_CALLS.fetch_add(1, Ordering::SeqCst);
        if request.body == b"signed-body" {
            Ok(())
        } else {
            Err(Response::json(
                401,
                &serde_json::json!({ "code": "auth_required" }),
            ))
        }
    }

    fn test_config() -> AppVercelConfig {
        AppVercelConfig {
            ingress_trust: VercelIngressTrust::PrivateService,
            internal_api_prefix: "/api/test",
            public_api_prefix: "/test/api",
            max_body_bytes_for_path: |_| 11,
            prepare_request: test_prepare_request,
            initialize_for_path: |_| false,
            initialization_cache_key_for_request: |_| String::new(),
            initialize: |_| Ok(()),
        }
    }

    #[test]
    fn normalizes_exact_internal_api_prefix() {
        assert_eq!(
            normalize_vercel_api_path(None, "/api/hc/schema", "/api/hc", "/hc/api"),
            "/api/schema"
        );
        assert_eq!(
            normalize_vercel_api_path(None, "/api/hc", "/api/hc", "/hc/api"),
            "/api"
        );
        assert_eq!(
            normalize_vercel_api_path(None, "/api/hc/future/nested/action", "/api/hc", "/hc/api"),
            "/api/future/nested/action"
        );
    }

    #[test]
    fn normalizes_exact_public_api_prefix() {
        assert_eq!(
            normalize_vercel_api_path(None, "/hc/api/schema", "/api/hc", "/hc/api"),
            "/api/schema"
        );
        assert_eq!(
            normalize_vercel_api_path(None, "/hc/api", "/api/hc", "/hc/api"),
            "/api"
        );
    }

    #[test]
    fn normalizes_vercel_rewrite_query_path() {
        assert_eq!(
            normalize_vercel_api_path(Some("/api/hc/schema"), "/api/hc", "/api/hc", "/hc/api",),
            "/api/schema"
        );
        assert_eq!(
            normalize_vercel_api_path(Some("/api/dev/records"), "/api/dev", "/api/dev", "/dev/api",),
            "/api/records"
        );
    }

    #[test]
    fn derives_vercel_rewrite_path_from_query() {
        let query = parse_query(Some("__platform_path=schema&limit=10"));
        assert_eq!(
            rewritten_path("/api/hc", &query).as_deref(),
            Some("/api/hc/schema")
        );
        let query = parse_query(Some("__platform_path=/records"));
        assert_eq!(
            rewritten_path("/api/dev", &query).as_deref(),
            Some("/api/dev/records")
        );
    }

    #[test]
    fn ignores_missing_vercel_rewrite_path_query() {
        let query = parse_query(Some("limit=10"));
        assert_eq!(rewritten_path("/api/hc", &query), None);
    }

    #[test]
    fn treats_empty_vercel_rewrite_path_as_app_api_root() {
        let query = parse_query(Some("__platform_path="));
        assert_eq!(
            rewritten_path("/api/hc", &query).as_deref(),
            Some("/api/hc")
        );
    }

    #[test]
    fn removes_vercel_rewrite_metadata_from_normalized_request_target() {
        assert_eq!(
            normalized_request_target(
                "/api/data-review/identity",
                Some("__platform_path=/data-review/identity"),
            ),
            "/api/data-review/identity"
        );
    }

    #[test]
    fn preserves_user_query_bytes_order_and_duplicates_in_normalized_request_target() {
        assert_eq!(
            normalized_request_target(
                "/api/data-review/identity",
                Some("as_of=2026-07-26&__platform_path=%2Fdata-review%2Fidentity&tag=a%2Fb&tag=c",),
            ),
            "/api/data-review/identity?as_of=2026-07-26&tag=a%2Fb&tag=c"
        );
        assert_eq!(
            normalized_request_target(
                "/api/future/nested/action",
                Some("cursor=next%2Fpage&tag=a&tag=b"),
            ),
            "/api/future/nested/action?cursor=next%2Fpage&tag=a&tag=b"
        );
    }

    #[test]
    fn does_not_normalize_non_boundary_prefixes() {
        assert_eq!(
            normalize_vercel_api_path(None, "/api/hcs/endpoint", "/api/hc", "/hc/api"),
            "/api/hcs/endpoint"
        );
        assert_eq!(
            normalize_vercel_api_path(None, "/api/developer/foo", "/api/dev", "/dev/api"),
            "/api/developer/foo"
        );
        assert_eq!(
            normalize_vercel_api_path(None, "/hc/apis/schema", "/api/hc", "/hc/api"),
            "/api/hc/apis/schema"
        );
    }

    #[test]
    fn folds_cookie_headers_with_cookie_delimiter() {
        let mut headers = BTreeMap::new();
        merge_header(&mut headers, "cookie".to_string(), "a=1");
        merge_header(&mut headers, "cookie".to_string(), "b=2");

        assert_eq!(headers.get("cookie").map(String::as_str), Some("a=1; b=2"));
    }

    #[test]
    fn strips_caller_controlled_platform_headers_at_public_vercel_ingress() {
        let mut request = Request::from_target(
            "GET".to_string(),
            "/api/records".to_string(),
            BTreeMap::from([
                ("cookie".to_string(), "session=kept".to_string()),
                ("x-platform-auth-app-id".to_string(), "spoofed".to_string()),
                ("X-Platform-Principal".to_string(), "spoofed".to_string()),
                (
                    TRUSTED_APP_AUTH_PRINCIPAL_JTI_HEADER.to_string(),
                    "spoofed".to_string(),
                ),
            ]),
            Vec::new(),
        );

        strip_client_platform_headers(&mut request);

        assert_eq!(
            request.headers.get("cookie").map(String::as_str),
            Some("session=kept")
        );
        assert!(request
            .headers
            .keys()
            .all(|name| !client_platform_header(name)));
    }

    #[tokio::test]
    async fn prepares_only_after_receiving_the_exact_bounded_body() {
        PREPARE_CALLS.store(0, Ordering::SeqCst);
        let request = Request::from_target(
            "POST".to_string(),
            "/api/records".to_string(),
            BTreeMap::new(),
            Vec::new(),
        );
        let prepared =
            prepare_bounded_request(request, ready(Ok(b"signed-body".to_vec())), test_config())
                .await
                .expect("body collection should not fail");
        let prepared = match prepared {
            Ok(request) => request,
            Err(_) => panic!("the exact signed body should authorize"),
        };
        assert_eq!(prepared.body, b"signed-body");
        assert_eq!(PREPARE_CALLS.load(Ordering::SeqCst), 1);

        let request = Request::from_target(
            "POST".to_string(),
            "/api/records".to_string(),
            BTreeMap::new(),
            Vec::new(),
        );
        let rejected =
            prepare_bounded_request(request, ready(Ok(b"tampered-body".to_vec())), test_config())
                .await
                .expect("body collection should not fail");
        assert_eq!(rejected.err().map(|response| response.status), Some(401));
        assert_eq!(PREPARE_CALLS.load(Ordering::SeqCst), 2);

        let request = Request::from_target(
            "POST".to_string(),
            "/api/records".to_string(),
            BTreeMap::new(),
            Vec::new(),
        );
        let rejected = prepare_bounded_request(
            request,
            ready(Err(BodyReadError::TooLarge(11))),
            test_config(),
        )
        .await
        .expect("an oversized request is a bounded application response");
        assert_eq!(rejected.err().map(|response| response.status), Some(413));
        assert_eq!(PREPARE_CALLS.load(Ordering::SeqCst), 2);
    }
}
