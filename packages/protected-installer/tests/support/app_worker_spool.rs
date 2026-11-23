use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use protected_installer::{
    FrozenInstallContext, SpoolFrameNotice, SpoolLifecycleFact, SpoolLifecycleKind,
    SpoolLifecycleNotice, SpoolReadyMarker,
};
use serde_json::{json, Value};

pub struct WorkerAcceptance {
    pub authorizations: Vec<Value>,
    pub checkpoints: Vec<Value>,
    pub stdout: String,
}

pub fn app_worker_path(name: &str) -> PathBuf {
    let test_binary = std::env::current_exe().expect("test executable path");
    let target_debug = test_binary
        .parent()
        .and_then(Path::parent)
        .expect("test executable is under target/debug/deps");
    let worker = target_debug.join(name);
    assert!(worker.is_file(), "built app worker executable exists");
    worker
}

pub fn fresh_spool(label: &str) -> (PathBuf, String) {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let run_id = format!("{label}-{}-{unique}", std::process::id());
    let spool = std::env::temp_dir().join(format!("protected-app-spool-{run_id}"));
    fs::create_dir_all(spool.join("startup")).expect("create private test spool");
    (spool, run_id)
}

pub fn run_spooled_worker(
    command: &mut Command,
    spool: &Path,
    run_id: &str,
    context: &FrozenInstallContext,
    direct_database_url: &str,
) -> WorkerAcceptance {
    fs::write(
        spool.join("startup/context.json"),
        serde_json::to_vec(context.value()).expect("serialize frozen context"),
    )
    .expect("publish frozen context");
    fs::write(
        spool.join("startup/direct-database-url.json"),
        serde_json::to_vec(direct_database_url).expect("serialize separate DB binding"),
    )
    .expect("publish private database binding");
    fs::write(
        spool.join("startup/ready.json"),
        serde_json::to_vec(&SpoolReadyMarker::startup(run_id)).expect("serialize startup marker"),
    )
    .expect("publish startup marker");

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn actual protected app worker");
    let stdout = child.stdout.take().expect("capture worker notices");
    let stderr = child.stderr.take().expect("capture worker diagnostics");
    let stdout_thread = thread::spawn(move || {
        let mut output = String::new();
        BufReader::new(stdout)
            .read_to_string(&mut output)
            .expect("read worker stdout");
        output
    });
    let stderr_thread = thread::spawn(move || {
        let mut output = String::new();
        BufReader::new(stderr)
            .read_to_string(&mut output)
            .expect("read worker stderr");
        output
    });

    let deadline = Instant::now() + Duration::from_secs(120);
    let mut next_frame_id = 1_u64;
    let mut authorizations = Vec::new();
    let mut checkpoints = Vec::new();
    let status = loop {
        let ready_path = spool
            .join("requests")
            .join(format!("{next_frame_id}.ready"));
        if ready_path.is_file() {
            relay_frame(
                spool,
                run_id,
                next_frame_id,
                context,
                &mut authorizations,
                &mut checkpoints,
            );
            next_frame_id += 1;
            continue;
        }
        if let Some(status) = child.try_wait().expect("poll protected app worker") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("protected app worker did not finish within the acceptance timeout");
        }
        thread::sleep(Duration::from_millis(10));
    };

    let stdout = stdout_thread.join().expect("stdout reader completes");
    let stderr = stderr_thread.join().expect("stderr reader completes");
    assert!(
        status.success(),
        "protected app worker succeeds; stderr contains no secret: {}",
        stderr
    );
    assert!(!stdout.contains(direct_database_url));
    assert!(!stderr.contains(direct_database_url));
    for target in &context.value().tenant_targets {
        assert!(
            !stdout.contains(target),
            "tenant identities stay off stdout"
        );
    }

    let mut frame_notices = 0_u64;
    let mut lifecycle_notices = 0_u64;
    for line in stdout.lines() {
        let value: Value = serde_json::from_str(line).expect("stdout line is typed JSON notice");
        match value.get("kind").and_then(Value::as_str) {
            Some("protected_installer_frame_ready") => {
                let notice: SpoolFrameNotice =
                    serde_json::from_value(value).expect("typed authorization frame notice");
                assert_eq!(notice.version, 1);
                assert_eq!(notice.run_id, run_id);
                frame_notices += 1;
            }
            Some("protected_installer_lifecycle_ready") => {
                let notice: SpoolLifecycleNotice =
                    serde_json::from_value(value).expect("typed lifecycle notice");
                assert_eq!(notice.version, 1);
                assert_eq!(notice.run_id, run_id);
                lifecycle_notices += 1;
            }
            _ => panic!("worker stdout contains notices only"),
        }
    }
    assert_eq!(
        frame_notices as usize,
        authorizations.len() + checkpoints.len()
    );
    assert_eq!(
        lifecycle_notices, 2,
        "started and succeeded notices are published"
    );
    assert!(
        !authorizations.is_empty(),
        "worker requested real effect authority"
    );
    assert_eq!(
        authorizations.len(),
        checkpoints.len(),
        "each authorized effect has a checkpoint"
    );

    let mut authorization_keys = Vec::new();
    for request in &authorizations {
        validate_request_context(request, context);
        authorization_keys.push((
            request["sequence"].as_u64().expect("effect sequence"),
            request["effect_id"]
                .as_str()
                .expect("effect identity")
                .to_string(),
        ));
    }
    let mut checkpoint_keys = Vec::new();
    for checkpoint in &checkpoints {
        validate_request_context(checkpoint, context);
        let receipt = &checkpoint["receipt"];
        assert!(matches!(
            receipt["state"].as_str(),
            Some("applied" | "no_change")
        ));
        assert_eq!(receipt["readback_sha256"].as_str().map(str::len), Some(64));
        checkpoint_keys.push((
            checkpoint["sequence"].as_u64().expect("effect sequence"),
            checkpoint["effect_id"]
                .as_str()
                .expect("effect identity")
                .to_string(),
        ));
    }
    assert_eq!(authorization_keys, checkpoint_keys);
    assert!(authorization_keys
        .windows(2)
        .all(|pair| pair[1].0 > pair[0].0));

    let started: SpoolLifecycleFact = serde_json::from_slice(
        &fs::read(spool.join("lifecycle/1.json")).expect("private started lifecycle fact"),
    )
    .expect("typed started lifecycle fact");
    let succeeded: SpoolLifecycleFact = serde_json::from_slice(
        &fs::read(spool.join("lifecycle/2.json")).expect("private success lifecycle fact"),
    )
    .expect("typed success lifecycle fact");
    assert_eq!(started.kind, SpoolLifecycleKind::WorkerStarted);
    assert_eq!(succeeded.kind, SpoolLifecycleKind::WorkerSucceeded);
    assert_eq!(started.run_id, run_id);
    assert_eq!(succeeded.run_id, run_id);

    WorkerAcceptance {
        authorizations,
        checkpoints,
        stdout,
    }
}

pub fn run_stdio_worker(
    command: &mut Command,
    context: &FrozenInstallContext,
    direct_database_url: &str,
) -> WorkerAcceptance {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn actual protected app worker in stdio mode");
    let mut input = child
        .stdin
        .take()
        .expect("write startup and authority replies");
    let output = child.stdout.take().expect("read authority requests");
    let stderr = child.stderr.take().expect("capture worker diagnostics");
    let stderr_thread = thread::spawn(move || {
        let mut output = String::new();
        BufReader::new(stderr)
            .read_to_string(&mut output)
            .expect("read worker stderr");
        output
    });

    writeln!(
        input,
        "{}",
        serde_json::to_string(context.value()).expect("serialize frozen startup context")
    )
    .expect("write startup context");
    writeln!(
        input,
        "{}",
        serde_json::to_string(direct_database_url).expect("serialize separate DB binding")
    )
    .expect("write private database binding");
    input.flush().expect("flush protected worker startup");

    let mut output = BufReader::new(output);
    let mut stdout = String::new();
    let mut line = String::new();
    let mut authorizations = Vec::new();
    let mut checkpoints = Vec::new();
    loop {
        line.clear();
        let read = output
            .read_line(&mut line)
            .expect("read worker protocol line");
        if read == 0 {
            break;
        }
        let request: Value = serde_json::from_str(line.trim_end())
            .expect("worker stdout carries a typed authority request");
        validate_request_context(&request, context);
        let response = match request["kind"].as_str() {
            Some("authorize_effect") => {
                authorizations.push(request.clone());
                response_from_request("effect_authorized", &request, "allowed", json!(true))
            }
            Some("checkpoint_effect") => {
                checkpoints.push(request.clone());
                response_from_request("checkpoint_recorded", &request, "recorded", json!(true))
            }
            _ => panic!("stdio worker emitted only authority requests"),
        };
        writeln!(
            input,
            "{}",
            serde_json::to_string(&response).expect("serialize parent authority reply")
        )
        .expect("write parent authority reply");
        input.flush().expect("flush parent authority reply");
        stdout.push_str(&line);
    }
    drop(input);
    let status = child.wait().expect("wait for stdio worker completion");
    let stderr = stderr_thread.join().expect("stderr reader completes");
    assert!(
        status.success(),
        "protected app stdio worker succeeds: {stderr}"
    );
    assert!(!stdout.contains(direct_database_url));
    assert!(!stderr.contains(direct_database_url));
    assert!(!authorizations.is_empty());
    assert_eq!(authorizations.len(), checkpoints.len());
    for (authorization, checkpoint) in authorizations.iter().zip(&checkpoints) {
        assert_eq!(authorization["sequence"], checkpoint["sequence"]);
        assert_eq!(authorization["effect_id"], checkpoint["effect_id"]);
        assert_eq!(
            checkpoint["receipt"]["readback_sha256"]
                .as_str()
                .map(str::len),
            Some(64)
        );
    }
    WorkerAcceptance {
        authorizations,
        checkpoints,
        stdout,
    }
}

fn relay_frame(
    spool: &Path,
    run_id: &str,
    frame_id: u64,
    context: &FrozenInstallContext,
    authorizations: &mut Vec<Value>,
    checkpoints: &mut Vec<Value>,
) {
    let request_path = spool.join(format!("requests/{frame_id}.json"));
    let request: Value = serde_json::from_slice(&fs::read(&request_path).expect("request frame"))
        .expect("typed request payload");
    let marker: SpoolReadyMarker = serde_json::from_slice(
        &fs::read(spool.join(format!("requests/{frame_id}.ready"))).expect("request marker"),
    )
    .expect("typed request marker");
    assert_eq!(marker, SpoolReadyMarker::frame(run_id, frame_id));
    validate_request_context(&request, context);
    let response = match request["kind"].as_str() {
        Some("authorize_effect") => {
            assert!(request["effect_id"].as_str().is_some());
            authorizations.push(request.clone());
            response_from_request("effect_authorized", &request, "allowed", json!(true))
        }
        Some("checkpoint_effect") => {
            assert_eq!(
                request["receipt"]["readback_sha256"].as_str().map(str::len),
                Some(64),
                "only confirmed readbacks are accepted"
            );
            checkpoints.push(request.clone());
            response_from_request("checkpoint_recorded", &request, "recorded", json!(true))
        }
        _ => panic!("worker sent only typed authorize/checkpoint requests"),
    };
    publish_new(
        &spool.join(format!("responses/{frame_id}.json")),
        &serde_json::to_vec(&response).expect("serialize authority response"),
    );
    publish_new(
        &spool.join(format!("responses/{frame_id}.ready")),
        &serde_json::to_vec(&SpoolReadyMarker::frame(run_id, frame_id))
            .expect("serialize response marker"),
    );
}

fn response_from_request(kind: &str, request: &Value, result_name: &str, result: Value) -> Value {
    let mut response = json!({
        "kind": kind,
        "version": request["version"],
        "operation_id": request["operation_id"],
        "context_digest": request["context_digest"],
        "fence_generation": request["fence_generation"],
        "sequence": request["sequence"],
        "effect_id": request["effect_id"],
    });
    response[result_name] = result;
    response
}

fn validate_request_context(request: &Value, context: &FrozenInstallContext) {
    let frozen = context.value();
    assert_eq!(request["version"].as_u64(), Some(1));
    assert_eq!(request["operation_id"], frozen.operation.operation_id);
    assert_eq!(request["context_digest"], context.digest());
    assert_eq!(
        request["fence_generation"].as_u64(),
        Some(frozen.operation.fence_generation)
    );
    assert_eq!(request["resource_id"], frozen.resource.resource_id);
    if request.get("app_id").is_some() {
        assert_eq!(request["app_id"], frozen.app_id);
        assert_eq!(request["release_id"], frozen.release.id);
        assert_eq!(request["installer_id"], frozen.installer.id);
        assert_eq!(request["installer_sha256"], frozen.installer.sha256);
    }
    if let Some(tenant_id) = request.get("tenant_id").and_then(Value::as_str) {
        assert!(frozen
            .tenant_targets
            .iter()
            .any(|tenant| tenant == tenant_id));
    }
}

fn publish_new(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .expect("publish a new private spool frame");
    file.write_all(bytes).expect("write complete private frame");
    file.sync_all().expect("durably publish private frame");
}
