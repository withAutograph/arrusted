use std::io::{self, BufRead, Write};

use protected_installer::{
    read_protected_installer_spool_startup, read_protected_installer_startup, AuthorityError,
    EffectAuthority, EffectAuthorizationRequest, EffectCheckpoint, EffectReceipt, EffectState,
    FileSpoolAuthorityChannel, FileSpoolLifecycleChannel, SpoolFailureCode,
};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "file-spool" {
        run_file_spool();
        return;
    }
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let (frozen, binding) = read_protected_installer_startup(&mut input).unwrap();
    let context = frozen.value().clone();
    assert!(
        format!("{binding:?}").contains("redacted"),
        "database binding debug output remains redacted"
    );
    if mode == "hang" {
        let marker = std::env::args()
            .nth(2)
            .expect("hang fixture needs a PID marker");
        std::fs::write(marker, std::process::id().to_string()).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(10));
        return;
    }
    drop(binding);

    let request = EffectAuthorizationRequest {
        kind: "authorize_effect".into(),
        version: 1,
        operation_id: context.operation.operation_id.clone(),
        approval_digest: context.operation.approval_digest.clone(),
        context_digest: frozen.digest().into(),
        fence_generation: context.operation.fence_generation,
        sequence: 1,
        effect_id: "install:tenant-fixture".into(),
        app_id: context.app_id.clone(),
        resource_id: context.resource.resource_id.clone(),
        release_id: context.release.id.clone(),
        installer_id: context.installer.id.clone(),
        installer_sha256: context.installer.sha256.clone(),
        tenant_id: Some(if mode == "wrong-target" {
            "tenant-outside-approval".into()
        } else {
            "tenant-fixture".into()
        }),
    };
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &request).unwrap();
    output.write_all(b"\n").unwrap();
    output.flush().unwrap();
    let mut reply = String::new();
    input.read_line(&mut reply).unwrap();
    let reply: serde_json::Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["allowed"], true);

    let checkpoint = EffectCheckpoint {
        kind: "checkpoint_effect".into(),
        version: 1,
        operation_id: context.operation.operation_id,
        context_digest: frozen.digest().into(),
        fence_generation: context.operation.fence_generation,
        sequence: 1,
        effect_id: "install:tenant-fixture".into(),
        resource_id: context.resource.resource_id,
        tenant_id: Some("tenant-fixture".into()),
        receipt: EffectReceipt {
            state: EffectState::Applied,
            readback_sha256: Some("d".repeat(64)),
        },
    };
    serde_json::to_writer(&mut output, &checkpoint).unwrap();
    output.write_all(b"\n").unwrap();
    output.flush().unwrap();
    let mut ack = String::new();
    input.read_line(&mut ack).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&ack).unwrap()["recorded"],
        true
    );
}

fn run_file_spool() {
    let mut args = std::env::args().skip(2);
    let spool = args.next().expect("spool fixture needs a directory");
    let run_id = args.next().expect("spool fixture needs a run ID");
    let timeout_ms: u64 = args
        .next()
        .expect("spool fixture needs a timeout")
        .parse()
        .expect("timeout is numeric");
    let mode = args.next().unwrap_or_default();
    let mut lifecycle = FileSpoolLifecycleChannel::new(&spool, &run_id, io::stdout())
        .unwrap_or_else(|_| std::process::exit(19));
    let (frozen, binding) =
        read_protected_installer_spool_startup(std::path::Path::new(&spool), &run_id)
            .unwrap_or_else(|_| {
                let _ = lifecycle.worker_failed(SpoolFailureCode::StartupRejected);
                std::process::exit(20)
            });
    if mode == "lifecycle-order" {
        assert!(lifecycle.worker_succeeded().is_err());
        lifecycle
            .worker_failed(SpoolFailureCode::StartupRejected)
            .unwrap();
        assert!(lifecycle
            .worker_failed(SpoolFailureCode::ProtocolFailure)
            .is_err());
        std::process::exit(25);
    }
    lifecycle
        .worker_started()
        .unwrap_or_else(|_| std::process::exit(21));
    assert!(format!("{binding:?}").contains("redacted"));
    drop(binding);

    let context = frozen.value();
    let request = EffectAuthorizationRequest {
        kind: "authorize_effect".into(),
        version: 1,
        operation_id: context.operation.operation_id.clone(),
        approval_digest: context.operation.approval_digest.clone(),
        context_digest: frozen.digest().into(),
        fence_generation: context.operation.fence_generation,
        sequence: 1,
        effect_id: "install:tenant-fixture".into(),
        app_id: context.app_id.clone(),
        resource_id: context.resource.resource_id.clone(),
        release_id: context.release.id.clone(),
        installer_id: context.installer.id.clone(),
        installer_sha256: context.installer.sha256.clone(),
        tenant_id: Some("tenant-fixture".into()),
    };
    let stdout = io::stdout();
    let mut authority = FileSpoolAuthorityChannel::new(
        spool,
        run_id,
        stdout.lock(),
        std::time::Duration::from_millis(timeout_ms),
    )
    .unwrap_or_else(|_| std::process::exit(21));
    match authority.authorize(&request) {
        Ok(()) => {}
        Err(AuthorityError::Denied) => {
            let _ = lifecycle.worker_failed(SpoolFailureCode::AuthorityDenied);
            std::process::exit(22)
        }
        Err(_) => {
            let _ = lifecycle.worker_failed(SpoolFailureCode::ProtocolFailure);
            std::process::exit(23)
        }
    }

    let checkpoint = EffectCheckpoint {
        kind: "checkpoint_effect".into(),
        version: 1,
        operation_id: context.operation.operation_id.clone(),
        context_digest: frozen.digest().into(),
        fence_generation: context.operation.fence_generation,
        sequence: 1,
        effect_id: "install:tenant-fixture".into(),
        resource_id: context.resource.resource_id.clone(),
        tenant_id: Some("tenant-fixture".into()),
        receipt: EffectReceipt {
            state: EffectState::Applied,
            readback_sha256: Some("d".repeat(64)),
        },
    };
    if authority.checkpoint(&checkpoint).is_err() {
        let _ = lifecycle.worker_failed(SpoolFailureCode::ProtocolFailure);
        std::process::exit(24);
    }
    lifecycle
        .worker_succeeded()
        .unwrap_or_else(|_| std::process::exit(26));
}
