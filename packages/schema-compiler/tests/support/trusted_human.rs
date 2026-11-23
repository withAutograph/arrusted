// Business-behavior fixtures opt into trusted human authority explicitly. Never
// use this helper in authorization/adversarial tests: those own their bindings.
#[allow(dead_code)]
pub fn bind(client: &mut postgres::Client, app: &str, customer: &str, actor: &str) {
    grant_runtime(client);
    for (function, request) in [
        (
            "kernel_bind_principal_scope",
            serde_json::json!({"principal_name":principal(client),"capability":"runtime","app_id":app,"customer_id":customer}),
        ),
        (
            "kernel_bind_actor_membership",
            serde_json::json!({"principal_name":principal(client),"app_id":app,"customer_id":customer,"actor_id":actor,"actor_kind":"human","role":"fixture"}),
        ),
    ] {
        let result: serde_json::Value = client
            .query_one(&format!("select {function}($1::jsonb)"), &[&request])
            .unwrap()
            .get(0);
        assert_eq!(result["ok"], true, "{function}: {result}");
    }
    select(client, actor);
}

#[allow(dead_code)]
pub fn select(client: &mut postgres::Client, actor: &str) {
    client
        .query_one("select set_config('kernel.actor_id',$1,false)", &[&actor])
        .unwrap();
}

fn principal(client: &mut postgres::Client) -> String {
    client
        .query_one("select session_user::text", &[])
        .unwrap()
        .get(0)
}

// Record preexisting roles before installing a schema's generated runtime.
#[allow(dead_code)]
pub fn before_install(client: &mut postgres::Client) {
    client.batch_execute("create temporary table if not exists fixture_role_baseline (schema_name text primary key, roles text[]); insert into pg_temp.fixture_role_baseline select current_schema(), array(select rolname::text from pg_roles) on conflict do nothing").unwrap();
}

// Keep direct membership ownership separate from inherited membership: only
// revoke grants this connection added, including repeated binds in one fixture.
#[allow(dead_code)]
pub fn grant_runtime(client: &mut postgres::Client) {
    grant_capability(client, "runtime");
}

#[allow(dead_code)]
pub fn grant_capability(client: &mut postgres::Client, capability: &str) {
    let role: String = client
        .query_one(
            "select kernel_installer_capability_role($1)",
            &[&capability],
        )
        .unwrap()
        .get(0);
    let role_literal = role.replace('\'', "''");
    client.batch_execute(&format!(r#"
        create temporary table if not exists fixture_runtime_grants (
            schema_name text, role_name text, principal_name text,
            primary key (schema_name, role_name, principal_name)
        );
        do $$ declare r text := '{role_literal}';
            made boolean := to_regrole(r) is null;
        begin
            if made then execute format('create role %I nologin', r); end if;
            if not exists (select 1 from pg_auth_members
                where roleid=to_regrole(r) and member=(session_user::regrole)::oid) then
                insert into pg_temp.fixture_runtime_grants values (current_schema(), r, session_user)
                    on conflict do nothing;
                execute format('grant %I to %I', r, session_user);
            end if;
        end $$;
    "#)).unwrap();
}

#[allow(dead_code)]
pub fn cleanup(client: &mut postgres::Client, schema: &str) {
    let Ok(rows) = client.query(
        "delete from pg_temp.fixture_runtime_grants where schema_name=$1 returning role_name, principal_name",
        &[&schema],
    ) else { return; };
    for row in rows {
        let role: String = row.get(0);
        let principal: String = row.get(1);
        let quoted_role = role.replace('"', "\"\"");
        let quoted_principal = principal.replace('"', "\"\"");
        let _ = client.batch_execute(&format!(
            "revoke \"{quoted_role}\" from \"{quoted_principal}\""
        ));
    }
}

#[allow(dead_code)]
pub fn drop_fixture(
    client: &mut postgres::Client,
    schema_name: &str,
) -> Result<(), postgres::Error> {
    let _ = client.batch_execute("rollback; reset session authorization; reset role");
    cleanup(client, schema_name);
    let baseline: Option<Vec<String>> = client
        .query_opt(
            "select roles from pg_temp.fixture_role_baseline where schema_name=$1",
            &[&schema_name],
        )
        .ok()
        .flatten()
        .map(|row| row.get(0));
    let escaped_schema_name = schema_name.replace('"', "\"\"");
    let _ = client.batch_execute(&format!(
        "rollback; reset role; set search_path to \"{escaped_schema_name}\""
    ));
    let capability_roles = client
        .query(
            "select kernel_installer_capability_role(capability) as role_name from unnest(array['query', 'runtime', 'schema_admin', 'execution_owner']) as capability",
            &[],
        )
        .map(|rows| {
            rows.into_iter()
                .map(|row| row.get::<_, String>("role_name"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let _ = client.batch_execute("reset role; set search_path to public");
    let result = client.batch_execute(&format!(
        "drop schema if exists \"{escaped_schema_name}\" cascade"
    ));
    for role_name in capability_roles {
        if baseline
            .as_ref()
            .is_none_or(|roles| roles.contains(&role_name))
        {
            continue;
        }
        let escaped_role_name = role_name.replace('"', "\"\"");
        let _ = client.batch_execute(&format!("drop role if exists \"{escaped_role_name}\""));
    }
    if result.is_ok() {
        let _ = client.execute(
            "delete from pg_temp.fixture_role_baseline where schema_name=$1",
            &[&schema_name],
        );
    }
    result
}
