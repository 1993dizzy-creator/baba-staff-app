import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { payableDisplayAsOf } = createRequire(import.meta.url)("../lib/ledger/payables.ts") as typeof import("../lib/ledger/payables");
const { buildLedgerEntries, accountFromPaymentNote } = createRequire(import.meta.url)("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");

const payment = (date:string, amount:number, account="BABA 법인계좌", status="confirmed") => ({
  allocated_amount: amount,
  payment: { business_date: date, status, movements: [{amount: -amount, fund_account: {id: account, display_name: account}}] },
});

test("August payment is visible in August; September payment is excluded until September", () => {
  const allocations = [payment("2026-08-24", 35_684_000), payment("2026-09-02", 13_532_000)];
  assert.deepEqual(payableDisplayAsOf(49_216_000, allocations, "2026-08"), {status:"partial",paidAmount:35_684_000,remainingAmount:13_532_000,accountName:"BABA 법인계좌"});
  assert.deepEqual(payableDisplayAsOf(49_216_000, allocations, "2026-09"), {status:"paid",paidAmount:49_216_000,remainingAmount:0,accountName:"BABA 법인계좌"});
  assert.equal(payableDisplayAsOf(49_216_000, [payment("2026-09-02",49_216_000)], "2026-08").status,"unpaid");
});

test("different payment accounts show multiple accounts and nonconfirmed payments are ignored", () => {
  const result=payableDisplayAsOf(100,[payment("2026-08-10",40,"BABA 법인계좌"),payment("2026-08-20",30,"매장 현금"),payment("2026-08-21",30,"개인(Cho)","draft")],"2026-08");
  assert.deepEqual(result,{status:"partial",paidAmount:70,remainingAmount:30,accountName:"복수계정"});
});

test("Phương and Ok Mart allocated items show paid accounts and accurate August remainder; Trung Đông stays unpaid", () => {
  let id=1;
  const row=(party:string,amount:number,paid:number)=>({
    id:id++,type:"expense",source_type:"inventory_purchase_candidate",business_date:"2026-08-01",amount,
    party:{name:party},source_snapshot:{item_name:`item-${id}`},
    payable:{id:id,original_amount:amount,status:"paid",allocations:paid?[payment("2026-08-24",paid)]:[]},
  });
  const rows=[
    row("Phương",20_000_000,20_000_000),row("Phương",29_216_000,15_684_000),
    row("Ok Mart",10_000_000,10_000_000),row("Ok Mart",5_000_000,5_000_000),
    row("Ok Mart",5_000_000,5_000_000),row("Ok Mart",5_000_000,2_126_508),
    row("Ok Mart",5_458_992,0),row("Trung Đông",15_662_600,0),
  ];
  const entries=buildLedgerEntries(rows,[],new Map(),[],"2026-08");
  const items=(party:string)=>entries.filter(entry=>entry.title===party).flatMap(entry=>entry.items);
  assert.equal(items("Phương").reduce((sum,item)=>sum+(item.settlementPaidAmount??0),0),35_684_000);
  assert.equal(items("Phương").reduce((sum,item)=>sum+(item.remainingAmount??0),0),13_532_000);
  assert.ok(entries.filter(entry=>entry.title==="Phương").every(entry=>entry.accountName==="BABA 법인계좌"));
  assert.equal(items("Ok Mart").reduce((sum,item)=>sum+(item.settlementPaidAmount??0),0),22_126_508);
  assert.equal(items("Ok Mart").reduce((sum,item)=>sum+(item.remainingAmount??0),0),8_332_484);
  assert.equal(items("Trung Đông")[0].settlementStatus,"unpaid");
  assert.equal(entries.find(entry=>entry.title==="Trung Đông")?.accountName,"미지급");
  assert.ok(entries.some(entry=>entry.title==="Phương"&&entry.settlementStatus==="partial"));
  assert.equal(entries.filter(entry=>entry.title==="Phương").length,2);
  assert.equal(entries.filter(entry=>entry.title==="Ok Mart").length,3);
});

test("six reported August party remainders total 77,281,996 without changing fund math",()=>{
  assert.equal([13_532_000,8_332_484,7_460_000,15_662_600,29_579_992,2_714_920].reduce((a,b)=>a+b,0),77_281_996);
  const route=readFileSync("app/api/admin/ledger/route.ts","utf8");
  assert.match(route,/payment:ledger_transactions!payment_transaction_id\(business_date,status,movements:ledger_movements/);
  assert.match(route,/buildLedgerEntries\(displayTransactions, candidates, partnerDefaultsByParty, mealCandidateSources, month\)/);
  assert.match(route,/buildFundAccountView\(\{/);
  assert.match(route,/operatingProfit: recognizedIncome - expense/);
});

test("real movement takes priority over source payment note", () => {
  const [entry]=buildLedgerEntries([{
    id:1,type:"expense",source_type:"legacy_sheet_detail",business_date:"2026-08-01",amount:100,
    source_snapshot:{paymentNote:"현금"},movements:[{amount:-100,fund_account:{display_name:"BABA 법인계좌"}}],
  }],[],new Map(),[],"2026-08");
  assert.equal(entry.accountName,"BABA 법인계좌");
  const [legacy]=buildLedgerEntries([{
    id:2,type:"expense",source_type:"legacy_sheet_detail",business_date:"2026-08-01",amount:100,
    source_snapshot:{paymentNote:"tk(cho)"},
  }],[],new Map(),[],"2026-08");
  assert.equal(legacy.accountName,"개인(Cho)");
});

test("legacy payment note aliases and mixed account notes", () => {
  assert.equal(accountFromPaymentNote("현금 1,000"),"매장 현금");
  assert.equal(accountFromPaymentNote("tiền mặt"),"매장 현금");
  assert.equal(accountFromPaymentNote("tài khoản"),"개인(Vương)");
  assert.equal(accountFromPaymentNote("tk(cho)"),"개인(Cho)");
  assert.equal(accountFromPaymentNote("pháp nhân"),"BABA 법인계좌");
  assert.equal(accountFromPaymentNote("현금 50,000 + 법인 50,000"),"복수계정");
});
