use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use postgres::{Client, NoTls};
use protected_installer::{
    connect_verified_installer_database, verify_database_login, ArtifactIdentity, AuthorityError,
    DatabaseResourceIdentity, DirectDatabaseBinding, EffectAuthority, EffectAuthorizationRequest,
    EffectCheckpoint, EffectState, EffectTarget, FrozenInstallContext, InstallEnvironment,
    OperationIdentity, ProtectedInstallContext, ProtectedInstallSession,
};

#[derive(Clone, Default)]
struct CountingAuthority {
    authorizations: Arc<AtomicUsize>,
    checkpoints: Arc<AtomicUsize>,
    denied: bool,
}

impl EffectAuthority for CountingAuthority {
    fn authorize(&mut self, _request: &EffectAuthorizationRequest) -> Result<(), AuthorityError> {
        self.authorizations.fetch_add(1, Ordering::SeqCst);
        if self.denied {
            Err(AuthorityError::Denied)
        } else {
            Ok(())
        }
    }

    fn checkpoint(&mut self, _receipt: &EffectCheckpoint) -> Result<(), AuthorityError> {
        self.checkpoints.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct DisposablePostgres {
    root: PathBuf,
    data: PathBuf,
    socket_directory: PathBuf,
    port: u16,
    started: bool,
}

impl DisposablePostgres {
    fn start() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "protected-installer-pg-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create isolated fixture directory");
        let data = root.join("data");
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve local test port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let socket_root = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            PathBuf::from("/tmp")
        };
        let socket_directory = socket_root.join(format!("pgs-{}-{unique}", std::process::id()));
        fs::create_dir(&socket_directory).expect("create short local PostgreSQL socket path");
        let mut fixture = Self {
            root,
            data,
            socket_directory,
            port,
            started: false,
        };
        run(
            "initdb",
            [
                "-D".to_string(),
                fixture.data.display().to_string(),
                "--username=fixture_admin".into(),
                "--auth=trust".into(),
                "--no-locale".into(),
                "--encoding=UTF8".into(),
            ],
        );
        fixture.started = true;
        run(
            "pg_ctl",
            [
                "-D".to_string(),
                fixture.data.display().to_string(),
                "-l".into(),
                fixture.root.join("postgres.log").display().to_string(),
                "-o".into(),
                format!(
                    "-h 127.0.0.1 -p {port} -k {}",
                    fixture.socket_directory.display()
                ),
                "-w".into(),
                "start".into(),
            ],
        );
        fixture
    }

    fn admin(&self) -> Client {
        Client::connect(
            &format!(
                "host=127.0.0.1 port={} user=fixture_admin dbname=postgres sslmode=disable",
                self.port
            ),
            NoTls,
        )
        .expect("connect to isolated PostgreSQL")
    }

    fn connect_database(&self, user: &str) -> Client {
        Client::connect(
            &format!(
                "host=127.0.0.1 port={} user={user} dbname=hc_fixture sslmode=disable",
                self.port
            ),
            NoTls,
        )
        .expect("connect to isolated fixture database")
    }

    fn connect_migrator(&self) -> Client {
        self.connect_database("hc_migrator")
    }

    fn grant_migrator_schema_access(&self) {
        let mut admin = Client::connect(
            &format!(
                "host=127.0.0.1 port={} user=fixture_admin dbname=hc_fixture sslmode=disable",
                self.port
            ),
            NoTls,
        )
        .expect("connect as fixture database owner");
        admin
            .batch_execute("grant usage, create on schema public to hc_migrator;")
            .expect("grant fixture migrator only the schema permissions needed by the test");
    }

    fn resource(&self) -> DatabaseResourceIdentity {
        DatabaseResourceIdentity {
            resource_id: "fixture-resource".into(),
            environment: InstallEnvironment::Local,
            hostname: "127.0.0.1".into(),
            port: self.port,
            database: "hc_fixture".into(),
            schema: "public".into(),
            migrator_role: "hc_migrator".into(),
            runtime_role: "hc_runtime".into(),
            provider_project_id: None,
            provider_branch_id: None,
        }
    }

    fn migrator_url(&self) -> String {
        format!(
            "postgres://hc_migrator:fixture@127.0.0.1:{}/hc_fixture?sslmode=disable",
            self.port
        )
    }

    fn context(&self, resource: DatabaseResourceIdentity) -> FrozenInstallContext {
        FrozenInstallContext::new(ProtectedInstallContext {
            version: 1,
            operation: OperationIdentity {
                operation_id: "op-hc-fixture".into(),
                approval_digest: "a".repeat(64),
                fence_generation: 1,
            },
            app_id: "hc".into(),
            resource,
            release: ArtifactIdentity {
                id: "hc-release-fixture".into(),
                sha256: "b".repeat(64),
            },
            installer: ArtifactIdentity {
                id: "hc-installer-fixture".into(),
                sha256: "c".repeat(64),
            },
            tenant_targets: vec!["tenant-fixture".into()],
        })
        .expect("valid fixture operation context")
    }
}

impl Drop for DisposablePostgres {
    fn drop(&mut self) {
        if self.started {
            let _ = Command::new("pg_ctl")
                .args([
                    "-D",
                    self.data.to_str().unwrap(),
                    "-m",
                    "immediate",
                    "-w",
                    "stop",
                ])
                .output();
            self.started = false;
        }
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.socket_directory);
    }
}

fn run<const N: usize>(binary: &str, args: [String; N]) {
    let output = Command::new(binary)
        .args(args)
        .output()
        .unwrap_or_else(|error| {
            panic!("required disposable PostgreSQL tool {binary} is unavailable: {error}")
        });
    assert_success(binary, output);
}

fn assert_success(binary: &str, output: Output) {
    assert!(
        output.status.success(),
        "{binary} failed for disposable test cluster: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn actual_database_login_and_resource_identity_are_checked_before_effects() {
    let fixture = DisposablePostgres::start();
    let mut admin = fixture.admin();
    admin
        .batch_execute("create role hc_migrator login createrole; create role hc_runtime login; grant hc_runtime to hc_migrator;")
        .expect("create only fixture-owned roles");
    admin
        .batch_execute("create database hc_fixture owner fixture_admin;")
        .expect("create isolated fixture database");
    admin
        .batch_execute("grant connect on database hc_fixture to hc_migrator;")
        .expect("grant fixture connection access");
    drop(admin);
    fixture.grant_migrator_schema_access();

    let resource = fixture.resource();
    let binding = DirectDatabaseBinding::new(fixture.migrator_url());
    let mut verified = connect_verified_installer_database(&binding, &resource)
        .expect("direct migrator binding should match live PostgreSQL identity");
    assert_eq!(
        verified.client_mut().err(),
        Some(protected_installer::InstallError::AuthorityDenied),
        "the verified handle does not expose an unscoped write connection"
    );
    let mut admin = fixture.connect_database("fixture_admin");
    admin.batch_execute("create table public.preserved(value text); insert into public.preserved values ('existing')")
        .expect("fixture owner creates its test table");
    admin
        .batch_execute("grant select on public.preserved to hc_migrator;")
        .expect("grant fixture readback access");
    drop(admin);

    let mut wrong_expectation = resource.clone();
    wrong_expectation.database = "other_database".into();
    assert!(verify_database_login(&mut fixture.connect_migrator(), &wrong_expectation).is_err());
    let mut session = ProtectedInstallSession::new(
        fixture.context(resource.clone()),
        CountingAuthority::default(),
    );
    let value = session
        .inspect(&mut verified, |database| {
            database
                .client_mut()?
                .query_one("select value from public.preserved", &[])
                .map(|row| row.get::<_, String>(0))
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)
        })
        .expect("read-only inspection reads the fixture row");
    assert_eq!(value, "existing");

    assert!(
        connect_verified_installer_database(
            &DirectDatabaseBinding::new(
                fixture.migrator_url().replace("hc_migrator", "hc_runtime")
            ),
            &resource,
        )
        .is_err(),
        "wrong login must fail before an installer receives the connection"
    );
}

#[test]
fn perform_binds_resource_and_rechecks_live_login_before_each_write() {
    let fixture = DisposablePostgres::start();
    let mut admin = fixture.admin();
    admin
        .batch_execute("create role hc_migrator login createrole; create role hc_runtime login; grant hc_runtime to hc_migrator;")
        .expect("create only fixture-owned roles");
    admin
        .batch_execute("create database hc_fixture owner fixture_admin;")
        .expect("create isolated fixture database");
    admin
        .batch_execute("grant connect on database hc_fixture to hc_migrator;")
        .expect("grant fixture connection access");
    drop(admin);
    fixture.grant_migrator_schema_access();

    let resource = fixture.resource();
    let binding = DirectDatabaseBinding::new(fixture.migrator_url());
    let mut verified = connect_verified_installer_database(&binding, &resource)
        .expect("direct migrator binding should match live PostgreSQL identity");
    let mut admin = fixture.connect_database("fixture_admin");
    admin
        .batch_execute("create table public.protected_effects(effect_id text primary key); grant all on public.protected_effects to hc_migrator;")
        .expect("create test-owned effect table");
    drop(admin);

    let target = EffectTarget {
        effect_id: "install-release:tenant-fixture".into(),
        tenant_id: Some("tenant-fixture".into()),
    };
    let denied_authorizations = Arc::new(AtomicUsize::new(0));
    let mut denied_session = ProtectedInstallSession::new(
        fixture.context(resource.clone()),
        CountingAuthority {
            authorizations: denied_authorizations.clone(),
            denied: true,
            ..CountingAuthority::default()
        },
    );
    let mut denied_write_ran = false;
    assert_eq!(
        denied_session.perform(&mut verified, target.clone(), |_| {
            denied_write_ran = true;
            Ok((EffectState::Applied, "d".repeat(64)))
        }),
        Err(protected_installer::InstallError::AuthorityDenied)
    );
    assert!(
        !denied_write_ran,
        "lost live authority must prevent the write"
    );
    assert_eq!(denied_authorizations.load(Ordering::SeqCst), 1);

    let mut wrong_resource = resource.clone();
    wrong_resource.resource_id = "different-resource".into();
    let wrong_authorizations = Arc::new(AtomicUsize::new(0));
    let mut wrong_session = ProtectedInstallSession::new(
        fixture.context(wrong_resource),
        CountingAuthority {
            authorizations: wrong_authorizations.clone(),
            ..CountingAuthority::default()
        },
    );
    let mut wrong_handle_write_ran = false;
    assert!(wrong_session
        .perform(&mut verified, target.clone(), |_| {
            wrong_handle_write_ran = true;
            Ok((EffectState::Applied, "d".repeat(64)))
        })
        .is_err());
    assert!(
        !wrong_handle_write_ran,
        "wrong resource must fail before write"
    );
    assert_eq!(wrong_authorizations.load(Ordering::SeqCst), 0);

    let context = fixture.context(resource);
    let authorizations = Arc::new(AtomicUsize::new(0));
    let checkpoints = Arc::new(AtomicUsize::new(0));
    let mut session = ProtectedInstallSession::new(
        context,
        CountingAuthority {
            authorizations: authorizations.clone(),
            checkpoints: checkpoints.clone(),
            denied: false,
        },
    );
    let mut alter_role_session = ProtectedInstallSession::new(
        fixture.context(fixture.resource()),
        CountingAuthority::default(),
    );
    let mut altered_verified = connect_verified_installer_database(
        &DirectDatabaseBinding::new(fixture.migrator_url()),
        &fixture.resource(),
    )
    .expect("create independent fixture handle for live role mismatch check");
    alter_role_session
        .perform(&mut altered_verified, target.clone(), |database| {
            database
                .client_mut()
                .map_err(|_| ())?
                .batch_execute("set role hc_runtime;")
                .map_err(|_| ())?;
            Ok((EffectState::Applied, "e".repeat(64)))
        })
        .expect("authorized callback can change role for the live mismatch check");
    let mut altered_role_write_ran = false;
    assert!(session
        .perform(&mut altered_verified, target.clone(), |_| {
            altered_role_write_ran = true;
            Ok((EffectState::Applied, "d".repeat(64)))
        })
        .is_err());
    assert!(
        !altered_role_write_ran,
        "wrong current role must fail before write"
    );
    assert_eq!(authorizations.load(Ordering::SeqCst), 0);

    session
        .perform(&mut verified, target, |database| {
            database
                .client_mut()
                .map_err(|_| ())?
                .execute(
                    "insert into public.protected_effects(effect_id) values ($1)",
                    &[&"install-release:tenant-fixture"],
                )
                .map_err(|_| ())?;
            Ok((EffectState::Applied, "d".repeat(64)))
        })
        .expect("normal retry with the unchanged pinned role succeeds");
    assert_eq!(authorizations.load(Ordering::SeqCst), 1);
    assert_eq!(checkpoints.load(Ordering::SeqCst), 1);
    let rows = session
        .inspect(&mut verified, |database| {
            database
                .client_mut()?
                .query_one("select count(*) from public.protected_effects", &[])
                .map(|row| row.get::<_, i64>(0))
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)
        })
        .expect("read isolated effect table");
    assert_eq!(rows, 1, "only the authorized retry writes");

    let unknown_authorizations = Arc::new(AtomicUsize::new(0));
    let unknown_checkpoints = Arc::new(AtomicUsize::new(0));
    let mut unknown_session = ProtectedInstallSession::new(
        fixture.context(fixture.resource()),
        CountingAuthority {
            authorizations: unknown_authorizations.clone(),
            checkpoints: unknown_checkpoints.clone(),
            denied: false,
        },
    );
    assert_eq!(
        unknown_session.perform(
            &mut verified,
            EffectTarget {
                effect_id: "uncertain-release:tenant-fixture".into(),
                tenant_id: Some("tenant-fixture".into()),
            },
            |_| Err(())
        ),
        Err(protected_installer::InstallError::ReadbackUnknown)
    );
    assert_eq!(unknown_authorizations.load(Ordering::SeqCst), 1);
    assert_eq!(unknown_checkpoints.load(Ordering::SeqCst), 1);

    let panic_authorizations = Arc::new(AtomicUsize::new(0));
    let mut panic_session = ProtectedInstallSession::new(
        fixture.context(fixture.resource()),
        CountingAuthority {
            authorizations: panic_authorizations.clone(),
            ..CountingAuthority::default()
        },
    );
    let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = panic_session.perform(
            &mut verified,
            EffectTarget {
                effect_id: "panic-release:tenant-fixture".into(),
                tenant_id: Some("tenant-fixture".into()),
            },
            |database| -> Result<(EffectState, String), ()> {
                database
                    .client_mut()
                    .map_err(|_| ())?
                    .execute(
                        "insert into public.protected_effects(effect_id) values ($1)",
                        &[&"panic-release:tenant-fixture"],
                    )
                    .map_err(|_| ())?;
                panic!("fixture effect callback panic")
            },
        );
    }));
    assert!(panic_result.is_err());
    assert_eq!(
        verified.client_mut().err(),
        Some(protected_installer::InstallError::AuthorityDenied),
        "effect panic closes raw access"
    );
    assert_eq!(
        panic_session.perform(
            &mut verified,
            EffectTarget {
                effect_id: "after-panic:tenant-fixture".into(),
                tenant_id: Some("tenant-fixture".into()),
            },
            |_| Ok((EffectState::Applied, "a".repeat(64))),
        ),
        Err(protected_installer::InstallError::Protocol),
        "the session cannot continue after an uncheckpointed panic"
    );
    assert_eq!(panic_authorizations.load(Ordering::SeqCst), 1);
}

#[test]
fn inspection_is_read_only_and_rolls_back_scope_and_error_paths() {
    let fixture = DisposablePostgres::start();
    let mut admin = fixture.admin();
    admin
        .batch_execute("create role hc_migrator login createrole; create role hc_runtime login; grant hc_runtime to hc_migrator;")
        .expect("create fixture roles");
    admin
        .batch_execute("create database hc_fixture owner fixture_admin;")
        .expect("create fixture database");
    admin
        .batch_execute("grant connect on database hc_fixture to hc_migrator;")
        .expect("grant fixture connection");
    drop(admin);
    fixture.grant_migrator_schema_access();
    let mut admin = fixture.connect_database("fixture_admin");
    admin
        .batch_execute("create table public.inspection_effects(value text); grant all on public.inspection_effects to hc_migrator;")
        .expect("create fixture table");
    drop(admin);

    let mut verified = connect_verified_installer_database(
        &DirectDatabaseBinding::new(fixture.migrator_url()),
        &fixture.resource(),
    )
    .expect("verify fixture connection");
    let mut session = ProtectedInstallSession::new(
        fixture.context(fixture.resource()),
        CountingAuthority::default(),
    );
    let write_was_rejected = session
        .inspect(&mut verified, |database| {
            let client = database.client_mut()?;
            client
                .batch_execute("select set_config('app.fixture_scope', 'inspection', true);")
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)?;
            Ok(client
                .execute(
                    "insert into public.inspection_effects(value) values ('blocked')",
                    &[],
                )
                .is_err())
        })
        .expect("read-only inspect completes after the attempted write is rejected");
    assert!(
        write_was_rejected,
        "READ ONLY transaction rejects persistent writes"
    );

    let row_count = session
        .inspect(&mut verified, |database| {
            let client = database.client_mut()?;
            let count: i64 = client
                .query_one("select count(*) from public.inspection_effects", &[])
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)?
                .get(0);
            let scope: Option<String> = client
                .query_one("select current_setting('app.fixture_scope', true)", &[])
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)?
                .get(0);
            assert!(
                scope.is_none_or(|scope| scope.is_empty()),
                "inspection rolls back session scope"
            );
            Ok(count)
        })
        .expect("subsequent inspection works after rollback");
    assert_eq!(row_count, 0);

    assert_eq!(
        session.inspect(&mut verified, |database| {
            database
                .client_mut()?
                .batch_execute("select set_config('app.fixture_scope', 'error-path', true);")
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)?;
            Err::<(), _>(protected_installer::InstallError::Protocol)
        }),
        Err(protected_installer::InstallError::Protocol)
    );
    assert_eq!(
        verified.client_mut().err(),
        Some(protected_installer::InstallError::AuthorityDenied),
        "inspection error closes raw access"
    );
    session
        .inspect(&mut verified, |database| {
            let scope: Option<String> = database
                .client_mut()?
                .query_one("select current_setting('app.fixture_scope', true)", &[])
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)?
                .get(0);
            assert!(
                scope.is_none_or(|scope| scope.is_empty()),
                "error path rolls back session scope"
            );
            Ok(())
        })
        .expect("connection remains usable after error rollback");

    let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = session.inspect(
            &mut verified,
            |database| -> Result<(), protected_installer::InstallError> {
                database
                    .client_mut()?
                    .batch_execute("select set_config('app.fixture_scope', 'panic-path', true);")
                    .map_err(|_| protected_installer::InstallError::DatabaseConnect)?;
                panic!("fixture inspection panic")
            },
        );
    }));
    assert!(panic_result.is_err());
    assert_eq!(
        verified.client_mut().err(),
        Some(protected_installer::InstallError::AuthorityDenied),
        "panic path closes raw access"
    );
    session
        .inspect(&mut verified, |database| {
            let scope: Option<String> = database
                .client_mut()?
                .query_one("select current_setting('app.fixture_scope', true)", &[])
                .map_err(|_| protected_installer::InstallError::DatabaseConnect)?
                .get(0);
            assert!(
                scope.is_none_or(|scope| scope.is_empty()),
                "panic path rolls back session scope"
            );
            Ok(())
        })
        .expect("connection remains usable after panic rollback");
}
