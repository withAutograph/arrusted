#![allow(dead_code)]
#[path = "trusted_human.rs"]
mod trusted_human;
use kernel::connect_postgres;
use schema_compiler::{
    compile_manifest_json, compile_sql_artifact_manifest, render_sql_artifact_bundle,
};
use serde_json::{json, Value};
use uuid::Uuid;
pub const APP: &str = "work_fixture";
pub const CUSTOMER: &str = "tenant";
pub const VERSION: &str = "work-v1";
pub const RECORD: &str = "00000000-0000-0000-0000-000000000001";
pub const OTHER_RECORD: &str = "00000000-0000-0000-0000-000000000002";
/// Exact predecessor session tables retained for the v82 migration regression.
pub fn predecessor_session_tables() -> &'static str {
    const BUNDLE: &str =
        include_str!("../fixtures/historical-sql/2026-10-26.canvas-sessions-v82.sql");
    let start = BUNDLE
        .find("create table if not exists work_session (")
        .unwrap();
    let end = start
        + BUNDLE[start..]
            .find("create index if not exists work_session_record_subject")
            .unwrap();
    &BUNDLE[start..end]
}
pub struct Fixture {
    pub client: postgres::Client,
    pub schema: String,
    pub principal: String,
    pub agent_principal: String,
    pub second_agent_principal: String,
    pub session_id: String,
    pub bundle: String,
}
impl Fixture {
    pub fn new() -> Option<Self> {
        Self::with_policy(true, false, false, false, false)
    }
    pub fn without_policy() -> Option<Self> {
        Self::with_policy(false, false, false, false, false)
    }
    pub fn with_public_ids() -> Option<Self> {
        Self::with_policy(true, true, false, false, false)
    }
    /// Adds the app-derived read-only custom fields `double_score`
    /// (score + score) and `parent_score` (the parent record's score).
    pub fn with_derived() -> Option<Self> {
        Self::with_policy(true, false, true, false, false)
    }
    /// Reads every record; updates only records the actor owns.
    pub fn with_owner_scoped_updates() -> Option<Self> {
        Self::with_policy(true, false, false, false, true)
    }
    /// Installs the current runtime into a schema where an earlier full
    /// release bundle (with its function shapes) is already installed. No
    /// policy, so its sessions Save (Save always drafts).
    #[allow(dead_code)]
    pub fn over_release_bundle(prior: &str) -> Option<Self> {
        Self::build(false, false, false, false, false, Some(prior))
    }
    fn with_policy(
        policy: bool,
        public_ids: bool,
        derived: bool,
        predecessor: bool,
        owner_scoped_updates: bool,
    ) -> Option<Self> {
        Self::build(
            policy,
            public_ids,
            derived,
            predecessor,
            owner_scoped_updates,
            None,
        )
    }
    fn build(
        policy: bool,
        public_ids: bool,
        derived: bool,
        predecessor: bool,
        owner_scoped_updates: bool,
        prior: Option<&str>,
    ) -> Option<Self> {
        let url = std::env::var("KERNEL_TEST_DATABASE_URL").ok()?;
        let mut input = json!({"app_id":APP,"customer_id":CUSTOMER,"version":VERSION,
         "models":[{"id":"item","kind":"entity","label":"Item","extensions":{"typed_custom_fields":true},"fields":[
          {"id":"owner","label":"Owner","type":"text","required":true},{"id":"score","label":"Score","type":"number"},
          {"id":"parent","label":"Parent","type":"relation","target_model":"item"},{"id":"secret","label":"Secret","type":"number"},{"id":"rate","label":"Rate","type":"money_rate"}]}],
         "custom_fields":[{"id":"item_custom_score","model":"item","field":"custom_score","label":"Custom score","type":"number","archived_at":null}],
         "authorization":{"roles":[{"id":"editor"},{"id":"reader"}],"grants":[{"role":"editor","model":"item",
          "operations":["read","create","update"],"read_fields":["$id","$version","owner","score","rate","custom_score","parent"],"write_fields":["owner","score","rate","custom_score","parent"],
          "record":{"kind":"actor_equals_field","field":"owner"}},
          // A membership moved to `reader` loses read access to score and custom_score.
          {"role":"reader","model":"item","operations":["read"],"read_fields":["$id","$version","owner","rate","parent"],
          "record":{"kind":"actor_equals_field","field":"owner"}}]}
        });
        if owner_scoped_updates {
            input["authorization"]["grants"] = json!([
                {"role":"editor","model":"item","operations":["read"],
                 "read_fields":["$id","$version","owner","score","rate","custom_score","parent"],"record":{"kind":"all"}},
                {"role":"editor","model":"item","operations":["create","update"],
                 "write_fields":["owner","score","rate","custom_score","parent"],"record":{"kind":"actor_equals_field","field":"owner"}}
            ]);
        }
        if public_ids {
            input["authorization"]["grants"].as_array_mut().unwrap().push(json!({"role":"editor","model":"item","operations":["read"],"read_fields":["$id","$version"],"record":{"kind":"all"}}));
        }
        if derived {
            input["models"][0]["derived_fields"] = json!([{"id":"double_score","label":"Double score","type":"number",
             "expression":{"type":"add","left":{"type":"field","field":"score"},"right":{"type":"field","field":"score"}}},
             {"id":"parent_score","label":"Parent score","type":"number",
             "expression":{"type":"relation_field","relation":"parent","field":"score"}}]);
        }
        if !policy {
            input.as_object_mut().unwrap().remove("authorization");
        }
        let compiled =
            compile_manifest_json(&input.to_string()).expect("compile test-owned work manifest");
        let manifest = compile_sql_artifact_manifest(&compiled).expect("compile test bundle");
        let mut client = connect_postgres(&url).expect("connect fresh PostgreSQL");
        let schema = format!("work_test_{}", Uuid::new_v4().simple());
        let principal = format!("work_actor_{}", Uuid::new_v4().simple());
        let agent_principal = format!("work_agent_{}", Uuid::new_v4().simple());
        let second_agent_principal = format!("work_agent_{}", Uuid::new_v4().simple());
        client
            .batch_execute(&format!(
                "create schema {schema}; set search_path to {schema}"
            ))
            .unwrap();
        if let Some(prior) = prior {
            client
                .batch_execute(prior)
                .expect("install the earlier release bundle");
            client
                .batch_execute(&format!("set search_path to {schema}"))
                .unwrap();
        }
        trusted_human::before_install(&mut client);
        if predecessor {
            client
                .batch_execute(predecessor_session_tables())
                .expect("install empty predecessor session tables");
        }
        let bundle = render_sql_artifact_bundle(&manifest);
        client.batch_execute(&bundle).expect("install work runtime");
        let schema_json = serde_json::to_value(&compiled.schema).unwrap();
        client.execute("insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values($1,$2,$3,$4,'{}',$4,now())",&[&APP,&CUSTOMER,&VERSION,&schema_json]).unwrap();
        client
            .batch_execute(
                "select kernel_sync_schema_authorization_policy(id) from schema_revision",
            )
            .unwrap();
        client.batch_execute(&format!(r#"insert into change_set(app_id,customer_id,schema_revision_id,created_with_mode,status,source_kind,created_order,applied_order,applied_at) values('{APP}','{CUSTOMER}',1,'mainline','mainline','fixture',1,1,now());
   insert into item_record(id,app_id,customer_id,external_key) values('{RECORD}','{APP}','{CUSTOMER}','mine'),('{OTHER_RECORD}','{APP}','{CUSTOMER}','other');
   insert into item_version(id,record_id,app_id,customer_id,stage,effective_start,change_set_id,applied_at,owner,score,secret,rate_amount,rate_currency,rate_period,parent,custom_fields) values
   ('00000000-0000-0000-0000-000000000011','{RECORD}','{APP}','{CUSTOMER}','mainline','2026-01-01',1,now(),'human',10,123,100,'USD','annual','{RECORD}','[{{"field_id":"custom_score","type":"number","value":"7"}}]'),
   ('00000000-0000-0000-0000-000000000012','{OTHER_RECORD}','{APP}','{CUSTOMER}','mainline','2026-01-01',1,now(),'other',900,456,900,'USD','annual',null,'[]');"#)).unwrap();
        let runtime: String = client
            .query_one("select kernel_installer_capability_role('runtime')", &[])
            .unwrap()
            .get(0);
        trusted_human::grant_runtime(&mut client);
        client.batch_execute(&format!("create role {principal} nologin; create role {agent_principal} nologin; create role {second_agent_principal} nologin; grant \"{runtime}\" to {principal}, {agent_principal}, {second_agent_principal}; grant usage on schema {schema} to {principal}, {agent_principal}, {second_agent_principal};")).unwrap();
        let mut f = Self {
            client,
            schema,
            principal,
            agent_principal,
            second_agent_principal,
            session_id: Uuid::new_v4().to_string(),
            bundle,
        };
        let binding=f.call("kernel_bind_principal_scope",json!({"principal_name":f.principal,"capability":"runtime","app_id":APP,"customer_id":CUSTOMER}));
        assert_ok(&binding);
        let binding=f.call("kernel_bind_principal_scope",json!({"principal_name":f.agent_principal,"capability":"runtime","app_id":APP,"customer_id":CUSTOMER}));
        assert_ok(&binding);
        let binding=f.call("kernel_bind_principal_scope",json!({"principal_name":f.second_agent_principal,"capability":"runtime","app_id":APP,"customer_id":CUSTOMER}));
        assert_ok(&binding);
        f.bind_actor("agent2", "agent");
        f.bind_actor("human", "human");
        f.bind_actor("agent", "agent");
        f.bind_actor("other", "human");
        f.actor("human");
        Some(f)
    }
    pub fn bind_actor(&mut self, actor: &str, kind: &str) {
        self.client
            .batch_execute("reset session authorization")
            .unwrap();
        let result=self.call("kernel_bind_actor_membership",json!({"principal_name":if actor=="agent2" { &self.second_agent_principal } else if kind=="agent" { &self.agent_principal } else { &self.principal },"app_id":APP,"customer_id":CUSTOMER,"actor_id":if kind=="agent" { "human" } else { actor },"role":"editor","actor_kind":kind}));
        assert_ok(&result);
    }
    pub fn actor(&mut self, actor: &str) {
        let principal = if actor == "agent2" {
            &self.second_agent_principal
        } else if actor == "agent" {
            &self.agent_principal
        } else {
            &self.principal
        };
        let actor = if actor == "agent" || actor == "agent2" {
            "human"
        } else {
            actor
        };
        self.client.batch_execute(&format!("reset session authorization; set session authorization {principal}; set kernel.actor_id='{actor}'")).unwrap();
    }
    pub fn make_other_record_visible(&mut self) {
        self.client
            .batch_execute("reset session authorization")
            .unwrap();
        self.client
            .execute(
                "update item_version set owner='human' where record_id=$1::text::uuid",
                &[&OTHER_RECORD],
            )
            .unwrap();
        self.actor("human");
    }
    pub fn call(&mut self, function: &str, request: Value) -> Value {
        self.client
            .query_one(&format!("select {function}($1::jsonb)"), &[&request])
            .unwrap()
            .get(0)
    }
    pub fn base(&self) -> Value {
        json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"session_id":self.session_id})
    }
    pub fn work(&mut self, patch: Value) -> Value {
        let mut request = self.base();
        request
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        self.call("kernel_work_session", request)
    }
    /// The `work` selector for this fixture's session.
    pub fn work_ref(&self) -> Value {
        json!({"session_id":self.session_id})
    }
    pub fn query(&mut self, patch: Value) -> Value {
        let mut request = json!({"app_id":APP,"customer_id":CUSTOMER,"schema_version":VERSION,"model_id":"item","as_of":"2026-01-01","select":["$id","$version","score"]});
        request
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        self.call("kernel_data_query", request)
    }
    /// Approves the draft a Save wrote, as the approver's "Save and approve".
    #[allow(dead_code)]
    pub fn approve_saved(&mut self, saved: &Value) {
        let id = saved["data"]["change_set"]["id"]
            .as_i64()
            .expect("Save wrote a draft");
        assert_ok(&self.call(
            "kernel_approve_draft_change_set",
            json!({"app_id":APP,"customer_id":CUSTOMER,"change_set_id":id}),
        ));
    }
    pub fn create(&mut self) -> Value {
        self.work(json!({"operation":"create","expected_revision":0,"request_id":"create","title":"Test","as_of":"2026-01-01"}))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .client
            .batch_execute("rollback; reset session authorization; reset role");
        // Remove fixture principals before their capability roles.
        let _ = self.client.batch_execute(&format!(
            "drop owned by {}, {}, {} cascade; drop role if exists {}, {}, {}",
            self.principal,
            self.agent_principal,
            self.second_agent_principal,
            self.principal,
            self.agent_principal,
            self.second_agent_principal,
        ));
        let _ = trusted_human::drop_fixture(&mut self.client, &self.schema);
    }
}
/// Staging and canvas edits are last-write-wins: they carry no request id or revision.
pub fn is_edit(request: &Value) -> bool {
    matches!(
        request["operation"].as_str(),
        Some("update" | "stage" | "unstage" | "discard_source" | "discard_turn")
    )
}
pub fn assert_ok(value: &Value) {
    assert_eq!(value["ok"], true, "{value}");
}
pub fn assert_error(value: &Value, code: &str) {
    assert_eq!(value["ok"], false, "{value}");
    assert_eq!(value["error"]["code"], code, "{value}");
}
