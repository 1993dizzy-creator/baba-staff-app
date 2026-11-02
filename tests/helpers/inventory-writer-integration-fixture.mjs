import {readFileSync} from 'node:fs';
import {initializeShadow,readMigration} from './pos-shadow-fixture.mjs';
export const journal='20261102120035_inventory_writer_event_journal.sql',integration='20261102120303_inventory_writer_shadow_integration.sql';
export const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
export const writerMetadata=db=>rows(db,"select oid,proowner,proacl::text,proconfig,proargdefaults::text,prorettype,proargtypes::text from pg_proc where pronamespace='public'::regnamespace and proname in ('inventory_update_with_audit_v1','inventory_create_with_receipt_v1','inventory_apply_purchase_correction_v1','inventory_apply_purchase_correction_v2','inventory_apply_purchase_correction_v3','inventory_apply_purchase_receipt_edit_v1','inventory_apply_keg_change','replace_inventory_keg','apply_sales_inventory_deduction_batch','prepare_and_apply_sales_inventory_reprocess','reprocess_modified_sales_inventory_deduction_receipt','rollback_canceled_sales_inventory_deduction_receipt') order by oid");
// Copy real function definitions into focused fixture schemas; no fake writers.
export function definition(sql,name){const start=sql.search(new RegExp('create (?:or replace )?function '+name.replaceAll('.','\\.')+'\\('));if(start<0)throw Error('Missing '+name);const end=sql.indexOf('$$;',start);if(end<0)throw Error('Missing delimiter '+name);return sql.slice(start,end+3);}
export async function installStandaloneJournal(db){
 await db.exec('create schema pos_inventory_shadow');
 const shadow=readMigration('20261102103506_pos_shadow_sale_versions_and_jobs.sql'),writer=readMigration('20261102110828_pos_shadow_writer_contract_and_order.sql');
 await db.exec(shadow.slice(shadow.indexOf('create table pos_inventory_shadow.movements('),shadow.indexOf('create function pos_inventory_shadow.immutable()')));
 for(const [sql,name] of [[shadow,'pos_inventory_shadow.authorize'],[shadow,'pos_inventory_shadow.valid_time'],[writer,'pos_inventory_shadow.writer_log_snapshot']])await db.exec(definition(sql,name));
 await db.exec(readMigration(journal));db.writerOriginalCatalog=await writerMetadata(db);await db.exec(readMigration(integration));
}
export async function writerFixture(db){
 await initializeShadow(db);
 await db.exec(`alter table inventory add column package_content_quantity numeric,add column package_content_unit text,
  add column low_stock_threshold numeric default 1,add column low_stock_enabled boolean default true,add column image_path text,
  add column supplier_partner_id bigint,add column updated_by_name text,add column updated_by_username text,add column is_active boolean default true;
  create sequence writer_item_ids start 1000;alter table inventory alter column id set default nextval('writer_item_ids');
  create table inventory_price_logs(id bigint generated always as identity primary key,item_id bigint,item_name text,item_code text,old_price numeric,new_price numeric,diff numeric,business_date date,source text,reason text,actor_username text,note text);
  alter table pos_sales_receipts add column synced_at timestamptz;
  alter table pos_sales_receipt_lines add column if not exists synced_at timestamptz,add column if not exists item_id text,add column if not exists ref_date timestamptz;
  alter table inventory_logs alter column prev_quantity type numeric(10,2),alter column new_quantity type numeric(10,2),alter column change_quantity type numeric(10,2);
 `);
 // Match the normal stock-save audit fields absent from the focused POS fixture.
 const keg=readFileSync('tests/helpers/keg-safety-fixture.mjs','utf8');
 const body=keg.match(/create table inventory_logs\(([^;]+)\);/)[1];
 for(const c of body.split(',')){const m=c.match(/^(\w+) (text|numeric|date|timestamptz|bigint)/);if(m)await db.exec(`alter table inventory_logs add column if not exists ${m[1]} ${m[2]}`);}
 await db.exec('create schema if not exists inventory_ledger_private');
 await db.exec(definition(readMigration('20261010140729_atomic_inventory_edit_and_versioned_correction.sql'),'inventory_ledger_private.item_matches_expected_v1'));
 const save=readMigration('20261030150000_inventory_purchase_billed_amount.sql'),create=readMigration('20261030170000_inventory_create_with_receipt.sql');
 await db.exec(definition(save,'public.inventory_update_with_audit_v1'));
 await db.exec(definition(create,'inventory_ledger_private.inventory_name_key_v1'));
 await db.exec(definition(create,'public.inventory_create_with_receipt_v1'));
 await db.exec(readMigration('20261102103822_pos_shadow_temporal_settlement.sql'));
 await db.exec(readMigration('20261102110828_pos_shadow_writer_contract_and_order.sql'));
 await db.exec(readMigration('202607020001_create_inventory_keg_tracking.sql').split('create or replace function public.replace_inventory_keg')[0]);
 await db.exec(readMigration('202607230003_unify_keg_sales_calculation.sql'));
 await db.exec(readMigration('20261020120000_keg_safety_p0.sql'));
 await db.exec(readMigration(journal));db.writerOriginalCatalog=await writerMetadata(db);await db.exec(readMigration(integration));
 return db;
}
export const item=async(db,id=1)=>(await rows(db,'select to_jsonb(i) i from inventory i where id=$1',[id]))[0].i;
export const apply=async(db,name,args,event={},request=crypto.randomUUID(),actor=1)=>(await rows(db,'select inventory_writer_apply_v1($1,$2,$3,$4,$5) r',[request,name,JSON.stringify(args),JSON.stringify(event),actor]))[0].r;
export async function save(db,quantity,{id=1,reason='stock_check',event={},request,expected}={}){
 return apply(db,'inventory_update_with_audit_v1',{p_item_id:id,p_expected_item:expected??await item(db,id),p_payload:{quantity},p_business_date:'2026-10-12',p_actor_user_id:1,p_reason:reason,p_source:'edit_form',p_price_business_date:'2026-10-12'},event,request);
}
export async function posCandidate(db,quantity=0.0714){
 const r=(await rows(db,'select to_jsonb(r) r from pos_sales_receipts r where id=10'))[0].r;
 const line=(await rows(db,'select id from pos_sales_receipt_lines where receipt_id=10'))[0].id;
 const b=(await rows(db,"insert into pos_inventory_deduction_batches(flow_version,source,status,receipt_count,ready_receipt_count) values('sales_db_v1','manual_preview','previewed',1,1) returning id"))[0].id;
 const br=(await rows(db,"insert into pos_inventory_deduction_receipts(batch_id,receipt_id,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,selected_for_apply,workflow_type,receipt_content_fingerprint,line_summary) values($1,10,'ready','hash','amount',$2,true,'initial_apply','initial','{\"hashVersion\":2}') returning id",[b,r.updated_at]))[0].id;
 await db.query("insert into pos_inventory_deductions(receipt_id,invoice_ref_id,batch_id,batch_receipt_id,receipt_line_id,pos_item_code,pos_item_name,mapping_id,mapping_type,inventory_item_id,operation_type,status,flow_version,business_date,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,deduct_quantity) values(10,'ref-10',$1,$2,$3,'TEST','Synthetic Glenfiddich 15',1,'direct',1,'preview','selected','sales_db_v1','2026-10-09','{\"mappingVersion\":1}','hash','amount',$4,1,$5,$5,$5)",[b,br,line,crypto.randomUUID(),quantity]);
 return {batch:b,receipt:r,validation:[{receiptId:10,currentInventoryHash:'hash',currentReceiptUpdatedAt:r.updated_at,applyAllowed:true}]};
}
export const applyPos=async(db,c)=>(await rows(db,"select apply_sales_inventory_deduction_batch($1,'owner',$2) r",[c.batch,JSON.stringify(c.validation)]))[0].r;
