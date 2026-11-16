import {PGlite} from '@electric-sql/pglite';
import {installCleaningFixture,context,tableId,scope} from './tables-cleaning-fixture.mjs';
import {loadTs} from './sales-auth-harness.mjs';
import * as core from '../../lib/pos/cukcuk/open-orders-core.ts';
import * as policy from '../../lib/sales/table-overview.ts';
import * as detail from '../../lib/sales/table-detail.ts';
import {babaTableCatalog} from '../../lib/sales/baba-table-catalog.ts';
import {addStoreDays} from '../../lib/store-settings/business-time-core.ts';
import {evaluateOpenOrdersCronWindow} from '../../lib/pos/cukcuk/open-orders-cron-policy.ts';
import * as autoNormal from '../../lib/sales/table-auto-normal.ts';
import {AUTO_NORMAL,enableAuto} from './tables-auto-normal-fixture.mjs';

export async function cleaningServiceFixture({auto=false}={}){
 const db=new PGlite(),day=await installCleaningFixture(db);
 await db.exec('update table_operations_private.config set enabled=true');
 let activation=null;
 if(auto){await db.exec(AUTO_NORMAL);activation=await enableAuto(db);}
 let failWrite=false,changeBeforeWrite=null;
 const adapter={rpc(name,args){return {abortSignal:async()=>{
  if(name==='tables_cleaning_confirm_v1'&&failWrite)return {data:null,error:{code:typeof failWrite==='string'?failWrite:'offline'}};
  if(name==='tables_cleaning_confirm_v1'&&changeBeforeWrite)await changeBeforeWrite(db);
  if(!['tables_cleaning_context_v1','tables_cleaning_confirm_v1','tables_auto_context_v1','tables_observe_payments_v1'].includes(name))throw Error('Unexpected RPC');
  const fields=Object.keys(args),values=Object.values(args).map(v=>typeof v==='object'?JSON.stringify(v):v);
  try{return {data:(await db.query(`select public.${name}(${fields.map((k,i)=>`${k} => $${i+1}`).join(',')}) r`,values)).rows[0].r,error:null};}
  catch(error){return {data:null,error:{code:error.code,message:error.message}};}
 }};}};
 const deps={'server-only':{},'@/lib/supabase/server':{supabaseServer:adapter},
  '@/lib/store-settings/business-time-adapter':{loadBusinessTimeAdapter:async()=>({databaseBusinessDate:day,snapshot:{cutoff:'03:00'},context:{isOpen:true}})},
  '@/lib/store-settings/business-time-core':{addStoreDays},'@/lib/pos/cukcuk/open-orders-scope':{openOrdersScope:()=>scope},
  '@/lib/pos/cukcuk/open-orders-core':core,'@/lib/pos/cukcuk/open-orders-cron-policy':{evaluateOpenOrdersCronWindow},
  './baba-table-catalog':{babaTableCatalog},'./table-overview':policy,'./table-detail':detail,'./table-auto-normal':autoNormal,
  './daily-sales-summary':{fetchAllExactPages(){throw Error('Unexpected non-atomic read');}}};
 const overviewServer=loadTs('lib/sales/table-overview-server.ts',deps);
 const service=loadTs('lib/sales/table-cleaning-server.ts',{...deps,'./table-overview-server':{validOrders:overviewServer.validOrders}});
 async function getDetail(id=tableId){
  const state=await service.readCleaningState(),catalog=babaTableCatalog();
  if(!state)throw Error('disabled');
  const result=detail.projectTableDetail({table:state.base.tables.find(t=>t.id===id),catalog:catalog.tables,overview:state.base,
   orders:state.context.snapshot.orders,receipts:state.context.receipts,now:new Date(),historyFrom:state.day});
  return service.decorateCleaningDetail(result);
 }
 return {db,day,service,tableId,getDetail,adapter,activation,context:()=>context(db,day),setFailWrite:value=>{failWrite=value;},setBeforeWrite:fn=>{changeBeforeWrite=fn;}};
}
