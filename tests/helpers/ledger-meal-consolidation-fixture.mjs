import {readFileSync} from 'node:fs';
import {fixtureSql,readMigration as manualMigration} from './ledger-manual-edit-native-fixture.mjs';
export const mealMigration=()=>readFileSync('supabase/migrations/20261031070537_meal_adjustment_original_business_date.sql','utf8');
export const applySql=()=>readFileSync('scripts/ledger/oct-meal-consolidation-apply.sql','utf8');
export async function install(db){
  let sql=fixtureSql.replace('create table ledger_candidates(id bigint primary key,resolved_transaction_id bigint references ledger_transactions(id));',
    `create table ledger_candidates(id bigint primary key,resolved_transaction_id bigint references ledger_transactions(id),candidate_type text,source_type text,status text,source_snapshot jsonb,source_drift_snapshot jsonb,source_drift_fingerprint text);`);
  const seed=`
    alter table ledger_fund_accounts add column is_business_fund boolean default true,add column active_from date default '2026-01-01',add column active_to date;
    update ledger_fund_accounts set is_business_fund=false where id=9;
    insert into ledger_fund_accounts(id,code,is_active) values(4,'vuong_personal_custody',true);
    insert into ledger_categories values(7,'직원 식대','expense',true);
    insert into ledger_transactions(id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,confirmed_by)
    select 6000+d,'expense','2026-10-01T11:00Z'::timestamptz+(d-1)*interval '1 day','2026-10-01'::date+d-1,'2026-10-01',300000,7,'confirmed',
      'attendance_meal_daily_candidate','candidate:'||(6000+d),'{"total_amount":300000,"employee_count":10}',repeat('a',64),1 from generate_series(1,27) d;
    insert into ledger_candidates select id,id,'employee_meal','attendance_meal_daily','confirmed',source_snapshot,'{"total_amount":360000,"employee_count":12}',repeat('b',64)
      from ledger_transactions where id between 6001 and 6027;
    insert into ledger_transactions(id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,confirmed_by,memo)
    select 7000+d,'expense','2026-10-01T11:00Z'::timestamptz+(d-1)*interval '1 day','2026-10-01'::date+d-1,'2026-10-01',case when d=1 then 60000 else 30000 end,7,'confirmed','manual','fixture:manual:'||d,1,'시트 식대 추가 검산' from generate_series(1,20) d;
    insert into ledger_transactions(id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,confirmed_by,correction_of_id)
    values(2112,'expense','2026-09-29T11:00Z','2026-09-29','2026-09-01',300000,7,'confirmed','attendance_meal_daily_candidate','candidate:2112','{"total_amount":300000}',repeat('a',64),1,null),
    (2163,'expense','2026-10-01T11:00Z','2026-10-01','2026-09-01',30000,7,'confirmed','ledger_correction',null,'{}',repeat('a',64),1,2112);
    insert into ledger_movements(transaction_id,fund_account_id,amount) select id,1,-amount from ledger_transactions where id between 6001 and 7020 or id in(2112,2163);
    select setval(pg_get_serial_sequence('ledger_transactions','id'),8000);
  `;
  sql=sql.replace('create trigger ledger_transactions_month_guard',seed+'\ncreate trigger ledger_transactions_month_guard');
  await db.exec(sql);await db.exec(manualMigration());await db.exec(mealMigration());
}
export async function manifest(db){return (await db.query(`select m.id manual_id,a.id automatic_id,
  md5(to_jsonb(m)::text) manual_hash,md5(to_jsonb(a)::text) automatic_hash,md5(to_jsonb(c)::text) candidate_hash,
  (select md5(jsonb_agg(to_jsonb(mv) order by mv.id)::text) from ledger_movements mv where transaction_id=m.id) movement_hash
  from ledger_transactions m join ledger_transactions a on a.business_date=m.business_date and a.source_type='attendance_meal_daily_candidate'
  join ledger_candidates c on c.resolved_transaction_id=a.id where m.id between 7001 and 7020 order by m.id`)).rows;}
export async function daily(db){return (await db.query(`select d::date::text business_date,f.code account_code,coalesce(sum(m.amount),0)::numeric::text amount
  from generate_series('2026-10-01'::date,'2026-10-27'::date,interval '1 day') d cross join ledger_fund_accounts f
  left join ledger_transactions t on t.business_date=d::date and t.status='confirmed'
  left join ledger_movements m on m.transaction_id=t.id and m.fund_account_id=f.id
  where f.is_business_fund group by d,f.code order by d,f.code`)).rows;}
export async function approvedSql(db){
  const pairs=(await db.query(`select m.id manual_id,a.id automatic_id,m.business_date::text business_date,m.amount::int amount,
    a.amount::int automatic_amount,(a.amount+m.amount)::int final_amount,m.source_key from ledger_transactions m
    join ledger_transactions a on a.business_date=m.business_date and a.source_type='attendance_meal_daily_candidate'
    where m.id between 7001 and 7020 order by m.id`)).rows;
  return applySql().replace("v_manifest jsonb := '[]'",`v_manifest jsonb := '${JSON.stringify(await manifest(db))}'`)
    .replace(/v_expected_daily jsonb := '[^']*'/,`v_expected_daily jsonb := '${JSON.stringify(await daily(db))}'`)
    .replace(/v_expected_pairs constant jsonb := '[^']*'/,`v_expected_pairs constant jsonb := '${JSON.stringify(pairs)}'`)
    .replace('v_actor bigint := null','v_actor bigint := 1');
}
export async function snapshot(db){return (await db.query(`select jsonb_build_object(
 'transactions',(select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t),
 'movements',(select jsonb_agg(to_jsonb(t) order by id) from ledger_movements t),
 'candidates',(select jsonb_agg(to_jsonb(t) order by id) from ledger_candidates t),
 'closures',(select jsonb_agg(to_jsonb(t) order by id) from ledger_month_closures t),
 'audits',(select jsonb_agg(to_jsonb(t) order by id) from ledger_audit_logs t)) s`)).rows[0].s;}
