import assert from 'node:assert/strict';
import test from 'node:test';
import {createAugustApplyManifest} from '../lib/ledger/august-rebuild-commit.ts';
import {previewAugustRebuild,type RebuildInput,type FundAccount,type SheetCell,type SourceLink,type RebuildAdjustment,type ExistingTransaction,type ExistingMovement} from '../lib/ledger/august-rebuild-plan.ts';

const ACCOUNT:Record<FundAccount,string>={
 store_cash:'10000',vuong_personal_custody:'0',cho_personal_custody:'0',baba_corporate_bank:'0'
};
const RUN='11111111-1111-4111-8111-111111111111';
const currency=(i:number)=>i.toString();
const day=(d:number)=>`2026-08-${String(d).padStart(2,'0')}`;
const movement=(id:number,tx:number,businessDate:string,amt:string):ExistingMovement=>({
 id:String(id),transactionId:String(tx),account:'store_cash',businessDate,signedAmountVnd:amt
});
const txn=(id:number,type='expense',sourceType='legacy_sheet_detail'):ExistingTransaction=>({id:String(id),type,sourceType,status:'confirmed',recognitionMonth:type==='balance_adjustment'?null:'2026-08'});

function fixture():RebuildInput{
 const sheetCells:SheetCell[]=[];
 const sourceLinks:SourceLink[]=[];
 const transactions:ExistingTransaction[]=[];
 const currentMovements:ExistingMovement[]=[];
 const proposedAdjustments:RebuildAdjustment[]=[];
 const technicalIds:string[]=[];
 // 427 different sheet-row numbers, 8 income receipts on August 31.
 for(let i=0;i<427;i++){
  const isFinal=i>=419;
  const cell=`G${i+4}`;
  const dt=isFinal?day(31):day((i%31)+1);
  const incomeId=100+i;
  const amt=isFinal?'1':'-1';
  sheetCells.push({cell,businessDate:dt,account:'store_cash',signedAmountVnd:amt});
  sourceLinks.push({cell,confidence:'verified',classification:'source-linked',transactionIds:[String(incomeId)],evidenceReference:`verified-receipt:${cell}`,reason:'test-only synthetic source'});
  transactions.push(txn(incomeId,isFinal?'income':'expense'));
  if(!isFinal)currentMovements.push(movement(10000+i,incomeId,dt,'-1'));
  else {
   const index=i-419;
   const techTxId=9000+index, techMoveId=19000+index;
   technicalIds.push(String(techMoveId));
   transactions.push(txn(techTxId,'balance_adjustment','ledger_correction'));
   currentMovements.push(movement(techMoveId,techTxId,dt,'1'));
   proposedAdjustments.push({id:`tech_${index}`,kind:'remove-technical',evidence:'verified',rationale:`verified original legacy movement ${techMoveId}`,
    sheetCells:[],originalMovementId:String(techMoveId),effects:[{businessDate:dt,account:'store_cash',signedAmountVnd:'-1'}]});
   proposedAdjustments.push({id:`restore_${index}`,kind:'restore-inflow',evidence:'verified',rationale:`verified original income ${incomeId}`,
    sheetCells:[cell],sourceTransactionId:String(incomeId),effects:[{businessDate:dt,account:'store_cash',signedAmountVnd:'1'}]});
  }
 }
 // 78 synthetic cards on existing rows. Exact August gross card amount.
 for(let i=0;i<78;i++){
  const cell=`J${i+4}`,amt=i===0?'225925643':'1';
  sheetCells.push({cell,businessDate:day((i%31)+1),account:'card_clearing',signedAmountVnd:amt});
  sourceLinks.push({cell,confidence:'verified',classification:'external-evidence',transactionIds:[],evidenceReference:`card-original:${cell}`,reason:'approved test card source'});
 }
 // Net August real movement: -419+8=-411, so closing after 10000 opening is 9589.
 const target={...ACCOUNT,store_cash:'9589'};
 const protections=['payable_allocations','pos_receipts','month_closure_history','ledger_audit_history','inventory_logs'].map(name=>({
  name,beforeCount:302,afterCount:302,beforeFingerprint:'checksum-unchanged',afterFingerprint:'checksum-unchanged'
 }));
 return {contract:{expectedSheetCells:505,expectedSourceRows:427,sourceRows:427,expectedCardTotalVnd:'225925720',
  requiredProtectionSets:protections.map(p=>p.name),expectedTechnicalMovementIds:technicalIds},
  sheetCells,sourceLinks,openingVnd:ACCOUNT,sheetClosingVnd:target,currentClosingVnd:target,
  transactions,currentMovements,proposedAdjustments,protections,
  futureMonths:[{month:'2026-09',sheetClosingVnd:target,currentClosingVnd:target},
    {month:'2026-10',sheetClosingVnd:target,currentClosingVnd:target}]};
}

test('505-cell manifest requires full PASS and emits fixed, deterministic cash-only corrections',()=>{
 const input=fixture();const original=JSON.stringify(input);
 const preview=previewAugustRebuild(input);
 assert.equal(preview.decision,'GO_FOR_SEPARATE_APPROVAL');
 assert.equal(preview.totals.dailyProposedMatches,124);
 const m=createAugustApplyManifest(input,RUN);
 assert.equal(m.status,'READY_FOR_ISOLATED_DB_TEST_ONLY');
 assert.equal(m.cellCount,505);assert.equal(m.sourceRows,427);
 assert.equal(m.cardTotal,'225925720');assert.equal(m.expectedDaily.length,124);
 assert.equal(m.events.length,16);
 assert.equal(new Set(m.events.map(e=>e.key)).size,16);
 assert.equal(m.requiredTechnicalMovementIds.length,8);
 assert.ok(m.events.every(e=>e.type==='correction'&&e.amount==='0'&&e.movements.length===1));
 assert.deepEqual(createAugustApplyManifest(input,RUN),m);
 assert.equal(JSON.stringify(input),original,'not allowed to mutate source input');
});

test('one corrected receipt is represented as non-economic correction, not another sale',()=>{
 const m=createAugustApplyManifest(fixture(),RUN);
 const r=m.events.find(e=>e.adjustmentId==='restore_0');
 assert.equal(r?.sourceTransactionId,'519');assert.equal(r?.type,'correction');assert.equal(r?.amount,'0');
 assert.deepEqual(r?.movements,[{accountId:1,amount:'1'}]);
 assert.equal(r?.occurredAt,'2026-08-31T03:00:00+07:00');
});

test('technical adjustment is exactly reversed by source movement and preserved for audit',()=>{
 const m=createAugustApplyManifest(fixture(),RUN);
 const r=m.events.find(e=>e.adjustmentId==='tech_0');
 assert.equal(r?.originalMovementId,'19000');assert.equal(r?.sourceTransactionId,'9000');
 assert.equal(r?.movements[0].amount,'-1');
 assert.equal(r?.type,'correction');
});

test('manifest refuses an unverified source even if all 124 daily balances agree',()=>{
 const x=fixture();x.sourceLinks=[{...x.sourceLinks[0],confidence:'candidate'},...x.sourceLinks.slice(1)];
 assert.equal(previewAugustRebuild(x).totals.dailyProposedMatches,124);
 assert.throws(()=>createAugustApplyManifest(x,RUN),/PREVIEW_BLOCKED/);
});

test('manifest refuses an incomplete historical protection fingerprint',()=>{
 const x=fixture();x.protections=x.protections.slice(1);
 assert.throws(()=>createAugustApplyManifest(x,RUN),/PREVIEW_BLOCKED|PROTECTION_NOT_VERIFIED/);
});

test('manifest refuses a different 505-cell sheet/card contract',()=>{
 const x=fixture();x.contract.expectedCardTotalVnd='225925719';
 assert.throws(()=>createAugustApplyManifest(x,RUN),/NOT_AUGUST_PRODUCTION_CONTRACT/);
});

test('manifest refuses a missing technical adjustment and missing September protection',()=>{
 const x=fixture();x.proposedAdjustments=x.proposedAdjustments.slice(1);
 assert.throws(()=>createAugustApplyManifest(x,RUN),/PREVIEW_BLOCKED/);
 const b=fixture();b.futureMonths=b.futureMonths.slice(0,1);
 assert.throws(()=>createAugustApplyManifest(b,RUN),/FOLLOWUP_MONTHS_NOT_COMPLETE/);
});

test('different retry keys are never silently accepted',()=>{
 assert.throws(()=>createAugustApplyManifest(fixture(),'not-a-uuid'),/INVALID_RUN_ID/);
 const x=fixture();x.proposedAdjustments[0].id='unsafe; DROP TABLE ledger_transactions; --';
 assert.throws(()=>createAugustApplyManifest(x,RUN),/BAD_ACTION_ID/);
});

test('adjustment keys cannot be confused across runs',()=>{
 const x=fixture();const first=createAugustApplyManifest(x,RUN);
 const second=createAugustApplyManifest(x,'22222222-2222-4222-8222-222222222222');
 assert.notEqual(first.events[0].key,second.events[0].key);
 assert.notEqual(first.effectDigest,second.effectDigest);
 assert.equal(first.sheetCellDigest,second.sheetCellDigest);
});

test('a changed source cell amount blocks commit even if no SQL is executed',()=>{
 const x=fixture();x.sheetCells[0].signedAmountVnd='-2';
 assert.throws(()=>createAugustApplyManifest(x,RUN),/PREVIEW_BLOCKED/);
});
