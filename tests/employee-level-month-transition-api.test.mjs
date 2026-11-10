import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {runInThisContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const external=createRequire(import.meta.url);

// Run the real PATCH handler with an in-memory DB boundary; no env or remote client.
function handler({mode='hire_date',start='2026-07-01'}={}) {
 const target={id:5,username:'fixture',name:'QA',role:'staff',hire_date:'2025-11-02',termination_date:null,is_active:true,is_system_account:false,level_program_enabled:true,level_base_date_override:mode==='override'?'2025-12-03':null,level_base_mode:null};
 const version={id:1,enabled:true,effectiveFrom:start,effectiveTo:null,baseDate:mode==='override'?'2025-12-03':'2025-11-02',baseDateMode:mode,revision:1};
 const calls=[],cache=new Map();
 const db={from(table){assert.equal(table,'users');return {select(){return this},eq(){return this},async maybeSingle(){return {data:target,error:null}}}},async rpc(name,args){calls.push({name,args});return {data:{...target,...args.p_updates},error:null}}};
 const stubs=new Map([
  ['next/server',{NextResponse:{json:(body,options)=>Response.json(body,options)}}],
  ['@/lib/supabase/server',{supabaseServer:db}],
  ['@/lib/auth/server-auth',{requireRole:async()=>({ok:true,actor:{id:1,username:'owner'}})}],
  ['@/lib/employee-level/server',{
   loadEmployeeLevelProgramVersions:async()=>new Map([[5,version]]),
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
 const {PATCH}=load('app/api/admin/users/route.ts');
 return {calls,request:body=>PATCH(new Request('http://fixture/api/admin/users',{method:'PATCH',body:JSON.stringify({id:5,lang:'ko',updates:{name:'Edited'},levelProgramEnabled:true,levelBaseDateMode:mode,levelBaseDateOverride:target.level_base_date_override,levelSalaryRaiseEnabled:true,...body})}))};
}

for(const mode of ['hire_date','override'])test(`basic-info-only ${mode} save keeps legacy policy and no effective date`,async()=>{
 const {request,calls}=handler({mode});const res=await request({levelEffectiveFrom:null});assert.equal(res.status,200);assert.equal(calls.length,1);assert.equal(calls[0].args.p_base_date_mode,mode);assert.equal(calls[0].args.p_effective_from,null);
});

test('explicit monthly conversion uses existing v10 and preserves actual hire date',async()=>{
 const {request,calls}=handler();const res=await request({levelBaseDateMode:'hire_month',levelEffectiveFrom:'2026-12-01'});assert.equal(res.status,200);assert.equal(calls.length,1);assert.equal(calls[0].name,'employee_update_profile_and_level_v10');assert.equal(calls[0].args.p_base_date_mode,'hire_month');assert.equal(calls[0].args.p_effective_from,'2026-12-01');assert.equal('hire_date' in calls[0].args.p_updates,false);
});

test('same-month legacy row is protected before RPC',async()=>{
 const {request,calls}=handler({start:'2026-12-01'});const res=await request({levelBaseDateMode:'hire_month',levelEffectiveFrom:'2026-12-01'});assert.equal(res.status,409);assert.equal((await res.json()).code,'LEVEL_MONTH_TRANSITION_CONFLICT');assert.equal(calls.length,0);
});

test('a changed legacy policy cannot be saved as another date-based version',async()=>{
 const {request,calls}=handler();const res=await request({levelProgramEnabled:false,levelEffectiveFrom:'2026-12-01'});assert.equal(res.status,400);assert.equal((await res.json()).code,'LEVEL_MONTH_BASE_REQUIRED');assert.equal(calls.length,0);
});
