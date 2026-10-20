-- LOCAL DRAFT ONLY. No backfill. Apply only after explicit production approval.
-- Prerequisite: 202607230003_unify_keg_sales_calculation.sql and existing Keg schema.
-- Execute this entire file on one connection; never apply individual statements.

create table public.inventory_keg_safety_audit (
  request_id uuid primary key,
  action text not null check (action in ('replace', 'edit-start')),
  inventory_item_id bigint not null references public.inventory(id),
  actor_username text not null,
  reason text not null,
  request_payload jsonb not null,
  before_state jsonb not null,
  after_state jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.inventory_keg_safety_audit enable row level security;
revoke all on public.inventory_keg_safety_audit from public, anon, authenticated, service_role;
grant select on public.inventory_keg_safety_audit to service_role;

-- Stable/read-only: evaluates only the selected item and its linked boundary.
create function public.inventory_preview_keg_change(
  p_action text, p_item_id bigint, p_session_id bigint, p_at timestamptz,
  p_business_date date, p_actor_username text, p_expected_quantity numeric default null
) returns jsonb language plpgsql stable security definer set search_path = public set timezone = 'UTC' as $$
declare
  v_item public.inventory%rowtype;
  v_active public.inventory_keg_sessions%rowtype;
  v_previous public.inventory_keg_sessions%rowtype;
  v_item_id bigint := p_item_id;
  v_before jsonb := '{}'::jsonb; v_after jsonb := '{}'::jsonb;
  v_old_sold numeric := 0; v_new_sold numeric := 0;
  v_old_loss numeric := 0; v_new_loss numeric := 0; v_capacity numeric;
  v_mismatch boolean := false; v_warnings jsonb := '[]'::jsonb;
  v_state jsonb; v_result jsonb; v_previous_count int;
begin
  if p_action is null or p_action not in ('replace','edit-start') or p_at is null or p_business_date is null then
    raise exception 'KEG_INVALID_REQUEST';
  end if;
  if not exists(select 1 from public.users where username=p_actor_username and is_active=true) then
    raise exception 'KEG_INVALID_ACTOR';
  end if;
  if p_at > statement_timestamp() then raise exception 'KEG_FUTURE_TIME'; end if;
  -- Vietnam business day starts at 03:00, independent of the connection timezone.
  if p_business_date is distinct from ((p_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date then
    raise exception 'KEG_BUSINESS_DATE_MISMATCH' using errcode = '22023';
  end if;
  if p_action='edit-start' then
    select inventory_item_id into v_item_id from public.inventory_keg_sessions
      where id=p_session_id and status='active';
    if not found then raise exception 'KEG_ACTIVE_SESSION_NOT_FOUND'; end if;
  end if;
  select * into v_item from public.inventory where id=v_item_id;
  if not found then raise exception 'KEG_ITEM_NOT_FOUND'; end if;
  if lower(coalesce(v_item.unit,'')) <> 'keg' or v_item.package_content_quantity is null
    or v_item.package_content_quantity <= 0 or lower(coalesce(v_item.package_content_unit,'')) <> 'ml' then
    raise exception 'KEG_INVALID_CAPACITY';
  end if;
  -- Missing mappings are unknown evidence, not zero POS sales.
    if not exists(select 1 from public.inventory_keg_tracking_mappings where inventory_item_id=v_item_id and is_active=true and target_type='product') then
      raise exception 'KEG_MAPPING_NOT_FOUND';
    end if;
  select * into v_active from public.inventory_keg_sessions
    where inventory_item_id=v_item_id and status='active' order by started_at desc limit 1;
  if p_action='edit-start' and v_active.id is distinct from p_session_id then
    raise exception 'KEG_STALE_PREVIEW';
  end if;
  if p_action='replace' then
    if p_expected_quantity is not null and round(p_expected_quantity,6) <> round(v_item.quantity,6) then
      raise exception 'KEG_QUANTITY_CONFLICT';
    end if;
    if coalesce(v_item.quantity,0)<1 then raise exception 'KEG_INSUFFICIENT_QUANTITY'; end if;
    if v_active.id is not null and p_at < v_active.started_at then raise exception 'KEG_TIME_CONFLICT'; end if;
    v_capacity := v_item.package_content_quantity;
    if v_active.id is not null then
      v_after := public.calculate_inventory_keg_sales(v_item_id,v_active.started_at,p_at);
      if p_at-v_active.started_at <= interval '5 minutes' then v_warnings := v_warnings || '"SHORT_INTERVAL"'::jsonb; end if;
    end if;
  else
    -- Existing (inventory_item_id, started_at) index restricts this to one item.
    select count(*) into v_previous_count from public.inventory_keg_sessions
      where inventory_item_id=v_item_id and status='closed' and ended_log_id=v_active.started_log_id;
    if v_previous_count>1 then raise exception 'KEG_BOUNDARY_CONFLICT'; end if;
    select * into v_previous from public.inventory_keg_sessions
      where inventory_item_id=v_item_id and status='closed' and ended_log_id=v_active.started_log_id;
    if v_previous.id is not null then
      if v_previous.ended_at is distinct from v_active.started_at then raise exception 'KEG_BOUNDARY_CONFLICT'; end if;
      if p_at<v_previous.started_at then raise exception 'KEG_TIME_CONFLICT'; end if;
      v_capacity := v_previous.capacity_quantity;
      v_before := public.calculate_inventory_keg_sales(v_item_id,v_previous.started_at,v_previous.ended_at);
      v_after := public.calculate_inventory_keg_sales(v_item_id,v_previous.started_at,p_at);
      v_old_sold := round((v_before->>'soldMl')::numeric,3);
      v_old_loss := greatest(v_capacity-v_old_sold,0);
      v_mismatch := v_previous.sold_quantity is null or v_previous.loss_quantity is null or v_previous.loss_rate is null
        or round(v_previous.sold_quantity,3)<>v_old_sold or round(v_previous.loss_quantity,3)<>round(v_old_loss,3)
        or v_previous.loss_rate<>round(v_old_loss/v_capacity,6);
    else
      -- A first session may have no predecessor; don't infer or invent a historical one.
      if exists(select 1 from public.inventory_keg_sessions where inventory_item_id=v_item_id and status='closed') then
        raise exception 'KEG_BOUNDARY_CONFLICT';
      end if;
      v_capacity := v_active.capacity_quantity;
    end if;
  end if;
  if p_action='edit-start' and v_previous.id is null then
    -- No closed Keg is affected: its sales/loss summary is not applicable, not a full-Keg loss.
    v_old_sold := null; v_old_loss := null; v_new_sold := null; v_new_loss := null;
    v_after := 'null'::jsonb;
  else
    v_after := v_after || jsonb_build_object('totalUnits',coalesce((v_after->>'regularUnits')::numeric,0)+coalesce((v_after->>'towerUnits')::numeric,0)+coalesce((v_after->>'otherUnits')::numeric,0));
    v_new_sold := round(coalesce((v_after->>'soldMl')::numeric,0),3);
    if p_action='replace' and v_new_sold=0 then v_warnings := v_warnings || '"ZERO_SALES"'::jsonb; end if;
    v_new_loss := greatest(v_capacity-v_new_sold,0);
  end if;
  v_state := jsonb_build_object('action',p_action,'at',p_at,'businessDate',p_business_date,'actor',p_actor_username,
    'item',jsonb_build_object('id',v_item.id,'quantity',v_item.quantity,'capacity',v_item.package_content_quantity,'unit',v_item.package_content_unit,'updatedAt',v_item.updated_at),
    'active',to_jsonb(v_active),'previous',to_jsonb(v_previous),'posBefore',v_before,'posAfter',v_after);
  v_result := jsonb_build_object('ok',true,'dryRun',true,'writesPerformed',false,'action',p_action,'itemId',v_item_id,
    'actorUsername',p_actor_username,'activeSessionId',v_active.id,'previousSessionId',v_previous.id,
    'oldAt',v_active.started_at,'replacementAt',p_at,'businessDate',p_business_date,
    'currentQuantity',v_item.quantity,'projectedQuantity',case when p_action='replace' then v_item.quantity-1 else v_item.quantity end,
    'capacityMl',v_capacity,'soldMl',v_new_sold,'lossMl',v_new_loss,'overageMl',case when v_new_sold is not null then greatest(v_new_sold-v_capacity,0) end,
    'usagePercent',round(v_new_sold/v_capacity*100,3),'salesBreakdown',v_after,
    'storedSoldMl',v_previous.sold_quantity,'storedLossMl',v_previous.loss_quantity,'posBeforeSoldMl',v_old_sold,'posBeforeLossMl',v_old_loss,
    'soldDeltaMl',v_new_sold-v_old_sold,'lossDeltaMl',v_new_loss-v_old_loss,
    'priorDriftMl',case when v_previous.sold_quantity is null then null else v_old_sold-v_previous.sold_quantity end,
    'snapshotMismatch',v_mismatch,'warnings',v_warnings,
    'previewToken',encode(sha256(convert_to(v_state::text,'UTF8')),'hex'));
  return v_result;
end $$;

create function public.inventory_apply_keg_change(
  p_action text, p_item_id bigint, p_session_id bigint, p_at timestamptz,
  p_business_date date, p_actor_username text, p_expected_quantity numeric,
  p_preview_token text, p_request_id uuid, p_reason text, p_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path = public set timezone = 'UTC' as $$
declare
  v_item_id bigint := p_item_id; v_active_id bigint; v_previous_id bigint;
  v_preview jsonb; v_payload jsonb; v_existing public.inventory_keg_safety_audit%rowtype;
  v_before jsonb; v_after jsonb; v_result jsonb; v_sold numeric; v_loss numeric; v_capacity numeric;
begin
  if p_request_id is null or nullif(btrim(p_preview_token),'') is null or length(coalesce(p_reason,''))>500 then
    raise exception 'KEG_INVALID_REQUEST';
  end if;
  if not exists(select 1 from public.users where username=p_actor_username and is_active=true) then raise exception 'KEG_INVALID_ACTOR'; end if;
  v_payload := jsonb_build_object('action',p_action,'itemId',p_item_id,'sessionId',p_session_id,'at',p_at,'businessDate',p_business_date,
    'actor',p_actor_username,'expectedQuantity',p_expected_quantity,'previewToken',p_preview_token,'reason',btrim(coalesce(p_reason,'')),'confirm',p_confirm);
  -- Request lock precedes the item/active/previous row lock order used by all new saves.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into v_existing from public.inventory_keg_safety_audit where request_id=p_request_id;
  if found then
    if v_existing.request_payload is distinct from v_payload then raise exception 'KEG_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing.result || jsonb_build_object('replayed',true);
  end if;
  if p_action='edit-start' then
    select inventory_item_id into v_item_id from public.inventory_keg_sessions where id=p_session_id;
  end if;
  perform 1 from public.inventory where id=v_item_id for update;
  if not found then raise exception 'KEG_ITEM_NOT_FOUND'; end if;
  perform 1 from public.inventory_keg_sessions where inventory_item_id=v_item_id and status='active' for update;
  -- Lock the linked predecessor, never all Keg histories.
  perform 1 from public.inventory_keg_sessions previous where previous.inventory_item_id=v_item_id and previous.status='closed'
    and previous.ended_log_id=(select started_log_id from public.inventory_keg_sessions where inventory_item_id=v_item_id and status='active') for update;
  v_preview := public.inventory_preview_keg_change(p_action,v_item_id,p_session_id,p_at,p_business_date,p_actor_username,p_expected_quantity);
  if v_preview->>'previewToken' is distinct from p_preview_token then raise exception 'KEG_STALE_PREVIEW'; end if;
  if (v_preview->>'snapshotMismatch')::boolean then raise exception 'KEG_STORED_SNAPSHOT_MISMATCH'; end if;
  if (p_action='edit-start' or jsonb_array_length(v_preview->'warnings')>0) and nullif(regexp_replace(coalesce(p_reason,''),'[[:space:]]','','g'),'') is null then
    raise exception 'KEG_REASON_REQUIRED';
  end if;
  if jsonb_array_length(v_preview->'warnings')>0 and not coalesce(p_confirm,false) then raise exception 'KEG_CONFIRMATION_REQUIRED'; end if;
  v_active_id := (v_preview->>'activeSessionId')::bigint;
  v_previous_id := (v_preview->>'previousSessionId')::bigint;
  v_before := jsonb_build_object('preview',v_preview,'active',(select to_jsonb(s) from public.inventory_keg_sessions s where id=v_active_id),
    'previous',(select to_jsonb(s) from public.inventory_keg_sessions s where id=v_previous_id));
  if p_action='replace' then
    -- Keep the existing atomic stock lock, expectedQuantity check, -1 log and close/open semantics.
    v_result := public.replace_inventory_keg(v_item_id,p_actor_username,p_business_date,(v_preview->>'currentQuantity')::numeric,p_at);
    if v_result->>'ok'='false' then raise exception 'KEG_QUANTITY_CONFLICT'; end if;
    if v_active_id is not null and (v_result#>>'{closedSession,soldQuantity}')::numeric is distinct from (v_preview->>'soldMl')::numeric then raise exception 'KEG_STALE_PREVIEW'; end if;
  else
    update public.inventory_keg_sessions set started_at=p_at,started_business_date=p_business_date,updated_at=clock_timestamp()
      where id=v_active_id and status='active';
    if not found then raise exception 'KEG_STALE_PREVIEW'; end if;
    if v_previous_id is not null then
      v_sold := (v_preview->>'soldMl')::numeric; v_loss := (v_preview->>'lossMl')::numeric; v_capacity := (v_preview->>'capacityMl')::numeric;
      update public.inventory_keg_sessions set ended_at=p_at,ended_business_date=p_business_date,sold_quantity=v_sold,
        sold_unit='ml',loss_quantity=v_loss,loss_rate=round(v_loss/v_capacity,6),updated_at=clock_timestamp(),
        summary_note=format('Keg time corrected. POS sales %s ml / %s ml; unsold %s ml.',v_sold,v_capacity,v_loss)
        where id=v_previous_id and status='closed';
      if not found then raise exception 'KEG_STALE_PREVIEW'; end if;
    end if;
    v_result := jsonb_build_object('ok',true,'session',jsonb_build_object('id',v_active_id,'startedAt',p_at,'startedBusinessDate',p_business_date));
  end if;
  v_after := jsonb_build_object('active',(select to_jsonb(s) from public.inventory_keg_sessions s where inventory_item_id=v_item_id and status='active'),
    'previous',(select to_jsonb(s) from public.inventory_keg_sessions s where id=case when p_action='replace' then v_active_id else v_previous_id end));
  insert into public.inventory_keg_safety_audit(request_id,action,inventory_item_id,actor_username,reason,request_payload,before_state,after_state,result)
    values(p_request_id,p_action,v_item_id,p_actor_username,btrim(coalesce(p_reason,'')),v_payload,v_before,v_after,v_result);
  return v_result;
end $$;

revoke all on function public.inventory_preview_keg_change(text,bigint,bigint,timestamptz,date,text,numeric) from public, anon, authenticated;
revoke all on function public.inventory_apply_keg_change(text,bigint,bigint,timestamptz,date,text,numeric,text,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.inventory_preview_keg_change(text,bigint,bigint,timestamptz,date,text,numeric) to service_role;
grant execute on function public.inventory_apply_keg_change(text,bigint,bigint,timestamptz,date,text,numeric,text,uuid,text,boolean) to service_role;

-- DDL, RLS and final ACLs become visible together; any preceding error aborts everything.
