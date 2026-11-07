import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cashPreflight,simulateCashBatch,cashPostflight,posMatchPlan,julySimulation,FUNDS} from '../scripts/ledger/cash-first-simulation.mjs';
import {fundMovementInScope} from '../lib/ledger/fund-account-view.ts';
import {renderPhase4} from '../scripts/ledger/july-restore-phase4-plan.mjs';
const root=process.env.JULY_PHASE4_INPUT_DIR,options={skip:!root};
test('existing154 excluded: 211 cash rows+30 references, exact124 cells and all four August opening amounts',options,()=>{
 const r=julySimulation(root),s=r.summary;
 assert.equal(s.alreadyProcessed,154);assert.equal(s.remaining,241);assert.equal(s.newCashRows,211);assert.equal(s.newMovementLegs,278);assert.equal(s.referenceOnlyRows,30);
 assert.equal(s.cashRowVolume,'1598469992');assert.equal(s.referenceVolume,'219868620');
 assert.deepEqual(s.fundDelta,{store_cash:'-53664400',vuong_personal_custody:'-1731700',cho_personal_custody:'93201900',baba_corporate_bank:'47186022'});
 assert.equal(s.matchesBefore,3);assert.equal(s.matchesAfter,124);assert.equal(s.residualCells,0);
 assert.equal(s.ending.reduce((n,e)=>n+BigInt(e.balance),0n),300353642n);
 assert.ok(s.ending.every(e=>e.residual==='0'));assert.equal(s.replayNewRows,0);assert.equal(s.replayNewMovements,0);
 const applied=new Set(r.registry.filter(r=>r.cashStatus==='existing_link').map(r=>r.key));assert.ok(r.fresh.every(r=>!applied.has(r.key)));
 assert.ok(r.fresh.every(r=>!r.economicPostingAllowed));assert.equal(r.economicExceptions.length,241);
 assert.equal(s.newRevenueOrExpensePostings,0);assert.equal(s.newCardMovementsOrAllocations,0);assert.equal(s.productionCalls,0);
});
test('atomic staging, exact replay and source revision conflict; invalid monetary data fails preflight',()=>{
 const rows=[{key:'one',row:1,date:'2026-01-01',effects:[{account:'store_cash',amount:'-7'}]},{key:'two',row:2,date:'2026-01-02',effects:[{account:'store_cash',amount:'10'}]}];
 const plan=cashPreflight({rows,completedKeys:[],period:'2026-01'}),before=new Map();
 assert.throws(()=>simulateCashBatch(plan,before,1),/SIMULATED_BATCH_FAILURE/);assert.equal(before.size,0);
 const a=simulateCashBatch(plan,before),b=simulateCashBatch(plan,a.registry);assert.equal(a.imported,2);assert.equal(b.imported,0);assert.equal(b.movements,0);
 const changed=cashPreflight({rows:[{...rows[0],effects:[{account:'store_cash',amount:'-8'}]}],completedKeys:[],period:'2026-01'});
 assert.throws(()=>simulateCashBatch(changed,a.registry),/SOURCE_REVISION_CONFLICT/);assert.equal(a.registry.get('one').effects[0].amount,'-7');
 assert.throws(()=>cashPreflight({rows:[rows[0],rows[0]],completedKeys:[],period:'2026-01'}),/DUPLICATE_SOURCE_KEY/);
 assert.throws(()=>cashPreflight({rows:[{...rows[0],effects:[{account:'store_cash',amount:'1.5'}]}],completedKeys:[],period:'2026-01'}),/INVALID_INTEGER_MONEY/);
 assert.throws(()=>cashPreflight({rows,completedKeys:[],period:'2026-02'}),/SOURCE_DATE_OUTSIDE_PERIOD/);
 assert.throws(()=>cashPreflight({rows:[{...rows[0],date:'2026-01-99'}],completedKeys:[],period:'2026-01'}),/INVALID_BUSINESS_DATE/);
});
test('applied phase4 renderer cannot regenerate an executable proposal',options,()=>{
 assert.throws(()=>renderPhase4({}),/PHASE4_ALREADY_APPLIED_DO_NOT_RENDER/);
});
test('POS role split and shared July29 payment IDs owned once; raw journal effects are never dropped',options,()=>{
 const r=julySimulation(root),p=r.pos;
 assert.deepEqual(Object.fromEntries(Object.entries(p.summary.roles).map(([k,v])=>[k,v.rows])),{daily_payment_summary:32,individual_collection:89,card_sale_reference:30,card_deposit:23});
 assert.equal(p.summary.identifiedRows,61);assert.equal(p.summary.unidentifiedRows,113);assert.equal(p.summary.uniquePaymentIds,278);assert.equal(p.summary.paymentReferences,284);
 assert.equal(p.summary.sharedPayments.length,6);assert.equal(p.summary.crossGroupConflicts.length,0);
 const g=p.groups.find(g=>g.key==='pos:2026-07-29:transfer');assert.deepEqual(g.rows,[364,369]);assert.equal(g.paymentIds.length,6);
 assert.ok(r.fresh.some(r=>r.row===364));assert.ok(r.fresh.some(r=>r.row===369));assert.ok(p.records.every(r=>!r.createRevenue&&!r.createAdditionalCash&&!r.createCardSettlement));
 // A payment reused in DIFFERENT economic groups is an exception, not an auto-match.
 const example=[{row:1,key:'a',date:'2026-01-01',group:'other',phase4Bucket:'pos_card',effects:[{account:'store_cash',amount:'1'}],previousPosLink:{groupKey:'first',paymentIds:[1]}},{row:2,key:'b',date:'2026-01-01',group:'other',phase4Bucket:'pos_card',effects:[{account:'store_cash',amount:'1'}],previousPosLink:{groupKey:'second',paymentIds:[1]}}];assert.equal(posMatchPlan(example).summary.crossGroupConflicts.length,1);
});
test('Jan-Jun generic period reuse; July-only additions fall outside existing August business-fund scope',()=>{
 for(let month=1;month<=6;month++){
  const period=`2026-${String(month).padStart(2,'0')}`,date=period+'-02',rows=[{row:1,key:`sheet:${period}:1`,date,effects:[{account:'store_cash',amount:'-2'},{account:'baba_corporate_bank',amount:'2'}]},{row:2,key:`sheet:${period}:2`,date,effects:[{account:'card_clearing',amount:'100'}]}];
  const plan=cashPreflight({rows,completedKeys:[],period});assert.equal(plan[1].cashStatus,'reference_only');
  const post=cashPostflight({plan,baseline:[{date,account:'store_cash',before:'10',target:'8'},{date,account:'baba_corporate_bank',before:'1',target:'3'}]});assert.equal(post.matchedAfter,2);
 }
 for(const f of FUNDS)assert.equal(fundMovementInScope(f,'2026-07-31','2026-08'),false);
 // This reuses the known boundary contract; no closed-month DB mutation is performed.
});
