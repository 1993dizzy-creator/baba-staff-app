import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";import test from"node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import{buildOldestFirstAllocations,calculatePayableBalances,payableMonthBounds,sumPayableAmounts}from"../lib/ledger/payables.ts";
import ts from "typescript";
// @ts-expect-error Node strips TypeScript extensions in tests.
import * as payableFunctions from "../lib/ledger/payables.ts";
// @ts-expect-error Node strips TypeScript extensions in tests.
import * as paymentVerificationFunctions from "../lib/ledger/payment-verification.ts";
const read=(p:string)=>readFileSync(join(process.cwd(),p),"utf8"),migration=read("supabase/migrations/202608210004_add_ledger_payable_payments.sql"),pay=read("app/api/admin/ledger/payables/pay/route.ts"),dashboard=read("app/api/admin/ledger/payables/route.ts"),detail=read("app/api/admin/ledger/payables/[partyId]/route.ts"),party=read("app/api/admin/ledger/parties/route.ts"),mapping=read("app/api/admin/ledger/supplier-party-mappings/route.ts"),page=read("app/(protected)/admin/ledger/payables/page.tsx"),entries=read("app/(protected)/admin/ledger/entries/page.tsx"),partialPlan=read("lib/ledger/partial-payable-payment.ts"),ledger=read("app/api/admin/ledger/route.ts"),inventoryMigration=read("supabase/migrations/202608210003_add_inventory_purchase_candidates.sql"),pos=read("lib/sales/payment-summary.ts");
test("unpaid payable can be fully paid",()=>assert.match(migration,/least\(v_remaining,v_outstanding\)/));
test("payable supports partial payment",()=>assert.match(migration,/'partially_paid'/));
test("partial payment changes status to partially paid",()=>assert.match(migration,/when v_outstanding=0 then 'paid' else 'partially_paid'/));
test("zero outstanding changes status to paid",()=>assert.match(migration,/when v_outstanding=0 then 'paid'/));
test("one payment allocates to multiple payables",()=>assert.match(migration,/for v_item in select value from jsonb_array_elements\(v_plan\)/));
test("one payable supports multiple payments",()=>{assert.match(inventoryMigration,/unique\(payable_id,payment_transaction_id\)/);assert.doesNotMatch(inventoryMigration,/unique\(payable_id\)/)});
test("oldest first allocation is stable",()=>assert.deepEqual(buildOldestFirstAllocations([{id:3,businessDate:"2026-08-10",outstandingAmount:4},{id:1,businessDate:"2026-08-01",outstandingAmount:3},{id:2,businessDate:"2026-08-05",outstandingAmount:5}],6),{allocations:[{payableId:1,allocatedAmount:3},{payableId:2,allocatedAmount:3}],unallocatedAmount:0}));
test("custom allocations are accepted and validated",()=>{assert.match(migration,/jsonb_typeof\(p_allocations\)<>'array'/);assert.match(pay,/p_allocations:body\.allocations\?\?null/)});
test("zero allocation is rejected",()=>assert.match(migration,/v_allocate<=0/));
test("allocation above current outstanding is rejected",()=>assert.match(migration,/v_allocate>v_outstanding/));
test("payables from another party are rejected",()=>assert.match(migration,/v_payable\.party_id<>p_party_id/));
test("allocation sum must equal payment amount",()=>assert.match(migration,/v_sum<>p_amount.*allocation_sum_mismatch/));
test("movement absolute amount equals payment amount",()=>assert.match(migration,/ledger_movements\(transaction_id,fund_account_id,amount\) values\(v_payment_id,p_fund_account_id,-p_amount\)/));
test("payment reduces existing fund balance through signed movement",()=>{assert.match(ledger,/sum \+ Number\(row\.amount\)/);assert.match(migration,/-p_amount/)});
test("payable payment never enters P and L",()=>{assert.match(migration,/'payable_payment'/);assert.match(ledger,/\.in\("type", \["income", "expense", "sales"\]\)/)});
test("payment transaction movement allocations and statuses share one RPC",()=>{assert.match(pay,/ledger_pay_payables_v1/);assert.doesNotMatch(pay,/\.from\("ledger_/);assert.match(migration,/insert into public\.ledger_transactions[\s\S]*insert into public\.ledger_movements[\s\S]*ledger_payable_allocations[\s\S]*update public\.ledger_payables/)});
test("payables lock in deterministic order",()=>{assert.match(migration,/order by t\.business_date,p\.id for update/);assert.match(migration,/order by p\.id for update/)});
test("status derives from allocation sum",()=>assert.match(migration,/original_amount-coalesce\(sum\(a\.allocated_amount\),0\)/));
test("party dashboard aggregates outstanding and dates",()=>{for(const field of["outstandingAmount","openCount","oldestDate","nearestDueDate","recentPaymentDate"])assert.match(dashboard,new RegExp(field))});
test("party detail returns payable and allocation payment history",()=>{assert.match(detail,/ledger_payable_allocations\(allocated_amount,payment_transaction_id\)/);assert.match(detail,/type","payable_payment/);assert.match(entries,/지급 내역/);assert.match(entries.replace(/\s+/g,""),/dailyPayments=useMemo\(\(\)=>groupPaymentsByDate\(detail\?\.payments\?\?\[\]\),\[detail\]\)/)});
test("lower roles are rejected by the shared server gate",()=>{for(const route of[pay,dashboard,detail,party,mapping])assert.match(route,/requireLedgerActor\(\)/)});
test("party creation is owner-master RPC only",()=>{assert.match(party,/ledger_create_party_v1/);assert.match(migration,/ledger_create_party_v1[\s\S]*not in\('owner','master'\)/)});
test("supplier party mapping can be saved",()=>{assert.match(mapping,/ledger_upsert_supplier_party_mapping_v1/);assert.match(migration,/'supplier_party_mapping_saved'/)});
test("payment precision remains numeric 16 comma 3",()=>{assert.match(inventoryMigration,/allocated_amount numeric\(16,3\)/);assert.match(migration,/round\(p_amount,3\)<>p_amount/)});
test("payment audit includes actor transaction party fund allocations and before after",()=>{for(const value of["p_actor_user_id","v_payment_id","p_party_id","p_amount","p_fund_account_id","allocations","v_before","v_after"])assert.match(migration,new RegExp(value))});
test("payment UI previews oldest first",()=>{
  // Partial payment now lives in 장부작성 > 미납금 상세 and reuses buildOldestFirstAllocations() through a thin validator.
  assert.match(partialPlan,/buildOldestFirstAllocations\(open, amount\)/);
  assert.match(entries,/planPartialPayablePayment\(partialRows,/);assert.match(entries,/배분 예정 \(오래된 외상부터\)/);assert.match(entries,/Phân bổ dự kiến \(cũ nhất trước\)/);
});
test("inventory candidate regression remains",()=>assert.match(inventoryMigration,/ledger_resolve_inventory_candidate_v1/));
test("POS parity regression remains",()=>assert.match(pos,/export function buildPaymentSummary/));

const source=(id=1,date="2026-08-10",amount:number|string=1000,status="unpaid",partyId=10)=>({id,party_id:partyId,original_amount:amount,status,expense:{id,business_date:date,status:"confirmed",source_snapshot:{item_name:`item-${id}`}}});
const allocation=(date:string,amount:number|string,payableId=1,status="confirmed")=>({payable_id:payableId,allocated_amount:amount,payment:{business_date:date,status}});
const monthly=(rows=[source()],payments:ReturnType<typeof allocation>[]=[],month="2026-09")=>calculatePayableBalances(rows,payments,month).summary!;
test("prior purchase carries into next month's opening",()=>assert.deepEqual(monthly(),{openingOutstanding:1000,periodPurchases:0,periodPayments:0,closingOutstanding:1000}));
test("payment before month reduces opening only",()=>assert.deepEqual(monthly([source()],[allocation("2026-08-31",300)]),{openingOutstanding:700,periodPurchases:0,periodPayments:0,closingOutstanding:700}));
test("payment within month reduces closing",()=>assert.deepEqual(monthly([source()],[allocation("2026-09-01",400)]),{openingOutstanding:1000,periodPurchases:0,periodPayments:400,closingOutstanding:600}));
test("later payment never rewrites historical closing, even for paid status",()=>{
  const rows=[source(1,"2026-08-10",1000,"paid")],payments=[allocation("2026-10-01",1000)];
  for(const month of ["2026-08","2026-09"])assert.equal(monthly(rows,payments,month).closingOutstanding,1000);
  assert.equal(monthly(rows,payments,"2026-10").closingOutstanding,0);
});
test("new monthly purchase increases purchases and closing",()=>assert.deepEqual(monthly([source(1,"2026-09-30")]),{openingOutstanding:0,periodPurchases:1000,periodPayments:0,closingOutstanding:1000}));
test("fully paid before month is absent from opening",()=>assert.equal(monthly([source(1,"2026-08-10",1000,"paid")],[allocation("2026-08-31",1000)]).openingOutstanding,0));
test("multiple partial payments carry precise unpaid remainder",()=>assert.deepEqual(monthly([source(1,"2026-08-10","1000.123","partially_paid")],[allocation("2026-08-20","200.001"),allocation("2026-08-31","300.002"),allocation("2026-09-30","100.003"),allocation("2026-10-01",100)]),{openingOutstanding:500.12,periodPurchases:0,periodPayments:100.003,closingOutstanding:400.117}));
test("party closing sums equal total and monthly rollforward holds across months",()=>{
  const rows=[source(),source(2,"2026-09-01",2000,"partially_paid",20),source(3,"2026-10-01",500,"unpaid",10)];
  const payments=[allocation("2026-08-31",100),allocation("2026-09-30",400),allocation("2026-09-01",700,2),allocation("2026-10-01",200,2)];
  for(const month of ["2026-08","2026-09","2026-10","2026-11"]){
    const result=calculatePayableBalances(rows,payments,month),s=result.summary!;
    assert.equal(s.closingOutstanding,sumPayableAmounts([s.openingOutstanding,s.periodPurchases,-s.periodPayments]));
    const partyTotals=[10,20].map(id=>sumPayableAmounts(result.payables.filter(row=>row.party_id===id).map(row=>row.outstandingAmount)));
    assert.equal(sumPayableAmounts(partyTotals),s.closingOutstanding);
    assert.equal(result.totalOutstanding,s.closingOutstanding);
  }
});
test("cancelled or unconfirmed sources and nonconfirmed payments are excluded",()=>{
  const invalid=source(3);invalid.expense.status="voided";
  assert.equal(monthly([source(),source(2,"2026-08-10",1000,"cancelled"),invalid],[allocation("2026-09-01",900,1,"draft"),allocation("2026-09-02",900,1,"voided")]).closingOutstanding,1000);
});
test("month boundaries exclude next month's purchases and payments; December rolls year",()=>{
  assert.deepEqual(payableMonthBounds("2026-12"),{monthStart:"2026-12-01",nextMonthStart:"2027-01-01"});
  assert.equal(monthly([source(),source(2,"2026-10-01")],[allocation("2026-10-01",1000)]).closingOutstanding,1000);
  for(const month of ["","2026-00","2026-13","26-09","2026-9"])assert.throws(()=>payableMonthBounds(month),/INVALID_MONTH/);
});
test("no month calculates current allocations and preserves partial-payment oldest-first preview",()=>{
  const result=calculatePayableBalances([source(2,"2026-08-10",1000,"partially_paid"),source(1,"2026-08-01",500,"paid")],[allocation("2026-10-01",500,1),allocation("2026-10-01",300,2)]);
  assert.equal(result.totalOutstanding,700);assert.equal(result.summary,undefined);
  assert.deepEqual(buildOldestFirstAllocations(result.payables.map(row=>({id:row.id,businessDate:row.expense!.business_date,outstandingAmount:row.outstandingAmount})),200),{allocations:[{payableId:2,allocatedAmount:200}],unallocatedAmount:0});
});

// Execute the actual GET handler with an in-memory Supabase query double.
// No environment files, credentials, network or production DB are used.
function payableApi(rows:ReturnType<typeof source>[],payments:ReturnType<typeof allocation>[],denied=false){
  const tables:Record<string,unknown[]>={ledger_payables:rows.map(row=>({...row,party:{name:`Party ${row.party_id}`},due_date:null})),ledger_payable_allocations:payments,ledger_transactions:payments.filter(row=>row.payment.status==="confirmed").map(row=>({party_id:10,business_date:row.payment.business_date,status:"confirmed"})),business_partner_ledger_parties:[],business_partners:[]};
  const calls:string[]=[];
  const supabase={from(table:string){calls.push(table);let from=0,to=999;const filters:Array<(row:Record<string,unknown>)=>boolean>=[];
    const field=(row:Record<string,unknown>,name:string)=>name.split(".").reduce<unknown>((value,key)=>(value as Record<string,unknown>)?.[key],row);
    const query={select(){return query},order(){return query},eq(name:string,value:unknown){if(name!=="type")filters.push(row=>field(row,name)===value);return query},neq(name:string,value:unknown){filters.push(row=>field(row,name)!==value);return query},lt(name:string,value:string){filters.push(row=>String(field(row,name))<value);return query},range(start:number,end:number){from=start;to=end;return query},then(resolve:(value:unknown)=>unknown){return Promise.resolve({data:tables[table].filter(row=>filters.every(filter=>filter(row as Record<string,unknown>))).slice(from,to+1),error:null}).then(resolve)}};return query;
  }};
  const dependencies:Record<string,unknown>={"@/lib/ledger/payables":payableFunctions,"@/lib/ledger/payment-verification":paymentVerificationFunctions,"@/lib/ledger/inventory-display":{withInventoryDisplay:async(rows:unknown[])=>rows},"@/lib/supabase/server":{supabaseServer:supabase},"@/lib/ledger/server":{requireLedgerActor:async()=>denied?{response:Response.json({ok:false},{status:403})}:{},ledgerJson:(body:unknown,status=200)=>Response.json(body,{status})}};
  const testModule={exports:{} as {GET:(request:Request)=>Promise<Response>}};
  const code=ts.transpileModule(dashboard,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","module","exports",code)((name:string)=>{assert.ok(name in dependencies);return dependencies[name]},testModule,testModule.exports);
  return {get:(query="")=>testModule.exports.GET(new Request(`http://local/api/admin/ledger/payables${query}`)),calls};
}
test("actual GET preserves current response, returns historical month summary and party totals",async()=>{
  const api=payableApi([source(1,"2026-08-10",1000,"paid"),source(2,"2026-09-10",500,"partially_paid")],[allocation("2026-09-20",100,2),allocation("2026-10-01",1000)]);
  const current=await (await api.get()).json();assert.equal(current.totalOutstanding,400);assert.equal(current.summary,undefined);assert.equal(current.payables.length,1);
  const historical=await (await api.get("?month=2026-09")).json();assert.deepEqual(historical.summary,{openingOutstanding:1000,periodPurchases:500,periodPayments:100,closingOutstanding:1400});assert.equal(historical.totalOutstanding,1400);assert.equal(historical.parties[0].outstandingAmount,1400);assert.equal(historical.parties[0].recentPaymentDate,"2026-09-20");assert.equal(historical.payables[0].allocatedAmount,0);
});
test("actual GET validates month and retains authorization gate before DB reads",async()=>{
  const api=payableApi([],[]);assert.equal((await api.get("?month=2026-13")).status,400);assert.equal(api.calls.length,0);
  const denied=payableApi([],[],true);assert.equal((await denied.get("?month=2026-09")).status,403);assert.equal(denied.calls.length,0);
});
test("payment verification is separate from ordinary payable totals in the actual GET",async()=>{
  const special={...source(1,"2026-08-29",1900000),expense:{...source(1).expense,source_snapshot:{item_name:"Kent",supplier:"Chợ",change_quantity:50,purchase_price:38000,paymentVerification:"pending"}}};
  const ordinary=source(2,"2026-08-29",500000);
  const current=await (await payableApi([special,ordinary],[]).get()).json();
  assert.equal(current.totalOutstanding,500000);
  assert.equal(current.verification.totalPending,1900000);
  assert.equal(current.verification.pendingCount,1);
  assert.equal(current.parties[0].outstandingAmount,500000);
  const paid=await (await payableApi([special,ordinary],[allocation("2026-09-04",1900000)]).get()).json();
  assert.equal(paid.verification.totalPending,0);
  assert.equal(paid.verification.items[0].paymentDate,"2026-09-04");
  const august=await (await payableApi([special,ordinary],[allocation("2026-09-04",1900000)]).get("?month=2026-08")).json();
  assert.equal(august.verification.totalPending,1900000);
  assert.equal(august.verification.items[0].paymentDate,null);
});
test("actual GET pages beyond 1000 payables and allocations without losing balances",async()=>{
  const rows=Array.from({length:1001},(_,i)=>source(i+1)),payments=rows.map(row=>allocation("2026-09-01",100,row.id));
  const result=await (await payableApi(rows,payments).get("?month=2026-09")).json();assert.equal(result.totalOutstanding,900900);assert.equal(result.parties[0].outstandingAmount,900900);assert.equal(result.summary.periodPayments,100100);
});
test("monthly report has no payables shortcut; old /payables URL redirects to entries and entries uses the monthly endpoint",()=>{
  const report=read("app/(protected)/admin/ledger/page.tsx");
  assert.doesNotMatch(report,/href="\/admin\/ledger\/payables"/);assert.doesNotMatch(report,/fetch\(`\/api\/admin\/ledger\/payables/);
  assert.doesNotMatch(page,/fetch\(|"use client"|useState/);assert.match(page,/import \{ redirect \} from "next\/navigation";/);
  assert.match(entries,/fetch\(`\/api\/admin\/ledger\/payables\?month=\$\{requestedMonth\}`/);
});
test("party period payments include fully settled payables and never use cumulative allocations",async()=>{
  const rows=[source(1,"2026-08-01",1000,"paid",10),source(2,"2026-08-05",500,"partially_paid",10),source(3,"2026-09-01",600,"unpaid",20)];
  const payments=[allocation("2026-08-10",1000,1),allocation("2026-08-15",200,2)];
  const api=payableApi(rows,payments);
  const august=await(await api.get("?month=2026-08")).json();
  assert.equal(august.parties[0].periodPurchases,1500);assert.equal(august.parties[0].periodPayments,1200);assert.equal(august.parties[0].closingOutstanding,300);
  const september=await(await api.get("?month=2026-09")).json();
  assert.equal(september.parties.find((row:{partyId:number})=>row.partyId===10).periodPayments,0);
  assert.equal(september.parties.find((row:{partyId:number})=>row.partyId===10).partialPaidAmount,200);
  assert.equal(sumPayableAmounts(september.parties.map((row:{closingOutstanding:number})=>row.closingOutstanding)),september.summary.closingOutstanding);
});
test("monthly parties retain purchase and payment activity with zero closing; current mode remains open-only",async()=>{
  const api=payableApi([source(1,"2026-08-01",1000,"paid",10)],[allocation("2026-08-31",1000)]);
  const monthly=await(await api.get("?month=2026-08")).json();assert.equal(monthly.parties.length,1);assert.equal(monthly.parties[0].periodPayments,1000);assert.equal(monthly.parties[0].closingOutstanding,0);assert.equal(monthly.payables.length,0);
  const current=await(await api.get()).json();assert.equal(current.parties.length,0);assert.equal(current.totalOutstanding,0);
});

test("historical detail includes paid sources while outstanding and summary keep their existing meaning",async()=>{
  const api=payableApi([
    source(1,"2026-08-01",1000,"paid"),
    source(2,"2026-08-22",500,"partially_paid"),
    source(3,"2026-08-24",300,"unpaid"),
  ],[
    allocation("2026-08-10",1000,1),
    allocation("2026-08-23",200,2),
    allocation("2026-09-02",300,2),
  ]);
  const august=await(await api.get("?month=2026-08")).json();
  assert.equal(august.historyPayables.length,3);
  assert.ok(Object.hasOwn(august.historyPayables[0].expense,"source_snapshot"));
  assert.ok(Object.hasOwn(august.historyPayables[0].expense,"display_snapshot"));
  assert.deepEqual(august.historyPayables.map((row:{settlementStatus:string})=>row.settlementStatus),["paid","partial","unpaid"]);
  assert.deepEqual(august.historyPayables.map((row:{outstandingAmount:number})=>row.outstandingAmount),[0,300,300]);
  assert.equal(august.payables.length,2);
  assert.equal(august.totalOutstanding,600);
  assert.equal(august.summary.closingOutstanding,600);
});

test("Phương August history restores paid dates, partial 8/22 and unpaid dates without changing totals",async()=>{
  const paidDays=[1,3,7,8,10,13,15,17,19,21];
  const unpaidDays=[24,25,26,29,31];
  const rows=[
    ...paidDays.map((day,index)=>source(index+1,`2026-08-${String(day).padStart(2,"0")}`,2_772_000,"paid")),
    source(11,"2026-08-22",11_134_000,"partially_paid"),
    ...unpaidDays.map((day,index)=>source(index+12,`2026-08-${String(day).padStart(2,"0")}`,index===4?2_362_000:2_000_000,"unpaid")),
  ];
  const payments=[...paidDays.map((_,index)=>allocation("2026-08-23",2_772_000,index+1)),allocation("2026-08-23",7_964_000,11)];
  const august=await(await payableApi(rows,payments).get("?month=2026-08")).json();
  const history=august.historyPayables as Array<{id:number;paidAmount:number;outstandingAmount:number;settlementStatus:string;expense:{business_date:string}}>;
  assert.equal(history.length,16);
  assert.ok(paidDays.every(day=>history.some(row=>row.expense.business_date===`2026-08-${String(day).padStart(2,"0")}`&&row.settlementStatus==="paid"&&row.outstandingAmount===0)));
  assert.ok(unpaidDays.every(day=>history.some(row=>row.expense.business_date===`2026-08-${String(day).padStart(2,"0")}`&&row.settlementStatus==="unpaid")));
  const partial=history.find(row=>row.expense.business_date==="2026-08-22");
  assert.equal(partial?.paidAmount,7_964_000);
  assert.equal(partial?.outstandingAmount,3_170_000);
  assert.equal(partial?.settlementStatus,"partial");
  assert.equal(august.parties[0].periodPurchases,49_216_000);
  assert.equal(august.parties[0].periodPayments,35_684_000);
  assert.equal(august.parties[0].closingOutstanding,13_532_000);
  assert.equal(august.totalOutstanding,13_532_000);
  assert.equal([13_532_000,8_332_484,7_460_000,15_662_600,29_579_992,2_714_920].reduce((a,b)=>a+b,0),77_281_996);
});
