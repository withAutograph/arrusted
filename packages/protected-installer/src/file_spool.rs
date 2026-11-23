//! Private file-spool transport for protected installer workers in command APIs that do not
//! expose a writable child stdin. The spool carries the same typed authority frames as the
//! stdin/stdout transport; it is ephemeral transport state, never an effect journal.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::{
    AuthorityError, DirectDatabaseBinding, EffectAuthority, EffectAuthorizationRequest,
    EffectCheckpoint, FrozenInstallContext, InstallError, MAX_PROTOCOL_FRAME_BYTES,
};

pub const FILE_SPOOL_PROTOCOL_VERSION: u32 = 1;

/// Completion marker published only after the corresponding JSON file is complete.
/// Startup uses frame_id 0; authority messages use positive, monotonically increasing IDs.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SpoolReadyMarker {
    pub version: u32,
    pub run_id: String,
    pub frame_id: u64,
}

impl SpoolReadyMarker {
    pub fn startup(run_id: impl Into<String>) -> Self {
        Self {
            version: FILE_SPOOL_PROTOCOL_VERSION,
            run_id: run_id.into(),
            frame_id: 0,
        }
    }

    pub fn frame(run_id: impl Into<String>, frame_id: u64) -> Self {
        Self {
            version: FILE_SPOOL_PROTOCOL_VERSION,
            run_id: run_id.into(),
            frame_id,
        }
    }
}

/// The only data written to worker stdout. The host reads the named request through the
/// Sandbox file API after seeing this notice; request and credential bytes never enter logs.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SpoolFrameNotice {
    pub kind: String,
    pub version: u32,
    pub run_id: String,
    pub frame_id: u64,
}

/// Coarse, non-sensitive terminal failure classification for worker lifecycle reporting.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpoolFailureCode {
    StartupRejected,
    AuthorityDenied,
    EffectFailed,
    ReadbackUnknown,
    ProtocolFailure,
    Cancelled,
    Timeout,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpoolLifecycleKind {
    WorkerStarted,
    WorkerSucceeded,
    WorkerFailed,
}

/// Closed lifecycle fact. It contains no effect result, customer data, SQL, or credentials.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SpoolLifecycleFact {
    pub version: u32,
    pub run_id: String,
    pub kind: SpoolLifecycleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<SpoolFailureCode>,
}

/// Payload-free stdout notice for a private lifecycle fact file.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SpoolLifecycleNotice {
    pub kind: String,
    pub version: u32,
    pub run_id: String,
    pub frame_id: u64,
}

/// Worker-side lifecycle reporter. Its sequence is independent from authorization frames;
/// lifecycle files are observations, never approvals, checkpoints, or a second journal.
pub struct FileSpoolLifecycleChannel<W: Write> {
    spool: PathBuf,
    run_id: String,
    notices: W,
    next_frame_id: u64,
    started: bool,
    terminal: bool,
    poisoned: bool,
}

impl<W: Write> FileSpoolLifecycleChannel<W> {
    pub fn new(
        spool: impl Into<PathBuf>,
        run_id: impl Into<String>,
        notices: W,
    ) -> Result<Self, InstallError> {
        let run_id = run_id.into();
        validate_run_id(&run_id)?;
        let spool = spool.into();
        fs::create_dir_all(spool.join("lifecycle")).map_err(|_| InstallError::Protocol)?;
        Ok(Self {
            spool,
            run_id,
            notices,
            next_frame_id: 0,
            started: false,
            terminal: false,
            poisoned: false,
        })
    }

    /// Call only after context, selected resource, and running installer pin are verified.
    pub fn worker_started(&mut self) -> Result<(), InstallError> {
        if self.started || self.terminal || self.poisoned {
            return Err(InstallError::Protocol);
        }
        self.publish(SpoolLifecycleKind::WorkerStarted, None)
    }

    /// Call only after all effect readbacks and durable checkpoint acknowledgements succeed.
    pub fn worker_succeeded(&mut self) -> Result<(), InstallError> {
        if !self.started || self.terminal || self.poisoned {
            return Err(InstallError::Protocol);
        }
        self.publish(SpoolLifecycleKind::WorkerSucceeded, None)
    }

    /// Failure may be reported before `worker_started` for a startup rejection.
    pub fn worker_failed(&mut self, failure_code: SpoolFailureCode) -> Result<(), InstallError> {
        if self.terminal || self.poisoned {
            return Err(InstallError::Protocol);
        }
        self.publish(SpoolLifecycleKind::WorkerFailed, Some(failure_code))
    }

    fn publish(
        &mut self,
        kind: SpoolLifecycleKind,
        failure_code: Option<SpoolFailureCode>,
    ) -> Result<(), InstallError> {
        let frame_id = self
            .next_frame_id
            .checked_add(1)
            .ok_or(InstallError::Protocol)?;
        let fact = SpoolLifecycleFact {
            version: FILE_SPOOL_PROTOCOL_VERSION,
            run_id: self.run_id.clone(),
            kind,
            failure_code,
        };
        let bytes = serde_json::to_vec(&fact).map_err(|_| InstallError::Protocol)?;
        if bytes.len() > MAX_PROTOCOL_FRAME_BYTES {
            return Err(InstallError::Protocol);
        }
        let lifecycle = self.spool.join("lifecycle");
        let fact_path = lifecycle.join(format!("{frame_id}.json"));
        let ready_path = lifecycle.join(format!("{frame_id}.ready"));
        let marker = SpoolReadyMarker::frame(self.run_id.clone(), frame_id);
        let marker_bytes = serde_json::to_vec(&marker).map_err(|_| InstallError::Protocol)?;
        publish_new_file(&fact_path, &bytes).map_err(|_| InstallError::Protocol)?;
        if publish_new_file(&ready_path, &marker_bytes).is_err() {
            if fs::remove_file(&fact_path).is_err() {
                self.poisoned = true;
            }
            return Err(InstallError::Protocol);
        }

        self.next_frame_id = frame_id;
        match kind {
            SpoolLifecycleKind::WorkerStarted => self.started = true,
            SpoolLifecycleKind::WorkerSucceeded | SpoolLifecycleKind::WorkerFailed => {
                self.terminal = true;
            }
        }
        let notice = SpoolLifecycleNotice {
            kind: "protected_installer_lifecycle_ready".to_string(),
            version: FILE_SPOOL_PROTOCOL_VERSION,
            run_id: self.run_id.clone(),
            frame_id,
        };
        serde_json::to_writer(&mut self.notices, &notice).map_err(|_| InstallError::Protocol)?;
        self.notices
            .write_all(b"\n")
            .and_then(|()| self.notices.flush())
            .map_err(|_| InstallError::Protocol)
    }
}

/// Read the host-published startup files and remove them before returning the database binding.
/// The host writes context.json and direct-database-url.json completely, then publishes ready.json.
pub fn read_protected_installer_spool_startup(
    spool: &Path,
    run_id: &str,
) -> Result<(FrozenInstallContext, DirectDatabaseBinding), InstallError> {
    validate_run_id(run_id)?;
    let startup = spool.join("startup");
    let paths = [
        startup.join("context.json"),
        startup.join("direct-database-url.json"),
        startup.join("ready.json"),
    ];
    let cleanup = StartupCleanup(paths.clone());

    let result = (|| {
        let marker: SpoolReadyMarker = read_json_file(&paths[2])?;
        validate_marker(&marker, run_id, 0)?;

        let context_bytes = read_bounded_file(&paths[0])?;
        let context = FrozenInstallContext::parse_json(&context_bytes)?;

        let mut binding_bytes = read_bounded_file(&paths[1])?;
        let decoded = serde_json::from_slice::<String>(&binding_bytes);
        binding_bytes.zeroize();
        let mut connection_url = decoded.map_err(|_| InstallError::DatabaseIdentityMismatch)?;
        if connection_url.is_empty()
            || connection_url.len() > MAX_PROTOCOL_FRAME_BYTES
            || connection_url
                .chars()
                .any(|value| matches!(value, '\n' | '\r'))
        {
            connection_url.zeroize();
            return Err(InstallError::DatabaseIdentityMismatch);
        }
        Ok((context, DirectDatabaseBinding::new(connection_url)))
    })();

    match result {
        Ok((context, binding)) => {
            if cleanup.remove().is_err() {
                let mut binding = binding;
                binding.connection_url.zeroize();
                return Err(InstallError::Protocol);
            }
            Ok((context, binding))
        }
        Err(error) => {
            let _ = cleanup.remove();
            Err(error)
        }
    }
}

/// Worker-side authority adapter for the host's structured file relay.
///
/// Requests are atomically published as JSON plus a separate ready marker, followed by a
/// payload-free stdout notice. Replies are accepted only after the matching marker appears and
/// all echoed operation identities match. The timeout bounds waiting for a matching response
/// after the notice has been written and flushed; it does not bound a blocked stdout write or the
/// whole install. The parent must drain notices and supervise cancellation/session expiry.
pub struct FileSpoolAuthorityChannel<W: Write> {
    spool: PathBuf,
    run_id: String,
    notices: W,
    timeout: Duration,
    next_frame_id: u64,
}

impl<W: Write> FileSpoolAuthorityChannel<W> {
    pub fn new(
        spool: impl Into<PathBuf>,
        run_id: impl Into<String>,
        notices: W,
        timeout: Duration,
    ) -> Result<Self, InstallError> {
        let run_id = run_id.into();
        validate_run_id(&run_id)?;
        if timeout.is_zero() {
            return Err(InstallError::Protocol);
        }
        let spool = spool.into();
        fs::create_dir_all(spool.join("requests")).map_err(|_| InstallError::Protocol)?;
        fs::create_dir_all(spool.join("responses")).map_err(|_| InstallError::Protocol)?;
        Ok(Self {
            spool,
            run_id,
            notices,
            timeout,
            next_frame_id: 0,
        })
    }

    fn exchange<T: Serialize, R: DeserializeOwned>(
        &mut self,
        value: &T,
    ) -> Result<R, AuthorityError> {
        let frame_id = self
            .next_frame_id
            .checked_add(1)
            .ok_or(AuthorityError::Protocol)?;
        let mut bytes = serde_json::to_vec(value).map_err(|_| AuthorityError::Protocol)?;
        if bytes.len() > MAX_PROTOCOL_FRAME_BYTES {
            bytes.zeroize();
            return Err(AuthorityError::Protocol);
        }

        let requests = self.spool.join("requests");
        let request_path = requests.join(format!("{frame_id}.json"));
        let request_ready = requests.join(format!("{frame_id}.ready"));
        let marker = SpoolReadyMarker::frame(self.run_id.clone(), frame_id);
        let marker_bytes = serde_json::to_vec(&marker).map_err(|_| AuthorityError::Protocol)?;
        if publish_new_file(&request_path, &bytes).is_err()
            || publish_new_file(&request_ready, &marker_bytes).is_err()
        {
            bytes.zeroize();
            return Err(AuthorityError::Protocol);
        }
        bytes.zeroize();

        let notice = SpoolFrameNotice {
            kind: "protected_installer_frame_ready".to_string(),
            version: FILE_SPOOL_PROTOCOL_VERSION,
            run_id: self.run_id.clone(),
            frame_id,
        };
        serde_json::to_writer(&mut self.notices, &notice).map_err(|_| AuthorityError::Protocol)?;
        self.notices
            .write_all(b"\n")
            .and_then(|()| self.notices.flush())
            .map_err(|_| AuthorityError::Protocol)?;
        self.next_frame_id = frame_id;

        let response = self.wait_for_response::<R>(frame_id)?;
        let responses = self.spool.join("responses");
        fs::remove_file(responses.join(format!("{frame_id}.json")))
            .map_err(|_| AuthorityError::Protocol)?;
        fs::remove_file(responses.join(format!("{frame_id}.ready")))
            .map_err(|_| AuthorityError::Protocol)?;
        Ok(response)
    }

    fn wait_for_response<R: DeserializeOwned>(&self, frame_id: u64) -> Result<R, AuthorityError> {
        let responses = self.spool.join("responses");
        let response_path = responses.join(format!("{frame_id}.json"));
        let ready_path = responses.join(format!("{frame_id}.ready"));
        let deadline = Instant::now() + self.timeout;
        loop {
            match fs::symlink_metadata(&ready_path) {
                Ok(metadata) if metadata.file_type().is_file() => {
                    let marker: SpoolReadyMarker =
                        read_json_file(&ready_path).map_err(|_| AuthorityError::Protocol)?;
                    validate_marker(&marker, &self.run_id, frame_id)
                        .map_err(|_| AuthorityError::Protocol)?;
                    return read_json_file(&response_path).map_err(|_| AuthorityError::Protocol);
                }
                Ok(_) => return Err(AuthorityError::Protocol),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(AuthorityError::Protocol),
            }
            if Instant::now() >= deadline {
                return Err(AuthorityError::Protocol);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl<W: Write> EffectAuthority for FileSpoolAuthorityChannel<W> {
    fn authorize(&mut self, request: &EffectAuthorizationRequest) -> Result<(), AuthorityError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply {
            kind: String,
            version: u32,
            operation_id: String,
            context_digest: String,
            fence_generation: u64,
            sequence: u64,
            effect_id: String,
            allowed: bool,
        }

        let reply: Reply = self.exchange(request)?;
        if reply.kind != "effect_authorized"
            || reply.version != request.version
            || reply.operation_id != request.operation_id
            || reply.context_digest != request.context_digest
            || reply.fence_generation != request.fence_generation
            || reply.sequence != request.sequence
            || reply.effect_id != request.effect_id
        {
            return Err(AuthorityError::Protocol);
        }
        if !reply.allowed {
            return Err(AuthorityError::Denied);
        }
        Ok(())
    }

    fn checkpoint(&mut self, checkpoint: &EffectCheckpoint) -> Result<(), AuthorityError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply {
            kind: String,
            version: u32,
            operation_id: String,
            context_digest: String,
            fence_generation: u64,
            sequence: u64,
            effect_id: String,
            recorded: bool,
        }

        let reply: Reply = self.exchange(checkpoint)?;
        if reply.kind != "checkpoint_recorded"
            || reply.version != checkpoint.version
            || reply.operation_id != checkpoint.operation_id
            || reply.context_digest != checkpoint.context_digest
            || reply.fence_generation != checkpoint.fence_generation
            || reply.sequence != checkpoint.sequence
            || reply.effect_id != checkpoint.effect_id
            || !reply.recorded
        {
            return Err(AuthorityError::Protocol);
        }
        Ok(())
    }
}

fn validate_run_id(run_id: &str) -> Result<(), InstallError> {
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(InstallError::Protocol);
    }
    Ok(())
}

fn validate_marker(
    marker: &SpoolReadyMarker,
    run_id: &str,
    frame_id: u64,
) -> Result<(), InstallError> {
    if marker.version != FILE_SPOOL_PROTOCOL_VERSION
        || marker.run_id != run_id
        || marker.frame_id != frame_id
    {
        return Err(InstallError::Protocol);
    }
    Ok(())
}

fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<T, InstallError> {
    let bytes = read_bounded_file(path)?;
    serde_json::from_slice(&bytes).map_err(|_| InstallError::Protocol)
}

fn read_bounded_file(path: &Path) -> Result<Vec<u8>, InstallError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| InstallError::Protocol)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_PROTOCOL_FRAME_BYTES as u64 {
        return Err(InstallError::Protocol);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| {
            file.take((MAX_PROTOCOL_FRAME_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
        })
        .map_err(|_| InstallError::Protocol)?;
    if bytes.len() > MAX_PROTOCOL_FRAME_BYTES {
        bytes.zeroize();
        return Err(InstallError::Protocol);
    }
    Ok(bytes)
}

fn publish_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "spool file has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let name = path.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "spool file has no name")
    })?;
    let temporary = parent.join(format!("{}.tmp", name.to_string_lossy()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let write_result = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    // A same-filesystem hard link atomically publishes without replacing an existing frame.
    if let Err(error) = fs::hard_link(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let _ = fs::remove_file(&temporary);
    Ok(())
}

struct StartupCleanup([PathBuf; 3]);

impl StartupCleanup {
    fn remove(&self) -> std::io::Result<()> {
        for path in &self.0 {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

impl Drop for StartupCleanup {
    fn drop(&mut self) {
        let _ = self.remove();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        FileSpoolLifecycleChannel, SpoolFailureCode, SpoolLifecycleFact, SpoolLifecycleKind,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn lifecycle_ready_publish_failure_cleans_fact_and_allows_failure_report_retry() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let spool = std::env::temp_dir().join(format!(
            "protected-installer-lifecycle-publish-{}-{unique}",
            std::process::id()
        ));
        let lifecycle_dir = spool.join("lifecycle");
        fs::create_dir_all(lifecycle_dir.join("1.ready"))
            .expect("create colliding ready-marker directory");

        let mut channel = FileSpoolLifecycleChannel::new(&spool, "publish-retry", std::io::sink())
            .expect("create lifecycle channel");
        assert!(channel.worker_started().is_err());
        assert!(
            !lifecycle_dir.join("1.json").exists(),
            "a failed marker publication must remove the orphan lifecycle fact"
        );
        assert!(
            !lifecycle_dir.join("1.ready.tmp").exists(),
            "a failed marker publication must remove its temporary file"
        );

        fs::remove_dir(lifecycle_dir.join("1.ready")).expect("remove collision");
        channel
            .worker_failed(SpoolFailureCode::StartupRejected)
            .expect("failure reporting can reuse the uncommitted sequence");
        let fact: SpoolLifecycleFact = serde_json::from_slice(
            &fs::read(lifecycle_dir.join("1.json")).expect("retry lifecycle fact"),
        )
        .expect("typed lifecycle fact");
        assert_eq!(fact.kind, SpoolLifecycleKind::WorkerFailed);
        assert_eq!(fact.failure_code, Some(SpoolFailureCode::StartupRejected));
        assert!(!lifecycle_dir.join("2.json").exists());

        fs::remove_dir_all(spool).expect("remove lifecycle fixture");
    }
}
