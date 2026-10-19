-- Inventory display-only daily sync -> Ledger category sync. NOT APPLIED automatically.
-- Scope: an explicit owner/master daily sync of a same-part, display-only change
-- (item names, category, category_vi, unit, code) of one original purchase receipt.
-- The RPC itself re-checks that the original receipt and the current item share one part.
--  * Pending candidate: refreshed in place (same candidate id, no superseded chain).
--    Its proposed category follows the new inventory category only when the current
--    proposal was itself derived from an earlier inventory category of that receipt.
--    Item/supplier rules (gas) always win over display categories. proposed_party_id never changes.
--  * Confirmed expense: category follows only through the audited reversal/rebook path,
--    and only when the month is open, nothing is paid, and no manual Ledger edit exists
--    (amount, display override, correction or manual audit history; display_snapshot={} is
--    the column default, not an edit). Amount, quantity, party/supplier, payable and fund
--    account are carried over unchanged.
--    Otherwise the projection reports review_required with a CATEGORY_SYNC_* code.
-- Every other caller (inventory edits, part changes, economic changes, reconcile)
-- keeps the existing projection path byte-for-byte. No data backfill in this file.
begin;

-- Mapping lookup shared by both paths. Deterministic when duplicate mappings exist.
create function inventory_ledger_private.display_sync_category_v1(p_source_key text,p_current bigint,p_snapshot jsonb)
returns bigint language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_new bigint; v_rule bigint;
begin
  -- Explicit item/supplier rules (e.g. gas) take precedence over every display category.
  v_rule:=inventory_ledger_private.purchase_category_for_new_source_v1(p_snapshot,null);
  if v_rule is not null then return coalesce(p_current,v_rule); end if;
  if p_current is not null and exists(select 1 from inventory_ledger_private.purchase_category_rules r
    where r.item_id=(p_snapshot->>'item_id')::bigint and r.category_id=p_current) then return p_current; end if;
  select m.ledger_category_id into v_new
    from public.ledger_inventory_category_mappings m
    join public.ledger_categories c on c.id=m.ledger_category_id and c.kind='expense' and c.is_active
    where m.is_active and lower(btrim(m.inventory_category))=lower(btrim(p_snapshot->>'category'))
    order by m.id limit 1;
  if v_new is null or p_current is not distinct from v_new then return p_current; end if;
  if p_current is null then return v_new; end if;
  -- Replace only a category proven to be derived from an earlier inventory category of
  -- the same receipt. Any other value is treated as an explicit Ledger choice.
  if exists (
    select 1 from public.ledger_candidates history
    join public.ledger_inventory_category_mappings old_mapping
      on lower(btrim(old_mapping.inventory_category))=lower(btrim(history.source_snapshot->>'category'))
    where history.source_type='inventory_purchase_log' and history.source_key=p_source_key
      and old_mapping.ledger_category_id=p_current
  ) then return v_new; end if;
  return p_current;
end;
$$;
alter function inventory_ledger_private.display_sync_category_v1(text,bigint,jsonb) owner to postgres;
revoke all on function inventory_ledger_private.display_sync_category_v1(text,bigint,jsonb) from public,anon,authenticated,service_role;

-- Confirmed expense category follow-up. Called only inside the scoped projection,
-- after the caller holds the source, month-close and transaction locks.
create function inventory_ledger_private.sync_confirmed_display_category_v1(
  p_candidate_id bigint,p_snapshot jsonb,p_fingerprint text,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_candidate public.ledger_candidates%rowtype; v_tx public.ledger_transactions%rowtype;
  v_payable public.ledger_payables%rowtype; v_category bigint; v_mode text; v_result jsonb;
begin
  select * into v_candidate from public.ledger_candidates where id=p_candidate_id for update;
  select * into v_tx from public.ledger_transactions where id=v_candidate.resolved_transaction_id for update;
  if v_candidate.status is distinct from 'confirmed' or v_tx.id is null or v_tx.status<>'confirmed' then
    return jsonb_build_object('status','unchanged');
  end if;
  v_category:=inventory_ledger_private.display_sync_category_v1(v_candidate.source_key,v_tx.category_id,p_snapshot);
  if v_category is null or v_category=v_tx.category_id then return jsonb_build_object('status','unchanged'); end if;
  -- Protection order: manual Ledger edits, month close, completed payment.
  -- display_snapshot defaults to {} on every posted row; only a non-empty override is an edit.
  -- Automatic posting writes no transaction audit row and inventory_source_rebooked is the
  -- automatic correction/category path; any other transaction audit row or a linked
  -- correction is a manual amount/category/memo/display change.
  if v_tx.amount is distinct from v_candidate.proposed_amount
     or coalesce(nullif(to_jsonb(v_tx)->'display_snapshot','null'::jsonb),'{}'::jsonb)<>'{}'::jsonb
     or v_tx.recognition_month is distinct from date_trunc('month',v_tx.business_date)::date
     or exists(select 1 from public.ledger_transactions child where child.correction_of_id=v_tx.id)
     or exists(select 1 from public.ledger_audit_logs a where a.entity_type='transaction'
       and a.entity_id=v_tx.id and a.action<>'inventory_source_rebooked') then
    return jsonb_build_object('status','review_required','code','CATEGORY_SYNC_MANUAL_OVERRIDE','categoryId',v_category);
  end if;
  if public.ledger_month_is_closed_v1(date_trunc('month',v_tx.business_date)::date)
     or public.ledger_month_is_closed_v1(v_tx.recognition_month)
     or public.ledger_month_is_closed_v1(date_trunc('month',(p_snapshot->>'business_date')::date)::date) then
    return jsonb_build_object('status','review_required','code','CATEGORY_SYNC_MONTH_CLOSED','categoryId',v_category);
  end if;
  select * into v_payable from public.ledger_payables where expense_transaction_id=v_tx.id for update;
  if v_payable.id is null or v_payable.status<>'unpaid'
     or exists(select 1 from public.ledger_payable_allocations a where a.payable_id=v_payable.id)
     or exists(select 1 from public.ledger_movements m where m.transaction_id=v_tx.id) then
    return jsonb_build_object('status','review_required','code','CATEGORY_SYNC_PAYMENT_COMPLETED','categoryId',v_category);
  end if;
  v_mode:=case when v_tx.source_snapshot->>'paymentVerification'='pending' then 'verification_pending' else 'payable' end;
  -- Same amount, party, due date, business date and payment semantics; only the category differs.
  v_result:=inventory_ledger_private.rebook_source(v_tx.id,v_mode,v_category,null,v_payable.due_date,v_tx.amount,
    v_tx.memo,'Inventory display category sync',p_actor_user_id,p_snapshot,p_fingerprint,v_tx.party_id,v_tx.business_date);
  if v_result->>'status'<>'rebooked' then
    return jsonb_build_object('status','review_required','code','CATEGORY_SYNC_'||upper(v_result->>'status'),'categoryId',v_category);
  end if;
  return v_result||jsonb_build_object('categoryId',v_category,'previousCategoryId',v_tx.category_id);
end;
$$;
alter function inventory_ledger_private.sync_confirmed_display_category_v1(bigint,jsonb,text,bigint) owner to postgres;
revoke all on function inventory_ledger_private.sync_confirmed_display_category_v1(bigint,jsonb,text,bigint) from public,anon,authenticated,service_role;

-- Amend the deployed bodies at exact, single-occurrence anchors. Stored bodies may use
-- LF or CRLF (sync_candidate is CRLF in Production); only anchors/additions are adapted.
do $contract$
declare
  signature text; definition text; matched_anchor text; addition_eol text; crlf boolean;
  anchors text[]; additions text[]; i integer;
begin
  foreach signature in array array[
    'inventory_ledger_private.sync_candidate(jsonb,bigint)',
    'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    if position('baba.inventory_display_sync' in definition)>0 then
      raise exception 'INVENTORY_DISPLAY_SYNC_ALREADY_APPLIED: %',signature;
    end if;
    crlf:=position(chr(13)||chr(10) in definition)>0;
    if signature='inventory_ledger_private.sync_candidate(jsonb,bigint)' then
      anchors:=array[$a1$    if v_pending.id is not null and v_pending.source_fingerprint = v_fingerprint then$a1$];
      additions:=array[$b1$    -- Explicit display-only daily sync: keep the pending candidate identity and its party.
    if v_pending.id is not null and not v_force_review
       and current_setting('baba.inventory_display_sync', true) = v_key
       and v_pending.proposed_amount = v_amount and v_pending.business_date = v_date
       and inventory_ledger_private.economics(v_pending.source_snapshot) = inventory_ledger_private.economics(v_snapshot) then
      v_category_id := inventory_ledger_private.display_sync_category_v1(v_key, v_pending.proposed_category_id, v_snapshot);
      -- A display-only change never re-derives the payee; the original branch below reuses v_party_id.
      v_party_id := v_pending.proposed_party_id;
      if v_pending.source_fingerprint is distinct from v_fingerprint
         or v_pending.proposed_category_id is distinct from v_category_id then
        insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
        values (p_actor_user_id, 'inventory_candidate_display_synced', 'candidate', v_pending.id, to_jsonb(v_pending),
          jsonb_build_object('source_snapshot', v_snapshot, 'source_fingerprint', v_fingerprint,
            'proposed_category_id', v_category_id, 'proposed_party_id', v_pending.proposed_party_id),
          'Inventory display-only daily sync');
        update public.ledger_candidates
        set source_snapshot = v_snapshot, source_fingerprint = v_fingerprint,
            proposed_category_id = v_category_id, updated_at = now()
        where id = v_pending.id returning * into v_pending;
      end if;
    end if;
$b1$];
    else
      anchors:=array[
        $a2$            v_code := 'METADATA_SYNCED';
          end if;
$a2$,
        $a3$  v_corrections bigint[];
$a3$];
      additions:=array[
        $b2$          -- Explicit display-only daily sync: follow the category on an unpaid open-month expense.
          if current_setting('baba.inventory_display_sync', true) = v_key then
            v_display_sync := inventory_ledger_private.sync_confirmed_display_category_v1(
              v_candidate.id, v_snapshot, v_fingerprint, p_request_actor_user_id);
            if v_display_sync->>'status' = 'rebooked' then
              v_result := v_display_sync; v_code := 'CATEGORY_REBOOKED';
            elsif v_display_sync->>'status' = 'review_required' then
              v_status := 'review_required'; v_code := v_display_sync->>'code';
            end if;
          end if;
$b2$,
        $b3$  v_display_sync jsonb;
$b3$];
    end if;
    for i in 1..array_length(anchors,1) loop
      anchors[i]:=replace(anchors[i],chr(13)||chr(10),chr(10));
      additions[i]:=replace(additions[i],chr(13)||chr(10),chr(10));
      matched_anchor:=case when crlf then replace(anchors[i],chr(10),chr(13)||chr(10)) else anchors[i] end;
      addition_eol:=case when crlf then replace(additions[i],chr(10),chr(13)||chr(10)) else additions[i] end;
      if (length(definition)-length(replace(definition,matched_anchor,'')))/length(matched_anchor)<>1 then
        raise exception 'INVENTORY_DISPLAY_SYNC_CONTRACT_MISMATCH: % anchor %',signature,i;
      end if;
      -- sync_candidate inserts before its anchor; the projection appends after its anchors.
      definition:=case when signature='inventory_ledger_private.sync_candidate(jsonb,bigint)'
        then replace(definition,matched_anchor,addition_eol||matched_anchor)
        else replace(definition,matched_anchor,matched_anchor||addition_eol) end;
    end loop;
    execute definition;
  end loop;
end;
$contract$;
alter function inventory_ledger_private.sync_candidate(jsonb,bigint) owner to postgres;
revoke all on function inventory_ledger_private.sync_candidate(jsonb,bigint) from public,anon,authenticated,service_role;
alter function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) owner to postgres;
revoke all on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) to service_role;

-- Owner/master entry point used only by /inventory/snapshots daily sync for a same-part
-- display-only target. The scope is transaction-local and bound to the original receipt.
create function public.ledger_project_inventory_display_sync_v1(p_inventory_log_id bigint,p_request_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_root_id bigint; v_result jsonb;
begin
  if not exists(select 1 from public.users where id=p_request_actor_user_id and is_active=true
    and app_login_enabled=true and lower(role::text) in ('owner','master')) then
    return jsonb_build_object('status','failed','code','FORBIDDEN');
  end if;
  select coalesce(correction_of_inventory_log_id,id) into v_root_id from public.inventory_logs where id=p_inventory_log_id;
  if v_root_id is null then return jsonb_build_object('status','failed','code','SOURCE_NOT_FOUND'); end if;
  -- Same-part guard: the original receipt, its corrections and the current item must share
  -- one part. Otherwise nothing is written and the caller keeps the part-change review path.
  if not exists(select 1 from public.inventory_logs l join public.inventory i on i.id=l.item_id
      where l.id=v_root_id and nullif(btrim(i.part),'') is not null
        and coalesce(nullif(btrim(l.part),''),nullif(btrim(l.new_part),''))=i.part
        and coalesce(nullif(btrim(l.new_part),''),nullif(btrim(l.part),''))=i.part)
     or exists(select 1 from public.inventory_logs c join public.inventory i on i.id=c.item_id
      where c.correction_of_inventory_log_id=v_root_id
        and coalesce(nullif(btrim(c.new_part),''),nullif(btrim(c.part),'')) is distinct from i.part) then
    return jsonb_build_object('status','review_required','code','DISPLAY_SYNC_PART_MISMATCH',
      'inventoryLogId',p_inventory_log_id,'createdCount',0,'supersededCount',0,'unchangedCount',0);
  end if;
  perform set_config('baba.inventory_display_sync','inventory-log:'||v_root_id,true);
  v_result:=public.ledger_project_inventory_purchase_log_v1(p_inventory_log_id,p_request_actor_user_id);
  perform set_config('baba.inventory_display_sync','',true);
  return v_result;
end;
$$;
alter function public.ledger_project_inventory_display_sync_v1(bigint,bigint) owner to postgres;
revoke all on function public.ledger_project_inventory_display_sync_v1(bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ledger_project_inventory_display_sync_v1(bigint,bigint) to service_role;
commit;
