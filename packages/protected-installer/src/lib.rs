//! Provider-neutral authority, target, and receipt boundary for reviewed app installers.
//!
//! The protected operator remains the owner of approval, the operation journal, and resource
//! fencing. This crate asks that operator for a fresh one-use authorization immediately before
//! each app-owned write effect and waits for its durable checkpoint acknowledgement afterward.
//! App-specific SQL and installation order remain in the HC or Vendor adapter.

use std::cell::Cell;
use std::fmt;
use std::fs;
use std::io::{BufRead, Write};
use std::path::Path;

use kernel::connect_postgres;
use postgres::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroize;

mod file_spool;
mod launcher;
pub use file_spool::{
    read_protected_installer_spool_startup, FileSpoolAuthorityChannel, FileSpoolLifecycleChannel,
    SpoolFailureCode, SpoolFrameNotice, SpoolLifecycleFact, SpoolLifecycleKind,
    SpoolLifecycleNotice, SpoolReadyMarker, FILE_SPOOL_PROTOCOL_VERSION,
};
pub use launcher::{
    launch_protected_installer, read_protected_installer_startup, PinnedInstallerWorker,
    TrustedInstallerCatalog,
};

pub const CONTEXT_VERSION: u32 = 1;
pub const MAX_PROTOCOL_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperationIdentity {
    pub operation_id: String,
    /// Digest of the operator's concrete approved effect plan.
    pub approval_digest: String,
    /// Monotonically increasing resource fence owned by the protected operator.
    pub fence_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DatabaseResourceIdentity {
    /// Opaque provider/operator resource identity; it is not inferred from a database name.
    pub resource_id: String,
    pub environment: InstallEnvironment,
    pub hostname: String,
    pub port: u16,
    pub database: String,
    pub schema: String,
    pub migrator_role: String,
    pub runtime_role: String,
    /// Provider IDs are operator-read facts. PostgreSQL cannot attest these IDs itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_branch_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum InstallEnvironment {
    Local,
    Preview,
    Production,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactIdentity {
    pub id: String,
    /// SHA-256 of the immutable release artifact selected by approval.
    pub sha256: String,
}

/// Immutable operation input delivered by the trusted operator to an installer worker.
///
/// Connection secrets are deliberately absent. The operator supplies a direct database
/// binding over a separate protected channel after independently reading provider identity.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProtectedInstallContext {
    pub version: u32,
    pub operation: OperationIdentity,
    pub app_id: String,
    pub resource: DatabaseResourceIdentity,
    pub release: ArtifactIdentity,
    pub installer: ArtifactIdentity,
    /// Exact tenant set approved for this operation; order is frozen and duplicates are rejected.
    pub tenant_targets: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrozenInstallContext {
    value: ProtectedInstallContext,
    digest: String,
}

impl FrozenInstallContext {
    pub fn parse_json(bytes: &[u8]) -> Result<Self, InstallError> {
        if bytes.len() > MAX_PROTOCOL_FRAME_BYTES {
            return Err(InstallError::InvalidContext);
        }
        let value: ProtectedInstallContext =
            serde_json::from_slice(bytes).map_err(|_| InstallError::InvalidContext)?;
        Self::new(value)
    }

    pub fn new(value: ProtectedInstallContext) -> Result<Self, InstallError> {
        validate_context(&value)?;
        let canonical = serde_json::to_vec(&value).map_err(|_| InstallError::InvalidContext)?;
        Ok(Self {
            value,
            digest: sha256(&canonical),
        })
    }

    pub fn value(&self) -> &ProtectedInstallContext {
        &self.value
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn allows_tenant(&self, tenant_id: &str) -> bool {
        self.value
            .tenant_targets
            .iter()
            .any(|target| target == tenant_id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InstallerPin {
    pub id: String,
    pub sha256: String,
}

/// Verify the worker file against a pin loaded from trusted operator configuration.
///
/// Call this in the trusted launcher before spawning the worker. `path` must come from the
/// operator-owned installer catalog and reside on an immutable/read-only deployment image;
/// never take the path or pin from the user-authored release or operation payload.
pub fn verify_pinned_installer_artifact(
    path: &Path,
    expected: &InstallerPin,
    context: &FrozenInstallContext,
) -> Result<(), InstallError> {
    if expected.id != context.value.installer.id
        || expected.sha256 != context.value.installer.sha256
        || !is_sha256(&expected.sha256)
    {
        return Err(InstallError::InstallerIdentityMismatch);
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| InstallError::InstallerIdentityMismatch)?;
    if !metadata.file_type().is_file() {
        return Err(InstallError::InstallerIdentityMismatch);
    }
    let bytes = fs::read(path).map_err(|_| InstallError::InstallerIdentityMismatch)?;
    if sha256(&bytes) != expected.sha256 {
        return Err(InstallError::InstallerIdentityMismatch);
    }
    Ok(())
}

/// Non-secret description of the database selected by the operator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseConnectionTarget {
    pub hostname: String,
    pub port: u16,
    pub database: String,
    pub login_role: String,
}

/// Secret direct binding delivered separately from the operation context and protocol frames.
/// Debug output is redacted and the owned URL is cleared when the binding is dropped.
pub struct DirectDatabaseBinding {
    connection_url: String,
}

impl DirectDatabaseBinding {
    pub fn new(connection_url: String) -> Self {
        Self { connection_url }
    }
}

impl fmt::Debug for DirectDatabaseBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DirectDatabaseBinding([redacted])")
    }
}

impl Drop for DirectDatabaseBinding {
    fn drop(&mut self) {
        self.connection_url.zeroize();
    }
}

/// Parse and compare a direct PostgreSQL URL before opening a connection.
///
/// The URL is never included in errors or `Debug`. Hosted endpoints require `verify-full` and
/// reject poolers, hostaddr, extra hosts, query overrides, and non-migrator logins.
pub fn verify_direct_connection_target(
    connection_url: &str,
    resource: &DatabaseResourceIdentity,
) -> Result<DatabaseConnectionTarget, InstallError> {
    let url = Url::parse(connection_url).map_err(|_| InstallError::DatabaseIdentityMismatch)?;
    let expected_ssl = match resource.environment {
        InstallEnvironment::Local => "disable",
        InstallEnvironment::Preview | InstallEnvironment::Production => "verify-full",
    };
    let mut sslmode = None;
    let mut channel_binding = None;
    for parameter in url.query().unwrap_or_default().split('&') {
        let (key, value) = parameter
            .split_once('=')
            .ok_or(InstallError::DatabaseIdentityMismatch)?;
        match key {
            "sslmode" if sslmode.is_none() => sslmode = Some(value.to_string()),
            "channel_binding" if channel_binding.is_none() => {
                channel_binding = Some(value.to_string())
            }
            _ => return Err(InstallError::DatabaseIdentityMismatch),
        }
    }
    if url.fragment().is_some() || sslmode.as_deref() != Some(expected_ssl) {
        return Err(InstallError::DatabaseIdentityMismatch);
    }
    if channel_binding
        .as_deref()
        .is_some_and(|mode| mode != "require")
    {
        return Err(InstallError::DatabaseIdentityMismatch);
    }
    let hostname = url
        .host_str()
        .ok_or(InstallError::DatabaseIdentityMismatch)?
        .to_ascii_lowercase();
    // `url::Url` does not know PostgreSQL's scheme-specific default port.
    let port = url.port().unwrap_or(5432);
    let database = url
        .path()
        .strip_prefix('/')
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or(InstallError::DatabaseIdentityMismatch)?;
    let login_role = url.username();
    if url.password().is_none()
        || !matches!(url.scheme(), "postgres" | "postgresql")
        || hostname != resource.hostname
        || (resource.environment == InstallEnvironment::Local && !is_loopback_hostname(&hostname))
        || hostname.contains("-pooler.")
        || port != resource.port
        || database != resource.database
        || login_role != resource.migrator_role
        || (resource.environment != InstallEnvironment::Local
            && (resource.provider_project_id.is_none() || resource.provider_branch_id.is_none()))
    {
        return Err(InstallError::DatabaseIdentityMismatch);
    }
    Ok(DatabaseConnectionTarget {
        hostname,
        port,
        database: database.to_string(),
        login_role: login_role.to_string(),
    })
}

/// Open the already-selected direct binding and verify actual PostgreSQL identity before effects.
pub fn connect_verified_installer_database(
    binding: &DirectDatabaseBinding,
    resource: &DatabaseResourceIdentity,
) -> Result<VerifiedInstallerDatabase, InstallError> {
    verify_direct_connection_target(&binding.connection_url, resource)?;
    let mut client =
        connect_postgres(&binding.connection_url).map_err(|_| InstallError::DatabaseConnect)?;
    verify_database_login(&mut client, resource)?;
    Ok(VerifiedInstallerDatabase {
        client: Some(client),
        resource: resource.clone(),
        access: Cell::new(DatabaseAccess::Closed),
    })
}

/// Read-only session/database check, also exposed for focused disposable-PostgreSQL tests.
pub fn verify_database_login(
    client: &mut Client,
    resource: &DatabaseResourceIdentity,
) -> Result<(), InstallError> {
    let row = client
        .query_one(
            "select current_database() as database, current_schema() as schema, current_user as role, session_user as login",
            &[],
        )
        .map_err(|_| InstallError::DatabaseIdentityMismatch)?;
    let database: String = row.get("database");
    let schema: Option<String> = row.get("schema");
    let role: String = row.get("role");
    let login: String = row.get("login");
    if database != resource.database
        || schema.as_deref() != Some(resource.schema.as_str())
        || role != resource.migrator_role
        || login != resource.migrator_role
    {
        return Err(InstallError::DatabaseIdentityMismatch);
    }
    Ok(())
}

/// Verified database handle. The raw connection can only be borrowed inside an authorized effect
/// or a readback closure, keeping the caller's write boundary visually explicit.
pub struct VerifiedInstallerDatabase {
    client: Option<Client>,
    resource: DatabaseResourceIdentity,
    access: Cell<DatabaseAccess>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DatabaseAccess {
    Closed,
    AuthorizedEffect,
    ReadOnlyInspection,
}

impl fmt::Debug for VerifiedInstallerDatabase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("VerifiedInstallerDatabase([redacted])")
    }
}

impl VerifiedInstallerDatabase {
    /// Borrow the connection only within an authorized effect or read-only inspection callback.
    /// The pinned worker is trusted code; this capability prevents accidental persistent writes
    /// outside those callbacks, but is not containment for hostile SQL that changes txn state.
    pub fn client_mut(&mut self) -> Result<&mut Client, InstallError> {
        if self.access.get() == DatabaseAccess::Closed {
            return Err(InstallError::AuthorityDenied);
        }
        self.raw_client()
    }

    fn raw_client(&mut self) -> Result<&mut Client, InstallError> {
        self.client.as_mut().ok_or(InstallError::DatabaseConnect)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectTarget {
    /// Stable app-owned effect identity, reused when reconciling the same operation.
    pub effect_id: String,
    /// Tenant-specific writes must name one frozen target. Resource-wide effects use `None`.
    pub tenant_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectState {
    Applied,
    NoChange,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectReceipt {
    pub state: EffectState,
    /// Digest of exact, sanitized identity/readback facts; never include rows or credentials.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readback_sha256: Option<String>,
}

pub trait EffectAuthority {
    /// The operator rereads approval and the live resource fence for this exact effect.
    fn authorize(&mut self, request: &EffectAuthorizationRequest) -> Result<(), AuthorityError>;
    /// The operator records the checkpoint in its one durable journal and acknowledges it.
    fn checkpoint(&mut self, receipt: &EffectCheckpoint) -> Result<(), AuthorityError>;
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectAuthorizationRequest {
    pub kind: String,
    pub version: u32,
    pub operation_id: String,
    pub approval_digest: String,
    pub context_digest: String,
    pub fence_generation: u64,
    pub sequence: u64,
    pub effect_id: String,
    pub app_id: String,
    pub resource_id: String,
    pub release_id: String,
    pub installer_id: String,
    pub installer_sha256: String,
    pub tenant_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectCheckpoint {
    pub kind: String,
    pub version: u32,
    pub operation_id: String,
    pub context_digest: String,
    pub fence_generation: u64,
    pub sequence: u64,
    pub effect_id: String,
    pub resource_id: String,
    pub tenant_id: Option<String>,
    pub receipt: EffectReceipt,
}

/// Synchronous session over the operator's private duplex IPC. `perform` authorizes immediately
/// before invoking one logical write boundary, then waits for durable journal acknowledgement.
pub struct ProtectedInstallSession<A: EffectAuthority> {
    context: FrozenInstallContext,
    authority: A,
    sequence: u64,
    failed: bool,
}

impl<A: EffectAuthority> ProtectedInstallSession<A> {
    pub fn new(context: FrozenInstallContext, authority: A) -> Self {
        Self {
            context,
            authority,
            sequence: 0,
            failed: false,
        }
    }

    pub fn context(&self) -> &FrozenInstallContext {
        &self.context
    }

    pub fn perform<F>(
        &mut self,
        database: &mut VerifiedInstallerDatabase,
        target: EffectTarget,
        write_and_readback: F,
    ) -> Result<EffectReceipt, InstallError>
    where
        F: FnOnce(&mut VerifiedInstallerDatabase) -> Result<(EffectState, String), ()>,
    {
        if self.failed {
            return Err(InstallError::Protocol);
        }
        ensure_database_binding(database, &self.context.value.resource)?;
        validate_effect_target(&self.context, &target)?;
        let sequence = self.sequence.checked_add(1).ok_or(InstallError::Protocol)?;
        let value = self.context.value();
        let request = EffectAuthorizationRequest {
            kind: "authorize_effect".to_string(),
            version: CONTEXT_VERSION,
            operation_id: value.operation.operation_id.clone(),
            approval_digest: value.operation.approval_digest.clone(),
            context_digest: self.context.digest.clone(),
            fence_generation: value.operation.fence_generation,
            sequence,
            effect_id: target.effect_id.clone(),
            app_id: value.app_id.clone(),
            resource_id: value.resource.resource_id.clone(),
            release_id: value.release.id.clone(),
            installer_id: value.installer.id.clone(),
            installer_sha256: value.installer.sha256.clone(),
            tenant_id: target.tenant_id.clone(),
        };
        if let Err(error) = self.authority.authorize(&request) {
            self.failed = true;
            return Err(match error {
                AuthorityError::Denied => InstallError::AuthorityDenied,
                AuthorityError::Protocol => InstallError::Protocol,
            });
        }
        self.sequence = sequence;

        database.access.set(DatabaseAccess::AuthorizedEffect);
        let callback_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            write_and_readback(database)
        }));
        database.access.set(DatabaseAccess::Closed);
        let (state, readback_sha256) = match callback_result {
            Err(payload) => {
                self.failed = true;
                std::panic::resume_unwind(payload)
            }
            Ok(Ok((state, digest))) if is_sha256(&digest) && state != EffectState::Unknown => {
                (state, Some(digest))
            }
            Ok(Ok((EffectState::Unknown, _))) | Ok(Err(())) => (EffectState::Unknown, None),
            Ok(Ok(_)) => (EffectState::Unknown, None),
        };
        let receipt = EffectReceipt {
            state: state.clone(),
            readback_sha256,
        };
        let checkpoint = EffectCheckpoint {
            kind: "checkpoint_effect".to_string(),
            version: CONTEXT_VERSION,
            operation_id: value.operation.operation_id.clone(),
            context_digest: self.context.digest.clone(),
            fence_generation: value.operation.fence_generation,
            sequence,
            effect_id: target.effect_id,
            resource_id: value.resource.resource_id.clone(),
            tenant_id: target.tenant_id,
            receipt: receipt.clone(),
        };
        if self.authority.checkpoint(&checkpoint).is_err() {
            self.failed = true;
            return Err(InstallError::CheckpointUnconfirmed);
        }
        match receipt.state {
            EffectState::Applied | EffectState::NoChange => Ok(receipt),
            EffectState::Unknown => {
                self.failed = true;
                Err(InstallError::ReadbackUnknown)
            }
        }
    }

    /// Readback runs without an effect permit; callbacks must only inspect and must return
    /// sanitized values. Mutations belong in `perform` so the operator fences each write.
    pub fn inspect<T>(
        &mut self,
        database: &mut VerifiedInstallerDatabase,
        inspect: impl FnOnce(&mut VerifiedInstallerDatabase) -> Result<T, InstallError>,
    ) -> Result<T, InstallError> {
        ensure_database_binding(database, &self.context.value.resource)?;
        database
            .raw_client()?
            .batch_execute("BEGIN READ ONLY")
            .map_err(|_| InstallError::DatabaseConnect)?;
        let read_only = database
            .raw_client()?
            .query_one("SHOW transaction_read_only", &[])
            .map(|row| row.get::<_, String>(0) == "on")
            .unwrap_or(false);
        if !read_only {
            let _ = rollback_inspection(database);
            return Err(InstallError::DatabaseIdentityMismatch);
        }

        database.access.set(DatabaseAccess::ReadOnlyInspection);
        let callback_result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inspect(database)));
        database.access.set(DatabaseAccess::Closed);
        let rollback_result = rollback_inspection(database);
        match callback_result {
            Err(payload) => {
                let _ = rollback_result;
                std::panic::resume_unwind(payload)
            }
            Ok(result) => {
                rollback_result?;
                result
            }
        }
    }
}

fn rollback_inspection(database: &mut VerifiedInstallerDatabase) -> Result<(), InstallError> {
    match database.raw_client()?.batch_execute("ROLLBACK") {
        Ok(()) => Ok(()),
        Err(_) => {
            database.client.take();
            Err(InstallError::DatabaseConnect)
        }
    }
}

fn ensure_database_binding(
    database: &mut VerifiedInstallerDatabase,
    expected: &DatabaseResourceIdentity,
) -> Result<(), InstallError> {
    if &database.resource != expected {
        return Err(InstallError::DatabaseIdentityMismatch);
    }
    verify_database_login(database.raw_client()?, expected)
}

/// Line-delimited request/reply adapter suitable for inherited child stdin/stdout pipes.
/// The trusted operator implements `EffectAuthority` on its side and remains the only journal.
pub struct LineAuthorityChannel<R: BufRead, W: Write> {
    replies: R,
    requests: W,
}

impl<R: BufRead, W: Write> LineAuthorityChannel<R, W> {
    pub fn new(replies: R, requests: W) -> Self {
        Self { replies, requests }
    }

    fn send<T: Serialize>(&mut self, value: &T) -> Result<(), AuthorityError> {
        serde_json::to_writer(&mut self.requests, value).map_err(|_| AuthorityError::Protocol)?;
        self.requests
            .write_all(b"\n")
            .and_then(|()| self.requests.flush())
            .map_err(|_| AuthorityError::Protocol)
    }

    fn receive<T: for<'de> Deserialize<'de>>(&mut self) -> Result<T, AuthorityError> {
        let mut frame = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            match self.replies.read(&mut byte) {
                Ok(0) => return Err(AuthorityError::Protocol),
                Ok(_) if byte[0] == b'\n' => break,
                Ok(_) => {
                    if frame.len() == MAX_PROTOCOL_FRAME_BYTES {
                        return Err(AuthorityError::Protocol);
                    }
                    frame.push(byte[0]);
                }
                Err(_) => return Err(AuthorityError::Protocol),
            }
        }
        serde_json::from_slice(&frame).map_err(|_| AuthorityError::Protocol)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AuthorizationReply {
    kind: String,
    version: u32,
    operation_id: String,
    context_digest: String,
    fence_generation: u64,
    sequence: u64,
    effect_id: String,
    allowed: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CheckpointReply {
    kind: String,
    version: u32,
    operation_id: String,
    context_digest: String,
    fence_generation: u64,
    sequence: u64,
    effect_id: String,
    recorded: bool,
}

impl<R: BufRead, W: Write> EffectAuthority for LineAuthorityChannel<R, W> {
    fn authorize(&mut self, request: &EffectAuthorizationRequest) -> Result<(), AuthorityError> {
        self.send(request)?;
        let reply: AuthorizationReply = self.receive()?;
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
        self.send(checkpoint)?;
        let reply: CheckpointReply = self.receive()?;
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorityError {
    Denied,
    Protocol,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallError {
    InvalidContext,
    InstallerIdentityMismatch,
    DatabaseIdentityMismatch,
    DatabaseConnect,
    AuthorityDenied,
    Protocol,
    CheckpointUnconfirmed,
    ReadbackUnknown,
}

impl fmt::Display for InstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidContext => "protected installer context is invalid",
            Self::InstallerIdentityMismatch => "protected installer identity mismatch",
            Self::DatabaseIdentityMismatch => "protected database identity mismatch",
            Self::DatabaseConnect => "protected database connection failed",
            Self::AuthorityDenied => "protected operation authority is no longer current",
            Self::Protocol => "protected installer authority protocol failed",
            Self::CheckpointUnconfirmed => "protected effect checkpoint was not confirmed",
            Self::ReadbackUnknown => "protected effect readback is unknown",
        })
    }
}

impl std::error::Error for InstallError {}

fn is_loopback_hostname(hostname: &str) -> bool {
    hostname == "localhost"
        || hostname
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn validate_context(value: &ProtectedInstallContext) -> Result<(), InstallError> {
    let resource = &value.resource;
    if value.version != CONTEXT_VERSION
        || !valid_opaque_id(&value.operation.operation_id)
        || !is_sha256(&value.operation.approval_digest)
        || value.operation.fence_generation == 0
        || !valid_app_id(&value.app_id)
        || !valid_opaque_id(&resource.resource_id)
        || !valid_hostname(&resource.hostname)
        || resource.port == 0
        || !valid_sql_name(&resource.database)
        || matches!(resource.database.as_str(), "postgres" | "neondb")
        || (resource.environment == InstallEnvironment::Local
            && !is_loopback_hostname(&resource.hostname))
        || resource.schema != "public"
        || !valid_sql_name(&resource.migrator_role)
        || !valid_sql_name(&resource.runtime_role)
        || resource.migrator_role == resource.runtime_role
        || !valid_opaque_id(&value.release.id)
        || !is_sha256(&value.release.sha256)
        || !valid_opaque_id(&value.installer.id)
        || !is_sha256(&value.installer.sha256)
        || (value.app_id == "auth" && !value.tenant_targets.is_empty())
        || (value.app_id != "auth" && value.tenant_targets.is_empty())
        || value
            .tenant_targets
            .iter()
            .any(|tenant| !valid_opaque_id(tenant))
        || duplicate(&value.tenant_targets)
    {
        return Err(InstallError::InvalidContext);
    }
    if resource.environment != InstallEnvironment::Local
        && (resource
            .provider_project_id
            .as_deref()
            .is_none_or(str::is_empty)
            || resource
                .provider_branch_id
                .as_deref()
                .is_none_or(str::is_empty)
            || resource.hostname.contains("-pooler."))
    {
        return Err(InstallError::InvalidContext);
    }
    if resource
        .provider_project_id
        .as_deref()
        .is_some_and(|id| !valid_opaque_id(id))
        || resource
            .provider_branch_id
            .as_deref()
            .is_some_and(|id| !valid_opaque_id(id))
    {
        return Err(InstallError::InvalidContext);
    }
    Ok(())
}

fn validate_effect_target(
    context: &FrozenInstallContext,
    target: &EffectTarget,
) -> Result<(), InstallError> {
    if !valid_opaque_id(&target.effect_id)
        || target
            .tenant_id
            .as_deref()
            .is_some_and(|tenant| !context.allows_tenant(tenant))
    {
        return Err(InstallError::InvalidContext);
    }
    Ok(())
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn valid_app_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
}

fn valid_hostname(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
}

fn valid_sql_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn duplicate(values: &[String]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    values.iter().any(|value| !seen.insert(value))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn sha256(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn sample_context() -> ProtectedInstallContext {
        ProtectedInstallContext {
            version: CONTEXT_VERSION,
            operation: OperationIdentity {
                operation_id: "operation-123".into(),
                approval_digest: "a".repeat(64),
                fence_generation: 7,
            },
            app_id: "hc".into(),
            resource: DatabaseResourceIdentity {
                resource_id: "resource-db-1".into(),
                environment: InstallEnvironment::Local,
                hostname: "127.0.0.1".into(),
                port: 5432,
                database: "hc_app".into(),
                schema: "public".into(),
                migrator_role: "hc_migrator".into(),
                runtime_role: "hc_runtime".into(),
                provider_project_id: None,
                provider_branch_id: None,
            },
            release: ArtifactIdentity {
                id: "hc:release-7".into(),
                sha256: "b".repeat(64),
            },
            installer: ArtifactIdentity {
                id: "hc-installer-v1".into(),
                sha256: "c".repeat(64),
            },
            tenant_targets: vec!["org-1".into(), "org-2".into()],
        }
    }

    fn auth_resource_context() -> ProtectedInstallContext {
        ProtectedInstallContext {
            version: CONTEXT_VERSION,
            operation: OperationIdentity {
                operation_id: "auth-operation-1".into(),
                approval_digest: "a".repeat(64),
                fence_generation: 1,
            },
            app_id: "auth".into(),
            resource: DatabaseResourceIdentity {
                resource_id: "auth-resource-1".into(),
                environment: InstallEnvironment::Local,
                hostname: "127.0.0.1".into(),
                port: 5432,
                database: "auth_test".into(),
                schema: "public".into(),
                migrator_role: "auth_migrator".into(),
                runtime_role: "auth_runtime".into(),
                provider_project_id: None,
                provider_branch_id: None,
            },
            release: ArtifactIdentity {
                id: "auth-schema-1".into(),
                sha256: "a".repeat(64),
            },
            installer: ArtifactIdentity {
                id: "auth-protected-installer-v1".into(),
                sha256: "b".repeat(64),
            },
            tenant_targets: Vec::new(),
        }
    }

    fn authorized_replies(
        context: &FrozenInstallContext,
        sequence: u64,
        effect_id: &str,
    ) -> String {
        let response = serde_json::json!({
            "kind": "effect_authorized",
            "version": CONTEXT_VERSION,
            "operation_id": context.value.operation.operation_id,
            "context_digest": context.digest,
            "fence_generation": context.value.operation.fence_generation,
            "sequence": sequence,
            "effect_id": effect_id,
            "allowed": true,
        });
        let ack = serde_json::json!({
            "kind": "checkpoint_recorded",
            "version": CONTEXT_VERSION,
            "operation_id": context.value.operation.operation_id,
            "context_digest": context.digest,
            "fence_generation": context.value.operation.fence_generation,
            "sequence": sequence,
            "effect_id": effect_id,
            "recorded": true,
        });
        format!("{response}\n{ack}\n")
    }

    #[test]
    fn freezes_unique_explicit_tenant_targets_and_rejects_unknown_targets() {
        let frozen = FrozenInstallContext::new(sample_context()).unwrap();
        assert!(frozen.allows_tenant("org-1"));
        assert!(!frozen.allows_tenant("org-3"));
        let mut duplicate = sample_context();
        duplicate.tenant_targets.push("org-1".into());
        assert_eq!(
            FrozenInstallContext::new(duplicate),
            Err(InstallError::InvalidContext)
        );
        let mut empty = sample_context();
        empty.tenant_targets.clear();
        assert_eq!(
            FrozenInstallContext::new(empty),
            Err(InstallError::InvalidContext)
        );
    }

    #[test]
    fn permits_resource_wide_auth_context_without_a_fabricated_tenant() {
        let frozen = FrozenInstallContext::new(auth_resource_context()).unwrap();
        assert!(!frozen.allows_tenant("auth"));
        assert_eq!(
            serde_json::to_string(frozen.value()).unwrap(),
            format!(
                r#"{{"version":1,"operation":{{"operation_id":"auth-operation-1","approval_digest":"{}","fence_generation":1}},"app_id":"auth","resource":{{"resource_id":"auth-resource-1","environment":"local","hostname":"127.0.0.1","port":5432,"database":"auth_test","schema":"public","migrator_role":"auth_migrator","runtime_role":"auth_runtime"}},"release":{{"id":"auth-schema-1","sha256":"{}"}},"installer":{{"id":"auth-protected-installer-v1","sha256":"{}"}},"tenant_targets":[]}}"#,
                "a".repeat(64),
                "a".repeat(64),
                "b".repeat(64),
            )
        );
        let mut invalid_auth = auth_resource_context();
        invalid_auth.tenant_targets.push("org-1".into());
        assert_eq!(
            FrozenInstallContext::new(invalid_auth),
            Err(InstallError::InvalidContext)
        );
    }

    #[test]
    fn rejects_zero_fence_generation_for_protected_operations() {
        let mut context = sample_context();
        context.operation.fence_generation = 0;
        assert_eq!(
            validate_context(&context),
            Err(InstallError::InvalidContext)
        );
    }

    #[test]
    fn denies_write_when_live_fence_has_been_lost() {
        let context = FrozenInstallContext::new(sample_context()).unwrap();
        let replies = serde_json::json!({
            "kind": "effect_authorized",
            "version": CONTEXT_VERSION,
            "operation_id": context.value.operation.operation_id,
            "context_digest": context.digest,
            "fence_generation": context.value.operation.fence_generation,
            "sequence": 1,
            "effect_id": "install-release:org-1",
            "allowed": false,
        })
        .to_string()
            + "\n";
        let mut channel = LineAuthorityChannel::new(Cursor::new(replies.into_bytes()), Vec::new());
        assert_eq!(
            channel.authorize(&effect_request(&context, "install-release:org-1")),
            Err(AuthorityError::Denied)
        );
    }

    #[test]
    fn verifies_independent_installer_pin_before_launch_boundary() {
        let context = FrozenInstallContext::new(sample_context()).unwrap();
        let directory = std::env::temp_dir().join(format!("installer-pin-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("hc-installer");
        let artifact = b"reviewed installer executable fixture";
        std::fs::write(&path, artifact).unwrap();
        let pin = InstallerPin {
            id: context.value.installer.id.clone(),
            sha256: sha256(artifact),
        };
        assert!(is_sha256(&pin.sha256), "{}", pin.sha256);
        let mut matching = sample_context();
        matching.installer.sha256 = pin.sha256.clone();
        assert_eq!(validate_context(&matching), Ok(()));
        let matching = FrozenInstallContext::new(matching).unwrap();
        assert_eq!(
            verify_pinned_installer_artifact(&path, &pin, &matching),
            Ok(())
        );
        std::fs::write(&path, b"modified installer fixture").unwrap();
        assert_eq!(
            verify_pinned_installer_artifact(&path, &pin, &matching),
            Err(InstallError::InstallerIdentityMismatch)
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn validates_direct_endpoint_and_rejects_overrides_or_wrong_login() {
        let mut resource = sample_context().resource;
        let url = "postgres://hc_migrator:secret@127.0.0.1:5432/hc_app?sslmode=disable";
        assert_eq!(
            verify_direct_connection_target(url, &resource)
                .unwrap()
                .login_role,
            "hc_migrator"
        );
        let no_port_url = "postgres://hc_migrator:secret@127.0.0.1/hc_app?sslmode=disable";
        assert_eq!(
            verify_direct_connection_target(no_port_url, &resource)
                .unwrap()
                .port,
            5432,
            "PostgreSQL URLs without a port select the PostgreSQL default"
        );
        assert_eq!(
            verify_direct_connection_target(
                "postgres://hc_migrator:secret@127.0.0.1:5433/hc_app?sslmode=disable",
                &resource
            ),
            Err(InstallError::DatabaseIdentityMismatch),
            "an explicit port must match the pinned resource"
        );
        assert_eq!(
            verify_direct_connection_target(
                "postgres://hc_runtime:secret@127.0.0.1:5432/hc_app?sslmode=disable",
                &resource
            ),
            Err(InstallError::DatabaseIdentityMismatch)
        );
        assert_eq!(verify_direct_connection_target("postgres://hc_migrator:secret@127.0.0.1:5432/hc_app?sslmode=disable&options=-csearch_path=evil", &resource), Err(InstallError::DatabaseIdentityMismatch));
        resource.environment = InstallEnvironment::Preview;
        resource.hostname = "db.example.test".into();
        resource.provider_project_id = Some("project-1".into());
        resource.provider_branch_id = Some("branch-1".into());
        assert_eq!(
            verify_direct_connection_target(
                "postgres://hc_migrator:secret@db.example.test:5432/hc_app?sslmode=verify-full",
                &resource
            )
            .unwrap()
            .hostname,
            "db.example.test"
        );
    }

    #[test]
    fn rejects_insecure_local_and_unsupported_ssl_bindings_before_connect() {
        let mut context = sample_context();
        context.resource.hostname = "remote.example.test".into();
        assert_eq!(
            FrozenInstallContext::new(context.clone()),
            Err(InstallError::InvalidContext)
        );
        assert_eq!(
            verify_direct_connection_target(
                "postgres://hc_migrator:secret@remote.example.test/hc_app?sslmode=disable",
                &context.resource
            ),
            Err(InstallError::DatabaseIdentityMismatch)
        );
        for database in ["postgres", "neondb"] {
            let mut context = sample_context();
            context.resource.database = database.into();
            assert_eq!(
                FrozenInstallContext::new(context),
                Err(InstallError::InvalidContext)
            );
        }
        let mut resource = sample_context().resource;
        resource.environment = InstallEnvironment::Preview;
        resource.hostname = "db.example.test".into();
        resource.provider_project_id = Some("project-1".into());
        resource.provider_branch_id = Some("branch-1".into());
        for query in [
            "sslmode=verify%2Dfull",
            "sslmode=verify-full&sslmode=verify-full",
            "sslmode=verify-full&channel_binding=require&channel_binding=require",
        ] {
            assert_eq!(
                verify_direct_connection_target(
                    &format!("postgres://hc_migrator:secret@db.example.test/hc_app?{query}"),
                    &resource
                ),
                Err(InstallError::DatabaseIdentityMismatch)
            );
        }
    }

    #[test]
    fn protocol_rejects_stale_fence_reply_identity() {
        let context = FrozenInstallContext::new(sample_context()).unwrap();
        let mut reply: serde_json::Value = serde_json::from_str(
            authorized_replies(&context, 1, "effect")
                .lines()
                .next()
                .unwrap(),
        )
        .unwrap();
        reply["fence_generation"] = serde_json::json!(context.value.operation.fence_generation - 1);
        let mut channel =
            LineAuthorityChannel::new(Cursor::new(format!("{reply}\n").into_bytes()), Vec::new());
        assert_eq!(
            channel.authorize(&effect_request(&context, "effect")),
            Err(AuthorityError::Protocol)
        );
    }

    fn effect_request(
        context: &FrozenInstallContext,
        effect_id: &str,
    ) -> EffectAuthorizationRequest {
        let value = context.value();
        EffectAuthorizationRequest {
            kind: "authorize_effect".into(),
            version: CONTEXT_VERSION,
            operation_id: value.operation.operation_id.clone(),
            approval_digest: value.operation.approval_digest.clone(),
            context_digest: context.digest().into(),
            fence_generation: value.operation.fence_generation,
            sequence: 1,
            effect_id: effect_id.into(),
            app_id: value.app_id.clone(),
            resource_id: value.resource.resource_id.clone(),
            release_id: value.release.id.clone(),
            installer_id: value.installer.id.clone(),
            installer_sha256: value.installer.sha256.clone(),
            tenant_id: None,
        }
    }
}
