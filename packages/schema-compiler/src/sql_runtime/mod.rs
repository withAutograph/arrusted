mod admin;
mod apply;
mod authorization;
mod derived;
mod drafts;
mod http_replay;
mod installer;
mod lookup_migration;
mod lookups;
mod reads;
mod search;
mod seeds;
mod shared;
mod tenant_schema;
mod work_sessions;

pub(super) struct RuntimeSqlFunction {
    pub(super) signature: &'static str,
    pub(super) sql: String,
}

pub(super) fn functions() -> Vec<RuntimeSqlFunction> {
    let mut functions = Vec::new();
    functions.extend(shared::functions());
    functions.extend(derived::functions());
    functions.extend(admin::functions());
    functions.extend(authorization::functions());
    functions.extend(apply::functions());
    functions.extend(drafts::functions());
    functions.extend(search::functions());
    functions.extend(reads::functions());
    functions.extend(work_sessions::functions());
    functions.extend(lookups::functions());
    functions.extend(lookup_migration::functions());
    functions.extend(seeds::functions());
    functions.extend(tenant_schema::functions());
    functions.extend(installer::functions());
    http_replay::wrap(functions)
}

pub(super) fn installer_substrate_sql() -> &'static str {
    installer::substrate_sql()
}

pub(super) fn installer_privilege_installation_sql() -> &'static str {
    installer::privilege_installation_sql()
}
