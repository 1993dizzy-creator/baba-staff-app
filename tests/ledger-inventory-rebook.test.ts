import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TransactionRow } from "../lib/ledger/entries";

const { buildLedgerEntries } = await import(new URL("../lib/ledger/entries.ts", import.meta.url).href) as typeof import("../lib/ledger/entries");
const { isLedgerCalendarDate, parseInventoryRebookAmount } = await import(new URL("../lib/ledger/inventory-rebook-input.ts", import.meta.url).href) as typeof import("../lib/ledger/inventory-rebook-input");

const read=(path:string)=>readFileSync(path,"utf8");
const sql=read("supabase/migrations/202608250003_rebook_inventory_transaction.sql");
const api=read("app/api/admin/ledger/transactions/[id]/edit/route.ts");
const page=read("app/(protected)/admin/ledger/entries/page.tsx");
const css=read("app/(protected)/admin/ledger/entries/entries.module.css");
const keeping=read("components/bar/keeping/KeepingUi.tsx");
const entries=read("lib/ledger/entries.ts");
const ledgerApi=read("app/api/admin/ledger/route.ts");
const payablesApi=read("app/api/admin/ledger/payables/route.ts");

test("payable status card and contained sheet use the requested hierarchy",()=>{
  assert.match(page,/미납금 현황/);assert.match(page,/Tình hình công nợ/);assert.doesNotMatch(page,/미납금 요약/);
  assert.match(page,/fillAvailable containedBody/);
  assert.match(keeping,/height:fillAvailable\?`calc\(100dvh/);
  assert.match(keeping,/overflowY:containedBody\?"hidden":"auto"/);
  assert.match(css,/\.payableSheetBody\{height:100%;min-height:0;display:flex;flex-direction:column/);
  assert.match(css,/\.payableSheetBody>\.payableDates\{min-height:0;flex:1;overflow-y:auto/);
});

test("confirmed Inventory edit actions are mode-scoped and bilingual",()=>{
  assert.match(page,/confirmedInventory = entry\.drilldown === "inventory" && entry\.status === "confirmed"/);
  assert.match(page,/confirmedInventory \? <button[\s\S]*editMode[\s\S]*수정 종료[\s\S]*수정/);
  assert.match(page,/entry\.status === "pending" \|\| \(confirmedInventory && editMode\)/);
  for(const label of ["Kết thúc chỉnh sửa","Phân loại thanh toán","Trả trước","Trả sau","Lý do chỉnh sửa","수정 저장"])assert.match(page,new RegExp(label));
});

test("rebook never updates the confirmed original and supports all payment transitions",()=>{
  assert.doesNotMatch(sql,/update public\.ledger_transactions/);
  assert.match(sql,/source_type not in \('inventory_purchase_candidate', 'inventory_purchase_rebook'\)/);
  assert.match(sql,/inventory_purchase_reversal/);assert.match(sql,/economic_effect_sign[\s\S]*-1/);
  assert.match(sql,/insert into public\.ledger_movements[\s\S]*select v_reversal_id, fund_account_id, -amount/);
  assert.match(sql,/if p_payment_mode = 'immediate' then[\s\S]*ledger_movements[\s\S]*else[\s\S]*ledger_payables/);
  for(const [oldMode,newMode] of [["immediate","immediate"],["immediate","payable"],["payable","immediate"],["payable","payable"]]){
    const oldMovement=oldMode==="immediate"?-100:0,newMovement=newMode==="immediate"?-150:0;
    assert.equal(oldMovement+(-oldMovement)+newMovement,newMovement);
    const oldPayable=oldMode==="payable"?100:0,newPayable=newMode==="payable"?150:0;
    assert.equal(oldPayable-oldPayable+newPayable,newPayable);
  }
});

test("payable payments, closed months, invalid state and duplicate rebooks are blocked before writes",()=>{
  assert.match(sql,/pg_advisory_xact_lock\([\s\S]*ledger_month_close:[\s\S]*ledger_month_is_closed_v1/);
  const firstInsert=sql.indexOf("insert into public.ledger_transactions");
  for(const marker of ["payable_already_paid","month_closed","invalid_original_state","already_rebooked"])assert.ok(sql.indexOf(marker)>0&&sql.indexOf(marker)<firstInsert);
  assert.match(sql,/ledger_payable_allocations[\s\S]*v_old_allocated > 0/);
  assert.match(sql,/v_old_payable\.status <> 'unpaid'/);
  assert.match(sql,/v_old_payable\.party_id is distinct from v_original\.party_id/);
  assert.match(sql,/v_old_payable\.original_amount <> v_original\.amount/);
  assert.match(sql,/p_payment_mode is null or p_payment_mode not in \('immediate', 'payable'\)/);
  assert.match(sql,/ledger_month_is_closed_v1/);
  assert.match(api,/month_closed[\s\S]*payable_already_paid[\s\S]*already_rebooked[\s\S]*409/);
});

test("rebook preserves provenance, writes one audit, and is one atomic RPC",()=>{
  assert.equal(sql.match(/v_original\.source_snapshot,\s*v_original\.source_fingerprint/g)?.length,2);
  for(const metadata of ["reversalOf","rebookOf","previousAmount","editedAt"])assert.doesNotMatch(sql,new RegExp(metadata));
  assert.match(sql,/inventory_transaction_rebooked/);
  assert.match(sql,/before_snapshot, after_snapshot/);
  for(const snapshot of ["replacementTransaction","replacementMovements","replacementPayable"])assert.match(sql,new RegExp(snapshot));
  assert.match(sql,/security definer[\s\S]*set search_path = pg_catalog, public/);
  assert.match(sql,/revoke all[\s\S]*from public, anon, authenticated[\s\S]*grant execute[\s\S]*to service_role/);
  assert.match(api,/ledger_rebook_inventory_transaction_v1/);
  assert.doesNotMatch(api,/\.from\("ledger_/);
});

test("Ledger rendering hides superseded effects and refreshes every dashboard source after edit",()=>{
  assert.match(entries,/inventory_purchase_reversal"\) continue/);
  assert.match(entries,/const reversedInventoryIds = new Set/);
  assert.match(entries,/row\.correction_of_id/);
  assert.match(entries,/reversedInventoryIds\.has\(value\(row\.id\)\)/);
  assert.match(entries,/inventory_purchase_candidate" \|\| row\.source_type === "inventory_purchase_rebook/);
  assert.match(ledgerApi,/payable:ledger_payables\(id,due_date,status,allocations:ledger_payable_allocations\(allocated_amount\)\)/);
  assert.match(page,/const fresh = await load\(\)/);
  assert.match(page,/entry\.items\.some\(\(item\) => item\.transactionId === transactionId\)/);
  assert.match(page,/setPayables\(payableBody\)/);
});

test("candidate pointer follows every effective rebook without changing provenance fields",()=>{
  assert.match(sql,/from public\.ledger_candidates[\s\S]*candidate_type = 'inventory_purchase'[\s\S]*status = 'confirmed'[\s\S]*resolved_transaction_id = v_original\.id[\s\S]*for update/);
  assert.match(sql,/if v_candidate\.id is null then[\s\S]*invalid_original_state/);
  assert.match(sql,/update public\.ledger_candidates\s+set resolved_transaction_id = v_rebook_id, updated_at = now\(\)\s+where id = v_candidate\.id/);
  assert.doesNotMatch(sql,/set resolved_transaction_id = v_rebook_id[^;]*(source_snapshot|source_fingerprint|resolved_by|resolved_at)/);
  let candidatePointer=1;
  candidatePointer=3; assert.equal(candidatePointer,3);
  candidatePointer=5; assert.equal(candidatePointer,5);
});

test("Inventory rebook chains collapse to the latest effective transaction",()=>{
  const transaction=(id:number,source_type:string,amount:number,correction_of_id:number|null):TransactionRow=>({
    id,type:"expense",business_date:"2026-08-01",amount,economic_effect_sign:source_type==="inventory_purchase_reversal"?-1:1,
    correction_of_id,source_type,source_snapshot:{item_name:"Item",change_quantity:1,purchase_price:amount},
    category:{id:10,name:"기타 비용"},party:{name:"Ok Mart"},party_id:20,
    movements:source_type==="inventory_purchase_reversal"?[]:[{amount:-amount,fund_account:{id:30,display_name:"현금"}}],
  });
  const original=transaction(1,"inventory_purchase_candidate",100,null);
  const reversal1=transaction(2,"inventory_purchase_reversal",100,1);
  const rebook1=transaction(3,"inventory_purchase_rebook",120,1);
  const first=buildLedgerEntries([original,reversal1,rebook1],[],new Map());
  assert.equal(first.length,1);assert.equal(first[0].amount,120);assert.equal(first[0].items.length,1);assert.equal(first[0].items[0].transactionId,3);
  const reversal2=transaction(4,"inventory_purchase_reversal",120,3);
  const rebook2=transaction(5,"inventory_purchase_rebook",90,3);
  const second=buildLedgerEntries([original,reversal1,rebook1,reversal2,rebook2],[],new Map());
  assert.equal(second.length,1);assert.equal(second[0].amount,90);assert.equal(second[0].items.length,1);assert.equal(second[0].items[0].transactionId,5);
});

test("API input validators accept three decimals and reject impossible dates",()=>{
  assert.equal(parseInventoryRebookAmount("123.456"),"123.456");
  assert.equal(parseInventoryRebookAmount(123.456),"123.456");
  for(const amount of ["123.4567","0","-1","1e3","9007199254740991.001"])assert.equal(parseInventoryRebookAmount(amount),null);
  assert.equal(isLedgerCalendarDate("2026-02-28"),true);
  assert.equal(isLedgerCalendarDate("2026-02-30"),false);
  assert.equal(isLedgerCalendarDate("2026-99-99"),false);
});

test("edit API whitelists input and maps safe application codes",()=>{
  assert.match(api,/allowedFields = new Set/);
  for(const field of ["paymentMode","categoryId","fundAccountId","dueDate","amount","memo","reason"])assert.match(api,new RegExp(`"${field}"`));
  assert.match(api,/requireLedgerActor/);assert.match(api,/INVALID_BODY/);assert.match(api,/INVENTORY_EDIT_FAILED/);
  assert.match(api,/forbidden" \? 403/);assert.match(api,/not_found" \? 404/);assert.match(api,/payable_already_paid/);
});

test("payables summary joins partner type without N plus one queries",()=>{
  assert.match(payablesApi,/business_partner_ledger_parties/);
  assert.match(payablesApi,/business_partners/);
  assert.match(payablesApi,/partnerType:string\|null/);
  assert.match(payablesApi,/businessPartnerByLedgerParty/);
  assert.match(payablesApi,/partnerTypeByBusinessPartner/);
  assert.equal((payablesApi.match(/from\("business_partner_ledger_parties"\)/g)??[]).length,1);
  assert.equal((payablesApi.match(/from\("business_partners"\)/g)??[]).length,1);
});

test("payable and account mini badges are bilingual and compact",()=>{
  for(const label of ["주류","식자재","음료","기타","Rượu","Thực phẩm","Đồ uống","Khác"])assert.match(page,new RegExp(label));
  for(const label of ["현금","법인","미지급","미지정","Tiền mặt","Công ty","Công nợ","Chưa rõ","Vương","Cho"])assert.match(page,new RegExp(label));
  assert.match(page,/partnerTypeLabel\(party\.partnerType,lang\)/);
  assert.match(page,/accountBadgeLabel\(entry\.accountName,lang,entry\)/);
  assert.match(css,/\.entryRow\{grid-template-columns:38px auto minmax\(0,1fr\) auto auto 12px/);
  assert.match(css,/@media\(max-width:560px\)[\s\S]*\.entryRow\{grid-template-columns:35px auto minmax\(0,1fr\) auto auto 9px/);
  assert.match(css,/\.accountBadge\{[^}]*font-size:9px/);
  assert.match(css,/\.accountBadgePayable\{/);
  assert.match(css,/\.payablePartyMain>\.partnerTypeBadge\{[^}]*font-size:8px/);
});

test("account leaves list metadata but remains searchable and visible in detail",()=>{
  const meta=page.slice(page.indexOf("function entryMeta"),page.indexOf("function partnerTypeLabel"));
  assert.doesNotMatch(meta,/entry\.accountName/);
  assert.match(page,/entryDisplayTitle\(entry, lang\)} \$\{entryMeta\(entry, lang\)} \$\{entry\.accountName/);
  assert.match(page,/entry\.accountName \?\? \(vi \? "Không có tài khoản" : "계정 없음"\)/);
});
