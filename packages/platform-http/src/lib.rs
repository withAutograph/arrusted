use std::collections::BTreeMap;
use std::io::{ErrorKind, Read};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde::Serialize;

pub const REQUEST_TARGET_HEADER: &str = "__platform_request_target";

#[derive(Debug)]
pub struct ApplicationRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub query: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl ApplicationRequest {
    pub fn from_target(
        method: String,
        target: String,
        mut headers: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> Self {
        let (path, query) = parse_target(&target);
        headers.insert(REQUEST_TARGET_HEADER.to_string(), target);
        Self::from_parts(method, path, headers, query, body)
    }

    pub fn from_parts(
        method: String,
        path: String,
        headers: BTreeMap<String, String>,
        query: BTreeMap<String, String>,
        body: Vec<u8>,
    ) -> Self {
        Self {
            method,
            path,
            headers,
            query,
            body,
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

pub struct ApplicationResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl ApplicationResponse {
    pub fn javascript(body: &str) -> Self {
        Self::new(
            200,
            "text/javascript; charset=utf-8",
            body.as_bytes().to_vec(),
        )
    }

    pub fn typescript(body: &str) -> Self {
        Self::new(200, "text/plain; charset=utf-8", body.as_bytes().to_vec())
    }

    pub fn json(status: u16, payload: &impl Serialize) -> Self {
        Self::new(
            status,
            "application/json; charset=utf-8",
            serde_json::to_vec_pretty(payload).expect("response payload serializes"),
        )
    }

    fn new(status: u16, content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type,
            body,
        }
    }
}

fn parse_target(target: &str) -> (String, BTreeMap<String, String>) {
    let Some((path, raw_query)) = target.split_once('?') else {
        return (target.to_string(), BTreeMap::new());
    };
    (path.to_string(), parse_query(Some(raw_query)))
}

pub fn parse_query(query: Option<&str>) -> BTreeMap<String, String> {
    query
        .into_iter()
        .flat_map(|raw_query| raw_query.split('&'))
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (url_decode(key), url_decode(value))
        })
        .collect()
}

pub fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                if let (Some(high), Some(low)) =
                    (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
                {
                    output.push(high * 16 + low);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

const MAX_CHUNK_LINE_BYTES: usize = 8 * 1024;
const MAX_CHUNKS: usize = 4 * 1024;
const MAX_CHUNK_METADATA_BYTES: usize = 128 * 1024;
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const MAX_TRAILER_BYTES: usize = 64 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub target: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

pub fn read_request(
    stream: &mut TcpStream,
    max_body_bytes_for_target: impl FnOnce(&str) -> usize,
) -> Result<Request, String> {
    read_request_with_timeout(stream, max_body_bytes_for_target, REQUEST_READ_TIMEOUT)
}

fn read_request_with_timeout(
    stream: &mut TcpStream,
    max_body_bytes_for_target: impl FnOnce(&str) -> usize,
    timeout: Duration,
) -> Result<Request, String> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| "request read deadline is invalid".to_string())?;
    let mut buffer = Vec::new();
    let mut chunk = [0; 8192];
    let header_end = loop {
        let read = read_before_deadline(stream, &mut chunk, deadline)?;
        if read == 0 {
            return Err("empty request".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("request headers too large".to_string());
        }
    };

    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "missing method".to_string())?
        .to_string();
    let target = parts.next().ok_or_else(|| "missing path".to_string())?;
    let headers = parse_headers(lines);
    let max_body_bytes = max_body_bytes_for_target(target);
    let buffered_body = buffer[header_end..].to_vec();
    let body = if uses_chunked_transfer(&headers)? {
        read_chunked_body(stream, buffered_body, max_body_bytes, deadline)?
    } else {
        read_fixed_body(
            stream,
            buffered_body,
            parse_content_length(&headers)?,
            max_body_bytes,
            deadline,
        )?
    };

    Ok(Request {
        method,
        target: target.to_string(),
        headers,
        body,
    })
}

fn uses_chunked_transfer(headers: &BTreeMap<String, String>) -> Result<bool, String> {
    let Some(value) = headers.get("transfer-encoding") else {
        return Ok(false);
    };
    if headers.contains_key("content-length") {
        return Err("request must not combine content-length and transfer-encoding".to_string());
    }
    let codings = value
        .split(',')
        .map(|coding| coding.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    if codings.as_slice() != ["chunked"] {
        return Err("unsupported transfer-encoding".to_string());
    }
    Ok(true)
}

fn read_fixed_body(
    stream: &mut TcpStream,
    mut body: Vec<u8>,
    content_length: usize,
    max_body_bytes: usize,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    if content_length > max_body_bytes {
        return Err(format!("request body exceeds {max_body_bytes} bytes"));
    }
    let mut chunk = [0; 8192];
    while body.len() < content_length {
        let read = read_before_deadline(stream, &mut chunk, deadline)?;
        if read == 0 {
            return Err("connection closed before full body received".to_string());
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok(body)
}

fn read_chunked_body(
    stream: &mut TcpStream,
    mut pending: Vec<u8>,
    max_body_bytes: usize,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    let mut chunk_count = 0usize;
    let mut metadata_bytes = 0usize;
    loop {
        let size_line = read_crlf_line(stream, &mut pending, MAX_CHUNK_LINE_BYTES, deadline)?;
        chunk_count = chunk_count
            .checked_add(1)
            .ok_or_else(|| "chunk count exceeds limit".to_string())?;
        if chunk_count > MAX_CHUNKS {
            return Err("chunk count exceeds limit".to_string());
        }
        add_chunk_metadata(&mut metadata_bytes, size_line.len() + 2)?;
        let size_token = size_line
            .split(|byte| *byte == b';')
            .next()
            .unwrap_or_default();
        if size_token.is_empty() || !size_token.iter().all(u8::is_ascii_hexdigit) {
            return Err("invalid chunk size".to_string());
        }
        let size = usize::from_str_radix(
            std::str::from_utf8(size_token).map_err(|_| "invalid chunk size")?,
            16,
        )
        .map_err(|_| "invalid chunk size".to_string())?;
        if size > max_body_bytes.saturating_sub(body.len()) {
            return Err(format!("request body exceeds {max_body_bytes} bytes"));
        }
        if size == 0 {
            let trailer_bytes = read_chunk_trailers(stream, &mut pending, deadline)?;
            add_chunk_metadata(&mut metadata_bytes, trailer_bytes)?;
            return Ok(body);
        }
        ensure_pending(stream, &mut pending, size + 2, deadline)?;
        if &pending[size..size + 2] != b"\r\n" {
            return Err("chunk payload is missing its terminator".to_string());
        }
        add_chunk_metadata(&mut metadata_bytes, 2)?;
        body.extend_from_slice(&pending[..size]);
        pending.drain(..size + 2);
    }
}

fn add_chunk_metadata(total: &mut usize, additional: usize) -> Result<(), String> {
    *total = total
        .checked_add(additional)
        .ok_or_else(|| "chunk metadata exceeds limit".to_string())?;
    if *total > MAX_CHUNK_METADATA_BYTES {
        return Err("chunk metadata exceeds limit".to_string());
    }
    Ok(())
}

fn read_chunk_trailers(
    stream: &mut TcpStream,
    pending: &mut Vec<u8>,
    deadline: Instant,
) -> Result<usize, String> {
    let mut total = 0usize;
    loop {
        let line = read_crlf_line(stream, pending, MAX_CHUNK_LINE_BYTES, deadline)?;
        total = total
            .checked_add(line.len() + 2)
            .ok_or_else(|| "chunk trailers are too large".to_string())?;
        if total > MAX_TRAILER_BYTES {
            return Err("chunk trailers are too large".to_string());
        }
        if line.is_empty() {
            return Ok(total);
        }
        if !line.contains(&b':') {
            return Err("invalid chunk trailer".to_string());
        }
    }
}

fn read_crlf_line(
    stream: &mut TcpStream,
    pending: &mut Vec<u8>,
    limit: usize,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let mut chunk = [0; 8192];
    loop {
        if let Some(index) = pending.windows(2).position(|window| window == b"\r\n") {
            if index > limit {
                return Err("chunk metadata line is too large".to_string());
            }
            let line = pending[..index].to_vec();
            pending.drain(..index + 2);
            return Ok(line);
        }
        if pending.len() > limit + 1 {
            return Err("chunk metadata line is too large".to_string());
        }
        let read = read_before_deadline(stream, &mut chunk, deadline)?;
        if read == 0 {
            return Err("connection closed before full chunked body received".to_string());
        }
        pending.extend_from_slice(&chunk[..read]);
    }
}

fn ensure_pending(
    stream: &mut TcpStream,
    pending: &mut Vec<u8>,
    required: usize,
    deadline: Instant,
) -> Result<(), String> {
    let mut chunk = [0; 8192];
    while pending.len() < required {
        let read = read_before_deadline(stream, &mut chunk, deadline)?;
        if read == 0 {
            return Err("connection closed before full chunk received".to_string());
        }
        pending.extend_from_slice(&chunk[..read]);
    }
    Ok(())
}

fn read_before_deadline(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
) -> Result<usize, String> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| "request read deadline exceeded".to_string())?;
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|error| error.to_string())?;
    stream.read(buffer).map_err(|error| match error.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => "request read deadline exceeded".to_string(),
        _ => error.to_string(),
    })
}

fn parse_headers<'a>(lines: impl Iterator<Item = &'a str>) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        merge_header(&mut headers, name.to_ascii_lowercase(), value.trim());
    }
    headers
}

fn merge_header(headers: &mut BTreeMap<String, String>, name: String, value: &str) {
    headers
        .entry(name)
        .and_modify(|existing| {
            existing.push_str(", ");
            existing.push_str(value);
        })
        .or_insert_with(|| value.to_string());
}

fn parse_content_length(headers: &BTreeMap<String, String>) -> Result<usize, String> {
    let Some(value) = headers.get("content-length") else {
        return Ok(0);
    };
    if value.contains(',') {
        return Err("duplicate content-length header".to_string());
    }
    value
        .parse::<usize>()
        .map_err(|_| "invalid content-length header".to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::thread;
    use std::time::Duration;

    use super::{
        read_request, read_request_with_timeout, ApplicationRequest, REQUEST_TARGET_HEADER,
    };

    const MAX_BODY_BYTES: usize = 1024 * 1024;

    #[test]
    fn application_request_preserves_target_and_decodes_query() {
        let request = ApplicationRequest::from_target(
            "GET".to_string(),
            "/api/records?tag=a%2Fb&name=Jane+Doe".to_string(),
            BTreeMap::new(),
            Vec::new(),
        );

        assert_eq!(request.path, "/api/records");
        assert_eq!(request.query.get("tag").map(String::as_str), Some("a/b"));
        assert_eq!(
            request.query.get("name").map(String::as_str),
            Some("Jane Doe")
        );
        assert_eq!(
            request
                .headers
                .get(REQUEST_TARGET_HEADER)
                .map(String::as_str),
            Some("/api/records?tag=a%2Fb&name=Jane+Doe")
        );
    }

    #[test]
    fn application_request_preserves_key_only_query_parameters() {
        let request = ApplicationRequest::from_target(
            "GET".to_string(),
            "/api/records?include_archived&limit=10".to_string(),
            BTreeMap::new(),
            Vec::new(),
        );

        assert_eq!(
            request.query.get("include_archived").map(String::as_str),
            Some("")
        );
        assert_eq!(request.query.get("limit").map(String::as_str), Some("10"));
    }

    #[test]
    fn decodes_standard_chunked_bodies_before_authentication() {
        let request = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n7\r\n{\"note\"\r\n8;source=qa\r\n:\"caf\xc3\xa9\"\r\n1\r\n}\r\n0\r\nx-trace: accepted\r\n\r\n",
        )
        .expect("chunked request parses");

        assert_eq!(request.body, b"{\"note\":\"caf\xc3\xa9\"}");
    }

    #[test]
    fn preserves_fixed_length_body_bytes() {
        let request = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ncontent-length: 6\r\n\r\ncaf\xc3\xa9!",
        )
        .expect("fixed request parses");

        assert_eq!(request.body, b"caf\xc3\xa9!");
    }

    #[test]
    fn rejects_fixed_length_bodies_over_the_request_limit() {
        let error = read_raw_request_with_limit(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ncontent-length: 7\r\n\r\npayload",
            6,
        )
        .expect_err("oversized fixed body is rejected");

        assert_eq!(error, "request body exceeds 6 bytes");
    }

    #[test]
    fn rejects_incomplete_fixed_length_bodies() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ncontent-length: 7\r\n\r\nshort",
        )
        .expect_err("incomplete fixed body is rejected");

        assert_eq!(error, "connection closed before full body received");
    }

    #[test]
    fn rejects_ambiguous_content_length_and_transfer_encoding() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ncontent-length: 1\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n",
        )
        .expect_err("ambiguous framing is rejected");

        assert!(error.contains("must not combine"));
    }

    #[test]
    fn rejects_duplicate_content_length() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ncontent-length: 1\r\ncontent-length: 1\r\n\r\nx",
        )
        .expect_err("duplicate length is rejected");

        assert_eq!(error, "duplicate content-length header");
    }

    #[test]
    fn rejects_chunked_bodies_over_the_request_limit_before_reading_payload() {
        let oversized = format!("{:x}", MAX_BODY_BYTES + 1);
        let raw = format!(
            "POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n{oversized}\r\n"
        );
        let error = read_raw_request(raw.as_bytes()).expect_err("oversized chunk is rejected");

        assert!(error.contains("request body exceeds"));
    }

    #[test]
    fn rejects_unsupported_transfer_codings() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
        )
        .expect_err("unsupported transfer coding is rejected");

        assert_eq!(error, "unsupported transfer-encoding");
    }

    #[test]
    fn rejects_excessive_chunk_counts() {
        let mut raw =
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n"
                .to_vec();
        for _ in 0..=super::MAX_CHUNKS {
            raw.extend_from_slice(b"1\r\nx\r\n");
        }
        raw.extend_from_slice(b"0\r\n\r\n");

        let error = read_raw_request(&raw).expect_err("excessive chunk count is rejected");
        assert_eq!(error, "chunk count exceeds limit");
    }

    #[test]
    fn rejects_excessive_cumulative_chunk_metadata() {
        let mut raw =
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n"
                .to_vec();
        for _ in 0..17 {
            raw.extend_from_slice(b"1;");
            raw.extend(std::iter::repeat_n(b'a', 8_000));
            raw.extend_from_slice(b"\r\nx\r\n");
        }
        raw.extend_from_slice(b"0\r\n\r\n");

        let error = read_raw_request(&raw).expect_err("excessive chunk metadata is rejected");
        assert_eq!(error, "chunk metadata exceeds limit");
    }

    #[test]
    fn rejects_incomplete_chunk_payloads() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n4\r\nx",
        )
        .expect_err("incomplete chunk is rejected");

        assert_eq!(error, "connection closed before full chunk received");
    }

    #[test]
    fn rejects_invalid_hexadecimal_chunk_sizes() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\ng\r\n",
        )
        .expect_err("invalid hexadecimal chunk size is rejected");

        assert_eq!(error, "invalid chunk size");
    }

    #[test]
    fn rejects_missing_chunk_payload_terminators() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n1\r\nxyz",
        )
        .expect_err("missing chunk payload terminator is rejected");

        assert_eq!(error, "chunk payload is missing its terminator");
    }

    #[test]
    fn rejects_malformed_chunk_trailers() {
        let error = read_raw_request(
            b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n0\r\nnot-a-header\r\n\r\n",
        )
        .expect_err("malformed chunk trailer is rejected");

        assert_eq!(error, "invalid chunk trailer");
    }

    #[test]
    fn rejects_a_body_that_stalls_past_the_total_request_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener binds");
        let address = listener.local_addr().expect("test listener has an address");
        let writer = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("test client connects");
            stream
                .write_all(b"POST /api/records HTTP/1.1\r\nhost: app.test\r\ntransfer-encoding: chunked\r\n\r\n4\r\nx")
                .expect("partial test request writes");
            thread::sleep(Duration::from_millis(100));
        });
        let (mut stream, _) = listener.accept().expect("test server accepts");
        let error =
            read_request_with_timeout(&mut stream, |_| MAX_BODY_BYTES, Duration::from_millis(20))
                .expect_err("stalled request is rejected");
        writer.join().expect("test request thread finishes");

        assert_eq!(error, "request read deadline exceeded");
    }

    fn read_raw_request(raw: &[u8]) -> Result<super::Request, String> {
        read_raw_request_with_limit(raw, MAX_BODY_BYTES)
    }

    fn read_raw_request_with_limit(
        raw: &[u8],
        max_body_bytes: usize,
    ) -> Result<super::Request, String> {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener binds");
        let address = listener.local_addr().expect("test listener has an address");
        let bytes = raw.to_vec();
        let writer = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("test client connects");
            stream.write_all(&bytes).expect("test request writes");
            stream
                .shutdown(Shutdown::Write)
                .expect("test request write side closes");
        });
        let (mut stream, _) = listener.accept().expect("test server accepts");
        let result = read_request(&mut stream, |_| max_body_bytes);
        writer.join().expect("test request thread finishes");
        result
    }
}
