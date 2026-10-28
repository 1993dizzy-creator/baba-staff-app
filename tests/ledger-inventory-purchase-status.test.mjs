import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {purchaseRepairError} from '../lib/inventory/purchase-repair-contract.ts';
import {buildLedgerEntries} from '../lib/ledger/entries.ts';
import {inventoryPurchaseStatusSummary} from '../lib/ledger/inventory-purchase-status.ts';

// Compact inventory purchase status in the transaction detail sheet: paid shows nothing,
// open 미납 only the 미납금 현황 button, 장부 반영 전 / 결제 미확인 one short notice,
// a receipt's 원입고 issue always. Display only: the summary numbers are unchanged.
function load(path,deps){
 const target={exports:{}};
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected '+name);return deps[name];},target,target.exports);
 return target.exports;
}
const display=load('lib/inventory/purchase-case-display.ts',{'./purchase-repair-contract':{purchaseRepairError}});
const css=new Proxy({},{get:(_,key)=>String(key)});
const {InventoryPurchaseStatus}=load('app/(protected)/admin/ledger/entries/EntryStatusSections.tsx',{
 react:React,'react/jsx-runtime':jsxRuntime,'./entries.module.css':{default:css},
 '@/lib/inventory/purchase-case-display':display,'@/lib/ledger/inventory-purchase-status':{inventoryPurchaseStatusSummary},
});

// #3307 10/22 flour 1,101,600₫ (production shape, read only) and its variants.
const BANK={id:2,code:'baba_corporate_bank',display_name:'BABA 법인계좌'};
const flour={id:3307,type:'expense',status:'confirmed',business_date:'2026-10-22',recognition_month:'2026-10-01',amount:'1101600.000',
 source_type:'inventory_purchase_candidate',source_key:'candidate:1978',party_id:29,party:{name:'khác'},economic_effect_sign:1,
 category:{id:31,name:'식자재'},occurred_at:'2026-10-22T09:15:35+00:00',
 source_snapshot:{unit:'Kg',reason:'purchase',item_id:625,category:'식자재',item_name:'지구표 999 강력분 밀가루',item_name_vi:'Bột mì địa cầu 999',
  category_vi:'Nguyên liệu',business_date:'2026-10-22',purchase_price:22032,change_quantity:50,purchase_amount:1101600,inventory_log_id:13849,paymentVerification:'pending'},
 payable:{id:1631,original_amount:1101600,due_date:null,status:'unpaid',allocations:[]}};
const pay=amount=>({allocated_amount:amount,payment:{id:8001,type:'payable_payment',source_type:'manual',amount,business_date:'2026-10-23',status:'confirmed'}});
const build=row=>buildLedgerEntries([row],[],new Map(),[],'2026-10')[0];
const confirmedSnapshot={...flour.source_snapshot};delete confirmedSnapshot.paymentVerification;
const payableRow=(allocations,snapshot=confirmedSnapshot)=>build({...flour,source_snapshot:snapshot,payable:{...flour.payable,allocations}});
const cases={
 immediate:build({...flour,source_snapshot:confirmedSnapshot,payable:null,movements:[{amount:-1101600,fund_account:BANK}]}),
 paid:payableRow([pay(1101600)]),
 unpaid:payableRow([]),
 partial:payableRow([pay(600000)]),
 verificationPending:build(flour),
 verificationPartial:payableRow([pay(600000)],flour.source_snapshot),
};
cases.pending={...cases.unpaid,status:'pending'};
const issue={inventoryLogId:19101,rootInventoryLogId:13849,code:'PURCHASE_CORRECTION_REFERENCE_REQUIRED',itemName:'지구표 999 강력분 밀가루',itemNameVi:'Bột mì địa cầu 999',
 supplier:'khác',businessDate:'2026-10-22',quantityDelta:0,amountDelta:0,originalQuantity:50,resolution:{candidates:[],recommended:false}};
const noop=()=>{};
const props=(entry,lang='ko',extra={})=>({entry,issues:[],lang,onShowIssue:noop,...extra});
const html=(entry,lang,extra)=>renderToStaticMarkup(React.createElement(InventoryPurchaseStatus,props(entry,lang,extra)));
// The rendered element tree, to read the click handlers SSR markup drops.
function buttons(node,found=[]){
 if(Array.isArray(node)){for(const child of node)buttons(child,found);return found;}
 if(!node||typeof node!=='object')return found;
 if(typeof node.type==='function')return buttons(node.type(node.props),found);
 if(node.type==='button')found.push(node.props);
 buttons(node.props?.children,found);
 return found;
}
const tree=(entry,extra)=>buttons(InventoryPurchaseStatus(props(entry,'ko',extra)));
const noFiller=markup=>{for(const filler of ['확인할 문제가 없습니다','추가 조치가 필요 없습니다','Không có vấn đề','Không cần xử lý','현재 상태','해결 방법'])assert.ok(!markup.includes(filler),filler);};

test('summary numbers are unchanged for every case',()=>{
 assert.deepEqual(['immediate','paid','unpaid','partial','verificationPending','verificationPartial'].map(key=>{const s=inventoryPurchaseStatusSummary(cases[key]);return [s.payable,s.paid,s.remaining,s.state,s.verificationPending];}),[
  [false,1101600,0,'paid',false],[true,1101600,0,'paid',false],[true,0,1101600,'unpaid',false],[true,600000,501600,'partial',false],[true,0,1101600,'unpaid',true],[true,600000,501600,'partial',true]]);
});

test('지급완료 (immediate and 미납 paid in full): no status card at all',()=>{
 for(const key of ['immediate','paid'])for(const lang of ['ko','vi'])assert.equal(html(cases[key],lang,{onOpenPayableParty:noop,onShowPayables:noop}),'',key+lang);
});

test('미납 and 일부 지급: only the "미납금 현황 열기 ›" button, party first then the 미납금 list',()=>{
 const party=()=>{},list=()=>{};
 for(const key of ['unpaid','partial']){
  const ko=html(cases[key],'ko',{onOpenPayableParty:party,onShowPayables:list});
  assert.equal(ko,'<button type="button" class="purchasePayableLink" data-testid="inventory-status-payable">미납금 현황 열기 ›</button>',key);
  assert.match(html(cases[key],'vi',{onShowPayables:list}),/>Mở tình hình công nợ ›<\/button>$/);
  assert.equal(tree(cases[key],{onOpenPayableParty:party,onShowPayables:list})[0].onClick,party);
  assert.equal(tree(cases[key],{onShowPayables:list})[0].onClick,list);
  assert.equal(html(cases[key],'ko',{}),'','no way to open → nothing');
 }
});

test('결제 미확인: short notice with the amounts, one line, the existing 미납금 현황 button',()=>{
 const list=()=>{};
 for(const key of ['verificationPending','verificationPartial']){
  const ko=html(cases[key],'ko',{onOpenPayableParty:noop,onShowPayables:list});
  assert.match(ko,/data-testid="inventory-status" data-status-kind="verificationPending"/);
  assert.match(ko,/<p class="purchaseNoticeTitle"><span class="purchaseNoticeIcon" aria-hidden="true">!<\/span>결제 미확인<\/p>/);
  assert.match(ko,/<dt>매입금액<\/dt><dd>1\.101\.600 ₫<\/dd>/);
  assert.match(ko,/<dt>미지급 잔액<\/dt><dd>(1\.101\.600|501\.600) ₫<\/dd>/);
  assert.match(ko,/지급했다면 \[미납금 현황\] › \[기타 · 결제 미확인\]에서 \[개별 결제\]로 기록하세요\./);
  assert.ok(!ko.includes('미납금 현황 열기'),'not the party payable button');
  assert.equal(tree(cases[key],{onShowPayables:list})[0].onClick,list);
  noFiller(ko);
  assert.match(html(cases[key],'vi',{onShowPayables:list}),/Chưa xác minh thanh toán<\/p>.*Đi tới tình hình công nợ ›/);
 }
});

test('장부 반영 전: short notice, purchase amount, 미반영, choose the payment in the item [수정]',()=>{
 const ko=html(cases.pending,'ko',{onOpenPayableParty:noop,onShowPayables:noop});
 assert.match(ko,/data-status-kind="pending"/);
 assert.match(ko,/!<\/span>장부 반영 전<\/p>/);
 assert.match(ko,/<dt>매입금액<\/dt><dd>1\.101\.600 ₫<\/dd><\/div><div><dt>실제 지급액<\/dt><dd>미반영<\/dd>/);
 assert.match(ko,/아래 품목의 \[수정\]에서 결제 방식을 선택하세요\./);
 assert.equal(tree(cases.pending,{onShowPayables:noop}).length,0,'nothing is paid or chosen automatically');
 noFiller(ko);
 assert.match(html(cases.pending,'vi'),/Chưa ghi sổ<\/p>.*Chọn cách thanh toán ở \[Sửa\]/);
});

test('원입고 issue: shown on every state, even a paid one, and moves to the issue',()=>{
 const onShowIssue=id=>moved.push(id),moved=[];
 for(const key of ['immediate','paid','unpaid','verificationPending','pending']){
  const markup=html(cases[key],'ko',{issues:[issue],onShowIssue,onShowPayables:noop});
  assert.match(markup,/data-testid="inventory-status-issues" data-status-kind="issue"/,key);
  assert.match(markup,/data-testid="inventory-status-issue-19101"><strong>지구표 999 강력분 밀가루 · /,key);
  assert.match(markup,/원입고와 대조해 장부를 정정하세요\. <button type="button" class="statusLink">확인 필요 항목으로 이동 ›<\/button>/,key);
  tree(cases[key],{issues:[issue],onShowIssue,onShowPayables:noop}).at(-1).onClick();
  noFiller(markup);
 }
 assert.deepEqual(moved,[19101,19101,19101,19101,19101]);
 assert.match(html(cases.paid,'vi',{issues:[issue]}),/Khác với phiếu nhập gốc<\/p>.*Đi tới mục cần kiểm tra ›/);
 assert.equal(html(cases.paid,'ko',{issues:[{...issue,inventoryLogId:1,rootInventoryLogId:2}]}),'','another receipt\'s issue is not shown');
});

test('common amount boxes: thin #E2E8F0 border, white, 8px radius, stronger label/amount contrast',()=>{
 const sheet=readFileSync('app/(protected)/admin/ledger/entries/entries.module.css','utf8');
 assert.match(sheet,/\.statusFacts>div\{min-width:0;padding:6px 8px;border:1px solid #e2e8f0;border-radius:8px;background:#fff\}/);
 assert.match(sheet,/\.statusFacts dt\{color:#64748b;/);
 assert.match(sheet,/\.statusFacts dd\{margin:2px 0 0;color:#0f172a;font-size:13px;font-weight:800;/);
 assert.match(sheet,/\.purchaseNotice\{[^}]*border:1px solid #e2e8f0;border-radius:10px;background:#fcfcfd;/);
});
