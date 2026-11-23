use super::RuntimeSqlFunction;

const MUTATIONS: &[(&str, &str)] = &[
    (
        "kernel_apply_change_set(jsonb)",
        "kernel_http_body_apply_change_set(jsonb)",
    ),
    (
        "kernel_apply_change_set_in_transaction(jsonb)",
        "kernel_http_body_apply_change_set_in_transaction(jsonb)",
    ),
    (
        "kernel_update_draft_notes(jsonb)",
        "kernel_http_body_update_draft_notes(jsonb)",
    ),
    (
        "kernel_discard_draft_change_set(jsonb)",
        "kernel_http_body_discard_draft_change_set(jsonb)",
    ),
    (
        "kernel_approve_draft_change_set(jsonb)",
        "kernel_http_body_approve_draft_change_set(jsonb)",
    ),
    (
        "kernel_revert_change_set(jsonb)",
        "kernel_http_body_revert_change_set(jsonb)",
    ),
    (
        "kernel_lookup_set_availability(jsonb)",
        "kernel_http_body_lookup_set_availability(jsonb)",
    ),
    (
        "kernel_lookup_transfer_alias(jsonb)",
        "kernel_http_body_lookup_transfer_alias(jsonb)",
    ),
    (
        "kernel_record_agent_run(jsonb)",
        "kernel_http_body_record_agent_run(jsonb)",
    ),
    (
        "kernel_update_agent_run_status(jsonb)",
        "kernel_http_body_update_agent_run_status(jsonb)",
    ),
];

pub(super) fn wrap(functions: Vec<RuntimeSqlFunction>) -> Vec<RuntimeSqlFunction> {
    let mut result = Vec::new();
    for function in functions {
        if let Some((_, body_signature)) = MUTATIONS
            .iter()
            .find(|(name, _)| *name == function.signature)
        {
            let name = function.signature.trim_end_matches("(jsonb)");
            let body = body_signature.trim_end_matches("(jsonb)");
            let body_sql = function.sql.replace(name, body);
            // The outer fixed lookup guard owns its HTTP operation. Preserve the
            // canonical apply receipt/policy implementation without entering a
            // second public HTTP boundary for the generated inner request.
            let body_sql = if function.signature == "kernel_lookup_set_availability(jsonb)" {
                body_sql.replace(
                    "return kernel_apply_change_set(apply_request);",
                    "return kernel_http_body_apply_change_set(apply_request);",
                )
            } else {
                body_sql
            };
            result.push(RuntimeSqlFunction {
                signature: body_signature,
                sql: body_sql,
            });
            result.push(RuntimeSqlFunction { signature: function.signature, sql: format!(r#"
create or replace function {name}(request jsonb)
returns jsonb language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare guard jsonb; result jsonb;
begin
  guard := kernel_http_mutation_guard(request,'{name}');
  if guard->'ok'='false'::jsonb then return guard; end if;
  result := {body}(request);
  if coalesce((guard->>'required')::boolean,false) then
    perform kernel_http_mutation_record(request,guard,result);
  end if;
  return result;
end;
$kernel$;
"#).trim().to_owned() });
        } else {
            result.push(function);
        }
    }
    result.extend(
        [
            ("kernel_admit_http_request(jsonb)", ADMIT_REQUEST),
            ("kernel_admit_http_operation(jsonb)", ADMIT_OPERATION),
            ("kernel_http_mutation_guard(jsonb,text)", MUTATION_GUARD),
            (
                "kernel_http_mutation_record(jsonb,jsonb,jsonb)",
                MUTATION_RECORD,
            ),
            ("kernel_finish_http_request(jsonb)", FINISH_REQUEST),
            ("kernel_prune_expired_http_requests()", PRUNE_EXPIRED),
            (
                "kernel_prune_expired_http_requests(text,text)",
                PRUNE_EXPIRED_SCOPE,
            ),
        ]
        .into_iter()
        .map(|(signature, sql)| RuntimeSqlFunction {
            signature,
            sql: sql.trim().to_owned(),
        }),
    );
    result
}

const ADMIT_REQUEST: &str = r#"
create or replace function kernel_admit_http_request(request jsonb)
returns jsonb language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare app text:=request->>'app_id'; customer text:=request->>'customer_id'; actor text:=request->>'actor_id'; role_name text:=request->>'role'; generation text:=request->>'fence_generation'; descriptor jsonb:=request->'http_request'; nonce text:=descriptor->>'jti'; identity_value jsonb; existing_identity jsonb;
begin
  if coalesce(descriptor->>'expiresAt','') !~ '^[1-9][0-9]*$' or (descriptor->>'expiresAt')::numeric<=floor(extract(epoch from clock_timestamp())) then
    return kernel_installer_error('authorization_denied','Verified request has expired','request','http_request_expired','a current signed request expiry is required');
  end if;
  if coalesce(btrim(nonce),'')='' or coalesce(descriptor->>'method','') not in ('POST','PUT','PATCH','DELETE')
    or descriptor->>'payloadSha256' is null or descriptor->>'payloadSha256' !~ '^[A-Za-z0-9_-]{43}$'
    or descriptor->>'bodySha256' is null or descriptor->>'bodySha256' !~ '^[A-Za-z0-9_-]{43}$'
    or coalesce(btrim(descriptor->>'issuer'),'')='' or coalesce(btrim(descriptor->>'audience'),'')='' or coalesce(btrim(descriptor->>'target'),'')=''
    or generation is null or generation !~ '^[1-9][0-9]*$' then
    return kernel_installer_error('authorization_denied','Protected request is unavailable','request','http_request_required','a verified mutation request and normalized payload identity are required');
  end if;
  if not exists(select 1 from kernel_principal_scope s where s.principal_name=session_user::name and s.active and s.capability='runtime' and s.app_id=app and s.customer_id=customer and (s.actor_id is null or s.actor_id=actor) and pg_has_role(session_user,pg_catalog.to_regrole(kernel_installer_capability_role('runtime')),'MEMBER')) then
    return kernel_installer_error('authorization_denied','Runtime scope is not authorized','request','scope_mismatch','the runtime principal is outside this request scope');
  end if;
  if role_name is null then
    if not kernel_roleless_access_authorized(app,customer,actor,generation) then return kernel_installer_error('authorization_denied','Actor access is not current','request','binding_mismatch','a current app admission is required'); end if;
  else
    perform 1 from kernel_actor_membership m where m.principal_name=session_user::name and m.app_id=app and m.customer_id=customer and m.actor_id=actor and m.role=role_name and m.active and m.fence_generation>0 and m.fence_generation::text=generation for share of m;
    if not found then return kernel_installer_error('authorization_denied','Actor binding is not current','request','binding_mismatch','a current actor binding is required'); end if;
  end if;
  -- Actor validation may wait on a revocation transaction. Never admit an expired request after that wait.
  if (descriptor->>'expiresAt')::numeric<=floor(extract(epoch from clock_timestamp())) then
    return kernel_installer_error('authorization_denied','Verified request has expired','request','http_request_expired','a current signed request expiry is required');
  end if;
  -- The fixed definer admission owns expiry-only cleanup; runtime cannot invoke this helper directly.
  perform kernel_prune_expired_http_requests(app,customer);
  if (descriptor->>'expiresAt')::numeric<=floor(extract(epoch from clock_timestamp())) then
    return kernel_installer_error('authorization_denied','Verified request has expired','request','http_request_expired','a current signed request expiry is required');
  end if;
  identity_value:=jsonb_build_object('actorId',actor,'role',role_name,'fenceGeneration',generation,'request',descriptor);
  insert into kernel_http_request_admission(principal_name,app_id,customer_id,jti,identity,expires_at)
  values(session_user::name,app,customer,nonce,identity_value,(descriptor->>'expiresAt')::bigint) on conflict do nothing;
  select a.identity into existing_identity from kernel_http_request_admission a where a.principal_name=session_user::name and a.app_id=app and a.customer_id=customer and a.jti=nonce;
  if existing_identity is distinct from identity_value then return kernel_installer_error('authorization_denied','Request identity does not match','request','http_request_identity_conflict','a nonce cannot be reused for changed identity or payload'); end if;
  return jsonb_build_object('ok',true,'data',null);
end;
$kernel$;
"#;

const ADMIT_OPERATION: &str = r#"
create or replace function kernel_admit_http_operation(request jsonb)
returns jsonb language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare admission jsonb; app text:=request->>'app_id'; customer text:=request->>'customer_id'; nonce text:=request->'http_request'->>'jti'; sequence_value bigint; operation_value text:=request->>'operation'; fingerprint_value text; existing record;
begin
  admission:=kernel_admit_http_request(request);
  if admission->'ok'<>'true'::jsonb then return admission; end if;
  if coalesce(request->>'sequence','') !~ '^[1-9][0-9]*$' or coalesce(jsonb_typeof(request->'payload'),'')<>'object' then return kernel_installer_error('authorization_denied','Operation identity is unavailable','request','http_operation_required','an ordered operation identity is required'); end if;
  sequence_value:=(request->>'sequence')::bigint;
  fingerprint_value:=encode(sha256(convert_to(kernel_canonical_json(request->'payload'),'UTF8')),'hex');
  select o.operation,o.fingerprint into existing from kernel_http_operation_admission o where o.principal_name=session_user::name and o.app_id=app and o.customer_id=customer and o.jti=nonce and o.sequence=sequence_value;
  if not found then
    if sequence_value<>coalesce((select max(o.sequence) from kernel_http_operation_admission o where o.principal_name=session_user::name and o.app_id=app and o.customer_id=customer and o.jti=nonce),0)+1 then return kernel_installer_error('authorization_denied','Operation order does not match','request','http_operation_order_conflict','new operations must be admitted in contiguous order'); end if;
    if exists(select 1 from kernel_http_request_consumption c where c.principal_name=session_user::name and c.app_id=app and c.customer_id=customer and c.jti=nonce) then return kernel_installer_error('authorization_denied','Request nonce was consumed','request','http_request_replayed','a consumed nonce cannot acquire new operations'); end if;
    insert into kernel_http_operation_admission(principal_name,app_id,customer_id,jti,sequence,operation,fingerprint) values(session_user::name,app,customer,nonce,sequence_value,operation_value,fingerprint_value) on conflict do nothing;
    select o.operation,o.fingerprint into existing from kernel_http_operation_admission o where o.principal_name=session_user::name and o.app_id=app and o.customer_id=customer and o.jti=nonce and o.sequence=sequence_value;
  end if;
  if existing.operation is distinct from operation_value or existing.fingerprint is distinct from fingerprint_value then return kernel_installer_error('authorization_denied','Operation identity does not match','request','http_operation_conflict','the ordered request operation cannot change'); end if;
  return jsonb_build_object('ok',true,'data',null);
end;
$kernel$;
"#;

const MUTATION_GUARD: &str = r#"
create or replace function kernel_http_mutation_guard(request jsonb, operation_value text)
returns jsonb language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare app text:=request->>'app_id'; customer text:=request->>'customer_id'; nonce text:=nullif(current_setting('kernel.http_jti',true),''); descriptor jsonb; identity_value jsonb; generation text:=nullif(current_setting('kernel.actor_fence_generation',true),''); role_name text:=nullif(current_setting('kernel.actor_role',true),''); actor text:=nullif(current_setting('kernel.actor_id',true),''); sequence_value bigint; consumed record; replay_id bigint; fingerprint_value text;
begin
  -- A context marked as agent writes only working state and draft thread
  -- replies, on every app, without the protected request protocol (session
  -- edits are last-write-wins; other session mutations keep their revision and
  -- request_id receipts), and every canonical mutation is refused.
  if kernel_request_marked_agent() then
    if operation_value in ('kernel_work_session','kernel_draft_threads') then return jsonb_build_object('required',false); end if;
    return kernel_installer_error('authorization_denied','Agent context cannot write canonical data','request','agent_canonical_write_forbidden','agents stage work-session changes; a human saves');
  end if;
  if not exists(select 1 from kernel_principal_scope s where s.principal_name=session_user::name and s.capability='runtime' and s.app_id=app and s.customer_id=customer and s.actor_binding_required) then return jsonb_build_object('required',false); end if;
  if nonce is null or nullif(current_setting('kernel.http_descriptor',true),'') is null or nullif(current_setting('kernel.http_sequence',true),'') is null then return kernel_installer_error('authorization_denied','Protected request is unavailable','request','http_request_required','a verified request nonce is required for mutations'); end if;
  if not kernel_principal_scope_authorized('runtime',app,customer,null) then return kernel_authorize_scope('runtime',app,customer,null); end if;
  -- Bind authorized scope before inspecting canonical receipts under their RLS.
  perform set_config('kernel.app_id',app,true); perform set_config('kernel.customer_id',customer,true);
  descriptor:=current_setting('kernel.http_descriptor',true)::jsonb;
  if coalesce(descriptor->>'expiresAt','') !~ '^[1-9][0-9]*$' or (descriptor->>'expiresAt')::numeric<=floor(extract(epoch from clock_timestamp())) then
    return kernel_installer_error('authorization_denied','Verified request has expired','request','http_request_expired','a current signed request expiry is required');
  end if;
  identity_value:=jsonb_build_object('actorId',actor,'role',role_name,'fenceGeneration',generation,'request',descriptor);
  if not exists(select 1 from kernel_http_request_admission a where a.principal_name=session_user::name and a.app_id=app and a.customer_id=customer and a.jti=nonce and a.identity=identity_value) then return kernel_installer_error('authorization_denied','Request admission does not match','request','http_request_identity_conflict','the request must match its durable admission'); end if;
  select c.* into consumed from kernel_http_request_consumption c where c.principal_name=session_user::name and c.app_id=app and c.customer_id=customer and c.jti=nonce;
  -- Only the private execution marker allows nested calls from a fixed mutation body.
  if found and consumed.executing_xid=pg_current_xact_id() and consumed.executing then return jsonb_build_object('required',false); end if;
  sequence_value:=current_setting('kernel.http_sequence',true)::bigint;
  fingerprint_value:=encode(sha256(convert_to(kernel_canonical_json(request),'UTF8')),'hex');
  if not exists(select 1 from kernel_http_operation_admission o where o.principal_name=session_user::name and o.app_id=app and o.customer_id=customer and o.jti=nonce and o.sequence=sequence_value and o.operation=operation_value and o.fingerprint=fingerprint_value) then return kernel_installer_error('authorization_denied','Operation admission does not match','request','http_operation_conflict','the operation must match its ordered durable admission'); end if;
  insert into kernel_http_request_consumption(principal_name,app_id,customer_id,jti,owner_xid) values(session_user::name,app,customer,nonce,pg_current_xact_id()) on conflict do nothing;
  select c.* into consumed from kernel_http_request_consumption c where c.principal_name=session_user::name and c.app_id=app and c.customer_id=customer and c.jti=nonce for update;
  if not found or (descriptor->>'expiresAt')::numeric<=floor(extract(epoch from clock_timestamp())) then return kernel_installer_error('authorization_denied','Verified request has expired','request','http_request_expired','expired requests cannot execute after waiting for another transaction'); end if;
  if consumed.owner_xid<>pg_current_xact_id() then
    select r.change_set_id into replay_id from kernel_http_operation_receipt r where r.principal_name=session_user::name and r.app_id=app and r.customer_id=customer and r.jti=nonce and r.sequence=sequence_value;
    if operation_value='kernel_work_session' then
      if not exists(select 1 from work_session s where s.app_id=app and s.customer_id=customer and s.id=(request->>'session_id')::uuid and s.owner_id=actor and s.receipts->(request->>'request_id')->>'fingerprint'=fingerprint_value) then
        return kernel_installer_error('authorization_denied','Request nonce was consumed','request','http_request_replayed','this mutation has no exact durable replay receipt');
      end if;
    elsif operation_value='kernel_draft_threads' then
      if coalesce(request->>'change_set_id','') !~ '^[0-9]{1,18}$' or not exists(select 1 from change_set c where c.app_id=app and c.customer_id=customer and c.id=(request->>'change_set_id')::bigint and c.thread_receipts->(request->>'request_id')->>'fingerprint'=kernel_draft_thread_fingerprint(actor,request)) then
        return kernel_installer_error('authorization_denied','Request nonce was consumed','request','http_request_replayed','this mutation has no exact durable replay receipt');
      end if;
    elsif replay_id is null or operation_value not in ('kernel_apply_change_set','kernel_apply_change_set_in_transaction','kernel_lookup_set_availability') or not exists(select 1 from change_set c where c.id=replay_id and c.app_id=app and c.customer_id=customer and c.idempotency_key=request->>'idempotency_key') then return kernel_installer_error('authorization_denied','Request nonce was consumed','request','http_request_replayed','this mutation has no exact durable replay receipt'); end if;
  end if;
  update kernel_http_request_consumption set executing=true,executing_xid=pg_current_xact_id() where principal_name=session_user::name and app_id=app and customer_id=customer and jti=nonce;
  return jsonb_build_object('required',true,'sequence',sequence_value,'fresh',consumed.owner_xid=pg_current_xact_id(),'operation',operation_value);
end;
$kernel$;
"#;

const MUTATION_RECORD: &str = r#"
create or replace function kernel_http_mutation_record(request jsonb, guard jsonb, result jsonb)
returns void language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare app text:=request->>'app_id'; customer text:=request->>'customer_id'; nonce text:=current_setting('kernel.http_jti',true); receipt_id bigint;
begin
  update kernel_http_request_consumption set executing=false,executing_xid=null where principal_name=session_user::name and app_id=app and customer_id=customer and jti=nonce;
  if (guard->>'fresh')::boolean then
    if guard->>'operation' in ('kernel_apply_change_set','kernel_apply_change_set_in_transaction','kernel_lookup_set_availability') and result->'ok'='true'::jsonb and coalesce(btrim(request->>'idempotency_key'),'')<>'' then receipt_id:=(result->'data'->>'id')::bigint; end if;
    insert into kernel_http_operation_receipt(principal_name,app_id,customer_id,jti,sequence,change_set_id) values(session_user::name,app,customer,nonce,(guard->>'sequence')::bigint,receipt_id) on conflict do nothing;
  end if;
end;
$kernel$;
"#;

const FINISH_REQUEST: &str = r#"
create or replace function kernel_finish_http_request(request jsonb)
returns jsonb language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare app text:=request->>'app_id'; customer text:=request->>'customer_id'; nonce text:=current_setting('kernel.http_jti',true); count_value bigint:=(request->>'operation_count')::bigint; consumed record;
begin
  if coalesce((current_setting('kernel.http_descriptor',true)::jsonb)->>'expiresAt','') !~ '^[1-9][0-9]*$' or ((current_setting('kernel.http_descriptor',true)::jsonb)->>'expiresAt')::numeric<=floor(extract(epoch from clock_timestamp())) then return kernel_installer_error('authorization_denied','Verified request has expired','request','http_request_expired','expired requests cannot commit'); end if;
  select c.* into consumed from kernel_http_request_consumption c where c.principal_name=session_user::name and c.app_id=app and c.customer_id=customer and c.jti=nonce for update;
  if not found then return jsonb_build_object('ok',true,'data',null); end if;
  if count_value<=0 or count_value is distinct from (select max(o.sequence) from kernel_http_operation_admission o where o.principal_name=session_user::name and o.app_id=app and o.customer_id=customer and o.jti=nonce) then return kernel_installer_error('authorization_denied','Request operations do not match','request','http_operation_count_conflict','the complete admitted operation sequence is required'); end if;
  if consumed.owner_xid=pg_current_xact_id() then
    if count_value is distinct from (select count(*) from kernel_http_operation_receipt r where r.principal_name=session_user::name and r.app_id=app and r.customer_id=customer and r.jti=nonce) then return kernel_installer_error('authorization_denied','Request operations are incomplete','request','http_operation_count_conflict','every operation must complete before commit'); end if;
    update kernel_http_request_consumption set operation_count=count_value where principal_name=session_user::name and app_id=app and customer_id=customer and jti=nonce;
  elsif consumed.operation_count is distinct from count_value then return kernel_installer_error('authorization_denied','Request operations do not match','request','http_operation_count_conflict','all admitted operations must be replayed in their original order'); end if;
  return jsonb_build_object('ok',true,'data',null);
end;
$kernel$;
"#;

const PRUNE_EXPIRED: &str = r#"
create or replace function kernel_prune_expired_http_requests()
returns bigint language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare candidate record; removed bigint:=0;
begin
  -- Private execution-owner maintenance only. Unknown legacy expiry is retained.
  for candidate in select a.principal_name,a.app_id,a.customer_id,a.jti from kernel_http_request_admission a where a.expires_at<=floor(extract(epoch from clock_timestamp())) loop
    begin
      -- Match business lock ordering; a busy transaction is skipped, never raced.
      perform 1 from kernel_http_request_consumption c where c.principal_name=candidate.principal_name and c.app_id=candidate.app_id and c.customer_id=candidate.customer_id and c.jti=candidate.jti for update nowait;
      perform 1 from kernel_http_request_admission a where a.principal_name=candidate.principal_name and a.app_id=candidate.app_id and a.customer_id=candidate.customer_id and a.jti=candidate.jti and a.expires_at<=floor(extract(epoch from clock_timestamp())) for update nowait;
      if not found then continue; end if;
      delete from kernel_http_operation_receipt r where r.principal_name=candidate.principal_name and r.app_id=candidate.app_id and r.customer_id=candidate.customer_id and r.jti=candidate.jti;
      delete from kernel_http_request_consumption c where c.principal_name=candidate.principal_name and c.app_id=candidate.app_id and c.customer_id=candidate.customer_id and c.jti=candidate.jti;
      delete from kernel_http_operation_admission o where o.principal_name=candidate.principal_name and o.app_id=candidate.app_id and o.customer_id=candidate.customer_id and o.jti=candidate.jti;
      delete from kernel_http_request_admission a where a.principal_name=candidate.principal_name and a.app_id=candidate.app_id and a.customer_id=candidate.customer_id and a.jti=candidate.jti;
      removed:=removed+1;
    exception when lock_not_available then null;
    end;
  end loop;
  return removed;
end;
$kernel$;
"#;

const PRUNE_EXPIRED_SCOPE: &str = r#"
create or replace function kernel_prune_expired_http_requests(scoped_app text, scoped_customer text)
returns bigint language plpgsql volatile parallel unsafe security invoker set search_path from current
as $kernel$
declare candidate record; removed bigint:=0;
begin
  -- Called only by validated fixed admission. Session login identity remains authoritative under SECURITY DEFINER.
  -- Unknown legacy expiry is retained; other principals/apps/customers are never inspected.
  for candidate in select a.principal_name,a.app_id,a.customer_id,a.jti from kernel_http_request_admission a where a.principal_name=session_user::name and a.app_id=scoped_app and a.customer_id=scoped_customer and a.expires_at<=floor(extract(epoch from clock_timestamp())) loop
    begin
      -- Match business lock ordering; a busy transaction is skipped, never raced.
      perform 1 from kernel_http_request_consumption c where c.principal_name=candidate.principal_name and c.app_id=candidate.app_id and c.customer_id=candidate.customer_id and c.jti=candidate.jti for update nowait;
      perform 1 from kernel_http_request_admission a where a.principal_name=candidate.principal_name and a.app_id=candidate.app_id and a.customer_id=candidate.customer_id and a.jti=candidate.jti and a.expires_at<=floor(extract(epoch from clock_timestamp())) for update nowait;
      if not found then continue; end if;
      delete from kernel_http_operation_receipt r where r.principal_name=candidate.principal_name and r.app_id=candidate.app_id and r.customer_id=candidate.customer_id and r.jti=candidate.jti;
      delete from kernel_http_request_consumption c where c.principal_name=candidate.principal_name and c.app_id=candidate.app_id and c.customer_id=candidate.customer_id and c.jti=candidate.jti;
      delete from kernel_http_operation_admission o where o.principal_name=candidate.principal_name and o.app_id=candidate.app_id and o.customer_id=candidate.customer_id and o.jti=candidate.jti;
      delete from kernel_http_request_admission a where a.principal_name=candidate.principal_name and a.app_id=candidate.app_id and a.customer_id=candidate.customer_id and a.jti=candidate.jti;
      removed:=removed+1;
    exception when lock_not_available then null;
    end;
  end loop;
  return removed;
end;
$kernel$;
"#;
