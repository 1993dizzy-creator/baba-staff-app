import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
function load(path,deps={}){
 const testModule={exports:{}};
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},testModule,testModule.exports);
 return testModule.exports;
}
const summaries=load('lib/inventory/keg-replacement-summary.ts');
export function fixture(code='L3',count=50){
 const itemId=code==='L4'?4:3,towerMl=code==='L4'?3000:2700;
 const logs=[],sessions=[],receipts=[],lines=[];
 for(let i=0;i<count;i++){
  const start=new Date(Date.UTC(2026,0,i+1)).toISOString(),end=new Date(Date.UTC(2026,0,i+2)).toISOString();
  logs.push({id:10000+i,item_id:itemId,code,item_name:code+' 생맥주',item_name_vi:code+' Bia tươi',part:'bar',category:'생맥주',category_vi:'Bia tươi',action:'update',source:'keg_replace',reason:'stock_check',created_at:end,change_quantity:30000,prev_quantity:0,new_quantity:30000,unit:'ml',actor_name:'QA'});
  const sold=10*(660+towerMl)+(i%7===0?500:0);
  sessions.push({id:20000+i,inventory_item_id:itemId,status:'closed',ended_log_id:10000+i,started_at:start,ended_at:end,capacity_quantity:30000,sold_quantity:sold,loss_quantity:Math.max(30000-sold,0)});
  for(let j=0;j<10;j++){
   const id=i*10+j+1,time=new Date(Date.parse(start)+3600000).toISOString();
   receipts.push({id,ref_date:time,payment_status:3,is_canceled:false,synced_at:null,updated_at:null});
   for(const [offset,item,quantity]of [[0,'glass',2],[1,'tower',1]])lines.push({id:id*2+offset,receipt_id:id,item_id:item,item_code:item,quantity,is_option:false,is_excluded:false,is_canceled:false,payment_status:3,ref_date:time,synced_at:null,updated_at:null});
  }
 }
 return{itemId,tables:{inventory_logs:logs,inventory_keg_sessions:sessions,inventory_keg_tracking_mappings:[{inventory_item_id:itemId,is_active:true,target_type:'product',pos_product_id:1,quantity_per_pos_unit:330},{inventory_item_id:itemId,is_active:true,target_type:'product',pos_product_id:2,quantity_per_pos_unit:towerMl}],pos_products:[{id:1,pos_item_id:'glass',item_id:'glass',item_code:'glass',item_name:'Beer glass',unit_name:'Cốc'},{id:2,pos_item_id:'tower',item_id:'tower',item_code:'tower',item_name:'Beer tower',unit_name:'Tháp'}],pos_sales_receipts:receipts,pos_sales_receipt_lines:lines}};
}
export function database(tables,{delay=0,failTable=null}={}){
 const reads=[];
 return{reads,from(table){let columns='*',limit=Infinity,start=0,end=Infinity;const filters=[],orders=[];
  const q={select(c){columns=c;return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},or(expression){
   const parts=expression.split(',');
   if(expression.includes('.gte.'))filters.push(r=>parts.some(p=>{const [key,,...value]=p.split('.');return r[key]!=null&&Date.parse(r[key])>=Date.parse(value.join('.'));}));
   // Fixture products all match the generated item_id/item_code OR filter.
   return q;
  },order(k,{ascending=true}={}){orders.push({k,ascending});return q;},range(a,b){start=a;end=b;return q;},limit(n){limit=n;return q;},async then(resolve,reject){try{
   const began=performance.now();if(delay)await new Promise(r=>setTimeout(r,delay));
   let rows=(tables[table]||[]).filter(r=>filters.every(f=>f(r)));
   for(const{k,ascending}of orders)rows.sort((a,b)=>(a[k]<b[k]?-1:a[k]>b[k]?1:0)*(ascending?1:-1));
   rows=rows.slice(start,Math.min(end+1,start+limit)).map(r=>columns==='*'?{...r}:Object.fromEntries(columns.split(',').map(c=>c.trim()).map(c=>[c,r[c]])));
   reads.push({table,ms:performance.now()-began,count:rows.length});return resolve({data:table===failTable?null:rows,error:table===failTable?{message:'isolated failure'}:null});
  }catch(e){return reject(e);}}};return q;
 }};
}
export function route(db,{authenticated=true}={}){
 return load('app/api/inventory/items/[id]/logs/route.ts',{'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>authenticated?{ok:true}:{ok:false,code:'UNAUTHENTICATED',status:401}},'@/lib/inventory/keg-replacement-summary':summaries,'@/lib/supabase/server':{supabaseServer:db}});
}
export async function call(api,itemId,query=''){
 const start=performance.now(),response=await api.GET(new Request('http://isolated.test/api/inventory/items/'+itemId+'/logs'+query),{params:Promise.resolve({id:String(itemId)})});
 const body=await response.text();return{status:response.status,body:JSON.parse(body),bytes:Buffer.byteLength(body),ms:performance.now()-start};
}
