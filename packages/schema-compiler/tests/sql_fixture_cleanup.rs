#[path = "support/trusted_human.rs"]
mod trusted_human;

#[test]
fn fixture_cleanup_preserves_prior_roles_and_direct_memberships() {
    let Ok(url) = std::env::var("KERNEL_TEST_DATABASE_URL") else {
        return;
    };
    let mut client = kernel::connect_postgres(&url).expect("connect fixture cleanup test");
    let schema = format!("fx_cleanup_{}", uuid::Uuid::new_v4().simple());
    let runtime = format!("{schema}_runtime");
    let query = format!("{schema}_query");
    let created = format!("{schema}_schema_admin");
    client
        .batch_execute(&format!(
            r#"
        create schema {schema};
        set search_path to {schema};
        create function kernel_installer_capability_role(text) returns text
            language sql as 'select current_schema() || ''_'' || $1';
        create role {runtime} nologin;
        create role {query} nologin;
        grant {runtime} to current_user;
    "#
        ))
        .unwrap();
    trusted_human::before_install(&mut client);
    trusted_human::grant_runtime(&mut client);
    trusted_human::grant_runtime(&mut client);
    trusted_human::grant_capability(&mut client, "query");
    trusted_human::grant_capability(&mut client, "schema_admin");
    // Reinstallation must not replace the original ownership baseline.
    trusted_human::before_install(&mut client);
    client.batch_execute("begin").unwrap();
    trusted_human::grant_capability(&mut client, "execution_owner");
    client.batch_execute("rollback").unwrap();
    trusted_human::drop_fixture(&mut client, &schema).unwrap();
    let roles: Vec<String> = client
        .query(
            "select rolname::text from pg_roles where rolname = any($1)",
            &[&vec![runtime.clone(), query.clone(), created]],
        )
        .unwrap()
        .into_iter()
        .map(|row| row.get(0))
        .collect();
    let grants: Vec<String> = client
        .query("select role.rolname::text from pg_auth_members membership join pg_roles role on role.oid=membership.roleid where membership.member=(session_user::regrole)::oid and role.rolname=any($1)", &[&vec![runtime.clone(), query.clone()]])
        .unwrap().into_iter().map(|row| row.get(0)).collect();
    client
        .batch_execute(&format!(
            "revoke {runtime} from current_user; drop role {runtime}; drop role {query}"
        ))
        .unwrap();
    assert_eq!(roles.len(), 2, "fixture-created role must be removed");
    assert!(roles.contains(&runtime) && roles.contains(&query));
    assert_eq!(
        grants,
        vec![runtime],
        "preserve prior direct grant; revoke only added grant"
    );
}
