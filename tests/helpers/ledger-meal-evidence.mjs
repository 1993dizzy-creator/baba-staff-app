import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {install} from './ledger-meal-consolidation-fixture.mjs';
const root='scripts/ledger/evidence/20261031/';
export const evidenceManifest=JSON.parse(readFileSync(root+'manifest.json','utf8'));
export function verifyEvidence(){for(const [file,hash] of Object.entries(evidenceManifest.files)){
  if(createHash('sha256').update(readFileSync(root+file)).digest('hex')!==hash)throw Error('EVIDENCE_HASH_MISMATCH '+file);
}}
function csv(file){const [header,...lines]=readFileSync(root+file,'utf8').trim().split(/\r?\n/);return lines.map(line=>Object.fromEntries(line.split(',').map((v,i)=>[header.split(',')[i],v])));}
export const manualEvidence=csv('confirmed_manual_meals_20.csv');
export const accountEvidence=csv('app_vs_sheet_daily_120_cells.csv');
const codes={cash:'store_cash',corporate_bank:'baba_corporate_bank',cho_personal:'cho_personal_custody',vuong_personal:'vuong_personal_custody'};
export const expectedDaily=accountEvidence.filter(r=>r.is_within_108_baseline==='True').map(r=>({business_date:r.date,account_code:codes[r.account],amount:Number(r.sheet_delta_vnd)}));
export const expectedPairs=manualEvidence.map(r=>({manual_id:Number(r.manual_tx_id),automatic_id:Number(r.auto_tx_id),business_date:r.date,
  amount:Number(r.manual_amount_vnd),automatic_amount:Number(r.auto_amount_vnd),final_amount:Number(r.expected_final_vnd),source_key:r.manual_source_key}));

// Local reconstruction: exact supplied target IDs, dates, amounts and source keys.
// Unknown non-target auto IDs and aggregate residual transactions are explicitly
// synthetic. This tests the supplied 108 balances; it is not a full live DB dump.
export async function installEvidence(db){
  verifyEvidence();await install(db);
  await db.exec(`delete from ledger_candidates where id between 6001 and 6027;
    delete from ledger_movements where transaction_id between 6001 and 7020;
    delete from ledger_transactions where id between 6001 and 7020;
    update ledger_fund_accounts set id=5 where id=4;
    insert into ledger_categories values(6,'직원 식대','expense',true);`);
  for(let day=1;day<=30;day++){
    const date='2026-10-'+String(day).padStart(2,'0'),e=manualEvidence.find(r=>r.date===date);
    const id=e?Number(e.auto_tx_id):9000+day,amount=e?Number(e.auto_amount_vnd):300000,count=e?Number(e.auto_employee_count):10;
    await db.query(`insert into ledger_transactions(id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,confirmed_by)
      values($1,'expense',$2,$3,'2026-10-01',$4,6,'confirmed','attendance_meal_daily_candidate',$5,$6,repeat('a',64),1)`,
      [id,date+'T11:00:00Z',date,amount,'candidate:'+id,{total_amount:amount,employee_count:count}]);
    await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,1,$2)',[id,-amount]);
    // Drift content is unknown in the CSV: synthetic revisions exercise preservation.
    const drift=[13,15,20,24].includes(day)?{total_amount:amount+90000,employee_count:count+3,fixtureOnly:true}:null;
    await db.query(`insert into ledger_candidates values($1,$1,'employee_meal','attendance_meal_daily','confirmed',$2,$3,$4)`,
      [id,{total_amount:amount,employee_count:count},drift,drift?'b'.repeat(64):null]);
    if(e){
      await db.query(`insert into ledger_transactions(id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,confirmed_by,memo)
        values($1,'expense',$2,$3,'2026-10-01',$4,6,'confirmed','manual',$5,1,$6)`,
        [Number(e.manual_tx_id),date+'T11:00:00Z',date,Number(e.manual_amount_vnd),e.manual_source_key,'기존 수기 식대 · 시트 '+e.sheet_row+'행']);
      await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,1,$2)',[Number(e.manual_tx_id),Number(e.cash_delta_vnd)]);
    }
  }
  await db.exec(`insert into ledger_transactions(id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,confirmed_by)
    values(3385,'expense','2026-10-01T11:00Z','2026-10-01','2026-10-01',30000,6,'cancelled','manual',1);
    insert into ledger_movements(transaction_id,fund_account_id,amount) values(3385,1,-30000);
    select setval(pg_get_serial_sequence('ledger_transactions','id'),10000);`);
  // Account-day residuals represent other ledger activity in aggregate; they
  // retain the supplied Oct 28-30 discrepancies without guessing meal corrections.
  for(const e of accountEvidence){
    const current=(await db.query(`select coalesce(sum(m.amount),0) amount from ledger_transactions t join ledger_movements m on m.transaction_id=t.id
      where t.status='confirmed' and t.business_date=$1 and m.fund_account_id=$2`,[e.date,Number(e.app_fund_account_id)])).rows[0];
    const delta=Number(e.app_delta_vnd)-Number(current.amount);if(!delta)continue;
    const tx=(await db.query(`insert into ledger_transactions(type,occurred_at,business_date,amount,status,source_type,confirmed_by,memo)
      values('balance_adjustment',$1,$2,$3,'confirmed','fixture_account_residual',1,'Synthetic aggregate residual, not production journal detail') returning id`,[e.date+'T11:00:00Z',e.date,Math.abs(delta)])).rows[0];
    await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) values($1,$2,$3)',[tx.id,Number(e.app_fund_account_id),delta]);
  }
}
export async function evidenceFreshManifest(db){return (await db.query(`select m.id manual_id,a.id automatic_id,
  m.business_date::text business_date,m.amount::numeric amount,
  md5(to_jsonb(m)::text) manual_hash,md5(to_jsonb(a)::text) automatic_hash,md5(to_jsonb(c)::text) candidate_hash,
  (select md5(jsonb_agg(to_jsonb(mv) order by mv.id)::text) from ledger_movements mv where transaction_id=m.id) movement_hash
  from ledger_transactions m join ledger_transactions a on a.business_date=m.business_date and a.source_type='attendance_meal_daily_candidate'
  join ledger_candidates c on c.resolved_transaction_id=a.id where m.id=any($1) order by m.id`,[expectedPairs.map(p=>p.manual_id)])).rows;}
