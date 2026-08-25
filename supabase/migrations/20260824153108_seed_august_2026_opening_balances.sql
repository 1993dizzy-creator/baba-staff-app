-- 2026-08 is the first Ledger operational month.
-- Opening balances are seeded from the finalized July closing / August opening values
-- in the legacy (2026)BABA - Sổ dự án sheet.

do $$
declare
  v_actor_id bigint;
  r record;
  v_account_id bigint;
  v_transaction_id bigint;
begin
  select id into v_actor_id
  from public.users
  where is_active=true and app_login_enabled=true and lower(role::text) in ('owner','master')
  order by case when lower(role::text)='owner' then 0 else 1 end, id
  limit 1;

  if v_actor_id is null then
    raise exception 'active owner/master actor required for opening balance seed';
  end if;

  for r in
    select * from (values
      ('store_cash'::text, 95464986::numeric),
      ('vuong_personal_custody'::text, 5231310::numeric),
      ('cho_personal_custody'::text, 95470741::numeric),
      ('baba_corporate_bank'::text, 104186605::numeric)
    ) as x(account_code, opening_amount)
  loop
    select id into v_account_id
    from public.ledger_fund_accounts
    where code=r.account_code and is_active=true;

    if v_account_id is null then
      raise exception 'opening balance account missing: %', r.account_code;
    end if;

    select id into v_transaction_id
    from public.ledger_transactions
    where source_type='opening_balance_seed'
      and source_key='2026-08-01:'||r.account_code;

    if v_transaction_id is null then
      insert into public.ledger_transactions(
        operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,
        status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by
      ) values (
        gen_random_uuid(),'opening',timestamptz '2026-08-01 03:00:00+07',date '2026-08-01',null,
        r.opening_amount,null,null,'confirmed','opening_balance_seed','2026-08-01:'||r.account_code,
        jsonb_build_object(
          'basis','legacy_sheet_closing_balance',
          'sheet','(2026)BABA - Sổ dự án',
          'sheet_month','2026-08',
          'opening_date','2026-08-01',
          'fund_account_code',r.account_code,
          'opening_amount',r.opening_amount
        ),
        md5('opening_balance_seed:2026-08-01:'||r.account_code||':'||r.opening_amount::text),
        now(),
        '2026년 8월 당월 시재 초기값',v_actor_id,v_actor_id
      ) returning id into v_transaction_id;

      insert into public.ledger_movements(transaction_id,fund_account_id,amount)
      values(v_transaction_id,v_account_id,r.opening_amount);

      insert into public.ledger_audit_logs(
        actor_user_id,action,entity_type,entity_id,after_snapshot,reason
      ) values (
        v_actor_id,'opening_balance_seeded','transaction',v_transaction_id,
        jsonb_build_object('fundAccountId',v_account_id,'accountCode',r.account_code,'amount',r.opening_amount),
        '2026년 8월 최초 장부 전환: 7월 마감 후 이월 시재'
      );
    end if;
  end loop;
end;
$$;
