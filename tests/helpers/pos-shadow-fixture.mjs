// Disposable native PostgreSQL only; never loads .env or an operating URL.
import {readFileSync} from 'node:fs';
import {initializePosCloseDatabase} from './pos-business-day-close-fixture.mjs';
import {initializeResolutionSchema,initializeWork} from './payment-upgrade-fixture.mjs';
import {reproduceOperatingInventoryContract} from './payment-upgrade-inventory-fixture.mjs';
export const shadowSchema='20261102103506_pos_shadow_sale_versions_and_jobs.sql';
export const readMigration=n=>readFileSync('supabase/migrations/'+n,'utf8');
export const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
export async function initializeShadow(db){
 await initializePosCloseDatabase(db);
 await db.exec(readMigration('20260912160056_add_pos_business_day_close_checks.sql'));
 await initializeResolutionSchema(db,{migration:'select 1'});
 await initializeWork(db,{migration:'select 1',beforeMigration:reproduceOperatingInventoryContract});
 await db.exec('alter table inventory alter column quantity type numeric(10,2);alter table inventory_logs add column created_at timestamptz default clock_timestamp()');
 await db.exec(readMigration('20261101180623_pos_stock_check_boundary_guard.sql'));
 await db.exec(readMigration('20261102101859_pos_reprocess_failure_persistence_and_dedup.sql'));
 await db.exec(readMigration(shadowSchema));
 await db.exec("insert into inventory(id,quantity,item_name,unit) values(1,0.03,'Synthetic Glenfiddich 15','bottle'),(2,20,'Other','bottle');insert into pos_item_mappings values(1,'TEST','direct',true,1,1,1,false)");
 await seedReceipt(db,10);
}
export async function seedReceipt(db,id,ref='ref-'+id){
 await db.query("insert into pos_sales_receipts(id,ref_id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at) values($1,$2,'2601006796-synthetic','2026-10-09','2026-10-09T13:01:00Z',3,false,100000,0,clock_timestamp())",[id,ref]);
 await db.query("insert into pos_sales_receipt_lines(receipt_id,receipt_ref_id,item_code,item_name,quantity,unit_price,payment_status,is_canceled,raw_json) values($1,$2,'TEST','Synthetic Glenfiddich 15',1,100000,3,false,'{}')",[id,ref]);
}
export async function capture(db,{receipt=10,key='obs-1',seq=1,quantity=1,time='2026-10-09T13:01:00Z',effects,evidence,saleSnapshot}={}){
 const r=(await rows(db,'select to_jsonb(r) r from pos_sales_receipts r where id=$1',[receipt]))[0].r;
 return (await rows(db,'select pos_shadow_capture_version($1,$2,$3,$4,$5,$6,$7,$8) r',[
  receipt,r.updated_at,key,seq,saleSnapshot??{quantity,canceled:r.is_canceled},
  JSON.stringify(effects??[{effectKey:'line-1',itemId:1,quantity,effectiveAt:time}]),
  evidence??{timeBasis:'historical_correction',proof:'synthetic authoritative fixture'},'owner']))[0].r;
}
export const claim=async(db,worker='synthetic-worker')=>(await rows(db,"select pos_shadow_claim($1,'owner') r",[worker]))[0].r;
export async function register(db,{kind='count',quantity=10,time='2026-10-11T04:12:18Z',recordedAt,item=1,proof='synthetic complete timeline',coverage=true}={}){
 const reason=kind==='count'?'stock_check':kind==='purchase'?'purchase':'other';
 const id=(await rows(db,"insert into inventory_logs(item_id,reason,source,new_quantity,change_quantity,created_at) values($1,$2,'edit_form',$3,$4,$5) returning id",[item,reason,quantity,kind==='count'?0:quantity,recordedAt??time]))[0].id;
 const result=(await rows(db,"select pos_shadow_register_movement($1,$2,$3,$4,'owner') r",[id,kind,time,{proof,coverageComplete:coverage}]))[0].r;
 return {id,...result};
}
export async function operatingSnapshot(db){
 const result={};
 for(const table of ['inventory','inventory_logs','pos_sales_receipts','pos_sales_receipt_lines','pos_inventory_deductions','pos_inventory_deduction_receipts','pos_inventory_deduction_batches'])
  result[table]=await rows(db,'select to_jsonb(t) row from '+table+' t order by id');
 return result;
}
