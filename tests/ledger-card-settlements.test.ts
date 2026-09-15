import test from"node:test";import assert from"node:assert/strict";import{readFileSync}from"node:fs";
import { createRequire } from "node:module";
const { calculateCardGross, calculateCardDepositSummary, recommendCardAllocations, buildEditableCardSales } = createRequire(import.meta.url)("../lib/ledger/card-settlements.ts") as typeof import("../lib/ledger/card-settlements");
const migration=readFileSync("supabase/migrations/202608210006_add_ledger_card_settlements.sql","utf8"),cancellationMigration=readFileSync("supabase/migrations/20260915093246_add_card_reconciliation_cancellation.sql","utf8"),api=readFileSync("app/api/admin/ledger/card-settlements/route.ts","utf8"),detailApi=readFileSync("app/api/admin/ledger/card-settlements/[id]/route.ts","utf8"),matchApi=readFileSync("app/api/admin/ledger/card-settlements/[id]/match/route.ts","utf8"),cancelApi=readFileSync("app/api/admin/ledger/card-settlements/[id]/cancel/route.ts","utf8"),ui=readFileSync("app/(protected)/admin/ledger/card-settlements/page.tsx","utf8"),snapshot=readFileSync("lib/ledger/month-close.ts","utf8"),posMigration=readFileSync("supabase/migrations/202608210002_add_ledger_pos_sales_sync.sql","utf8"),posSource=readFileSync("lib/ledger/pos-sales.ts","utf8"),foundation=readFileSync("tests/ledger-v1-foundation.test.ts","utf8"),inventory=readFileSync("tests/ledger-inventory-candidates.test.ts","utf8"),payable=readFileSync("tests/ledger-payable-payments.test.ts","utf8"),meal=readFileSync("tests/ledger-meal-payroll.test.ts","utf8");
test("card deposit registration RPC",()=>assert.match(api,/ledger_create_card_deposit_v1/));
test("deposit subtracts card pending",()=>assert.match(migration,/v_transaction,v_clearing,-p_amount/));
test("deposit adds destination bank",()=>assert.match(migration,/v_transaction,p_destination_account_id,p_amount/));
test("card deposit is not income",()=>assert.match(migration,/values\(v_operation,'card_settlement_deposit'/));
test("new deposit is unmatched",()=>assert.match(migration,/default 'unmatched'/));
test("partial status is supported",()=>assert.match(migration,/else'partial'end/));
test("matched status is supported",()=>assert.match(migration,/status='matched'/));
test("one deposit supports several sales",()=>assert.match(migration,/jsonb_array_elements\(p_allocations\)/));
test("one sale supports several deposits",()=>assert.match(migration,/r.id<>v_rec.id/));
test("gross overallocation is rejected",()=>assert.match(migration,/gross_overallocated/));
test("allocations are keyed by reconciliation and sale",()=>assert.match(migration,/unique\(reconciliation_id,pos_card_transaction_id\)/));
test("gross below deposit cannot complete",()=>assert.match(migration,/gross_below_deposit/));
test("five million less 4.91 million is 90 thousand",()=>assert.equal(5_000_000-4_910_000,90_000));
test("difference expense is created",()=>assert.match(migration,/'expense_recognition'[\s\S]*v_diff/));
test("difference additionally subtracts pending",()=>assert.match(migration,/v_diff_tx,v_clearing,-v_diff/));
test("difference has one unique source key",()=>assert.match(migration,/card-reconciliation:'\|\|v_rec.id\|\|':difference/));
test("expected fee is only an editable recommendation input, never persisted",()=>{assert.match(ui,/useState\("1\.8"\)/);assert.doesNotMatch(migration+api+matchApi,/expectedFee|expectedFeeRate/)});
test("rate uses completed reconciliation only",()=>assert.match(readFileSync("lib/ledger/card-settlements.ts","utf8"),/row.status === "matched"/));
test("unmatched and partial do not enter rate",()=>assert.match(readFileSync("lib/ledger/card-settlements.ts","utf8"),/monthlyCompletedDifference \/ monthlyCompletedGross/));
test("card sales lock in id order",()=>assert.match(migration,/id=any\(v_ids\) order by id for update/));
test("matching is one atomic RPC",()=>assert.match(matchApi,/ledger_match_card_reconciliation_v1/));
test("pending balance is validated",()=>assert.match(migration,/insufficient_card_pending/));
test("POS card transaction is read only",()=>assert.doesNotMatch(migration,/update public\.ledger_transactions set[^;]+pos_sales_daily_payment/i));
test("POS source is never mutated",()=>assert.doesNotMatch(api+matchApi,/from\("pos_sales_[^"]+"\)\.(insert|update|delete)/));
test("all endpoints use owner master server gate",()=>{for(const route of[api,matchApi,cancelApi])assert.match(route,/requireLedgerActor/)});
test("POS parity remains",()=>assert.match(posSource,/loadPosLedgerParity/));
test("Inventory regression remains",()=>assert.match(inventory,/purchase inventory log becomes a candidate/));
test("Payable regression remains",()=>assert.match(payable,/one payment allocates to multiple payables/));
test("Meal Payroll regression remains",()=>assert.match(meal,/company cost parity/));
test("Foundation balance and profit regression remains",()=>assert.match(foundation,/balances accumulate only confirmed signed movements/));
test("card clearing mapping remains",()=>assert.match(posMigration,/\('card','card_clearing'\)/));
test("new tables enable RLS and deny browser CRUD",()=>{assert.match(migration,/ledger_card_reconciliations enable row level security/);assert.match(migration,/revoke all on table[^;]+from public,anon,authenticated,service_role/)});
test("RPC execution is service role only",()=>{assert.match(migration,/revoke all on function public\.ledger_match_card_reconciliation_v1[^;]+from public,anon,authenticated/);assert.match(migration,/grant execute on function public\.ledger_match_card_reconciliation_v1[^;]+to service_role/)});
test("audit preserves deposit and settlement facts",()=>{for(const fact of["depositTransactionId","bankAccountId","depositAmount","allocations","matchedGrossAmount","differenceAmount","beforePendingBalance","afterPendingBalance","status"])assert.match(migration,new RegExp(fact))});
test("cancellation metadata preserves confirmed facts and requires a nonblank reason",()=>{
  for(const field of["cancelled_at","cancelled_by","cancel_reason"])assert.match(cancellationMigration,new RegExp(field));
  assert.match(cancellationMigration,/status = 'cancelled'[\s\S]*confirmed_at is not null[\s\S]*difference_amount = matched_gross_amount - deposit_amount/);
  assert.match(cancellationMigration,/status = 'cancelled'[\s\S]*nullif\(btrim\(cancel_reason\), ''\) is not null/);
  assert.match(cancellationMigration,/cancelled_by bigint null references public\.users\(id\) on delete restrict/);
});
test("cancel RPC is service-role-only, security definer, and reason-gated",()=>{
  const fn=cancellationMigration.slice(cancellationMigration.indexOf("create function public.ledger_cancel_card_reconciliation_v1"),cancellationMigration.indexOf("create or replace function public.ledger_close_preflight_v1"));
  assert.match(fn,/security definer[\s\S]*set search_path = pg_catalog, public/);assert.match(fn,/nullif\(btrim\(p_reason\), ''\) is null/);
  assert.match(cancellationMigration,/revoke all on function public\.ledger_cancel_card_reconciliation_v1[^;]+from public, anon, authenticated/);
  assert.match(cancellationMigration,/grant execute on function public\.ledger_cancel_card_reconciliation_v1[^;]+to service_role/);
});
test("cancel is append-only, reverses deposit and optional difference, and preserves lines",()=>{
  const fn=cancellationMigration.slice(cancellationMigration.indexOf("create function public.ledger_cancel_card_reconciliation_v1"),cancellationMigration.indexOf("create or replace function public.ledger_close_preflight_v1"));
  assert.doesNotMatch(fn,/delete from public\.ledger_(transactions|movements|card_reconciliation_lines)/i);
  assert.doesNotMatch(fn,/update public\.ledger_transactions/i);
  assert.match(fn,/card_settlement_deposit_reversal/);assert.match(fn,/card_settlement_difference_reversal/);
  assert.match(fn,/select v_deposit_reversal_id, fund_account_id, -amount/);assert.match(fn,/select v_difference_reversal_id, fund_account_id, -amount/);
  assert.match(fn,/v_difference\.id is not null[\s\S]*economic_effect_sign[\s\S]*-1/);
  assert.match(fn,/correction_of_id[\s\S]*v_original\.id/);assert.match(fn,/correction_of_id[\s\S]*v_difference\.id/);
  assert.match(fn,/preservedLineCount/);
});
test("cancellation validates originals and is row-locked and idempotent",()=>{
  const fn=cancellationMigration.slice(cancellationMigration.indexOf("create function public.ledger_cancel_card_reconciliation_v1"),cancellationMigration.indexOf("create or replace function public.ledger_close_preflight_v1"));
  for(const marker of["v_original.status <> 'confirmed'","v_original.type <> 'card_settlement_deposit'","v_original.source_type <> 'card_settlement_deposit'","v_deposit_movement_count <> 2","v_difference_count <> 1","for update","already_cancelled"])assert.match(fn,new RegExp(marker));
  assert.match(fn,/card-reconciliation:' \|\| v_rec\.id \|\| ':deposit-reversal'/);assert.match(fn,/card-reconciliation:' \|\| v_rec\.id \|\| ':difference-reversal'/);
});
test("create match and cancel share month-close then clearing lock order",()=>{
  for(const name of["ledger_create_card_deposit_v1","ledger_match_card_reconciliation_v1","ledger_cancel_card_reconciliation_v1"]){
    const start=cancellationMigration.indexOf(name),end=cancellationMigration.indexOf("$$;",start),fn=cancellationMigration.slice(start,end);
    const monthLock=fn.indexOf("ledger_month_close:"),closed=fn.indexOf("ledger_month_is_closed_v1"),clearing=fn.indexOf("ledger_card_clearing_balance");
    assert.ok(monthLock>=0&&monthLock<closed&&closed<clearing,name);
  }
});
test("preflight blocks incomplete deposits and ignores cancelled allocation history",()=>{
  const fn=cancellationMigration.slice(cancellationMigration.indexOf("create or replace function public.ledger_close_preflight_v1"));
  assert.match(fn,/r\.status in \('unmatched', 'partial'\)[\s\S]*date_trunc\('month', r\.deposit_date\)::date = p_month[\s\S]*v_blockers[\s\S]*'CARD_UNMATCHED'/);
  assert.match(fn,/join public\.ledger_card_reconciliations r on r\.id = l\.reconciliation_id and r\.status <> 'cancelled'/);
  assert.match(snapshot,/row\.status!=="cancelled"&&!asOfMatchedIds\.has/);
  assert.match(snapshot,/eq\("reconciliation\.status","matched"\)/);
});
test("list and detail APIs retain cancelled rows and expose cancellation audit metadata",()=>{
  assert.doesNotMatch(api,/\.neq\("status",\s*"cancelled"\)/);assert.match(api,/totalHistoryCount/);assert.match(api,/totalCancelledCount/);
  for(const field of["cancelled_at","cancelled_by","cancel_reason"])assert.match(api+detailApi,new RegExp(field));
});

const cardSale = (id=1, amount=1000, business_date="2026-08-15") => ({ id, amount, business_date });
const cardLine = (amount=1000, status="matched", id=1) => ({ reconciliation_id: 1, pos_card_transaction_id: id, allocated_gross_amount: amount, reconciliation: { status } });
const gross = (sales=[cardSale()], lines:ReturnType<typeof cardLine>[] = []) => calculateCardGross(sales, lines, "2026-08-01", "2026-09-01");
test("A: no allocation leaves all monthly card gross unreconciled", () => {
  const result=gross();assert.equal(result.monthlyCardGross,1000);assert.equal(result.monthlyReconciledGross,0);assert.equal(result.monthlyUnreconciledGross,1000);
});
test("B and C: later deposit allocates gross, not net deposit, against originating month", () => {
  const result=gross([cardSale()],[cardLine()]);assert.equal(result.monthlyReconciledGross,1000);assert.equal(result.monthlyUnreconciledGross,0);
  const rec={id:1,deposit_date:"2026-09-10",deposit_amount:982,matched_gross_amount:1000,difference_amount:18,status:"matched"};
  assert.equal(calculateCardDepositSummary([rec],"2026-08-01","2026-09-01").actualCardDeposits,0);
  const september=calculateCardDepositSummary([rec],"2026-09-01","2026-10-01");assert.equal(september.actualCardDeposits,982);assert.equal(september.monthlyCompletedDifference,18);assert.equal(september.actualDifferenceRate,0.018);
});
test("D: cancelled reconciliation never allocates gross", () => assert.equal(gross([cardSale()],[cardLine(1000,"cancelled")]).monthlyUnreconciledGross,1000));
test("E: partial allocation reduces outstanding by exactly its gross", () => assert.equal(gross([cardSale()],[cardLine(400,"partial")]).monthlyUnreconciledGross,600));
test("sale-month completed gross excludes partial saves while connected gross includes them",()=>{
  const result=gross([cardSale()],[cardLine(400,"partial"),cardLine(300,"matched")]);assert.equal(result.monthlyReconciledGross,700);assert.equal(result.monthlySettledGross,300);assert.equal(result.monthlyUnreconciledGross,300);
});
test("F: allocations of other months never enter selected sale month", () => {
  const result=gross([cardSale(),cardSale(2,2000,"2026-09-01")],[cardLine(2000,"matched",2)]);assert.equal(result.monthlyReconciledGross,0);assert.equal(result.monthlyUnreconciledGross,1000);assert.equal(result.totalUnreconciledGross,1000);
});
test("gross is floored per sale, so overallocated rows never mask other outstanding", () => {
  const result=gross([cardSale(),cardSale(2)],[cardLine(1500)]);assert.equal(result.monthlyReconciledGross,1000);assert.equal(result.monthlyUnreconciledGross,1000);
});
test("multiple allocations maintain three decimal places", () => {
  const result=gross([cardSale(1,1.003)],[cardLine(0.1),cardLine(0.2),cardLine(0.001)]);assert.equal(result.monthlyReconciledGross,0.301);assert.equal(result.monthlyUnreconciledGross,0.702);
});
test("deposit summary scopes unmatched and completed metrics by deposit date, excludes cancelled", () => {
  const rec=(id:number,status:string,deposit_date="2026-09-10")=>({id,status,deposit_date,deposit_amount:982,matched_gross_amount:1000,difference_amount:status==="matched"?18:0});
  const result=calculateCardDepositSummary([rec(1,"matched"),rec(2,"partial"),rec(3,"unmatched"),rec(4,"cancelled"),rec(5,"matched","2026-08-31")],"2026-09-01","2026-10-01");
  assert.equal(result.actualCardDeposits,2946);assert.equal(result.monthlyUnmatchedDeposits,1964);assert.equal(result.monthlyCompletedGross,1000);assert.equal(result.monthlyCompletedDeposit,982);assert.equal(result.monthlyCompletedDifference,18);assert.equal(result.actualDifferenceRate,0.018);
});
test("recommendation reaches fee-adjusted gross and partially allocates the final oldest sale", () => {
  const sales=[{id:3,business_date:"2026-09-01",outstandingGrossAmount:2000},{id:2,business_date:"2026-08-01",outstandingGrossAmount:1000},{id:1,business_date:"2026-08-01",outstandingGrossAmount:600}];
  const result=recommendCardAllocations(sales,982,0.018);assert.equal(result.targetGross,1000);assert.equal(result.unallocatedGross,0);assert.deepEqual(result.allocations,[{transactionId:1,allocatedGrossAmount:600},{transactionId:2,allocatedGrossAmount:400}]);assert.equal(sales[0].id,3);
});
test("recommendation respects capacities, zero fee, rounding and invalid rates", () => {
  const sales=[{id:1,business_date:"2026-08-01",outstandingGrossAmount:500}];
  assert.equal(recommendCardAllocations(sales,982,0.018).unallocatedGross,500);
  assert.equal(recommendCardAllocations(sales,100,0).targetGross,100);
  assert.ok(recommendCardAllocations(sales,100,0.017).targetGross>=100/(1-0.017));
  for(const rate of [-0.01,1,NaN,Infinity])assert.throws(()=>recommendCardAllocations(sales,982,rate));
});
test("editing partial matches restores own allocation capacity including exhausted candidates", () => {
  const candidate={...cardSale(),allocatedGrossAmount:400,outstandingGrossAmount:600};
  const own={pos_card_transaction_id:1,allocated_gross_amount:300,sale:candidate};
  const restored=buildEditableCardSales([candidate],[own])[0];assert.equal(restored.allocatedGrossAmount,100);assert.equal(restored.outstandingGrossAmount,900);
  const exhausted={...cardSale(2),allocatedGrossAmount:1000,outstandingGrossAmount:0};
  const result=buildEditableCardSales([], [{pos_card_transaction_id:2,allocated_gross_amount:1000,sale:exhausted}]);assert.equal(result[0].outstandingGrossAmount,1000);assert.equal(result[0].allocatedGrossAmount,0);
});
test("dashboard accounting income and historical payable card remain intact", () => {
  const dashboard=readFileSync("app/(protected)/admin/ledger/page.tsx","utf8");
  assert.match(dashboard,/money\(data.summary.income\)/);assert.match(dashboard,/data.summary.unreconciledCardGross/);assert.match(dashboard,/월말 미지급금/);assert.match(dashboard,/payables\?month=\$\{month\}/);assert.match(dashboard,/setOutstanding\(payables.summary.closingOutstanding\)/);
});
test("UI retains manual allocations and POS detail and adds guarded cancellation controls", () => {
  assert.match(ui,/setAllocations\(current/);assert.match(ui,/pos-drilldown/);assert.match(ui,/정산 차액률/);assert.match(ui,/부분 저장/);
  assert.match(ui,/정산 취소/);assert.match(ui,/취소 사유/);assert.match(ui,/취소 확정/);assert.match(ui,/\/cancel/);assert.match(ui,/status==="cancelled"/);
  assert.match(ui,/카드 입금 이동과 정산 차액을 역분개하고 연결된 카드매출을 다시 미정산 상태로 돌립니다/);
  assert.match(ui,/working\|\|!cancelReason\.trim\(\)/);
});
