//! Trusted parent process launcher for protected installer workers.
//!
//! The catalog and authority are supplied by the protected operator. They must never be
//! constructed from a caller/model request. This module owns process isolation and the sole
//! parent-side path from worker requests to the live operator effect authority.

use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{
    AuthorityError, EffectAuthority, EffectAuthorizationRequest, EffectCheckpoint, EffectState,
    FrozenInstallContext, InstallError, InstallerPin, MAX_PROTOCOL_FRAME_BYTES,
};

/// One immutable operator-owned worker entry. `args` are fixed operator configuration, never
/// operation input. The deployment image holding `path` must be immutable/read-only.
#[derive(Clone, Debug)]
pub struct PinnedInstallerWorker {
    pub pin: InstallerPin,
    pub path: PathBuf,
    pub args: Vec<String>,
}

/// Trusted worker catalog loaded by the operator from its own deployment configuration.
#[derive(Clone, Debug, Default)]
pub struct TrustedInstallerCatalog {
    workers: Vec<PinnedInstallerWorker>,
}

impl TrustedInstallerCatalog {
    pub fn new(workers: Vec<PinnedInstallerWorker>) -> Result<Self, InstallError> {
        if workers.iter().any(|worker| {
            worker.pin.id.is_empty()
                || worker.pin.sha256.len() != 64
                || worker.path.as_os_str().is_empty()
        }) {
            return Err(InstallError::InstallerIdentityMismatch);
        }
        for (index, worker) in workers.iter().enumerate() {
            if workers[..index]
                .iter()
                .any(|other| other.pin.id == worker.pin.id)
            {
                return Err(InstallError::InstallerIdentityMismatch);
            }
        }
        Ok(Self { workers })
    }

    fn select(
        &self,
        context: &FrozenInstallContext,
    ) -> Result<&PinnedInstallerWorker, InstallError> {
        self.workers
            .iter()
            .find(|worker| worker.pin.id == context.value().installer.id)
            .ok_or(InstallError::InstallerIdentityMismatch)
    }
}

/// Run the catalog-selected worker with a mandatory live operator authority.
///
/// The first two stdin lines are the canonical frozen context and the separate direct DB URL.
/// Later stdin/stdout lines are the existing typed authority protocol. A timeout, malformed
/// frame, unexpected target/sequence, denied permit, missing ACK, or nonzero exit fails closed
/// and kills the worker. No child environment is inherited.
pub fn launch_protected_installer<A: EffectAuthority>(
    context: FrozenInstallContext,
    binding: crate::DirectDatabaseBinding,
    catalog: &TrustedInstallerCatalog,
    authority: &mut A,
    timeout: Duration,
) -> Result<(), InstallError> {
    if timeout.is_zero() {
        return Err(InstallError::Protocol);
    }
    crate::verify_direct_connection_target(&binding.connection_url, &context.value().resource)?;
    let worker = catalog.select(&context)?;
    verify_worker(worker, &context)?;
    let context_bytes =
        serde_json::to_vec(context.value()).map_err(|_| InstallError::InvalidContext)?;
    if context_bytes.len() > MAX_PROTOCOL_FRAME_BYTES {
        return Err(InstallError::InvalidContext);
    }
    let mut binding = binding;
    if binding
        .connection_url
        .chars()
        .any(|value| matches!(value, '\n' | '\r'))
        || binding.connection_url.len() > MAX_PROTOCOL_FRAME_BYTES
    {
        return Err(InstallError::DatabaseIdentityMismatch);
    }
    let deadline = std::time::Instant::now() + timeout;

    let mut child = Command::new(&worker.path)
        .args(&worker.args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| InstallError::InstallerIdentityMismatch)?;
    let stdin = child.stdin.take().ok_or(InstallError::Protocol)?;
    let stdout = child.stdout.take().ok_or(InstallError::Protocol)?;
    let mut guard = ChildGuard { child: Some(child) };
    let (frame_tx, frame_rx) = mpsc::sync_channel(1);
    thread::spawn(move || read_worker_frames(stdout, frame_tx));

    let writer = PipeWriter::new(stdin);
    let mut channel = WorkerAuthorityChannel::new(writer, frame_rx, deadline, authority, &context);
    if channel
        .send_initial(&context_bytes, &binding.connection_url)
        .is_err()
    {
        binding.connection_url.zeroize();
        return Err(InstallError::Protocol);
    }
    binding.connection_url.zeroize();

    while channel.process_one()? {}
    let status = loop {
        if let Some(status) = guard
            .child_mut()?
            .try_wait()
            .map_err(|_| InstallError::Protocol)?
        {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            return Err(InstallError::Protocol);
        }
        thread::sleep(Duration::from_millis(10));
    };
    if channel.unknown_seen {
        return Err(InstallError::ReadbackUnknown);
    }
    if !status.success() || channel.has_pending_authorization() || channel.sequence == 0 {
        return Err(InstallError::Protocol);
    }
    guard.disarm();
    Ok(())
}

/// Decode the bounded private startup frames shared by trusted installer workers. The second
/// frame is a JSON string so literal newlines cannot escape its boundary. Errors never include
/// the secret frame contents.
pub fn read_protected_installer_startup<R: BufRead>(
    input: &mut R,
) -> Result<(FrozenInstallContext, crate::DirectDatabaseBinding), InstallError> {
    let context = FrozenInstallContext::parse_json(&read_startup_line(input)?)?;
    let mut binding_bytes = read_startup_line(input)?;
    let decoded = serde_json::from_slice(&binding_bytes);
    binding_bytes.zeroize();
    let mut connection_url: String = decoded.map_err(|_| InstallError::DatabaseIdentityMismatch)?;
    if connection_url.is_empty()
        || connection_url.len() > MAX_PROTOCOL_FRAME_BYTES
        || connection_url
            .chars()
            .any(|value| matches!(value, '\n' | '\r'))
    {
        connection_url.zeroize();
        return Err(InstallError::DatabaseIdentityMismatch);
    }
    Ok((context, crate::DirectDatabaseBinding::new(connection_url)))
}

fn read_startup_line<R: BufRead>(input: &mut R) -> Result<Vec<u8>, InstallError> {
    let mut frame = Vec::new();
    let read = match input
        .take((MAX_PROTOCOL_FRAME_BYTES + 2) as u64)
        .read_until(b'\n', &mut frame)
    {
        Ok(read) => read,
        Err(_) => {
            frame.zeroize();
            return Err(InstallError::Protocol);
        }
    };
    if read == 0 || frame.len() > MAX_PROTOCOL_FRAME_BYTES + 1 || frame.last() != Some(&b'\n') {
        frame.zeroize();
        return Err(InstallError::Protocol);
    }
    frame.pop();
    if frame.last() == Some(&b'\r') {
        frame.pop();
    }
    Ok(frame)
}

fn verify_worker(
    worker: &PinnedInstallerWorker,
    context: &FrozenInstallContext,
) -> Result<(), InstallError> {
    if worker.pin.id != context.value().installer.id
        || worker.pin.sha256 != context.value().installer.sha256
        || !is_sha256(&worker.pin.sha256)
    {
        return Err(InstallError::InstallerIdentityMismatch);
    }
    let metadata =
        fs::symlink_metadata(&worker.path).map_err(|_| InstallError::InstallerIdentityMismatch)?;
    if !metadata.file_type().is_file() {
        return Err(InstallError::InstallerIdentityMismatch);
    }
    let bytes = fs::read(&worker.path).map_err(|_| InstallError::InstallerIdentityMismatch)?;
    if sha256(&bytes) != worker.pin.sha256 {
        return Err(InstallError::InstallerIdentityMismatch);
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_worker_frames(mut stdout: impl Read, tx: SyncSender<Result<Vec<u8>, InstallError>>) {
    let mut frame = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stdout.read(&mut byte) {
            Ok(0) => {
                if !frame.is_empty() {
                    let _ = tx.send(Err(InstallError::Protocol));
                }
                return;
            }
            Ok(_) if byte[0] == b'\n' => {
                if tx.send(Ok(std::mem::take(&mut frame))).is_err() {
                    return;
                }
            }
            Ok(_) => {
                if frame.len() >= MAX_PROTOCOL_FRAME_BYTES {
                    let _ = tx.send(Err(InstallError::Protocol));
                    return;
                }
                frame.push(byte[0]);
            }
            Err(_) => {
                let _ = tx.send(Err(InstallError::Protocol));
                return;
            }
        }
    }
}

struct WriterMessage {
    bytes: Vec<u8>,
    acknowledgement: SyncSender<Result<(), InstallError>>,
}

struct PipeWriter {
    messages: SyncSender<WriterMessage>,
}

impl PipeWriter {
    fn new(mut stdin: ChildStdin) -> Self {
        let (messages, receiver) = mpsc::sync_channel::<WriterMessage>(1);
        thread::spawn(move || {
            while let Ok(message) = receiver.recv() {
                let mut bytes = message.bytes;
                let result = stdin
                    .write_all(&bytes)
                    .and_then(|()| stdin.flush())
                    .map_err(|_| InstallError::Protocol);
                bytes.zeroize();
                let failed = result.is_err();
                let _ = message.acknowledgement.send(result);
                if failed {
                    return;
                }
            }
        });
        Self { messages }
    }

    fn send(&self, mut bytes: Vec<u8>, deadline: std::time::Instant) -> Result<(), InstallError> {
        let (acknowledgement, result) = mpsc::sync_channel(1);
        let message = WriterMessage {
            bytes: std::mem::take(&mut bytes),
            acknowledgement,
        };
        if let Err(error) = self.messages.try_send(message) {
            match error {
                mpsc::TrySendError::Full(mut message)
                | mpsc::TrySendError::Disconnected(mut message) => message.bytes.zeroize(),
            }
            bytes.zeroize();
            return Err(InstallError::Protocol);
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(InstallError::Protocol);
        }
        match result.recv_timeout(remaining) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                Err(InstallError::Protocol)
            }
        }
    }
}

struct WorkerAuthorityChannel<'a, A: EffectAuthority> {
    writer: PipeWriter,
    frames: Receiver<Result<Vec<u8>, InstallError>>,
    deadline: std::time::Instant,
    authority: &'a mut A,
    context: &'a FrozenInstallContext,
    sequence: u64,
    pending: Option<EffectAuthorizationRequest>,
    unknown_seen: bool,
}

impl<'a, A: EffectAuthority> WorkerAuthorityChannel<'a, A> {
    fn new(
        writer: PipeWriter,
        frames: Receiver<Result<Vec<u8>, InstallError>>,
        deadline: std::time::Instant,
        authority: &'a mut A,
        context: &'a FrozenInstallContext,
    ) -> Self {
        Self {
            writer,
            frames,
            deadline,
            authority,
            context,
            sequence: 0,
            pending: None,
            unknown_seen: false,
        }
    }

    fn send_initial(&mut self, context: &[u8], binding: &str) -> Result<(), InstallError> {
        let mut binding = serde_json::to_vec(binding).map_err(|_| InstallError::Protocol)?;
        if binding.len() > MAX_PROTOCOL_FRAME_BYTES {
            binding.zeroize();
            return Err(InstallError::DatabaseIdentityMismatch);
        }
        let mut bytes = Vec::with_capacity(context.len() + binding.len() + 2);
        bytes.extend_from_slice(context);
        bytes.push(b'\n');
        bytes.extend_from_slice(&binding);
        bytes.push(b'\n');
        binding.zeroize();
        self.writer.send(bytes, self.deadline)
    }

    fn receive_bytes(&self) -> Result<Option<Vec<u8>>, InstallError> {
        let remaining = self
            .deadline
            .saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(InstallError::Protocol);
        }
        match self.frames.recv_timeout(remaining) {
            Ok(Ok(bytes)) => Ok(Some(bytes)),
            Ok(Err(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => Err(InstallError::Protocol),
            Err(RecvTimeoutError::Disconnected) => Ok(None),
        }
    }

    fn reply<T: Serialize>(&mut self, value: &T) -> Result<(), InstallError> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| InstallError::Protocol)?;
        bytes.push(b'\n');
        self.writer.send(bytes, self.deadline)
    }

    fn has_pending_authorization(&self) -> bool {
        self.pending.is_some()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorizationRequestFrame {
    kind: String,
    version: u32,
    operation_id: String,
    approval_digest: String,
    context_digest: String,
    fence_generation: u64,
    sequence: u64,
    effect_id: String,
    app_id: String,
    resource_id: String,
    release_id: String,
    installer_id: String,
    installer_sha256: String,
    tenant_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointFrame {
    kind: String,
    version: u32,
    operation_id: String,
    context_digest: String,
    fence_generation: u64,
    sequence: u64,
    effect_id: String,
    resource_id: String,
    tenant_id: Option<String>,
    receipt: crate::EffectReceipt,
}

#[derive(Serialize)]
struct AuthorizationReply<'a> {
    kind: &'static str,
    version: u32,
    operation_id: &'a str,
    context_digest: &'a str,
    fence_generation: u64,
    sequence: u64,
    effect_id: &'a str,
    allowed: bool,
}

#[derive(Serialize)]
struct CheckpointReply<'a> {
    kind: &'static str,
    version: u32,
    operation_id: &'a str,
    context_digest: &'a str,
    fence_generation: u64,
    sequence: u64,
    effect_id: &'a str,
    recorded: bool,
}

impl<A: EffectAuthority> WorkerAuthorityChannel<'_, A> {
    fn process_one(&mut self) -> Result<bool, InstallError> {
        let Some(bytes) = self.receive_bytes()? else {
            return Ok(false);
        };
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| InstallError::Protocol)?;
        match value.get("kind").and_then(serde_json::Value::as_str) {
            Some("authorize_effect") => self.authorize_frame(&bytes)?,
            Some("checkpoint_effect") => self.checkpoint_frame(&bytes)?,
            _ => return Err(InstallError::Protocol),
        }
        Ok(true)
    }

    fn authorize_frame(&mut self, bytes: &[u8]) -> Result<(), InstallError> {
        if self.pending.is_some() {
            return Err(InstallError::Protocol);
        }
        let frame: AuthorizationRequestFrame =
            serde_json::from_slice(bytes).map_err(|_| InstallError::Protocol)?;
        let expected_sequence = self.sequence.checked_add(1).ok_or(InstallError::Protocol)?;
        let context = self.context.value();
        let request = EffectAuthorizationRequest {
            kind: frame.kind,
            version: frame.version,
            operation_id: frame.operation_id,
            approval_digest: frame.approval_digest,
            context_digest: frame.context_digest,
            fence_generation: frame.fence_generation,
            sequence: frame.sequence,
            effect_id: frame.effect_id,
            app_id: frame.app_id,
            resource_id: frame.resource_id,
            release_id: frame.release_id,
            installer_id: frame.installer_id,
            installer_sha256: frame.installer_sha256,
            tenant_id: frame.tenant_id,
        };
        if request.kind != "authorize_effect"
            || request.version != crate::CONTEXT_VERSION
            || request.operation_id != context.operation.operation_id
            || request.approval_digest != context.operation.approval_digest
            || request.context_digest != self.context.digest()
            || request.fence_generation != context.operation.fence_generation
            || request.sequence != expected_sequence
            || request.app_id != context.app_id
            || request.resource_id != context.resource.resource_id
            || request.release_id != context.release.id
            || request.installer_id != context.installer.id
            || request.installer_sha256 != context.installer.sha256
            || !valid_target(context, &request.effect_id, request.tenant_id.as_deref())
        {
            return Err(InstallError::Protocol);
        }
        let allowed = match self.authority.authorize(&request) {
            Ok(()) => true,
            Err(AuthorityError::Denied) => false,
            Err(AuthorityError::Protocol) => return Err(InstallError::Protocol),
        };
        self.reply(&AuthorizationReply {
            kind: "effect_authorized",
            version: request.version,
            operation_id: &request.operation_id,
            context_digest: &request.context_digest,
            fence_generation: request.fence_generation,
            sequence: request.sequence,
            effect_id: &request.effect_id,
            allowed,
        })?;
        if !allowed {
            return Err(InstallError::AuthorityDenied);
        }
        self.sequence = expected_sequence;
        self.pending = Some(request);
        Ok(())
    }

    fn checkpoint_frame(&mut self, bytes: &[u8]) -> Result<(), InstallError> {
        let frame: CheckpointFrame =
            serde_json::from_slice(bytes).map_err(|_| InstallError::Protocol)?;
        let request = self.pending.as_ref().ok_or(InstallError::Protocol)?;
        let context = self.context.value();
        if frame.kind != "checkpoint_effect"
            || frame.version != crate::CONTEXT_VERSION
            || frame.operation_id != context.operation.operation_id
            || frame.context_digest != self.context.digest()
            || frame.fence_generation != context.operation.fence_generation
            || frame.sequence != self.sequence
            || frame.effect_id != request.effect_id
            || frame.resource_id != context.resource.resource_id
            || frame.tenant_id != request.tenant_id
            || frame
                .receipt
                .readback_sha256
                .as_deref()
                .is_some_and(|digest| !is_sha256(digest))
            || (frame.receipt.state != EffectState::Unknown
                && frame.receipt.readback_sha256.is_none())
        {
            return Err(InstallError::Protocol);
        }
        let checkpoint = EffectCheckpoint {
            kind: frame.kind,
            version: frame.version,
            operation_id: frame.operation_id,
            context_digest: frame.context_digest,
            fence_generation: frame.fence_generation,
            sequence: frame.sequence,
            effect_id: frame.effect_id,
            resource_id: frame.resource_id,
            tenant_id: frame.tenant_id,
            receipt: frame.receipt,
        };
        self.authority
            .checkpoint(&checkpoint)
            .map_err(|_| InstallError::CheckpointUnconfirmed)?;
        self.reply(&CheckpointReply {
            kind: "checkpoint_recorded",
            version: checkpoint.version,
            operation_id: &checkpoint.operation_id,
            context_digest: &checkpoint.context_digest,
            fence_generation: checkpoint.fence_generation,
            sequence: checkpoint.sequence,
            effect_id: &checkpoint.effect_id,
            recorded: true,
        })?;
        self.unknown_seen |= checkpoint.receipt.state == EffectState::Unknown;
        self.pending = None;
        Ok(())
    }
}

fn valid_target(
    context: &crate::ProtectedInstallContext,
    effect_id: &str,
    tenant_id: Option<&str>,
) -> bool {
    if !crate::valid_opaque_id(effect_id) {
        return false;
    }
    match tenant_id {
        Some(tenant) => context
            .tenant_targets
            .iter()
            .any(|approved| approved == tenant),
        None => true,
    }
}

struct ChildGuard {
    child: Option<Child>,
}
impl ChildGuard {
    fn child_mut(&mut self) -> Result<&mut Child, InstallError> {
        self.child.as_mut().ok_or(InstallError::Protocol)
    }
    fn disarm(&mut self) {
        self.child = None;
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
