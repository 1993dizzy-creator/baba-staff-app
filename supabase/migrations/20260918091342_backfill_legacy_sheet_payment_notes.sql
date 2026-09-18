begin;

-- Display metadata only. The legacy balances already include these payments.
do $$
declare
  target_count integer;
begin
  with notes(sheet_row, payment_note) as (
    values
      (6, '현금'), (11, '현금'), (26, '현금'), (55, '현금'),
      (85, '현금'), (137, '현금'), (240, '현금'), (267, '현금'),
      (283, '현금'), (333, '현금'), (358, '현금'), (395, '현금'),
      (420, '현금'), (421, '현금'),
      (179, '법인'), (296, '법인'),
      (198, 'tk(cho)'), (309, 'tk(cho)'), (342, 'tk(cho)'),
      (292, 'tài khoản')
  )
  select count(*) into target_count
  from public.ledger_transactions t
  join notes n on t.source_snapshot->>'row' = n.sheet_row::text
  where t.source_type = 'legacy_sheet_detail'
    and t.source_snapshot->>'sheet' = '(2026)BABA - Sổ dự án'
    and t.source_snapshot->>'tab' = '8월'
    and t.source_snapshot->>'fundMovementApplied' = 'false'
    and not (t.source_snapshot ? 'paymentNote');

  if target_count <> 20 then
    raise exception 'Expected 20 legacy payment-note targets, found %', target_count;
  end if;

  with notes(sheet_row, payment_note) as (
    values
      (6, '현금'), (11, '현금'), (26, '현금'), (55, '현금'),
      (85, '현금'), (137, '현금'), (240, '현금'), (267, '현금'),
      (283, '현금'), (333, '현금'), (358, '현금'), (395, '현금'),
      (420, '현금'), (421, '현금'),
      (179, '법인'), (296, '법인'),
      (198, 'tk(cho)'), (309, 'tk(cho)'), (342, 'tk(cho)'),
      (292, 'tài khoản')
  )
  update public.ledger_transactions t
  set source_snapshot = t.source_snapshot || jsonb_build_object('paymentNote', n.payment_note)
  from notes n
  where t.source_snapshot->>'row' = n.sheet_row::text
    and t.source_type = 'legacy_sheet_detail'
    and t.source_snapshot->>'sheet' = '(2026)BABA - Sổ dự án'
    and t.source_snapshot->>'tab' = '8월'
    and t.source_snapshot->>'fundMovementApplied' = 'false'
    and not (t.source_snapshot ? 'paymentNote');
end $$;

commit;
