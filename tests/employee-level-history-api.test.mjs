import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {runInThisContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const external=createRequire(import.meta.url);


function fixture({authorized=true,error=false,missing=false}={}){
 const calls=[],cache=new Map();
 const db={from(table){let selection;const result=()=>({error:error?{message:'failed'}:null,data:table==='users'?(missing?null:{role:'staff',hire_date:'2025-11-02',termination_date:null,is_system_account:false}):table==='employee_level_program_versions'?[{id:34,user_id:5,enabled:true,effective_from:'2026-10-01',effective_to:null,base_date:'2025-11-01',base_date_mode:'hire_month',revision:2}]:table==='employee_level_audit_logs'?[{id:1,action:'policy_changed',created_at:'2026-10-01T00:00:00Z'}]:[{id:7,pay_type:'hourly',base_salary:35000,fixed_raise_amount:0,standard_workdays:null,standard_minutes_per_day:420,effective_from:'2026-01-01',effective_to:null}]});return {select(value){selection=value;calls.push({table,selection});return this},eq(key,value){assert.ok(['id','user_id'].includes(key));assert.equal(value,'5');return this},order(){return this},lte(){return this},or(){return this},async maybeSingle(){return result()},then(resolve){return Promise.resolve(result()).then(resolve)}}}};
 const stubs=new Map([['next/server',{NextResponse:{json:(body,options)=>Response.json(body,options)}}],['@/lib/supabase/server',{supabaseServer:db}],['@/lib/auth/server-auth',{requireRole:async(roles)=>{assert.deepEqual(roles,['owner','master']);return authorized?{ok:true}:{ok:false,status:403,code:'FORBIDDEN'}}}],['@/lib/employment/termination-policy',{getVietnamDateKey:()=> '2026-11-10'}]]);
 function load(file){const path=resolve(file);if(cache.has(path))return cache.get(path).exports;const loadedModule={exports:{}};cache.set(path,loadedModule);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const localRequire=name=>{if(stubs.has(name))return stubs.get(name);if(name==='server-only')return {};if(name.startsWith('.')||name.startsWith('@/')){let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);if(!existsSync(child))child+='.ts';return load(child)}return external(name)};
  runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:path})(localRequire,loadedModule,loadedModule.exports);return loadedModule.exports;
 }

 const {GET}=load('app/api/admin/users/[id]/level-history/route.ts');return {calls,request:(id='5')=>GET(new Request('http://fixture/api/admin/users/'+id+'/level-history'),{params:Promise.resolve({id})})};
}
test('history is owner/master-only and rejects invalid IDs before reading DB',async()=>{for(const [authorized,id,status]of [[false,'5',403],[true,'0',400],[true,'1 OR 1=1',400],[true,'9007199254740992',400]]){const f=fixture({authorized});assert.equal((await f.request(id)).status,status);assert.equal(f.calls.length,0)}});
test('history returns date-effective levels and minimum contract/audit fields without identity or payment data',async()=>{const f=fixture(),r=await f.request();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');const body=await r.json();assert.equal(body.history.current.level,4);assert.equal(body.history.next.date,'2027-02-01');assert.equal(body.contracts[0].standardWorkdays,null);assert.deepEqual(body.adminChanges,[{id:1,action:'policy_changed',createdAt:'2026-10-01T00:00:00Z'}]);assert.equal(f.calls.length,4);assert.equal(f.calls.find(c=>c.table==='users').selection,'role,hire_date,termination_date,is_system_account');assert.equal(f.calls.find(c=>c.table==='employee_level_audit_logs').selection,'id,action,created_at');assert.doesNotMatch(JSON.stringify(body),/password|username|actor|payment|paid_amount/)});
test('missing staff and failed queries return explicit errors',async()=>{assert.equal((await fixture({missing:true}).request()).status,404);assert.equal((await fixture({error:true}).request()).status,500)});
