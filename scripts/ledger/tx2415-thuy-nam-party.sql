-- TX#2415 (2026-10-02 돼지고기 현금 구매 500,000₫) → ledger party #35 THỦY NAM.
-- RUN ONLY WITH EXPLICIT APPROVAL, in the Supabase SQL Editor, as one statement batch.
--
-- Changes exactly one column of one row: ledger_transactions.party_id NULL → 35 (+ updated_at),
-- and writes one audit row. Amount, type, date, category (육류 #42), memo, title, status and the
-- cash movement #1235 (store_cash −500,000) are asserted unchanged before commit.
-- Idempotent: a second run finds party_id = 35 and changes nothing (no second audit row).
-- Refuses if the row, the party or October differ from what was reviewed (2026-10-28 read-only).
-- Actor recorded in the audit row: user #1 (active master).
-- Rollback (only if approved): set party_id back to NULL the same way with its own audit row.

begin;
set local lock_timeout = '5s';

do $$
declare
  v_before public.ledger_transactions%rowtype;
  v_after public.ledger_transactions%rowtype;
  v_movements jsonb;
  v_movements_after jsonb;
begin
  -- Same month lock as the manual edit RPCs, then the row.
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:2026-10'));
  select * into v_before from public.ledger_transactions where id = 2415 for update;
  if not found then raise exception 'TX2415_NOT_FOUND'; end if;

  if v_before.party_id = 35 then
    raise notice 'TX2415_ALREADY_LINKED: party_id is already 35, nothing changed';
    return;
  end if;

  if v_before.type <> 'expense' or v_before.status <> 'confirmed' or v_before.source_type <> 'manual'
     or v_before.business_date <> date '2026-10-02' or v_before.recognition_month <> date '2026-10-01'
     or v_before.amount <> 500000 or v_before.category_id <> 42 or v_before.party_id is not null
     or v_before.correction_of_id is not null then
    raise exception 'TX2415_PRECONDITION: row differs from the reviewed state';
  end if;
  if not exists (select 1 from public.ledger_parties where id = 35 and is_active and name = 'THỦY NAM') then
    raise exception 'TX2415_PRECONDITION: party #35 THỦY NAM not active';
  end if;
  if public.ledger_month_is_closed_v1(date '2026-10-01') then
    raise exception 'TX2415_PRECONDITION: 2026-10 is closed';
  end if;
  if exists (select 1 from public.ledger_payables where expense_transaction_id = 2415)
     or exists (select 1 from public.ledger_payable_allocations where payment_transaction_id = 2415) then
    raise exception 'TX2415_PRECONDITION: payable or payment link exists';
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb) into v_movements
    from public.ledger_movements m where m.transaction_id = 2415;
  if v_movements <> jsonb_build_array(jsonb_build_object('id', 1235, 'transaction_id', 2415, 'fund_account_id', 1,
       'amount', -500000.000, 'created_at', v_movements -> 0 -> 'created_at')) then
    raise exception 'TX2415_PRECONDITION: movement differs (%).', v_movements;
  end if;

  update public.ledger_transactions set party_id = 35, updated_at = now() where id = 2415 returning * into v_after;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb) into v_movements_after
    from public.ledger_movements m where m.transaction_id = 2415;
  if v_movements_after <> v_movements
     or (to_jsonb(v_after) - 'party_id' - 'updated_at') <> (to_jsonb(v_before) - 'party_id' - 'updated_at') then
    raise exception 'TX2415_POSTCONDITION: something other than party_id changed';
  end if;

  insert into public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason)
  values (1, 'manual_transaction_party_linked', 'transaction', 2415,
    jsonb_build_object('transaction', to_jsonb(v_before), 'movements', v_movements),
    jsonb_build_object('transaction', to_jsonb(v_after), 'movements', v_movements_after, 'changedFields', jsonb_build_array('partyId')),
    '10/2 돼지고기 현금 구매 거래처 THỦY NAM(ledger party #35) 확인 연결');
end
$$;

-- Expect: party_id 35, amount 500000, movement #1235 store_cash −500000, one 'manual_transaction_party_linked' audit row.
select t.id, t.party_id, p.name, t.amount, t.status, t.business_date, t.category_id,
  (select jsonb_agg(jsonb_build_object('id', m.id, 'account', m.fund_account_id, 'amount', m.amount)) from public.ledger_movements m where m.transaction_id = t.id) as movements,
  (select count(*) from public.ledger_audit_logs a where a.entity_type = 'transaction' and a.entity_id = t.id and a.action = 'manual_transaction_party_linked') as link_audits
from public.ledger_transactions t left join public.ledger_parties p on p.id = t.party_id
where t.id = 2415;

commit;
