import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as languageMissing from '../lib/inventory/language-missing.ts';

function setup({rows=[],role='owner',auth,error=false}={}) {
 const calls=[];
 const db={from(table){assert.equal(table,'inventory','language checks cannot touch historical tables');calls.push({table});let active,from,to;
  const q={select(columns){assert.equal(columns,'id, item_name, item_name_vi, is_active, created_at, updated_at');return q;},eq(key,value){assert.equal(key,'is_active');active=value;return q;},order(key){assert.equal(key,'id');return q;},range(a,b){from=a;to=b;return q;},then(resolve){return Promise.resolve({data:error?null:rows.filter(row=>row.is_active===active).sort((a,b)=>a.id-b.id).slice(from,to+1),error:error?{message:'private database detail'}:null}).then(resolve);}};
  return q;
 }};
 const deps={'@supabase/supabase-js':{createClient:()=>db},'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>auth??{ok:true,actor:{id:2,role}}},'@/lib/inventory/language-missing':languageMissing};
 const compiled={exports:{}};const source=ts.transpileModule(readFileSync('app/api/inventory/snapshot/name-sync/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',source)(name=>{assert.ok(name in deps,name);return deps[name];},compiled,compiled.exports);
 process.env.NEXT_PUBLIC_SUPABASE_URL='http://isolated.test';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key-not-a-credential';
 return {calls,get:query=>compiled.exports.GET(new Request('http://test/api/inventory/snapshot/name-sync'+(query?'?'+query:''))),post:action=>compiled.exports.POST(new Request('http://test/api/inventory/snapshot/name-sync',{method:'POST',body:JSON.stringify({action})}))};
}
const item=(id,extra={})=>({id,item_name:'이름',item_name_vi:'Tên',is_active:true,created_at:'2026-11-01T03:00:00Z',updated_at:'2026-11-03T03:00:00Z',...extra});

test('language-only GET pages active master rows, including gaps after row 1000, without historical reads',async()=>{
 const rows=Array.from({length:1000},(_,i)=>item(i+1));rows.push(item(1001,{item_name:''}),item(1002,{item_name_vi:' '}),item(1003,{item_name:null,is_active:false}));
 const before=JSON.stringify(rows),s=setup({rows,role:'staff'}),response=await s.get(),body=await response.json();
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(body.canSync,false);
 assert.deepEqual(body.languageMissingItems.map(r=>[r.itemId,r.missingLanguages]),[[1001,['ko']],[1002,['vi']]]);
 assert.equal(body.languageMissingItems[0].registeredAt,'2026-11-01T03:00:00Z');assert.equal(s.calls.length,2);assert.equal(JSON.stringify(rows),before);
 assert.deepEqual(Object.keys(body).sort(),['canSync','languageMissingItems','ok']);
});

test('legacy month/date query callers get the same global language list in all months',async()=>{
 const s=setup({rows:[item(1,{item_name_vi:null})]});let expected;
 for(const query of ['',...Array.from({length:12},(_,i)=>'month=2026-'+String(i+1).padStart(2,'0')),'businessDate=2026-11-01','businessDate=2026-11-03']){
  const response=await s.get(query);assert.equal(response.status,200);const body=await response.json();expected??=body;assert.deepEqual(body,expected);
 }
 assert.equal(s.calls.length,15);
});

test('a successful master name fix removes its language gap without changing historical data',async()=>{
 const rows=[item(1,{item_name_vi:null})],s=setup({rows});assert.equal((await(await s.get()).json()).languageMissingItems.length,1);
 rows[0].item_name_vi='Tên mới';assert.deepEqual((await(await s.get()).json()).languageMissingItems,[]);
});

test('GET errors are explicit and sanitized; failed reads do not claim an empty success list',async()=>{
 const s=setup({error:true}),response=await s.get(),body=await response.json();assert.equal(response.status,500);assert.equal(body.ok,false);assert.equal(body.languageMissingItems,undefined);assert.doesNotMatch(JSON.stringify(body),/private database detail/);
});

test('authentication precedes reads and deprecated POST preserves owner/master authorization without DB access',async()=>{
 const denied=setup({auth:{ok:false,code:'AUTH_REQUIRED',status:401}});assert.equal((await denied.get()).status,401);assert.equal((await denied.post('sync_all')).status,401);assert.deepEqual(denied.calls,[]);
 for(const role of ['owner','master','staff']){const s=setup({role});for(const action of ['sync_item','sync_all','sync_month','unknown']){const response=await s.post(action);assert.equal(response.status,role==='staff'?403:409);if(role!=='staff')assert.equal((await response.json()).code,'INVENTORY_HISTORICAL_SYNC_DISABLED');}assert.deepEqual(s.calls,[]);}
});
