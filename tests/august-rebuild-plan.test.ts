import assert from 'node:assert/strict';
import test from 'node:test';
import {
  previewAugustRebuild,
  parseVndMilli,
  formatVndMilli,
  FUND_ACCOUNTS,
  type FundAccount,
  type RebuildInput,
  type ExistingTransaction,
  type ExistingMovement,
  type SheetCell,
  type RebuildAdjustment,
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
} from '../lib/ledger/august-rebuild-plan.ts';

const opening: Record<FundAccount,string> = {
  store_cash:'1000',vuong_personal_custody:'1000',cho_personal_custody:'1000',baba_corporate_bank:'1000',
};
function funds(overrides: Partial<Record<FundAccount,string>>={}): Record<FundAccount,string> {
  return {...opening,...overrides};
}
function sheet(cell:string,account:SheetCell['account'],amount:string,day=1):SheetCell {
  return {cell,account,businessDate:`2026-08-${String(day).padStart(2,'0')}`,signedAmountVnd:amount};
}
function tx(id:string,type:string='expense',sourceType:string='legacy_sheet_detail'):ExistingTransaction {
  return {id,type,sourceType,status:'confirmed',recognitionMonth:type==='expense'?'2026-08':null};
}
function movement(id:string,transactionId:string,amount:string,day=1,account:FundAccount='store_cash'):ExistingMovement {
  return {id,transactionId,signedAmountVnd:amount,account,businessDate:`2026-08-${String(day).padStart(2,'0')}`};
}
function verifiedLink(cell:string){return {cell,confidence:'verified' as const,classification:'external-evidence',transactionIds:[],evidenceReference:'synthetic-test-bank-proof',reason:'synthetic original evidence checked'};}
function base(sheetCells:SheetCell[], adjustments:RebuildAdjustment[]=[]):RebuildInput {
  return {
    contract:{expectedSheetCells:sheetCells.length,expectedSourceRows:sheetCells.length,sourceRows:sheetCells.length,requiredProtectionSets:['payable_allocations'],expectedTechnicalMovementIds:[]},
    sheetCells,sourceLinks:sheetCells.map(x=>verifiedLink(x.cell)),openingVnd:funds(),sheetClosingVnd:funds(),
    transactions:[],currentMovements:[],proposedAdjustments:adjustments,
    protections:[{name:'payable_allocations',beforeCount:302,afterCount:302,beforeFingerprint:'fixed-302',afterFingerprint:'fixed-302'}],
    futureMonths:[],
  };
}
const transfer:RebuildAdjustment = {
  id:'transfer-G4-I4',kind:'transfer',evidence:'verified',rationale:'paired 100 VND transfer',
  sheetCells:['G4','I4'],effects:[
    {businessDate:'2026-08-01',account:'store_cash',signedAmountVnd:'-100'},
    {businessDate:'2026-08-01',account:'cho_personal_custody',signedAmountVnd:'100'},
  ]
};

test('exact VND thousandths: never rounds 0.1, 91,763.1, or large legacy balances',()=>{
  assert.equal(parseVndMilli('91763.1'),BigInt(91763100));
  assert.equal(parseVndMilli('-149781532.5'),-BigInt(149781532500));
  assert.equal(parseVndMilli('0.001'),BigInt(1));
  assert.equal(formatVndMilli(-BigInt(149781532500)),'-149781532.5');
  assert.equal(formatVndMilli(BigInt(91763100)),'91763.1');
  for(const invalid of ['1,000','3.2631','1e4','Infinity','NaN','-','01','1.0001','']){
    assert.throws(()=>parseVndMilli(invalid),/INVALID_VND/);
  }
});

test('basic bank transfer reconstructs fund flows without creating expense or revenue',()=>{
  const input=base([sheet('G4','store_cash','-100'),sheet('I4','cho_personal_custody','100')],[transfer]);
  input.sheetClosingVnd=funds({store_cash:'900',cho_personal_custody:'1100'});
  const saved=JSON.stringify(input);
  const result=previewAugustRebuild(input);
  assert.equal(result.decision,'GO_FOR_SEPARATE_APPROVAL');
  assert.equal(result.daily.length,124);
  assert.equal(result.totals.dailyBeforeMatches,122);
  assert.equal(result.totals.dailyProposedMatches,124);
  assert.equal(result.totals.augustDifferenceVnd,'0');
  assert.equal(JSON.stringify(input),saved,'preview must not mutate its input');
});

test('a mismatched sheet opening+movement never becomes a GO even if APP agrees',()=>{
  const input=base([sheet('G4','store_cash','-100')]);
  input.sheetClosingVnd=funds({store_cash:'999'});
  input.transactions=[tx('e')]; input.currentMovements=[movement('m','e','-100')];
  const result=previewAugustRebuild(input);
  assert.equal(result.decision,'BLOCKED');
  assert.ok(result.blockers.some(x=>x.startsWith('SHEET_OPENING_CLOSING_MISMATCH:')));
});

test('relocate a payment to another business day without duplicating August expense',()=>{
  const input=base([sheet('G8','store_cash','-50',21)], [{
    id:'chicken_18_to_21',kind:'relocate-payment',evidence:'verified',rationale:'same supplier invoice and paid on 21st',
    originalMovementId:'m1',sheetCells:['G8'],effects:[
      {businessDate:'2026-08-18',account:'store_cash',signedAmountVnd:'50'},
      {businessDate:'2026-08-21',account:'store_cash',signedAmountVnd:'-50'},
    ]
  }]);
  input.transactions=[tx('chicken','expense','inventory_purchase_candidate')];
  input.currentMovements=[movement('m1','chicken','-50',18)];
  input.sheetClosingVnd=funds({store_cash:'950'});
  const result=previewAugustRebuild(input);
  assert.equal(result.decision,'GO_FOR_SEPARATE_APPROVAL');
  assert.equal(result.totals.dailyProposedMatches,124);
  assert.equal(result.totals.dailyBeforeMatches,122);
});

test('relocation is blocked if the original transaction is not reversed exactly',()=>{
  const input=base([sheet('G8','store_cash','-50',21)], [{
    id:'wrong_relocation',kind:'relocate-payment',evidence:'verified',rationale:'mistaken source',
    originalMovementId:'m1',sheetCells:['G8'],effects:[
      {businessDate:'2026-08-18',account:'store_cash',signedAmountVnd:'40'},
      {businessDate:'2026-08-21',account:'store_cash',signedAmountVnd:'-40'},
    ]
  }]);
  input.transactions=[tx('a')];input.currentMovements=[movement('m1','a','-50',18)];
  input.sheetClosingVnd=funds({store_cash:'950'});
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.ok(r.blockers.some(x=>x.includes('RELOCATION_DOES_NOT_REVERSE_ORIGINAL')));
  assert.equal(r.daily.find(x=>x.date==='2026-08-18' && x.account==='store_cash')?.proposedVnd,'-50');
});

test('duplicate reversal of the same source movement is rejected, never twice applied',()=>{
  const deltas=[
    {businessDate:'2026-08-18',account:'store_cash' as FundAccount,signedAmountVnd:'50'},
    {businessDate:'2026-08-21',account:'store_cash' as FundAccount,signedAmountVnd:'-50'},
  ];
  const input=base([sheet('G8','store_cash','-50',21)], [
    {id:'once',kind:'relocate-payment',evidence:'verified',rationale:'first',originalMovementId:'m1',sheetCells:['G8'],effects:deltas},
    {id:'twice',kind:'relocate-payment',evidence:'verified',rationale:'second',originalMovementId:'m1',sheetCells:['G8'],effects:deltas},
  ]);
  input.transactions=[tx('a')]; input.currentMovements=[movement('m1','a','-50',18)];
  input.sheetClosingVnd=funds({store_cash:'950'});
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.ok(r.blockers.some(x=>x.includes('DUPLICATE_MOVEMENT_REVERSAL:m1')));
  assert.equal(r.totals.dailyProposedMatches,124,'preview should only count first valid relocation');
});

test('existing recognized cost with no movement can receive CASH-only restoration',()=>{
  const input=base([sheet('G6','store_cash','-50')],[{
    id:'shipping_payment',kind:'restore-outflow',evidence:'verified',rationale:'already recognized shipping on 8/1',
    sourceTransactionId:'shipping_expense',sheetCells:['G6'],effects:[
      {businessDate:'2026-08-01',account:'store_cash',signedAmountVnd:'-50'}]
  }]);
  input.sheetClosingVnd=funds({store_cash:'950'});
  input.transactions=[tx('shipping_expense','expense','legacy_sheet_detail')];
  assert.equal(previewAugustRebuild(input).decision,'GO_FOR_SEPARATE_APPROVAL');
  input.currentMovements=[movement('already','shipping_expense','-50',1)];
  const wrong=previewAugustRebuild(input);
  assert.equal(wrong.decision,'BLOCKED');
  assert.ok(wrong.blockers.some(x=>x.includes('INVALID_RESTORATION_SOURCE')));
});

test('replace a legacy technical adjustment only by exact source movement reversal',()=>{
  const input=base([sheet('G6','store_cash','-50')],[
    {id:'takeout_legacy',kind:'remove-technical',evidence:'verified',rationale:'all eight tech replacements must atomically qualify',
       originalMovementId:'mTech',sheetCells:[],effects:[{businessDate:'2026-08-31',account:'store_cash',signedAmountVnd:'-100'}]},
    {id:'actual_payment',kind:'restore-outflow',evidence:'verified',rationale:'existing shipping expense',
      sourceTransactionId:'expense1',sheetCells:['G6'],effects:[{businessDate:'2026-08-01',account:'store_cash',signedAmountVnd:'-50'}]}
  ]);
  input.contract.expectedTechnicalMovementIds=['mTech'];
  input.sheetClosingVnd=funds({store_cash:'950'});
  input.transactions=[tx('tech','balance_adjustment','ledger_correction'),tx('expense1')];
  input.currentMovements=[movement('mTech','tech','100',31)];
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'GO_FOR_SEPARATE_APPROVAL');
  assert.equal(r.totals.dailyProposedMatches,124);
  input.proposedAdjustments=[input.proposedAdjustments[1]];
  const noTech=previewAugustRebuild(input);
  assert.equal(noTech.decision,'BLOCKED');
  assert.ok(noTech.blockers.some(x=>x.includes('LEGACY_ADJUSTMENT_NOT_REPLACED:mTech')));
});

test('unverified source link blocks approval even if 124/124 balances match',()=>{
  const input=base([sheet('G4','store_cash','-1')]);
  input.transactions=[tx('a')];input.currentMovements=[movement('m','a','-1')];
  input.sheetClosingVnd=funds({store_cash:'999'});
  input.sourceLinks=[{...verifiedLink('G4'),confidence:'candidate'}];
  const r=previewAugustRebuild(input);
  assert.equal(r.totals.dailyProposedMatches,124);
  assert.equal(r.decision,'BLOCKED');
  assert.ok(r.blockers.some(x=>x.includes('UNVERIFIED_SHEET_LINK:G4')));
});

test('unverified proposed adjustment never alters projected funds',()=>{
  const input=base([sheet('G4','store_cash','-1')],[{
    id:'fake_balancing',kind:'restore-outflow',evidence:'provisional',rationale:'unverified expense',
    sourceTransactionId:'expense',sheetCells:['G4'],effects:[{businessDate:'2026-08-01',account:'store_cash',signedAmountVnd:'-1'}]
  }]);
  input.sheetClosingVnd=funds({store_cash:'999'});
  input.transactions=[tx('expense')];
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.equal(r.totals.dailyProposedMatches,123);
  assert.equal(r.closing.find(x=>x.month==='2026-08' && x.account==='store_cash')?.projectedClosingVnd,'1000');
});

test('reject duplicate sheet refs, missing coverage and altered card total',()=>{
  const input=base([sheet('G4','store_cash','-1'),sheet('G4','store_cash','-1'),sheet('J4','card_clearing','250')]);
  input.sheetClosingVnd=funds({store_cash:'998'});
  input.contract.expectedCardTotalVnd='249';
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.ok(r.blockers.some(x=>x.includes('DUPLICATE_OR_MISSING_SHEET_CELL:G4')));
  assert.ok(r.blockers.includes('CARD_TOTAL_CHANGED'));
});

test('protect payable allocations, POS, source history and stored snapshots by unchanged fingerprint',()=>{
  const input=base([]);
  input.contract.requiredProtectionSets=['payable_allocations','pos_receipts','month_closure_history'];
  input.protections=[{name:'payable_allocations',beforeCount:302,afterCount:301,beforeFingerprint:'before',afterFingerprint:'after'}];
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.ok(r.blockers.includes('PROTECTED_DATA_CHANGED:payable_allocations'));
  assert.ok(r.blockers.includes('PROTECTION_NOT_PROVIDED:pos_receipts'));
  assert.ok(r.blockers.includes('PROTECTION_NOT_PROVIDED:month_closure_history'));
});

test('the exact 3,263.1 VND August deficit propagates to September and October',()=>{
  const input=base([sheet('G370','store_cash','-3263.1',27)]);
  input.sheetClosingVnd=funds({store_cash:'-2263.1'});
  input.futureMonths=[
    {month:'2026-09',currentClosingVnd:funds(),sheetClosingVnd:funds({store_cash:'-2263.1'})},
    {month:'2026-10',currentClosingVnd:funds(),sheetClosingVnd:funds({store_cash:'-2263.1'})},
  ];
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.equal(r.totals.augustDifferenceVnd,'3263.1');
  assert.equal(r.totals.dailyRemaining,1);
  assert.deepEqual(r.closing.filter(x=>x.account==='store_cash').map(x=>x.differenceVnd),['3263.1','3263.1','3263.1']);
});

test('reject stale database snapshot before applying any plan',()=>{
  const input=base([]);
  input.currentClosingVnd=funds({store_cash:'999'});
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.ok(r.blockers.includes('APP_SNAPSHOT_STALE:store_cash'));
});

test('check sheet field mapping and dates at the 03:00 business-day boundary input',()=>{
  const input=base([sheet('G110','store_cash','-10')]);
  input.sheetClosingVnd=funds({store_cash:'990'});
  input.transactions=[tx('t')];input.currentMovements=[movement('m','t','-10')];
  assert.equal(previewAugustRebuild(input).decision,'GO_FOR_SEPARATE_APPROVAL');
  input.sheetCells=[{...input.sheetCells[0],businessDate:'2026-09-01'}];
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.ok(r.blockers.some(x=>x.includes('INVALID_SHEET_DAY:G110')));
});

test('full 505-cell / 427-row shape remains immutable and all 124 daily fund buckets agree',()=>{
  const rows=Array.from({length:427},(_,i)=>{
    const num=i+4;
    return sheet(`G${num}`,'store_cash','-1',(i%31)+1);
  });
  const card=Array.from({length:78},(_,i)=>sheet(`J${i+4}`,'card_clearing','2',(i%31)+1));
  const input=base([...rows,...card]);
  input.contract.expectedSheetCells=505;
  input.contract.expectedSourceRows=427;
  input.contract.sourceRows=427;
  input.contract.expectedCardTotalVnd='156';
  input.sheetClosingVnd=funds({store_cash:'573'});
  input.transactions=rows.map((_,i)=>tx(`expense-${i}`));
  input.currentMovements=rows.map((r,i)=>movement(`movement-${i}`,`expense-${i}`,'-1',(i%31)+1));
  const originalCells=JSON.stringify(input.sheetCells);
  const result=previewAugustRebuild(input);
  assert.equal(result.decision,'GO_FOR_SEPARATE_APPROVAL');
  assert.equal(result.totals.sheetCellCount,505);
  assert.equal(result.totals.verifiedSourceLinks,505);
  assert.equal(result.totals.dailyBeforeMatches,124);
  assert.equal(result.totals.sheetCardVnd,'156');
  assert.equal(JSON.stringify(input.sheetCells),originalCells);
});

test('existing August 666250 reversal carries unchanged 666250 into September and October',()=>{
  const input=base([]);
  input.openingVnd=funds({store_cash:'51502786'});
  input.sheetClosingVnd=funds({store_cash:'51502786'});
  input.transactions=[tx('thuy_reversal','expense','inventory_purchase_reversal')];
  input.currentMovements=[movement('aug_cash_reversal','thuy_reversal','666250',31)];
  input.currentClosingVnd=funds({store_cash:'52169036'});
  input.futureMonths=[
    {month:'2026-09',currentClosingVnd:funds({store_cash:'39145456'}),sheetClosingVnd:funds({store_cash:'38479206'})},
    {month:'2026-10',currentClosingVnd:funds({store_cash:'78671656'}),sheetClosingVnd:funds({store_cash:'78005406'})},
  ];
  const r=previewAugustRebuild(input);
  assert.equal(r.decision,'BLOCKED');
  assert.equal(r.totals.augustDifferenceVnd,'666250');
  assert.deepEqual(r.closing.filter(x=>x.account==='store_cash').map(x=>x.differenceVnd),['666250','666250','666250']);
  assert.equal(r.totals.dailyProposedMatches,123);
});

test('verified cells must reference a specific source or explicit external proof',()=>{
  const input=base([sheet('G4','store_cash','1')]);
  input.sheetClosingVnd=funds({store_cash:'1001'});
  input.transactions=[tx('receipt','income','manual')];
  input.currentMovements=[movement('receipt-movement','receipt','1')];
  input.sourceLinks=[{cell:'G4',confidence:'verified',classification:'source-linked',transactionIds:[],reason:'looks like an invoice'}];
  const result=previewAugustRebuild(input);
  assert.equal(result.decision,'BLOCKED');
  assert.ok(result.blockers.some(x=>x.includes('VERIFIED_LINK_WITHOUT_SOURCE:G4')));
  assert.ok(result.blockers.some(x=>x.includes('VERIFIED_LINK_WITHOUT_EVIDENCE:G4')));
  input.sourceLinks=[{...input.sourceLinks[0],transactionIds:['missing'],evidenceReference:'bank:202608-001'}];
  const bad=previewAugustRebuild(input);
  assert.ok(bad.blockers.includes('SOURCE_LINK_TX_NOT_FOUND:G4:missing'));
});
