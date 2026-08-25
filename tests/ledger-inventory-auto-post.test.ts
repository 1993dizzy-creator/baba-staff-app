import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql=readFileSync("supabase/migrations/202608250002_auto_post_inventory_purchases.sql","utf8");
const page=readFileSync("app/(protected)/admin/ledger/entries/page.tsx","utf8");
const syncRoute=readFileSync("app/api/admin/ledger/inventory-candidates/sync/route.ts","utf8");

test("inventory sync keeps its signature, security and service-only grant",()=>{
  assert.match(sql,/ledger_sync_inventory_candidates_v1\(\s*p_rows jsonb,\s*p_actor_user_id bigint/);
  assert.match(sql,/security definer\s+set search_path = pg_catalog, public/);
  assert.match(sql,/alter function public\.ledger_sync_inventory_candidates_v1\(jsonb, bigint\) owner to postgres/);
  assert.match(sql,/revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(sql,/grant execute[\s\S]*to service_role/);
});

test("complete immediate and postpaid candidates reuse the audited single resolver",()=>{
  assert.match(sql,/payment_mode = 'immediate'[\s\S]*ledger_resolve_inventory_candidate_v1\([\s\S]*'immediate'/);
  assert.match(sql,/business_partner_fund_account_is_eligible_v1/);
  assert.match(sql,/else\s+v_result := public\.ledger_resolve_inventory_candidate_v1\(\s*v_pending\.id, 'payable'/);
  assert.match(sql,/v_pending\.business_date \+ v_business_partner\.default_payment_term_days/);
  assert.match(sql,/'autoConfirmedImmediateCount'[\s\S]*'autoConfirmedPayableCount'[\s\S]*'pendingReviewCount'/);
});

test("incomplete mappings remain pending and same-fingerprint pending rows reach auto resolution",()=>{
  assert.match(sql,/v_pending\.proposed_category_id is null[\s\S]*v_pending\.proposed_party_id is null[\s\S]*v_pending_review/);
  const same=sql.indexOf("v_pending.source_fingerprint = v_fingerprint");
  const sameBranchEnd=sql.indexOf("    else",same);
  const resolver=sql.indexOf("ledger_resolve_inventory_candidate_v1",same);
  assert.ok(same>=0&&sameBranchEnd>same&&resolver>sameBranchEnd);
  assert.doesNotMatch(sql.slice(same,sameBranchEnd),/continue;/);
  assert.match(sql,/v_latest\.status = 'confirmed'[\s\S]*source_fingerprint = v_fingerprint[\s\S]*v_unchanged[\s\S]*continue/);
});

test("changed confirmed source aborts the whole sync and API maps it to conflict",()=>{
  assert.match(sql,/v_latest\.status = 'confirmed'[\s\S]*raise exception using\s+errcode = '55000',\s+message = 'SOURCE_CHANGED_AFTER_POST'/);
  assert.match(syncRoute,/inventorySyncDbError\(error\)[\s\S]*mapped\.code[\s\S]*mapped\.status/);
  assert.match(syncRoute,/messages\.includes\("SOURCE_CHANGED_AFTER_POST"\)[\s\S]*code: "SOURCE_CHANGED_AFTER_POST", status: 409/);
  assert.match(syncRoute,/INVENTORY_CANDIDATE_SYNC_FAILED/);
});

test("dismissed changed source creates a separate pending review before skipping resolver",()=>{
  assert.match(sql,/v_latest\.status = 'dismissed'[\s\S]*source_fingerprint = v_fingerprint[\s\S]*v_unchanged[\s\S]*continue/);
  assert.match(sql,/v_latest\.status = 'dismissed'[\s\S]*v_force_review := true/);
  const dismissed=sql.indexOf("v_latest.status = 'dismissed'");
  const insert=sql.indexOf("insert into public.ledger_candidates",dismissed);
  const forceReview=sql.indexOf("if v_force_review then",insert);
  const resolver=sql.indexOf("ledger_resolve_inventory_candidate_v1",forceReview);
  assert.ok(dismissed>=0&&insert>dismissed&&forceReview>insert&&resolver>forceReview);
  assert.match(sql.slice(insert,forceReview),/'inventory_purchase'[\s\S]*v_snapshot, v_fingerprint[\s\S]*returning \* into v_pending/);
  assert.match(sql.slice(forceReview,resolver),/v_pending_review := v_pending_review \+ 1;\s+continue/);
  assert.doesNotMatch(sql,/where id = v_latest\.id/);
});

test("dismissed changed pending remains review-only on the second and later sync",()=>{
  assert.match(sql,/v_latest\.status = 'pending'\s+and exists \(\s+select 1\s+from public\.ledger_candidates history/);
  assert.match(sql,/history\.source_type = v_latest\.source_type[\s\S]*history\.source_key = v_latest\.source_key[\s\S]*history\.id < v_latest\.id/);
  assert.match(sql,/history\.status = 'dismissed'[\s\S]*history\.source_fingerprint is distinct from v_latest\.source_fingerprint[\s\S]*v_force_review := true/);

  type Candidate={id:number;status:"dismissed"|"pending";fingerprint:string};
  const forceReview=(latest:Candidate,history:Candidate[])=>latest.status==="pending"&&history.some(row=>row.id<latest.id&&row.status==="dismissed"&&row.fingerprint!==latest.fingerprint);
  const rows:Candidate[]=[{id:1,status:"dismissed",fingerprint:"A"}];
  const firstChangedFingerprint="B";
  rows.push({id:2,status:"pending",fingerprint:firstChangedFingerprint});
  const secondSyncLatest=rows.at(-1)!;
  assert.equal(forceReview(secondSyncLatest,rows),true);
  assert.equal(secondSyncLatest.status,"pending");
  assert.equal(rows[0].status,"dismissed");
  const counters={autoConfirmedImmediateCount:0,autoConfirmedPayableCount:0,pendingReviewCount:0};
  if(forceReview(secondSyncLatest,rows))counters.pendingReviewCount+=1;
  assert.deepEqual(counters,{autoConfirmedImmediateCount:0,autoConfirmedPayableCount:0,pendingReviewCount:1});
});

test("invalid input raises instead of returning after earlier row mutations",()=>{
  assert.doesNotMatch(sql,/return jsonb_build_object\('status', 'invalid_rows'\)/);
  assert.match(sql,/p_rows is null[\s\S]*errcode = '22023',[\s\S]*message = 'INVALID_ROWS'/);
  assert.match(sql,/exception when others then\s+raise exception using\s+errcode = '22023',\s+message = 'INVALID_ROWS'/);
  assert.match(sql,/or v_amount <= 0 then\s+raise exception using\s+errcode = '22023',\s+message = 'INVALID_ROWS'/);
  assert.match(syncRoute,/messages\.includes\("INVALID_ROWS"\)[\s\S]*code: "INVALID_ROWS", status: 400/);
});

test("every required inventory source field has an explicit null guard",()=>{
  for(const variable of ["v_key","v_fingerprint","v_snapshot","v_date","v_amount"]){
    assert.match(sql,new RegExp(`${variable} is null`));
  }
  assert.match(sql,/v_amount is null[\s\S]*or v_key !~ '\^inventory-log:\[0-9\]\+\$'[\s\S]*or length\(v_fingerprint\) <> 64[\s\S]*or jsonb_typeof\(v_snapshot\) <> 'object'[\s\S]*or v_amount <= 0 then[\s\S]*message = 'INVALID_ROWS'/);
});

test("immediate fund account is eligible on the candidate business date",()=>{
  assert.match(sql,/account\.active_from <= v_pending\.business_date/);
  assert.match(sql,/account\.active_to is null or account\.active_to >= v_pending\.business_date/);
  assert.match(sql,/account\.is_active = true[\s\S]*account\.is_business_fund = true[\s\S]*account\.type <> 'card_clearing'/);
  assert.match(sql,/not exists \([\s\S]*ledger_fund_accounts[\s\S]*v_pending_review := v_pending_review \+ 1;\s+continue/);
});

test("opening balance and payable selection UI preserve one-request allocation payment",()=>{
  assert.match(page,/aria-expanded=\{openingExpanded\}/);
  assert.match(page,/useState\(false\)/);
  assert.match(page,/\/api\/admin\/ledger\/payables\/\$\{party\.partyId\}/);
  assert.match(page,/selectedDates\.has\(group\.businessDate\)/);
  assert.match(page,/fetch\("\/api\/admin\/ledger\/payables\/pay"/);
  assert.match(page,/allocations:selectedPayables\.map/);
  assert.match(page,/allocatedAmount:row\.outstandingAmount/);
  assert.doesNotMatch(page,/for\s*\([^)]*payable[^)]*\)[\s\S]{0,120}fetch/);
  for(const label of ["미납금 요약","Tổng hợp công nợ","선택 미납금","Công nợ đã chọn","출금 계정","Tài khoản chi"]) assert.match(page,new RegExp(label));
});
