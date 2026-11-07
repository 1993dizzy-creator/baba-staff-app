import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCsv,reviewJulySources} from '../scripts/ledger/july-restore-source-review.mjs';
test('CSV preserves quoted commas, escaped quotes, multiline Vietnamese/Korean and blank versus zero',()=>{
 assert.deepEqual(parseCsv('\uFEFFid,memo,amount\r\n4,"Chợ, 가게 ""A""\n메모",0\r\n5,test,\r\n'),[{id:'4',memo:'Chợ, 가게 "A"\n메모',amount:'0'},{id:'5',memo:'test',amount:''}]);
 assert.throws(()=>parseCsv('id,memo\n4,"unfinished'),/UNCLOSED/);
 assert.throws(()=>parseCsv('id,memo\n4,a,5'),/WIDTH/);
});
test('owner export: all 395 mapped rows, 31 targets, 155 delta cells and 124 closing cells', {skip:!process.env.JULY_INPUT_DIR},()=>{
 const r=reviewJulySources(process.env.JULY_INPUT_DIR);
 assert.equal(r.summary.status,'PASS_SOURCE_DRY_RUN');assert.equal(r.rows.length,395);assert.equal(new Set(r.rows.map(x=>x.key)).size,395);
 assert.equal(r.summary.checks.mappingRowIdentityAndDate,395);assert.equal(r.summary.checks.dailyAccountDeltaMatches,155);assert.equal(r.summary.checks.dailyBusinessClosingMatches,124);
 assert.deepEqual(r.summary.byStatus,{needs_link:148,hold:13,needs_confirmation:151,registration_candidate:82,link_existing:1});
 assert.equal(r.rows.filter(x=>x.sourceType==='매출 / 정산').length,126);
 assert.equal(r.rows.filter(x=>x.sourceType==='매출 / 정산'&&x.group==='other').length,94);
 assert.equal(r.rows.find(x=>x.row===395).status,'link_existing');
 assert.equal(r.rows.find(x=>x.row===33).status,'hold');
 assert.ok([114,154,344].every(n=>r.rows.find(x=>x.row===n).status==='hold'));
 assert.ok(r.rows.every(x=>x.executable===false));
 assert.equal(r.summary.cardCarryover.unresolvedEffectOnCurrentClearing,'-6102347');
 // All batch cash effects reconstruct the supplied month, including held rows.
 for(const account of ['store_cash','vuong_personal_custody','cho_personal_custody','baba_corporate_bank']) {
  assert.equal(Object.values(r.summary.batches).reduce((s,b)=>s+BigInt(b.deltas[account]),0n).toString(),r.summary.controlTotals.deltas[account]);
 }
});
