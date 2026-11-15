import {readFileSync} from 'node:fs';
import {BASE,RECEIPT_EVIDENCE,MERGED,PREREQUISITES} from './pos-open-orders-native-fixture.mjs';
import {BABA_TABLES,BABA_TABLES_EVIDENCE} from '../../lib/sales/baba-table-catalog.ts';
export const CLEANING=readFileSync(new URL('../../supabase/migrations/20261115103656_tables_cleaning_v1.sql',import.meta.url),'utf8');
export const branch=BABA_TABLES_EVIDENCE.branchId, scope='a'.repeat(64)+':'+branch, tableId=BABA_TABLES[3].MapObjectID;
export async function installCleaningFixture(db,{beforeCleaning,afterCleaning}={}){
 await db.exec(PREREQUISITES);
 await db.exec(`create table public.users(id bigint primary key,role text,is_active boolean,app_login_enabled boolean);
 insert into users values(1,'staff',true,true),(2,'manager',true,true);
 alter table pos_sales_receipts add column ref_no text,add column ref_date timestamptz,add column final_amount numeric,add column status_changed_at timestamptz;
 create table pos_sales_receipt_lines(id bigint primary key,receipt_id bigint,source text,item_name text,quantity numeric,final_amount numeric,is_canceled boolean);
 create index fixture_receipt_line_lookup on pos_sales_receipt_lines(receipt_id);
 create function public.store_business_date_for_timestamp_v1(p_timestamp timestamptz) returns date language sql stable as $$select ((p_timestamp at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date$$;`);
 await db.exec(BASE);await db.exec(RECEIPT_EVIDENCE);await db.exec(MERGED);
 if(beforeCleaning)await beforeCleaning(db);
 await db.exec(CLEANING);
 if(afterCleaning)await afterCleaning(db);
 const day=(await db.query('select public.store_business_date_for_timestamp_v1(clock_timestamp())::text as store_day')).rows[0].store_day;
 await db.query(`insert into pos_open_orders_private.sync_state(scope,branch_id,business_date,last_success_at,last_attempt_at) values($1,$2,$3,clock_timestamp(),clock_timestamp())`,[scope,branch,day]);
 await db.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,ref_no,raw_json)
 values(100,'cukcuk',$1,$2,3,false,100000,100000,clock_timestamp()-interval '1 minute','100','{"OrderId":"paid-order","TableName":"BAR4"}')`,[branch,day]);
 return day;
}
export async function context(db,day){return (await db.query('select public.tables_cleaning_context_v1($1,$2) r',[scope,day])).rows[0].r;}
export async function confirm(db,day,ctx,{requestId='00000000-0000-4000-8000-000000000001',actorId=1,id=tableId}={}){
 const key=ctx.keys[tableId];
 return (await db.query('select public.tables_cleaning_confirm_v1($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) r',
  [scope,day,id,actorId,requestId,key.receiptId,key.evidenceKey,JSON.stringify(ctx.snapshot),JSON.stringify(ctx.receipts)])).rows[0].r;
}
export async function addOrder(db,day,{name='BAR4',id='new-order',status=1}={}){
 await db.query(`insert into pos_open_orders_private.orders(scope,business_date,order_id,order_no,status,status_class,order_date,total_amount,table_name,has_lines,run_id,observed_at)
 values($1,$2,$3,'new', $4,'open',clock_timestamp()-interval '20 seconds',100000,$5,true,'00000000-0000-4000-8000-000000000001',clock_timestamp())`,[scope,day,id,status,name]);
 await db.query(`insert into pos_open_orders_private.order_lines(scope,business_date,order_id,detail_id,item_name,quantity,price,amount,is_option,is_orphan_option,is_canceled)
 values($1,$2,$3,'line','Synthetic menu',1,100000,100000,false,false,false)`,[scope,day,id]);
 await db.query('update pos_open_orders_private.sync_state set last_success_at=clock_timestamp() where scope=$1',[scope]);
}
