import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {install} from './helpers/payroll-batch-safety-fixture.mjs';

const external=createRequire(import.meta.url),cache=new Map();let calls=[],database=null;
const supabase={from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){return {data:null,error:null};}}),
  async rpc(name,args){calls.push({name,args});
    assert.ok(['employee_create_with_schedule_v6','employee_create_with_proration_v1'].includes(name));
    if(!database)return {data:{id:77},error:null};
    const result=await database.query(`select public.${name}($1::jsonb,$2::boolean,$3::text,$4::date,$5::boolean,$6::text,$7::bigint,$8::text) r`,[
      JSON.stringify(args.p_employee),args.p_level_program_enabled,args.p_base_date_mode,args.p_base_date_override,
      args.p_salary_raise_enabled,args.p_change_reason,args.p_actor_id,args.p_actor_username]);
    return {data:result.rows[0].r,error:null};
  }};
const stubs=new Map([
  ['next/server',{NextResponse:{json:(body,init)=>new Response(JSON.stringify(body),init)}}],
  ['@/lib/supabase/server',{supabaseServer:supabase}],
  ['@/lib/auth/server-auth',{requireRole:async()=>({ok:true,actor:{id:1,username:'owner'}})}],
  ['@/lib/payroll/first-month-proration-server',{firstMonthEnrollmentEnabled:()=>true}],
]);
function load(file){
  const path=resolve(file);if(cache.has(path))return cache.get(path).exports;
  const m={exports:{}};cache.set(path,m);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const require=name=>{if(stubs.has(name))return stubs.get(name);
    if(name.startsWith('.')||name.startsWith('@/')){let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);if(!existsSync(child))child+='.ts';return load(child);}return external(name);};
  new Function('require','module','exports',code)(require,m,m.exports);return m.exports;
}
const {POST}=load('app/api/admin/users/create/route.ts');
const body=(extra={})=>({username:'api-fixture',password:'local-test-only',name:'Fixture',role:'staff',hire_date:'2026-11-16',
  work_start_time:'16:00',work_end_time:'01:00',attendance_tracking_enabled:true,level_program_enabled:false,is_active:false,app_login_enabled:false,...extra});
const request=data=>new Request('http://local.test/api/admin/users/create',{method:'POST',body:JSON.stringify(data)});

for(const lang of ['ko','vi'])for(const marker of ['first_month_proration','attendance_tracking_enabled']){
  test(`${lang}: fixed-pay + level ON rejected before saving (${marker})`,async()=>{
    calls=[];const response=await POST(request(body({lang,level_program_enabled:true,[marker]:marker==='first_month_proration'})));
    assert.equal(response.status,400);const result=await response.json();assert.equal(result.code,'FIXED_PAY_LEVEL_NOT_ALLOWED');
    assert.ok(result.error);assert.equal(calls.length,0);
  });
}
test('fixed legacy request without a level field defaults OFF; hidden account flags cannot disable new accounts',async()=>{
  calls=[];const data=body({attendance_tracking_enabled:false});delete data.level_program_enabled;
  assert.equal((await POST(request(data))).status,200);
  assert.equal(calls[0].args.p_level_program_enabled,false);assert.equal(calls[0].args.p_salary_raise_enabled,null);
  assert.equal(calls[0].args.p_employee.is_active,true);assert.equal(calls[0].args.p_employee.app_login_enabled,true);
});
test('actual create API → existing RPC stores active/login ON and preserves level boundaries and fixed enrollment',async()=>{
  database=await install(new PGlite({extensions:{btree_gist}}));
  try{
    for(const [index,extra] of [
      {level_program_enabled:false},
      {level_program_enabled:true,hire_date:'2026-11-15'},
      {level_program_enabled:true},
      {first_month_proration:true,attendance_tracking_enabled:false},
      {role:'owner',level_program_enabled:false},
    ].entries()){
      calls=[];const response=await POST(request(body({username:'api-'+index,...extra})));
      assert.equal(response.status,200);const id=(await response.json()).user.id;
      const saved=(await database.query('select is_active,app_login_enabled,level_program_enabled,attendance_tracking_enabled from users where id=$1',[id])).rows[0];
      assert.equal(saved.is_active,true);assert.equal(saved.app_login_enabled,true);
      assert.equal(saved.level_program_enabled,extra.level_program_enabled??false);
      assert.equal(saved.attendance_tracking_enabled,extra.attendance_tracking_enabled??true);
      if(extra.level_program_enabled){
        const policy=(await database.query('select base_date::text from employee_level_program_versions where user_id=$1',[id])).rows[0];
        assert.equal(policy.base_date,extra.hire_date?'2026-11-01':'2026-12-01');
      }
      if(extra.first_month_proration)assert.equal((await database.query('select status from payroll_first_month_policies where user_id=$1',[id])).rows[0].status,'pending');
    }
  }finally{await database.close();database=null;}
});
