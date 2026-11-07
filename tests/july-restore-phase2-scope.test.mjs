// Offline phase-2 scope only. Never loads credentials or queries a database.
// JULY_PHASE2_INPUT_DIR points to this worktree's preserved .local/july-restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const root=process.env.JULY_PHASE2_INPUT_DIR;
const options={skip:!root};
const load=name=>JSON.parse(readFileSync(join(root,name),'utf8'));
const applied=[11,17,30,43,45,56,67,91,95,96,108,125,126,136,147,163,173,185,191,193,198,216,220,221,225,236,238,249,258,262,275,277,282,284,291,298,302,306,311,314,319,331,340,353,357,363,368,374,381];
const originals={
 'dry-run-20261107-v2/395-row-dry-run.json':'3cf683f65aa4afbea718de6362364672917065eed2611dd33c1b000a37734da6',
 'runtime-review-20261107-final/82-candidate-decisions.json':'80a92e00b8014b1128140cf23b20f80e0255b35b723475e6acf95eb10f2bae01',
 'runtime-review-20261107-final/148-source-links.json':'6f581799fc18d2f2254aa086f4655e387c699b972ca0c827780cbdf7070b9b43',
};

test('phase 2 reuses unchanged prior PASS inputs, without repeating source reconciliation',options,()=>{
 for(const [name,hash] of Object.entries(originals))
  assert.equal(createHash('sha256').update(readFileSync(join(root,name))).digest('hex'),hash,name);
 const decisions=load('runtime-review-20261107-final/82-candidate-decisions.json');
 assert.deepEqual(decisions.filter(r=>r.status==='ready').map(r=>r.row).sort((a,b)=>a-b),applied);
});

test('remaining scope is exactly 345 unchanged rows; applied 49 and existing #1190 never enter it',options,()=>{
 const source=load('dry-run-20261107-v2/395-row-dry-run.json');
 const remaining=load('phase2-discovery-20261107/remaining-345.json');
 const expected=source.filter(r=>!applied.includes(r.row)&&r.row!==395);
 assert.equal(remaining.length,345);
 assert.equal(new Set(remaining.map(r=>r.row)).size,345);
 assert.equal(new Set(remaining.map(r=>r.key)).size,345);
 assert.deepEqual(remaining,expected); // Includes dates, account amounts, notes, source keys.
 assert.ok(remaining.every(r=>r.executable===false));
 const linked=source.find(r=>r.row===395);
 assert.equal(linked.status,'link_existing');
 assert.match(linked.mappingNotes,/#1190/);
});

test('scope removal preserves exact residual fund effects, with card clearing kept separate',options,()=>{
 const remaining=load('phase2-discovery-20261107/remaining-345.json');
 const totals={};
 for(const row of remaining)for(const e of row.effects)
  totals[e.account]=(BigInt(totals[e.account]??0)+BigInt(e.amount)).toString();
 assert.deepEqual(totals,{
  baba_corporate_bank:'-277306320',store_cash:'-91183400',
  card_clearing:'219868620',cho_personal_custody:'90049900',
  vuong_personal_custody:'-10841700',
 });
 // These are all residual source rows, never an approved batch or current DB balances.
 assert.equal(Object.entries(totals).filter(([k])=>k!=='card_clearing')
  .reduce((sum,[,v])=>sum+BigInt(v),0n),-289281520n);
});
