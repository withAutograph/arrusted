use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protected_installer::{
    launch_protected_installer, read_protected_installer_startup, ArtifactIdentity, AuthorityError,
    DatabaseResourceIdentity, DirectDatabaseBinding, EffectAuthority, EffectAuthorizationRequest,
    EffectCheckpoint, FrozenInstallContext, InstallEnvironment, InstallError, InstallerPin,
    OperationIdentity, PinnedInstallerWorker, ProtectedInstallContext, SpoolFrameNotice,
    SpoolLifecycleFact, SpoolLifecycleKind, SpoolLifecycleNotice, SpoolReadyMarker,
    TrustedInstallerCatalog, MAX_PROTOCOL_FRAME_BYTES,
};
use sha2::{Digest, Sha256};

#[derive(Clone, Default)]
struct RecordingAuthority(Arc<Mutex<Vec<String>>>);

impl EffectAuthority for RecordingAuthority {
    fn authorize(&mut self, request: &EffectAuthorizationRequest) -> Result<(), AuthorityError> {
        self.0.lock().unwrap().push(format!(
            "authorize:{}:{}",
            request.sequence, request.effect_id
        ));
        Ok(())
    }

    fn checkpoint(&mut self, checkpoint: &EffectCheckpoint) -> Result<(), AuthorityError> {
        self.0.lock().unwrap().push(format!(
            "checkpoint:{}:{}",
            checkpoint.sequence, checkpoint.effect_id
        ));
        Ok(())
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fixture(args: Vec<String>) -> (FrozenInstallContext, TrustedInstallerCatalog) {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_protected_installer_fixture"));
    let pin_digest = digest(&fs::read(&path).unwrap());
    let context = FrozenInstallContext::new(ProtectedInstallContext {
        version: 1,
        operation: OperationIdentity {
            operation_id: "op-fixture".into(),
            approval_digest: "a".repeat(64),
            fence_generation: 2,
        },
        app_id: "fixture-app".into(),
        resource: DatabaseResourceIdentity {
            resource_id: "resource-fixture".into(),
            environment: InstallEnvironment::Local,
            hostname: "localhost".into(),
            port: 5432,
            database: "fixture".into(),
            schema: "public".into(),
            migrator_role: "migrator".into(),
            runtime_role: "runtime".into(),
            provider_project_id: None,
            provider_branch_id: None,
        },
        release: ArtifactIdentity {
            id: "release-fixture".into(),
            sha256: "b".repeat(64),
        },
        installer: ArtifactIdentity {
            id: "fixture-worker".into(),
            sha256: pin_digest.clone(),
        },
        tenant_targets: vec!["tenant-fixture".into()],
    })
    .unwrap();
    let catalog = TrustedInstallerCatalog::new(vec![PinnedInstallerWorker {
        pin: InstallerPin {
            id: "fixture-worker".into(),
            sha256: pin_digest,
        },
        path,
        args,
    }])
    .unwrap();
    (context, catalog)
}

fn spool_directory(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "protected-installer-spool-{}-{label}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_startup(spool: &Path, context: &FrozenInstallContext, run_id: &str) {
    let startup = spool.join("startup");
    fs::create_dir_all(&startup).unwrap();
    fs::write(
        startup.join("context.json"),
        serde_json::to_vec(context.value()).unwrap(),
    )
    .unwrap();
    fs::write(
        startup.join("direct-database-url.json"),
        serde_json::to_vec(
            "postgres://migrator:spool-private-secret@localhost:5432/fixture?sslmode=disable",
        )
        .unwrap(),
    )
    .unwrap();
    fs::write(
        startup.join("ready.json"),
        serde_json::to_vec(&SpoolReadyMarker::startup(run_id)).unwrap(),
    )
    .unwrap();
}

fn spawn_spool_worker(spool: &Path, run_id: &str, timeout_ms: u64, mode: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_protected_installer_fixture"))
        .args([
            "file-spool",
            spool.to_str().unwrap(),
            run_id,
            &timeout_ms.to_string(),
            mode,
        ])
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn next_notice(stdout: &mut BufReader<ChildStdout>, run_id: &str, frame_id: u64) -> String {
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(
        !line.is_empty(),
        "worker emits a notice before waiting for a reply"
    );
    let notice: SpoolFrameNotice = serde_json::from_str(&line).unwrap();
    assert_eq!(notice.kind, "protected_installer_frame_ready");
    assert_eq!(notice.version, 1);
    assert_eq!(notice.run_id, run_id);
    assert_eq!(notice.frame_id, frame_id);
    line
}

fn next_lifecycle_notice(
    stdout: &mut BufReader<ChildStdout>,
    run_id: &str,
    frame_id: u64,
) -> String {
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert!(!line.is_empty(), "worker emits a lifecycle notice");
    let notice: SpoolLifecycleNotice = serde_json::from_str(&line).unwrap();
    assert_eq!(notice.kind, "protected_installer_lifecycle_ready");
    assert_eq!(notice.version, 1);
    assert_eq!(notice.run_id, run_id);
    assert_eq!(notice.frame_id, frame_id);
    line
}

fn lifecycle_fact(spool: &Path, run_id: &str, frame_id: u64) -> SpoolLifecycleFact {
    let marker: SpoolReadyMarker = serde_json::from_slice(
        &fs::read(spool.join(format!("lifecycle/{frame_id}.ready"))).unwrap(),
    )
    .unwrap();
    assert_eq!(marker.version, 1);
    assert_eq!(marker.run_id, run_id);
    assert_eq!(marker.frame_id, frame_id);
    serde_json::from_slice(&fs::read(spool.join(format!("lifecycle/{frame_id}.json"))).unwrap())
        .unwrap()
}

fn request_frame(spool: &Path, run_id: &str, frame_id: u64) -> serde_json::Value {
    let marker: SpoolReadyMarker = serde_json::from_slice(
        &fs::read(spool.join(format!("requests/{frame_id}.ready"))).unwrap(),
    )
    .unwrap();
    assert_eq!(marker.version, 1);
    assert_eq!(marker.run_id, run_id);
    assert_eq!(marker.frame_id, frame_id);
    serde_json::from_slice(&fs::read(spool.join(format!("requests/{frame_id}.json"))).unwrap())
        .unwrap()
}

fn write_response(spool: &Path, run_id: &str, frame_id: u64, response: &serde_json::Value) {
    let responses = spool.join("responses");
    fs::create_dir_all(&responses).unwrap();
    fs::write(
        responses.join(format!("{frame_id}.json")),
        serde_json::to_vec(response).unwrap(),
    )
    .unwrap();
    // This distinct completion marker is published only after the entire JSON reply is written.
    fs::write(
        responses.join(format!("{frame_id}.ready")),
        serde_json::to_vec(&SpoolReadyMarker::frame(run_id, frame_id)).unwrap(),
    )
    .unwrap();
}

fn authorization_reply(request: &serde_json::Value, allowed: bool) -> serde_json::Value {
    serde_json::json!({
        "kind": "effect_authorized",
        "version": request["version"],
        "operation_id": request["operation_id"],
        "context_digest": request["context_digest"],
        "fence_generation": request["fence_generation"],
        "sequence": request["sequence"],
        "effect_id": request["effect_id"],
        "allowed": allowed,
    })
}

fn checkpoint_reply(request: &serde_json::Value, recorded: bool) -> serde_json::Value {
    serde_json::json!({
        "kind": "checkpoint_recorded",
        "version": request["version"],
        "operation_id": request["operation_id"],
        "context_digest": request["context_digest"],
        "fence_generation": request["fence_generation"],
        "sequence": request["sequence"],
        "effect_id": request["effect_id"],
        "recorded": recorded,
    })
}

#[test]
fn file_spool_process_preserves_typed_authority_flow_without_stdout_payloads() {
    let (context, _) = fixture(Vec::new());
    let run_id = "run-file-spool-1";
    let spool = spool_directory("success");
    write_startup(&spool, &context, run_id);
    let mut child = spawn_spool_worker(&spool, run_id, 5_000, "");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    let started_notice = next_lifecycle_notice(&mut stdout, run_id, 1);
    assert!(!started_notice.contains("spool-private-secret"));
    let started = lifecycle_fact(&spool, run_id, 1);
    assert_eq!(started.run_id, run_id);
    assert_eq!(started.kind, SpoolLifecycleKind::WorkerStarted);
    assert!(started.failure_code.is_none());

    let first_notice = next_notice(&mut stdout, run_id, 1);
    assert!(!first_notice.contains("install:tenant-fixture"));
    assert!(!first_notice.contains("spool-private-secret"));
    let authorization = request_frame(&spool, run_id, 1);
    assert_eq!(authorization["kind"], "authorize_effect");
    assert_eq!(authorization["sequence"], 1);
    assert_eq!(authorization["effect_id"], "install:tenant-fixture");
    write_response(
        &spool,
        run_id,
        1,
        &authorization_reply(&authorization, true),
    );

    let second_notice = next_notice(&mut stdout, run_id, 2);
    assert!(!second_notice.contains("d".repeat(64).as_str()));
    let checkpoint = request_frame(&spool, run_id, 2);
    assert_eq!(checkpoint["kind"], "checkpoint_effect");
    assert_eq!(checkpoint["sequence"], 1);
    assert_eq!(checkpoint["effect_id"], authorization["effect_id"]);
    write_response(&spool, run_id, 2, &checkpoint_reply(&checkpoint, true));

    let succeeded_notice = next_lifecycle_notice(&mut stdout, run_id, 2);
    assert!(!succeeded_notice.contains("spool-private-secret"));
    let succeeded = lifecycle_fact(&spool, run_id, 2);
    assert_eq!(succeeded.kind, SpoolLifecycleKind::WorkerSucceeded);
    assert!(succeeded.failure_code.is_none());
    drop(stdout);
    assert!(child.wait().unwrap().success());
    assert!(!spool.join("startup/direct-database-url.json").exists());
    fs::remove_dir_all(spool).unwrap();
}

#[test]
fn file_spool_denial_and_wrong_startup_run_marker_fail_closed() {
    let (context, _) = fixture(Vec::new());
    let run_id = "run-file-spool-denied";
    let spool = spool_directory("denied");
    write_startup(&spool, &context, run_id);
    let mut child = spawn_spool_worker(&spool, run_id, 5_000, "deny");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    next_lifecycle_notice(&mut stdout, run_id, 1);
    next_notice(&mut stdout, run_id, 1);
    let request = request_frame(&spool, run_id, 1);
    write_response(&spool, run_id, 1, &authorization_reply(&request, false));
    next_lifecycle_notice(&mut stdout, run_id, 2);
    drop(stdout);
    assert_eq!(child.wait().unwrap().code(), Some(22));
    assert!(!spool.join("requests/2.json").exists());
    let failed = lifecycle_fact(&spool, run_id, 2);
    assert_eq!(failed.kind, SpoolLifecycleKind::WorkerFailed);
    assert_eq!(
        failed.failure_code,
        Some(protected_installer::SpoolFailureCode::AuthorityDenied)
    );
    fs::remove_dir_all(spool).unwrap();

    let (context, _) = fixture(Vec::new());
    let run_id = "run-file-spool-stale";
    let spool = spool_directory("stale-marker");
    write_startup(&spool, &context, run_id);
    fs::write(
        spool.join("startup/ready.json"),
        serde_json::to_vec(&SpoolReadyMarker::startup("another-run")).unwrap(),
    )
    .unwrap();
    let mut child = spawn_spool_worker(&spool, run_id, 5_000, "");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    next_lifecycle_notice(&mut stdout, run_id, 1);
    drop(stdout);
    assert_eq!(child.wait().unwrap().code(), Some(20));
    let failed = lifecycle_fact(&spool, run_id, 1);
    assert_eq!(failed.kind, SpoolLifecycleKind::WorkerFailed);
    assert_eq!(
        failed.failure_code,
        Some(protected_installer::SpoolFailureCode::StartupRejected)
    );
    assert!(!spool.join("lifecycle/2.json").exists());
    fs::remove_dir_all(spool).unwrap();

    let (context, _) = fixture(Vec::new());
    let run_id = "run-file-spool-order";
    let spool = spool_directory("lifecycle-order");
    write_startup(&spool, &context, run_id);
    let mut child = spawn_spool_worker(&spool, run_id, 5_000, "lifecycle-order");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    next_lifecycle_notice(&mut stdout, run_id, 1);
    drop(stdout);
    assert_eq!(child.wait().unwrap().code(), Some(25));
    let failed = lifecycle_fact(&spool, run_id, 1);
    assert_eq!(failed.kind, SpoolLifecycleKind::WorkerFailed);
    assert_eq!(
        failed.failure_code,
        Some(protected_installer::SpoolFailureCode::StartupRejected)
    );
    assert!(!spool.join("lifecycle/2.json").exists());
    assert!(!spool.join("requests/1.json").exists());
    fs::remove_dir_all(spool).unwrap();
}

#[test]
fn file_spool_missing_reply_times_out_and_process_cancellation_never_acks() {
    let (context, _) = fixture(Vec::new());
    let run_id = "run-file-spool-timeout";
    let spool = spool_directory("timeout");
    write_startup(&spool, &context, run_id);
    let mut child = spawn_spool_worker(&spool, run_id, 100, "");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    next_lifecycle_notice(&mut stdout, run_id, 1);
    next_notice(&mut stdout, run_id, 1);
    next_lifecycle_notice(&mut stdout, run_id, 2);
    drop(stdout);
    assert_eq!(child.wait().unwrap().code(), Some(23));
    assert!(!spool.join("requests/2.json").exists());
    assert_eq!(
        lifecycle_fact(&spool, run_id, 2).failure_code,
        Some(protected_installer::SpoolFailureCode::ProtocolFailure)
    );
    fs::remove_dir_all(spool).unwrap();

    let (context, _) = fixture(Vec::new());
    let run_id = "run-file-spool-cancel";
    let spool = spool_directory("cancel");
    write_startup(&spool, &context, run_id);
    let mut child = spawn_spool_worker(&spool, run_id, 5_000, "");
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    next_lifecycle_notice(&mut stdout, run_id, 1);
    next_notice(&mut stdout, run_id, 1);
    child.kill().unwrap();
    let _ = child.wait().unwrap();
    assert!(!spool.join("requests/2.json").exists());
    assert!(!spool.join("lifecycle/2.json").exists());
    fs::remove_dir_all(spool).unwrap();
}

#[test]
fn pinned_process_transport_carries_private_binding_and_requires_authority_ack() {
    let (context, catalog) = fixture(Vec::new());
    let mut authority = RecordingAuthority::default();

    launch_protected_installer(
        context,
        DirectDatabaseBinding::new(
            "postgres://migrator:fixture-secret@localhost:5432/fixture?sslmode=disable".into(),
        ),
        &catalog,
        &mut authority,
        Duration::from_secs(5),
    )
    .unwrap();

    assert_eq!(
        *authority.0.lock().unwrap(),
        vec![
            "authorize:1:install:tenant-fixture",
            "checkpoint:1:install:tenant-fixture",
        ]
    );
}

#[test]
fn rejects_unapproved_target_before_authority_and_kills_stuck_worker() {
    let (context, catalog) = fixture(vec!["wrong-target".into()]);
    let mut authority = RecordingAuthority::default();
    assert!(launch_protected_installer(
        context,
        DirectDatabaseBinding::new(
            "postgres://migrator:fixture-secret@localhost:5432/fixture?sslmode=disable".into()
        ),
        &catalog,
        &mut authority,
        Duration::from_secs(2),
    )
    .is_err());
    assert!(authority.0.lock().unwrap().is_empty());

    let marker = std::env::temp_dir().join(format!(
        "protected-installer-worker-{}-{}.pid",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let (context, catalog) = fixture(vec!["hang".into(), marker.to_string_lossy().into_owned()]);
    assert!(launch_protected_installer(
        context,
        DirectDatabaseBinding::new(
            "postgres://migrator:fixture-secret@localhost:5432/fixture?sslmode=disable".into()
        ),
        &catalog,
        &mut authority,
        Duration::from_millis(150),
    )
    .is_err());
    let worker_pid = std::fs::read_to_string(&marker).expect("worker reached its stuck state");
    let still_running = std::process::Command::new("kill")
        .args(["-0", worker_pid.trim()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("inspect owned fixture process");
    assert!(
        !still_running.success(),
        "timed-out worker must be terminated and reaped"
    );
    std::fs::remove_file(marker).unwrap();
}

#[test]
fn rejects_wrong_database_binding_before_worker_or_authority() {
    let (context, catalog) = fixture(Vec::new());
    let mut authority = RecordingAuthority::default();
    assert_eq!(
        launch_protected_installer(
            context,
            DirectDatabaseBinding::new(
                "postgres://wrong:fixture-secret@localhost:5433/fixture".into(),
            ),
            &catalog,
            &mut authority,
            Duration::from_secs(2),
        ),
        Err(InstallError::DatabaseIdentityMismatch)
    );
    assert!(authority.0.lock().unwrap().is_empty());
}

#[test]
fn startup_decoder_bounds_frames_and_preserves_authority_stream() {
    let (context, _) = fixture(Vec::new());
    let mut startup = serde_json::to_vec(context.value()).unwrap();
    startup.push(b'\n');
    startup.extend_from_slice(
        b"\"postgres://migrator:fixture-secret@localhost:5432/fixture?sslmode=disable\"\n",
    );
    startup.extend_from_slice(b"{\"kind\":\"next-frame\"}\n");
    let mut input = std::io::BufReader::new(std::io::Cursor::new(startup));
    let (decoded, binding) = read_protected_installer_startup(&mut input).unwrap();
    assert_eq!(decoded.digest(), context.digest());
    assert!(format!("{binding:?}").contains("redacted"));
    let mut following = String::new();
    std::io::BufRead::read_line(&mut input, &mut following).unwrap();
    assert_eq!(following, "{\"kind\":\"next-frame\"}\n");

    let mut missing_binding = serde_json::to_vec(context.value()).unwrap();
    missing_binding.push(b'\n');
    let mut input = std::io::BufReader::new(std::io::Cursor::new(missing_binding));
    assert_eq!(
        read_protected_installer_startup(&mut input).unwrap_err(),
        InstallError::Protocol
    );

    let mut malformed = serde_json::to_vec(context.value()).unwrap();
    malformed.extend_from_slice(b"\nnot-a-json-string\n");
    let mut input = std::io::BufReader::new(std::io::Cursor::new(malformed));
    assert_eq!(
        read_protected_installer_startup(&mut input).unwrap_err(),
        InstallError::DatabaseIdentityMismatch
    );

    let oversized = vec![b'x'; MAX_PROTOCOL_FRAME_BYTES + 2];
    let mut input = std::io::BufReader::new(std::io::Cursor::new(oversized));
    assert_eq!(
        read_protected_installer_startup(&mut input).unwrap_err(),
        InstallError::Protocol
    );
}
