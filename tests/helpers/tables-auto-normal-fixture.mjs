import {readFileSync} from 'node:fs';
import {installCleaningFixture,scope,tableId} from './tables-cleaning-fixture.mjs';
import assert from 'node:assert/strict';
export {scope,tableId};
export const AUTO_NORMAL=readFileSync(new URL('../../supabase/migrations/20261116095122_tables_auto_normal_v1.sql',import.meta.url),'utf8');
export async function installAutoFixture(db){
 const day=await installCleaningFixture(db);
 const before=(await db.query("select p.oid,md5(pg_get_functiondef(p.oid)) hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','table_operations_private','pos_open_orders_private') order by p.oid")).rows;
 await db.exec(AUTO_NORMAL);
 for(const row of before)assert.equal((await db.query('select md5(pg_get_functiondef($1::oid)) hash',[row.oid])).rows[0].hash,row.hash,'Existing function unchanged');
 return day;
}
export async function enableAuto(db){
 return (await db.query('update table_operations_private.auto_config set enabled=true returning activation_key')).rows[0].activation_key;
}
export async function autoContext(db,day,activation){
 return (await db.query('select public.tables_auto_context_v1($1,$2,$3) r',[scope,day,activation])).rows[0].r;
}
export async function observe(db,day,activation,ctx,ids=[tableId]){
 ctx??=await autoContext(db,day,activation);
 const tables=ids.map(id=>({tableId:id,receiptId:ctx.keys[id]?.receiptId,autoKey:ctx.keys[id]?.autoKey}));
 return (await db.query('select public.tables_observe_payments_v1($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) r',
  [scope,day,activation,JSON.stringify(tables),JSON.stringify(ctx.snapshot),JSON.stringify(ctx.receipts)])).rows[0].r;
}
