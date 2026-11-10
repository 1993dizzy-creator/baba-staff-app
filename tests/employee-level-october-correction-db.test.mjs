import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const base=readFileSync('tests/employee-level-month-base-db.test.mjs','utf8');
const schema=base.match(/const FIXTURE = `([\s\S]*?)`;/)[1];
const migration=readFileSync('docs/sql/employee-level-month-base-v1-draft.sql','utf8');
const scripts=Object.fromEntries(['execute-draft','preflight','postflight'].map(k=>[k,readFileSync(`docs/sql/employee-level-october-correction-${k}.sql`,'utf8')]));
const pairs=[...scripts['execute-draft'].matchAll(/\((\d+),(\d+),(\d+),'([^']+)'::date,'([^']+)','([a-f0-9]+)','([a-f0-9]+)','([a-f0-9]+)'\)/g)].slice(0,11).map(m=>({id:+m[1],old:+m[2],next:+m[3],date:m[4],mode:m[5],oldHash:m[6],newHash:m[7],userHash:m[8]}));
const marker='employee_level_october_correction_20261110_v1';
const mirror=`jsonb_build_object('id',u.id,'hire_date',u.hire_date,'termination_date',u.termination_date,'is_active',u.is_active,'is_system_account',u.is_system_account,'level_program_enabled',u.level_program_enabled,'level_base_date_override',u.level_base_date_override,'level_base_mode',u.level_base_mode)`;
async function setup(){const db=new PGlite();await db.exec(schema);await db.exec(migration);
 await db.exec(`insert into users(id,username,password,name,role,hire_date) values (1,'owner','fixture-only','Owner','owner','2025-01-01'); select set_config('baba.level_correction_actor_id','1',false);`);
 for(const p of pairs){const auto=p.mode==='hire_month';const hire=p.id===6?'2025-12-03':p.date.slice(0,7)+'-02';const oldBase=p.id===6?'2026-01-03':auto?hire:p.date;
  await db.query(`insert into users(id,username,password,name,hire_date,level_program_enabled,level_base_date_override) values($1,$2,'fixture-only','QA',$3,true,$4)`,[p.id,'qa'+p.id,hire,auto?null:oldBase]);
  await db.query(`insert into employee_level_program_versions(id,user_id,enabled,effective_from,effective_to,base_date,base_date_mode,revision,change_reason,created_by,created_by_username) values($1,$2,true,'2026-07-01','2026-12-01',$3,$4,1,'fixture',1,'owner'),($5,$2,true,'2026-12-01',null,$6,$7,2,'fixture',1,'owner')`,[p.old,p.id,oldBase,auto?'hire_date':'override',p.next,p.date,p.mode]);
  for(let n=0;n<2;n++)await db.query(`insert into payroll_employee_payments values($1,$2,'{"levelSnapshot":{"level":4}}','fixture-hash',123456,'paid')`,[p.id*10+n,p.id]);
 }
 await db.exec(`insert into employee_level_audit_logs(user_id,action,actor_username,change_reason) values(2,'level_base_date_changed','owner','existing-audit');`);
 const hash=(await db.query(`select md5(coalesce(string_agg(md5(to_jsonb(p)::text),',' order by id),'')) h from payroll_employee_payments p`)).rows[0].h;
 // Only expected baseline digests are replaced with independently seeded fixture digests.
 // Production constants and all gate comparisons/counts remain in the shipped files.
 let transformed=Object.fromEntries(Object.entries(scripts).map(([k,s])=>[k,s.replaceAll('6a3013ee9ab4288f07fcb3d361d889bc',hash)]));
 for(const p of pairs){const rows=(await db.query(`select md5(to_jsonb(v)::text) h,id from employee_level_program_versions v where id in($1,$2)`,[p.old,p.next])).rows;
  const userHash=(await db.query(`select md5((${mirror})::text) h from users u where id=$1`,[p.id])).rows[0].h;
  for(const k of Object.keys(transformed))for(const [a,b]of [[p.oldHash,rows.find(r=>+r.id===p.old).h],[p.newHash,rows.find(r=>+r.id===p.next).h],[p.userHash,userHash]])transformed[k]=transformed[k].replaceAll(a,b);
 }
 return {db,sql:transformed};}
const state=async db=>Object.fromEntries(await Promise.all(['users','employee_level_program_versions','employee_level_audit_logs','payroll_employee_payments'].map(async t=>[t,(await db.query(`select to_jsonb(t) row from ${t} t order by id`)).rows])));

test('October correction: 11 version pairs + mirrors atomically, audit pre/post images, paid rows unchanged, rerun refused',async()=>{const {db,sql}=await setup();try{
 await db.exec(sql.preflight);const before=await state(db);await db.exec(sql['execute-draft']);await db.exec(sql.postflight);const after=await state(db);
 assert.deepEqual(after.payroll_employee_payments,before.payroll_employee_payments);
 assert.deepEqual(after.employee_level_audit_logs.slice(0,1),before.employee_level_audit_logs);
 assert.equal(after.employee_level_audit_logs.length,12);
 for(const a of after.employee_level_audit_logs.slice(1)){assert.equal(a.row.change_reason,marker);assert.equal(a.row.previous_version_snapshot.old_version.effective_to,'2026-12-01');assert.equal(a.row.next_version_snapshot.old_version.effective_to,'2026-10-01');assert.equal(a.row.next_version_snapshot.new_version.effective_from,'2026-10-01');assert.equal(a.row.actor_id,1);}
 for(const p of pairs){const u=after.users.find(x=>x.row.id===p.id).row;assert.equal(u.level_base_mode,p.mode);assert.equal(u.level_base_date_override,p.mode==='override_month'?p.date:null);assert.equal(u.hire_date,before.users.find(x=>x.row.id===p.id).row.hire_date);}
 await assert.rejects(db.exec(sql['execute-draft']),/DRIFT|ALREADY_APPLIED/);await db.exec('rollback');assert.deepEqual(await state(db),after);
}finally{await db.close()}});

for(const [label,mutate,expected]of [
 ['payment fingerprint',`update payroll_employee_payments set calculated_net_amount=7 where id=20`,'BASELINE_MISMATCH'],
 ['payment count',`delete from payroll_employee_payments where id=20`,'BASELINE_MISMATCH'],
 ['paid status',`update payroll_employee_payments set payment_status='unpaid' where id=20`,'BASELINE_MISMATCH'],
 ['version drift',`update employee_level_program_versions set revision=99 where id=34`,'SOURCE_DRIFT'],
 ['mirror drift',`update users set level_base_date_override='2025-11-01' where id=2`,'SOURCE_DRIFT'],
 ['partial correction',`update employee_level_program_versions set effective_to='2026-10-01' where id=15`,'SOURCE_DRIFT'],
 ['conflicting future policy',`insert into employee_level_program_versions(id,user_id,enabled,effective_from,base_date,base_date_mode,revision,change_reason,created_by_username) values(90,5,true,'2027-01-01','2025-11-01','hire_month',3,'conflict','owner')`,'SOURCE_DRIFT'],
 ['unauthorized actor',`select set_config('baba.level_correction_actor_id','999',false)`,'ACTOR_REQUIRED'],
])test(`correction rejects ${label} without applying any rows`,async()=>{const {db,sql}=await setup();try{await db.exec(mutate);const before=await state(db);await assert.rejects(db.exec(sql['execute-draft']),new RegExp(expected));await db.exec('rollback');assert.deepEqual(await state(db),before)}finally{await db.close()}});

test('failure on audit INSERT rolls back both version changes and mirrors',async()=>{const {db,sql}=await setup();try{
 await db.exec(`create function fail_correction_audit() returns trigger language plpgsql as $$ begin if new.user_id=10 then raise exception 'STAGED_AUDIT_FAILURE'; end if;return new;end $$; create trigger staged before insert on employee_level_audit_logs for each row execute function fail_correction_audit();`);
 const before=await state(db);await assert.rejects(db.exec(sql['execute-draft']),/STAGED_AUDIT_FAILURE/);await db.exec('rollback');assert.deepEqual(await state(db),before);
}finally{await db.close()}});
