create or replace function kernel_work_session(request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path from current as $kernel$
declare
  op text := request->>'operation';
  actor text;
  agent boolean;
  schema_json jsonb;
  guard jsonb;
  fingerprint text;
  work_id uuid;
  stored record;
  receipt jsonb;
  session jsonb;
  state jsonb;
  result jsonb;
  patch jsonb;
  thread_key text;
  thread jsonb;
  rule_key text;
  rule jsonb;
  entry jsonb;
  canonical jsonb;
  confirmation jsonb;
  images jsonb;
  live jsonb := '[]';
  versions jsonb := '{}';
  writes jsonb;
  apply_request jsonb;
  change_set jsonb;
  replay boolean := false;
  revision bigint;
  touched jsonb;
  restored jsonb;
  pending jsonb;
  previous jsonb;
  entries jsonb;
  removed jsonb := '[]';
  extra jsonb := '{}';
  -- Staging and canvas edits (stage, unstage, discard_source, discard_turn,
  -- update) are last-write-wins: no request id, revision or receipt, so a
  -- human and an agent editing at once both land. Every other mutation keeps
  -- its request id (idempotent retry) and expected revision.
  lww boolean := request->>'operation' in ('update', 'stage', 'unstage', 'discard_source', 'discard_turn');
begin
  if jsonb_typeof(request) is distinct from 'object' then raise exception 'contract_validation_failed: invalid work request'; end if;
  actor := kernel_work_actor(request);
  schema_json := kernel_read_scope_schema(request->>'app_id', request->>'customer_id');
  if request->>'schema_version' is distinct from schema_json->>'version' then
    raise exception 'schema_drift: generated work operation schema version is stale';
  end if;
  -- Trusted membership, never request source, decides human authority; a
  -- context marked as agent is an agent whatever its membership says.
  agent := kernel_request_is_agent(request->>'app_id', request->>'customer_id', actor);
  -- An agent may start a session for the person it acts for (owned by that
  -- person, like `git checkout -b`), arrange the canvas and move its as-of
  -- date (an update of layout and as_of only), never retitle or rescope it.
  if agent and (op in ('duplicate', 'save', 'archive', 'unarchive', 'pin', 'pull', 'presence')
      or (op = 'update' and (jsonb_typeof(request->'patch') is distinct from 'object'
        or (request->'patch') = '{}'::jsonb or (request->'patch') - array['layout', 'as_of'] <> '{}'::jsonb))) then
    raise exception 'authorization_denied: operation requires a human';
  end if;

  if op = 'list' then
    -- Headers only; staged values are read through get under current grants.
    select coalesce(jsonb_agg(jsonb_build_object(
        'app_id', s.app_id, 'customer_id', s.customer_id, 'id', s.id, 'owner_id', s.owner_id,
        'title', s.title, 'as_of', s.as_of, 'scope', s.scope, 'layout', s.layout, 'pinned', s.pinned,
        'status', s.status, 'revision', s.revision, 'created_at', s.created_at, 'updated_at', s.updated_at)
      order by s.pinned desc, s.updated_at desc, s.id), '[]')
    into result
    from work_session s
    where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id'
      and s.owner_id = actor and s.status = coalesce(request->>'status', 'active');
    return jsonb_build_object('ok', true, 'data', result);
  end if;
  if op = 'get' then return jsonb_build_object('ok', true, 'data', kernel_work_read(request)); end if;
  -- Only an agent asks the person to Save.
  if op = 'save_request' and not agent then raise exception 'authorization_denied: only an agent asks to Save'; end if;
  -- The person's selection in the canvas: presence state, not working state.
  -- It takes no revision and no receipt, bumps none and notifies nobody, so it
  -- never races edits or wakes other viewers. Owner-private like the session.
  if op = 'presence' then
    work_id := kernel_work_uuid(request->>'session_id');
    if work_id is null then raise exception 'contract_validation_failed: session_id is required'; end if;
    patch := request->'selection';
    if jsonb_typeof(patch) is distinct from 'array' or jsonb_array_length(patch) > 200 or exists (
      select 1 from jsonb_array_elements(patch) t
      where jsonb_typeof(t) is distinct from 'object' or jsonb_typeof(t->'model_id') is distinct from 'string'
        or kernel_work_uuid(t->>'record_id') is null
        or (t ? 'field_id' and jsonb_typeof(t->'field_id') is distinct from 'string')
        or t - array['model_id', 'record_id', 'field_id'] <> '{}'::jsonb
    ) then
      raise exception 'contract_validation_failed: selection must be at most 200 targets';
    end if;
    guard := kernel_http_mutation_guard(request, 'kernel_work_session');
    if guard ? 'ok' then return guard; end if;
    if not exists (select 1 from work_session s
        where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id' and s.id = work_id and s.owner_id = actor) then
      raise exception 'authorization_denied: session is unavailable';
    end if;
    insert into work_session_presence as p (app_id, customer_id, session_id, actor_id, selection, updated_at)
    values (request->>'app_id', request->>'customer_id', work_id, actor, patch, clock_timestamp())
    on conflict (app_id, customer_id, session_id, actor_id) do update set selection = excluded.selection, updated_at = excluded.updated_at;
    result := jsonb_build_object('ok', true, 'data', jsonb_build_object('targets', jsonb_array_length(patch)));
    perform kernel_http_mutation_record(request, guard, result);
    return result;
  end if;
  -- A page of staged entries; reads need no request ID or mutation guard.
  if op = 'entries' then return jsonb_build_object('ok', true, 'data', kernel_work_entries_page(request)); end if;

  if lww and (request ? 'request_id' or request ? 'expected_revision') then
    raise exception 'contract_validation_failed: edits are last-write-wins and take no request_id or expected_revision';
  elsif not lww and (coalesce(btrim(request->>'request_id'), '') = '' or coalesce(request->>'expected_revision', '') !~ '^[0-9]+$') then
    raise exception 'contract_validation_failed: mutation requires request_id and expected_revision';
  end if;
  guard := kernel_http_mutation_guard(request, 'kernel_work_session');
  if guard ? 'ok' then return guard; end if;
  work_id := (request->>'session_id')::uuid;
  if work_id is null then raise exception 'contract_validation_failed: session_id is required'; end if;
  fingerprint := encode(sha256(convert_to(kernel_canonical_json(request), 'UTF8')), 'hex');
  -- Serialize create/replay before a row exists, and later mutations with it.
  perform pg_advisory_xact_lock(hashtextextended((request->>'app_id') || ':' || (request->>'customer_id') || ':work:' || work_id::text, 0));
  select s.* into stored from work_session s
  where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id' and s.id = work_id and s.owner_id = actor
  for update;
  if found then
    receipt := case when lww then null else stored.receipts->(request->>'request_id') end;
    session := to_jsonb(stored) - 'receipts';
    if receipt is not null then
      -- A replay repeats no effect: it answers from the current state.
      if receipt->>'fingerprint' is distinct from fingerprint then raise exception 'idempotency_conflict: request id was reused'; end if;
      replay := true;
      revision := stored.revision;
      change_set := receipt->'change_set';
    else
      if op in ('create', 'duplicate') then raise exception 'revision_conflict: session already exists'; end if;
      if not lww and stored.revision <> (request->>'expected_revision')::bigint then raise exception 'revision_conflict: session changed'; end if;
      if stored.status <> 'active' and op <> 'unarchive' then raise exception 'revision_conflict: session is archived'; end if;
    end if;
  elsif op not in ('create', 'duplicate') then
    raise exception 'authorization_denied: session is unavailable';
  end if;

  if replay then
    null;
  elsif op in ('create', 'duplicate') then
    if (request->>'expected_revision')::bigint <> 0 then raise exception 'revision_conflict: session already exists'; end if;
    if jsonb_typeof(request->'title') is distinct from 'string' or btrim(request->>'title') = '' then
      raise exception 'contract_validation_failed: title required';
    end if;
    receipt := jsonb_build_object(request->>'request_id', jsonb_build_object('fingerprint', fingerprint, 'revision', 1));
    if op = 'create' then
      if request->>'as_of' is null then raise exception 'contract_validation_failed: title and as_of required'; end if;
      insert into work_session(app_id, customer_id, id, owner_id, title, as_of, scope, layout, receipts)
      values (request->>'app_id', request->>'customer_id', work_id, actor, request->>'title', (request->>'as_of')::date,
        coalesce(request->'scope', '{}'), coalesce(request->'layout', '{}'), receipt);
    else
      -- A scenario is a copy of a session's metadata, rules and staged entries;
      -- threads stay with their session. The source's mutation lock makes both
      -- copies come from one source revision.
      perform pg_advisory_xact_lock(hashtextextended((request->>'app_id') || ':' || (request->>'customer_id') || ':work:'
        || ((request->>'source_session_id')::uuid)::text, 0));
      insert into work_session(app_id, customer_id, id, owner_id, title, as_of, scope, layout, rules, receipts)
      select s.app_id, s.customer_id, work_id, s.owner_id, request->>'title', s.as_of, s.scope, s.layout, s.rules, receipt
      from work_session s
      where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id'
        and s.id = (request->>'source_session_id')::uuid and s.owner_id = actor;
      if not found then raise exception 'authorization_denied: source session is unavailable'; end if;
      -- Copied entries belong to no thread and no agent turn of the copy.
      insert into work_session_record(app_id, customer_id, session_id, model_id, record_id, field_id, value, baseline, base_version,
        source, actor_id, author_principal, author_kind, rule_id, thread_id, turn_id, replaced, note, created_at, updated_at)
      select app_id, customer_id, work_id, model_id, record_id, field_id, value, baseline, base_version,
        source, actor_id, author_principal, author_kind, rule_id, null, null, replaced, note, created_at, updated_at
      from work_session_record
      where app_id = request->>'app_id' and customer_id = request->>'customer_id'
        and session_id = (request->>'source_session_id')::uuid;
    end if;
    revision := 1;
  else
    case op
    when 'update' then
      patch := request->'patch';
      if jsonb_typeof(patch) is distinct from 'object' or patch - array['title', 'scope', 'layout', 'as_of'] <> '{}'::jsonb
        or jsonb_typeof(patch->'scope') = 'null' or jsonb_typeof(patch->'layout') = 'null' then
        raise exception 'contract_validation_failed: invalid session patch';
      end if;
      if patch ? 'title' and (jsonb_typeof(patch->'title') is distinct from 'string' or btrim(patch->>'title') = '') then
        raise exception 'contract_validation_failed: title must be nonempty text';
      end if;
      if patch ? 'as_of' then
        begin
          if jsonb_typeof(patch->'as_of') is distinct from 'string' or patch->>'as_of' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            or to_char((patch->>'as_of')::date, 'YYYY-MM-DD') <> patch->>'as_of' then
            raise exception 'contract_validation_failed: as_of must be a calendar date';
          end if;
        exception when datetime_field_overflow or invalid_datetime_format then
          raise exception 'contract_validation_failed: as_of must be a calendar date';
        end;
      end if;
      session := session || patch;
      -- A new as-of re-reads the session at that date: every rule re-runs, and
      -- staged entries stay as they are; entries whose record moved since
      -- they were staged read as stale and are confirmed at Save.
      if patch ? 'as_of' and patch->>'as_of' is distinct from stored.as_of::text then
        -- Rule queries read the overlay at the session's stored date.
        update work_session s set as_of = (patch->>'as_of')::date
        where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id' and s.id = work_id;
        for rule in select value from jsonb_each(session->'rules') order by key loop
          perform kernel_work_rule_evaluate(request, session, rule);
        end loop;
      end if;
    when 'pin' then
      if jsonb_typeof(request->'pinned') is distinct from 'boolean' then raise exception 'contract_validation_failed: pinned must be boolean'; end if;
      session := session || jsonb_build_object('pinned', request->'pinned');
    when 'archive' then session := session || jsonb_build_object('status', 'archived');
    when 'unarchive' then session := session || jsonb_build_object('status', 'active');
    when 'stage', 'unstage' then
      if op = 'unstage' then
        patch := jsonb_build_array(jsonb_build_object('model_id', request->'model_id', 'record_id', request->'record_id', 'field_id', request->'field_id'));
      else
        patch := request->'changes';
        if jsonb_typeof(patch) is distinct from 'array' then raise exception 'contract_validation_failed: changes must be an array'; end if;
      end if;
      -- Human and agent change any staged entry (the working tree); an entry
      -- an agent overwrites keeps the human's value as `replaced`.
      if request ? 'note' and request->'note' <> 'null'::jsonb and (jsonb_typeof(request->'note') is distinct from 'string'
          or char_length(request->>'note') > 200) then
        raise exception 'contract_validation_failed: note must be text of at most 200 characters';
      end if;
      if op = 'unstage' then
        -- A human unstages any entry. An agent never removes a person's edit:
        -- it may not unstage a person's entry, and unstaging its own entry
        -- that overwrote a person's puts the person's value back (as
        -- discard_source does). Unstaging reads no canonical data.
        if agent then
          select jsonb_build_object('author_kind', w.author_kind) into entry
          from work_session_record w
          where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
            and w.model_id = request->>'model_id' and w.record_id = kernel_work_uuid(request->>'record_id') and w.field_id = request->>'field_id';
          if entry->>'author_kind' = 'human' then
            raise exception 'authorization_denied: agents may not unstage a person''s change';
          end if;
          update work_session_record w set value = w.replaced->'value', source = 'user', actor_id = w.replaced->>'actor_id',
            author_principal = coalesce(w.replaced->>'author_principal', w.author_principal), author_kind = 'human',
            rule_id = null, thread_id = null, turn_id = null, note = null, replaced = null, updated_at = clock_timestamp()
          where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
            and w.model_id = request->>'model_id' and w.record_id = kernel_work_uuid(request->>'record_id') and w.field_id = request->>'field_id'
            and w.replaced->>'author_kind' = 'human';
        end if;
        delete from work_session_record w
        where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
          and w.model_id = request->>'model_id' and w.record_id = kernel_work_uuid(request->>'record_id') and w.field_id = request->>'field_id'
          and (not agent or w.author_kind = 'agent');
      else
        -- An agent's staged entries carry its context's turn; human edits none.
        perform kernel_work_stage(request, session, patch, jsonb_build_object(
          'source', case when agent then 'agent' else 'user' end, 'actor_id', actor,
          'author_principal', session_user::text, 'author_kind', case when agent then 'agent' else 'human' end,
          'turn_id', case when agent then kernel_request_turn_id() end,
          'note', nullif(btrim(coalesce(request->>'note', '')), '')), true);
      end if;
    when 'discard_source' then
      if request->>'source' is null or request->>'source' not in ('user', 'agent') then
        raise exception 'contract_validation_failed: invalid source';
      end if;
      if agent and request->>'source' <> 'agent' then raise exception 'authorization_denied: agents may discard only their own changes'; end if;
      -- An agent entry that holds a human's overwritten value goes back to
      -- that human value instead of being lost.
      with updated as (
        update work_session_record w set value = w.replaced->'value', source = 'user', actor_id = w.replaced->>'actor_id',
          author_principal = coalesce(w.replaced->>'author_principal', w.author_principal), author_kind = 'human',
          rule_id = null, thread_id = null, turn_id = null, note = null, replaced = null, updated_at = clock_timestamp()
        where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
          and w.author_kind = 'agent' and w.replaced->>'author_kind' = 'human'
          and w.source = request->>'source'
          and (not agent or w.author_principal = session_user::text)
        returning w.model_id, w.record_id, w.field_id
      )
      select coalesce(jsonb_agg(to_jsonb(updated)), '[]') into restored from updated;
      with deleted as (
        delete from work_session_record w
        where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
          and w.source = request->>'source'
          and (not agent or (w.author_kind = 'agent' and w.author_principal = session_user::text))
        returning w.model_id, w.record_id, w.field_id
      )
      select coalesce(jsonb_agg(to_jsonb(deleted)), '[]') into removed from deleted;
    when 'discard_turn' then
      -- One turn's staged entries; rules, threads and proposals stay. A human
      -- discards any turn of the session, an agent only entries it authored.
      if kernel_work_uuid(request->>'turn_id') is null then
        raise exception 'contract_validation_failed: turn_id must be a lowercase UUID';
      end if;
      -- An agent entry that holds a human's overwritten value goes back to
      -- that human value instead of being lost.
      with updated as (
        update work_session_record w set value = w.replaced->'value', source = 'user', actor_id = w.replaced->>'actor_id',
          author_principal = coalesce(w.replaced->>'author_principal', w.author_principal), author_kind = 'human',
          rule_id = null, thread_id = null, turn_id = null, note = null, replaced = null, updated_at = clock_timestamp()
        where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
          and w.author_kind = 'agent' and w.replaced->>'author_kind' = 'human'
          and w.turn_id = (request->>'turn_id')::uuid
          and (not agent or w.author_principal = session_user::text)
        returning w.model_id, w.record_id, w.field_id
      )
      select coalesce(jsonb_agg(to_jsonb(updated)), '[]') into restored from updated;
      with deleted as (
        delete from work_session_record w
        where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
          and w.turn_id = (request->>'turn_id')::uuid
          and (not agent or (w.author_kind = 'agent' and w.author_principal = session_user::text))
        returning w.model_id, w.record_id, w.field_id
      )
      select coalesce(jsonb_agg(to_jsonb(deleted)), '[]') into removed from deleted;
    when 'rule_create', 'rule_parameters', 'rule_remove' then
      rule_key := coalesce(request->>'rule_id', request#>>'{rule,id}');
      if coalesce(rule_key, '') = '' then raise exception 'contract_validation_failed: rule_id required'; end if;
      rule := session->'rules'->rule_key;
      if op = 'rule_create' then
        if rule is not null then raise exception 'revision_conflict: rule already exists'; end if;
        if jsonb_typeof(request->'rule') is distinct from 'object' then raise exception 'contract_validation_failed: invalid work rule'; end if;
        rule := request->'rule' || jsonb_build_object('id', rule_key, 'author_principal', session_user::text,
          'author_kind', case when agent then 'agent' else 'human' end);
      elsif rule is null then
        raise exception 'record_target_missing: rule is unavailable';
      end if;
      -- An agent tunes any rule's parameters; it removes only its own rules.
      if agent and op = 'rule_remove' and (rule->>'author_kind' <> 'agent' or rule->>'author_principal' <> session_user::text) then
        raise exception 'authorization_denied: agents may remove only their own rules';
      end if;
      if op = 'rule_remove' then
        session := jsonb_set(session, '{rules}', (session->'rules') - rule_key);
        with deleted as (
          delete from work_session_record w
          where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
            and w.rule_id = rule_key
          returning w.model_id, w.record_id, w.field_id
        )
        select coalesce(jsonb_agg(to_jsonb(deleted)), '[]') into removed from deleted;
      else
        if op = 'rule_parameters' then rule := rule || jsonb_build_object('parameters', request->'parameters'); end if;
        session := jsonb_set(session, array['rules', rule_key], rule);
        select coalesce(jsonb_agg(jsonb_build_object('model_id', w.model_id, 'record_id', w.record_id, 'field_id', w.field_id)), '[]')
        into previous
        from work_session_record w
        where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
          and w.rule_id = rule_key;
        extra := kernel_work_rule_evaluate(request, session, rule);
      end if;
    when 'save_request' then
      -- The agent asks the person to Save: a thread of kind save_request,
      -- replacing any open one. Save resolves it, and so does Not now.
      thread_key := request->>'thread_id';
      if coalesce(thread_key, '') = '' or session->'threads' ? thread_key then raise exception 'revision_conflict: thread exists or id missing'; end if;
      if jsonb_typeof(request->'reason') is distinct from 'string' or btrim(request->>'reason') = ''
          or char_length(request->>'reason') > 200 then
        raise exception 'contract_validation_failed: reason must be text of at most 200 characters';
      end if;
      session := jsonb_set(session, '{threads}', kernel_work_resolve_save_requests(session->'threads'));
      session := jsonb_set(session, array['threads', thread_key], jsonb_build_object(
        'id', thread_key, 'kind', 'save_request', 'reason', btrim(request->>'reason'), 'resolved', false,
        'messages', '[]'::jsonb, 'actor_id', actor, 'author_kind', 'agent',
        -- The revision this request makes: a later one means the session changed since.
        'revision', stored.revision + 1, 'created_at', clock_timestamp()));
      extra := jsonb_build_object('thread', session->'threads'->thread_key);
    when 'thread_open' then
      thread_key := request->>'thread_id';
      if coalesce(thread_key, '') = '' or session->'threads' ? thread_key then raise exception 'revision_conflict: thread exists or id missing'; end if;
      if request->'anchor' ?& array['model_id', 'record_id'] then
        perform kernel_work_canonical_map(request, session, jsonb_build_array(request->'anchor'));
      end if;
      session := jsonb_set(session, array['threads', thread_key],
        jsonb_build_object('id', thread_key, 'anchor', request->'anchor', 'resolved', false, 'messages', '[]'::jsonb));
      extra := jsonb_build_object('thread', session->'threads'->thread_key);
    when 'thread_reply', 'thread_resolve', 'propose', 'dismiss', 'pull' then
      thread_key := request->>'thread_id';
      thread := session->'threads'->thread_key;
      if thread is null then raise exception 'record_target_missing: thread unavailable'; end if;
      if op = 'thread_reply' then
        if jsonb_typeof(request->'message') is distinct from 'string' or btrim(request->>'message') = '' then
          raise exception 'contract_validation_failed: message required';
        end if;
        thread := jsonb_set(thread, '{messages}', (thread->'messages') || jsonb_build_array(jsonb_build_object(
          'id', request->>'request_id', 'actor_id', actor, 'author_kind', case when agent then 'agent' else 'human' end,
          'message', request->'message', 'created_at', clock_timestamp())));
        extra := jsonb_build_object('message', thread->'messages'->-1);
      elsif op = 'thread_resolve' then
        thread := thread || jsonb_build_object('resolved', true);
      elsif op = 'propose' then
        if jsonb_typeof(request->'changes') is distinct from 'array' then raise exception 'contract_validation_failed: proposal changes required'; end if;
        if agent and thread ? 'proposal'
          and (thread#>>'{proposal,author_kind}' <> 'agent' or thread#>>'{proposal,author_principal}' <> session_user::text) then
          raise exception 'authorization_denied: agents may change only their own proposals';
        end if;
        -- Proposals are validated as staging would, but stay outside the overlay.
        perform kernel_work_stage(request, session, request->'changes', '{}'::jsonb, false);
        thread := thread || jsonb_build_object('proposal', jsonb_build_object(
          'id', request->>'request_id', 'changes', request->'changes', 'actor_id', actor,
          'author_principal', session_user::text, 'author_kind', case when agent then 'agent' else 'human' end,
          'created_at', clock_timestamp()));
        extra := jsonb_build_object('proposal', thread->'proposal');
      else
        -- The expected revision identifies the proposal the caller saw: every
        -- proposal change advances the session revision.
        if thread->'proposal' is null then raise exception 'proposal_conflict: no proposal to resolve'; end if;
        if op = 'pull' then
          touched := thread#>'{proposal,changes}';
          -- Pulled changes keep the proposal's provenance.
          perform kernel_work_stage(request, session, thread#>'{proposal,changes}', jsonb_build_object(
            'source', case when thread#>>'{proposal,author_kind}' = 'agent' then 'agent' else 'user' end,
            'actor_id', thread#>>'{proposal,actor_id}', 'author_principal', thread#>>'{proposal,author_principal}',
            'author_kind', thread#>>'{proposal,author_kind}', 'thread_id', thread_key), true);
        elsif agent and (thread#>>'{proposal,author_kind}' <> 'agent' or thread#>>'{proposal,author_principal}' <> session_user::text) then
          raise exception 'authorization_denied: agents may dismiss only their own proposals';
        end if;
        thread := thread - 'proposal';
      end if;
      session := jsonb_set(session, array['threads', thread_key], thread);
    when 'save' then
      -- Save always writes one draft; an approver publishes it through draft
      -- approval, which stays a separate human act. Declared policies reject
      -- drafts (policy-aware drafts are a follow-up), so Save refuses under one
      -- before any work, including an all-gone Save that would never reach
      -- canonical apply.
      if coalesce((kernel_policy_active_snapshot(request->>'app_id', request->>'customer_id')->>'declared')::boolean, false) then
        raise exception using errcode = 'AR001', message = jsonb_build_object('ok', false, 'error', jsonb_build_object(
          'code', 'unsupported_capability', 'message', 'Policy-enabled writes support mainline changes only',
          'details', jsonb_build_array(jsonb_build_object('path', 'mode', 'code', 'unsupported_policy_lifecycle', 'message', 'draft'))))::text;
      end if;
      -- The expected revision identifies the overlay the caller saw; stale and
      -- gone entries still need explicit confirmation of the current version.
      state := kernel_work_state(request);
      pending := state->'overlay';
      if jsonb_array_length(pending) = 0 then raise exception 'contract_validation_failed: nothing to Save'; end if;
      -- Read and confirm versions without taking canonical locks ahead of apply.
      images := kernel_work_canonical_map(request, session, pending);
      for entry in select value from jsonb_array_elements(pending) loop
        canonical := kernel_work_canonical_image(images->(jsonb_build_array(entry->>'model_id', entry->>'record_id')::text), entry);
        confirmation := (
          select c.value from jsonb_array_elements(coalesce(request->'confirmed_stale', '[]')) c(value)
          where c.value->>'model_id' = entry->>'model_id' and c.value->>'record_id' = entry->>'record_id'
            and c.value->>'field_id' = entry->>'field_id'
          limit 1);
        if confirmation ? 'gone' and confirmation->'gone' is distinct from canonical->'gone' then
          raise exception 'stale_base: gone target changed before Save';
        end if;
        if canonical ? 'gone' then
          if confirmation->'current_version' is distinct from canonical->'version_id' or confirmation->'gone' is distinct from canonical->'gone' then
            raise exception 'stale_base: confirm gone target before Save';
          end if;
          continue;
        end if;
        if canonical->'version_id' is distinct from entry->'base_version'
          and confirmation->'current_version' is distinct from canonical->'version_id' then
          raise exception 'stale_base: confirm current canonical version before Save';
        end if;
        live := live || jsonb_build_array(entry);
        versions := versions || jsonb_build_object((entry->>'model_id') || ':' || (entry->>'record_id'), canonical->'version_id');
      end loop;
      -- One write per staged record, through ordinary canonical apply.
      select coalesce(jsonb_agg(write order by model_id, record_id), '[]') into writes
      from (
        select e->>'model_id' model_id, e->>'record_id' record_id,
          jsonb_build_object('model_id', e->>'model_id', 'effective_start', session->'as_of',
            'record_key', jsonb_build_object('type', 'record_id', 'value', e->>'record_id'),
            'values', coalesce(jsonb_object_agg(e->>'field_id', e->'value') filter (where e->'value' <> 'null'::jsonb and not custom), '{}'),
            'custom_fields', coalesce(jsonb_agg((e->'value') || jsonb_build_object('field_id', e->>'field_id')) filter (where e->'value' <> 'null'::jsonb and custom), '[]'),
            'clear_fields', coalesce(jsonb_agg(e->'field_id') filter (where e->'value' = 'null'::jsonb and not custom), '[]'),
            'clear_custom_fields', coalesce(jsonb_agg(e->'field_id') filter (where e->'value' = 'null'::jsonb and custom), '[]')) write
        from jsonb_array_elements(live) e
        cross join lateral (
          select exists (
            select 1 from jsonb_array_elements(kernel_active_custom_fields(schema_json, e->>'model_id')) f
            where f->>'field_id' = e->>'field_id'
          ) custom
        ) field
        group by e->>'model_id', e->>'record_id'
      ) per_record;
      -- Confirmed gone entries are left out; if nothing remains, Save only
      -- clears the overlay. A gone record restored before the write drops its
      -- staged change.
      if jsonb_array_length(writes) > 0 then
      declare caught_state text; caught_message text; caught_constraint text; caught_table text;
      begin
        apply_request := jsonb_build_object('app_id', request->'app_id', 'customer_id', request->'customer_id', 'actor_id', actor,
          'source_kind', 'work_session', 'source_ref', work_id::text, 'idempotency_key', 'work:' || work_id::text || ':' || (request->>'request_id'),
          'mode', 'draft', 'writes', writes);
        change_set := kernel_apply_execute_internal(apply_request, false, null, null, false);
      exception when serialization_failure then raise;
      when others then
        if split_part(sqlerrm, ':', 1) = 'stale_base' then raise; end if;
        get stacked diagnostics caught_state = returned_sqlstate, caught_message = message_text,
          caught_constraint = constraint_name, caught_table = table_name;
        raise exception using errcode = 'AR001', message = jsonb_build_object('ok', false,
          'error', kernel_apply_error_envelope_v2(caught_state, caught_message, caught_constraint, caught_table, apply_request))::text;
      end;
      end if;
      -- Draft apply has no version precondition API. Recheck under its canonical
      -- locks before committing the draft receipt or clearing the overlay.
      if jsonb_array_length(live) > 0 then
        images := kernel_work_canonical_map(request, session, live);
        if exists (
          select 1 from jsonb_array_elements(live) e
          where kernel_work_canonical_image(images->(jsonb_build_array(e->>'model_id', e->>'record_id')::text), e)->'version_id'
            is distinct from versions->((e->>'model_id') || ':' || (e->>'record_id'))
        ) then
          raise exception 'stale_base: canonical version changed during Save';
        end if;
      end if;
      if change_set is not null and change_set <> 'null'::jsonb then
        change_set := jsonb_set(change_set, '{schema_revision_id}', to_jsonb(change_set->>'schema_revision_id'));
        -- A Save sends the session's open threads with its changes, in the
        -- session's thread shape, so the workspace reads its discussion while
        -- it waits for review and once it is approved. Proposals stay
        -- session working state. The session keeps its threads.
        -- Rule notes on saved entries go with them, keyed model:record:field.
        update change_set c set threads = coalesce((
          select jsonb_object_agg(t.key, t.value - 'proposal') from jsonb_each(session->'threads') t
          where not coalesce((t.value->>'resolved')::boolean, false)
            and t.value->>'kind' is distinct from 'save_request'), '{}'::jsonb),
          entry_notes = (
          select jsonb_object_agg((e->>'model_id') || ':' || (e->>'record_id') || ':' || (e->>'field_id'), e->'note')
          from jsonb_array_elements(live) e where jsonb_typeof(e->'note') = 'string')
        where c.app_id = request->>'app_id' and c.customer_id = request->>'customer_id'
          and c.id = (change_set->>'id')::bigint;
      end if;
      extra := jsonb_build_object('cleared', true);
      -- Save answers the agent's request to Save, in the same transaction; a
      -- failed Save rolls back with it and leaves the request open.
      session := jsonb_set(session, '{threads}', kernel_work_resolve_save_requests(session->'threads'));
      delete from work_session_record w
      where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id;
    else
      raise exception 'contract_validation_failed: unknown work operation';
    end case;
    update work_session s set
      title = session->>'title', as_of = (session->>'as_of')::date, scope = session->'scope', layout = session->'layout',
      pinned = (session->>'pinned')::boolean, status = session->>'status',
      rules = session->'rules', threads = session->'threads',
      revision = stored.revision + 1, updated_at = clock_timestamp(),
      receipts = s.receipts || case when lww then '{}'::jsonb else jsonb_build_object(request->>'request_id', jsonb_strip_nulls(jsonb_build_object(
        'fingerprint', fingerprint, 'revision', stored.revision + 1, 'change_set', change_set))) end
    where s.app_id = request->>'app_id' and s.customer_id = request->>'customer_id' and s.id = work_id;
    revision := stored.revision + 1;
  end if;
  -- Open canvases learn of a new revision on commit and re-read through their
  -- own authorized reads; the payload carries no session data.
  if not replay then
    perform pg_notify('kernel_work_session', (request->>'customer_id') || ':' || work_id::text || ':' || revision::text);
  end if;
  -- A mutation answers with the session revision and only what it touched:
  -- its entries (as they now stand), the targets it removed, and what the
  -- operation produced. Only get returns the session. A replay answers the
  -- same way from the current state and reauthorizes the entries it returns.
  if op = 'stage' then
    touched := (select jsonb_agg(c) from jsonb_array_elements(request->'changes') c);
  elsif op = 'unstage' then
    touched := jsonb_build_array(request);
  elsif op = 'pull' and replay then
    select jsonb_agg(jsonb_build_object('model_id', w.model_id, 'record_id', w.record_id, 'field_id', w.field_id)) into touched
    from work_session_record w
    where w.app_id = request->>'app_id' and w.customer_id = request->>'customer_id' and w.session_id = work_id
      and w.thread_id = request->>'thread_id';
  end if;
  if op in ('rule_create', 'rule_parameters') then
    entries := kernel_work_entries(request, work_id, null, coalesce(request->>'rule_id', request#>>'{rule,id}'));
    if not replay then
      select coalesce(jsonb_agg(p), '[]') into removed from jsonb_array_elements(previous) p
      where not exists (
        select 1 from jsonb_array_elements(entries) e
        where e->>'model_id' = p->>'model_id' and e->>'record_id' = p->>'record_id' and e->>'field_id' = p->>'field_id'
      );
    end if;
    -- A replay does not re-evaluate, so it reports no overlaps.
    extra := jsonb_build_object('overlaps', coalesce(extra->'overlaps', '[]'::jsonb))
      || jsonb_build_object('rule', session->'rules'->coalesce(request->>'rule_id', request#>>'{rule,id}'));
  elsif op in ('discard_source', 'discard_turn') then
    -- Entries put back to the human's value are touched as they now stand,
    -- answered only where a fresh authorized read would show them.
    entries := kernel_work_entries(request, work_id, coalesce(restored, '[]'::jsonb), null);
    if not replay and entries <> '[]'::jsonb then
      entries := kernel_work_readable(request, session, entries);
    end if;
  elsif touched is not null then
    entries := kernel_work_entries(request, work_id, touched, null);
    select coalesce(jsonb_agg(jsonb_build_object('model_id', t->'model_id', 'record_id', t->'record_id', 'field_id', t->'field_id')), '[]')
    into removed
    from (select distinct on (t->>'model_id', t->>'record_id', t->>'field_id') t from jsonb_array_elements(touched) t) targets
    where not exists (
      select 1 from jsonb_array_elements(entries) e
      where e->>'model_id' = t->>'model_id' and e->>'record_id' = t->>'record_id' and e->>'field_id' = t->>'field_id'
    );
    -- An unstage that put a person's value back (an agent's own entry over
    -- it) answers with that entry only where a fresh authorized read would
    -- show it; it is restored either way and is not reported removed.
    if op = 'unstage' and not replay and entries <> '[]'::jsonb then
      entries := kernel_work_readable(request, session, entries);
    end if;
  end if;
  if replay then
    removed := case when touched is null then '[]'::jsonb else removed end;
    extra := case op
      when 'thread_open' then jsonb_build_object('thread', session->'threads'->(request->>'thread_id'))
      when 'save_request' then jsonb_build_object('thread', session->'threads'->(request->>'thread_id'))
      when 'thread_reply' then jsonb_build_object('message', (
        select m from jsonb_array_elements(session#>array['threads', request->>'thread_id', 'messages']) m
        where m->>'id' = request->>'request_id'))
      when 'propose' then jsonb_build_object('proposal', case
        when session#>>array['threads', request->>'thread_id', 'proposal', 'id'] = request->>'request_id'
        then session#>array['threads', request->>'thread_id', 'proposal'] end)
      else extra end;
    -- A replay returns only what a fresh authorized read would: every target
    -- it returns (entries, proposal changes, thread proposal and anchor) is
    -- authorized under current grants.
    perform kernel_work_canonical_map(request, session, coalesce(entries, '[]'::jsonb)
      || coalesce(extra#>'{proposal,changes}', '[]'::jsonb)
      || coalesce(extra#>'{thread,proposal,changes}', '[]'::jsonb)
      || case when extra#>'{thread,anchor}' ?& array['model_id', 'record_id']
        then jsonb_build_array(extra#>'{thread,anchor}') else '[]'::jsonb end);
  end if;
  -- Targets the server discovered (bulk deletions, rule outputs that left the
  -- match set, pulled targets) are reported only where a fresh authorized read
  -- would show them; the deletion itself reads nothing.
  if op in ('discard_source', 'discard_turn', 'rule_create', 'rule_parameters', 'rule_remove', 'pull')
    and coalesce(removed, '[]'::jsonb) <> '[]'::jsonb then
    removed := kernel_work_readable(request, session, removed);
  end if;
  if op = 'save' then
    -- The draft Save wrote (null when nothing was written).
    extra := jsonb_build_object('change_set', coalesce(change_set, 'null'::jsonb), 'cleared', true);
  elsif op in ('create', 'duplicate') then
    extra := jsonb_build_object('session_id', work_id);
  end if;
  result := jsonb_build_object('ok', true, 'data', jsonb_build_object('revision', revision)
    || case when op in ('stage', 'unstage', 'pull', 'discard_source', 'discard_turn', 'rule_create', 'rule_parameters', 'rule_remove')
      then jsonb_build_object('entries', coalesce(entries, '[]'::jsonb), 'removed', coalesce(removed, '[]'::jsonb)) else '{}'::jsonb end
    || extra);
  perform kernel_http_mutation_record(request, guard, result);
  return result;
exception when serialization_failure then raise;
when others then
  if sqlstate = 'AR001' then return sqlerrm::jsonb; end if;
  if split_part(sqlerrm, ':', 1) in ('revision_conflict', 'idempotency_conflict', 'proposal_conflict', 'stale_base', 'contract_validation_failed') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', split_part(sqlerrm, ':', 1),
      'message', btrim(substring(sqlerrm from position(':' in sqlerrm) + 1)), 'details', '[]'::jsonb));
  end if;
  return jsonb_build_object('ok', false, 'error', kernel_read_error_envelope(sqlstate, sqlerrm));
end $kernel$;
