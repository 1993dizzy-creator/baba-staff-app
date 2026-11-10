import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {runInThisContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const external=createRequire(import.meta.url);

// Run the real PATCH handler with an in-memory DB boundary; no env or remote client.
function handler({mode='hire_date',start='2026-07-01',scheduled=false,raise=true,terminated=false,authorized=true}={}) {
 const target={id:5,username:'fixture',name:'QA',role:'staff',hire_date:'2025-11-02',termination_date:terminated?'2026-10-31':null,is_active:!terminated,is_system_account:false,level_program_enabled:true,level_base_date_override:mode==='override'?'2025-12-03':null,level_base_mode:null};
 const version={id:1,enabled:true,effectiveFrom:start,effectiveTo:null,baseDate:mode==='override'?'2025-12-03':'2025-11-02',baseDateMode:mode,revision:1,...(raise?{}:{salaryRaiseEnabled:false})};
 const calls=[],cache=new Map();
 const db={from(table){assert.equal(table,'users');return {select(){return this},eq(key){this.key=key;return this},async maybeSingle(){return {data:this.key==='username'?null:target,error:null}}}},async rpc(name,args){calls.push({name,args});return {data:{...target,...args.p_updates},error:null}}};
 const stubs=new Map([
  ['next/server',{NextResponse:{json:(body,options)=>Response.json(body,options)}}],
  ['@/lib/supabase/server',{supabaseServer:db}],
  ['@/lib/auth/server-auth',{requireRole:async()=>authorized?({ok:true,actor:{id:1,username:'owner'}}):({ok:false,status:403,code:'FORBIDDEN'})}],
  ['@/lib/employee-level/server',{
   loadEmployeeLevelProgramVersions:async(_ids,date)=>new Map([[5,scheduled&&date>='2026-12-01'?{...version,id:2,effectiveFrom:'2026-12-01',revision:2}:version]]),
   getEmployeeLevelInfo:()=>({eligible:true,level:0}),
   applyEmployeeLevelProgramVersion:user=>user,
   withEmployeeLevelInfo:user=>({...user,levelInfo:{}}),
  }],
  ['@/lib/payroll/meal-allowance-eligibility-server',{loadMealAllowanceEligibilityAt:async()=>new Map()}],
 ]);
 function load(file){const path=resolve(file);if(cache.has(path))return cache.get(path).exports;const loadedModule={exports:{}};cache.set(path,loadedModule);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const localRequire=name=>{if(stubs.has(name))return stubs.get(name);if(name==='server-only')return {};if(name.startsWith('.')||name.startsWith('@/')){let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);if(!existsSync(child))child+='.ts';return load(child)}return external(name)};
  runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:path})(localRequire,loadedModule,loadedModule.exports);return loadedModule.exports;
 }
 // Use actual termination rules while fixing the business date for deterministic cases.
 stubs.set('@/lib/employment/termination-policy',{...load('lib/employment/termination-policy.ts'),getVietnamDateKey:()=> '2026-11-10'});
 const {PATCH}=load('app/api/admin/users/route.ts');const {POST}=load('app/api/admin/users/create/route.ts');
 return {calls,create:body=>POST(new Request('http://fixture/api/admin/users/create',{method:'POST',body:JSON.stringify({username:'new',password:'fixture-only',name:'New',role:'staff',hire_date:'2026-11-01',work_start_time:'09:00',work_end_time:'16:00',...body})})),request:body=>PATCH(new Request('http://fixture/api/admin/users',{method:'PATCH',body:JSON.stringify({id:5,lang:'ko',updates:{name:'Edited'},levelProgramEnabled:true,levelBaseDateMode:mode,levelBaseDateOverride:target.level_base_date_override,levelSalaryRaiseEnabled:true,...body})}))};
}

for(const mode of ['hire_date','override'])test(`basic-info-only ${mode} save keeps legacy policy and no effective date`,async()=>{
 const {request,calls}=handler({mode});const res=await request({levelEffectiveFrom:null});assert.equal(res.status,200);assert.equal(calls.length,1);assert.equal(calls[0].args.p_base_date_mode,mode);assert.equal(calls[0].args.p_effective_from,null);
});

test('explicit monthly conversion uses safe v11 and preserves actual hire date',async()=>{
 const {request,calls}=handler();const res=await request({levelBaseDateMode:'hire_month',levelEffectiveFrom:'2026-12-01'});assert.equal(res.status,200);assert.equal(calls.length,1);assert.equal(calls[0].name,'employee_update_profile_and_level_v11');assert.equal(calls[0].args.p_base_date_mode,'hire_month');assert.equal(calls[0].args.p_effective_from,'2026-12-01');assert.equal('hire_date' in calls[0].args.p_updates,false);
});

test('same-month legacy row is protected before RPC',async()=>{
 const {request,calls}=handler({scheduled:true});const res=await request({levelBaseDateMode:'hire_month',levelEffectiveFrom:'2026-12-01'});assert.equal(res.status,409);assert.equal((await res.json()).code,'LEVEL_POLICY_SCHEDULED_CHANGE_EXISTS');assert.equal(calls.length,0);
});

test('a changed legacy policy cannot be saved as another date-based version',async()=>{
 const {request,calls}=handler();const res=await request({levelProgramEnabled:false,levelEffectiveFrom:'2026-12-01'});assert.equal(res.status,400);assert.equal((await res.json()).code,'LEVEL_MONTH_BASE_REQUIRED');assert.equal(calls.length,0);
});

test('new policy changes default to next month and auto-include raises without a choice',async()=>{const {request,calls}=handler();const res=await request({levelBaseDateMode:'hire_month',levelSalaryRaiseEnabled:false,levelPolicyEdit:true});assert.equal(res.status,200);assert.equal(calls[0].args.p_effective_from,'2026-12-01');assert.equal(calls[0].args.p_salary_raise_enabled,true);assert.equal(calls[0].args.p_expected_version_id,1);assert.equal(calls[0].args.p_expected_revision,1)});
test('basic profile save preserves historical raise exclusion even when old client includes a different raise flag',async()=>{const {request,calls}=handler({raise:false});const res=await request({});assert.equal(res.status,200);assert.equal(calls[0].args.p_effective_from,null);assert.equal(calls[0].args.p_salary_raise_enabled,false)});
test('unchanged explicit apply still sends no effective policy date',async()=>{const {request,calls}=handler();const res=await request({levelPolicyEdit:true});assert.equal(res.status,200);assert.equal(calls[0].args.p_effective_from,null)});
test('current-month changes are rejected rather than backdated',async()=>{const {request,calls}=handler();const res=await request({levelBaseDateMode:'hire_month',levelEffectiveFrom:'2026-11-01'});assert.equal(res.status,400);assert.equal(calls.length,0)});
test('basic save leaves the reserved next policy intact',async()=>{const {request,calls}=handler({scheduled:true});const res=await request({});assert.equal(res.status,200);assert.equal(calls[0].args.p_effective_from,null)});
for(const part of ['hall','kitchen'])test('create ON policy includes salary raise automatically for '+part,async()=>{const {create,calls}=handler();const res=await create({part,level_program_enabled:true,level_salary_raise_enabled:false});assert.equal(res.status,200);assert.equal(calls[0].name,'employee_create_with_schedule_v6');assert.equal(calls[0].args.p_salary_raise_enabled,true)});
test('rehire ON policy includes salary raise automatically',async()=>{const {request,calls}=handler({terminated:true});const res=await request({action:'rehire',rehireDate:'2026-11-10',confirmPreviousPayrollCompleted:true,levelProgramEnabled:true,levelSalaryRaiseEnabled:false});assert.equal(res.status,200);assert.equal(calls[0].name,'employee_rehire_with_level_policy_v4');assert.equal(calls[0].args.p_salary_raise_enabled,true)});
test('authorization is enforced before any mutation',async()=>{const {request,calls}=handler({authorized:false});const res=await request({levelBaseDateMode:'hire_month'});assert.equal(res.status,403);assert.equal(calls.length,0)});
