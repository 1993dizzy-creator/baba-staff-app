import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {database} from './helpers/inventory-ledger-fixture.mjs';
const file='20261010180457_scope_gas_inventory_purchase_category.sql';
const migration=readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,'');
const move=readFileSync('supabase/migrations/20261010181400_reclassify_petrolimex_partner_utilities.sql','utf8');
const productionContracts=[['inventory_ledger_private.sync_candidate(jsonb,bigint)','fe28c88c30a1a3a55f756018a25eeec9'],['public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint)','3a5059d9faf63b73d9c116414d538a17']];
const name='Cửa hàng gas petrolimex chính hãng';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const project=async(db,id)=>(await one(db,'select ledger_project_inventory_purchase_log_v1($1,2) as result',[id])).result;
async function fixture({apply=true}={}){
 const db=await database();
 await db.exec(`
 alter table business_partner_ledger_parties add primary key(business_partner_id);
 alter table ledger_month_closures add column revision integer default 3;
 alter table business_partners add column partner_type text default 'other',add column partner_subtype_id bigint,add column settlement_mode text,add column settlement_rule text,add column phone text,add column contact_name text,add column memo text,add column updated_at timestamptz;
 insert into ledger_categories(id,name,kind) values(23,'가스비','expense'),(90,'기타 재고매입','expense');
 insert into business_partners(id,name,is_active,payment_mode,partner_type) values(21,'${name}',true,'postpaid','consumable');
 insert into ledger_parties(id,name,type,default_category_id) values(21,'${name}','supplier',23);
 insert into business_partner_ledger_parties values(21,21);
 insert into inventory(id,supplier_partner_id) values(342,21);
 insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id) values('기타',90);
 create table business_partner_subtypes(id bigint primary key,code text,partner_type text,name_ko text,name_vi text,emoji text,is_active boolean);
 insert into business_partner_subtypes values(43,'utility_gas','utilities','가스','Gas',null,true);
 create table business_partner_audit_logs(business_partner_id bigint,actor_user_id bigint,action text,before_snapshot jsonb,after_snapshot jsonb);
 `);
 await db.exec(readFileSync('supabase/migrations/202608230004_fix_business_partner_fund_account_eligibility.sql','utf8'));
 const paymentTypes=readFileSync('supabase/migrations/202608210004_add_ledger_payable_payments.sql','utf8');await db.exec(paymentTypes.slice(0,paymentTypes.indexOf('alter table public.ledger_parties')));
 const sub=readFileSync('supabase/migrations/202608240002_add_business_partner_subtypes.sql','utf8');
 await db.exec(sub.slice(sub.indexOf('create function public.business_partner_subtype_is_eligible_v1'),sub.indexOf('alter function public.business_partner_subtype_is_eligible_v1')));
 const current=readFileSync('supabase/migrations/20261001172556_support_unspecified_partner_payment_mode.sql','utf8');
 await db.exec(current.slice(current.indexOf('create or replace function public.business_partner_create_v4'),current.indexOf('-- The only existing partner data')));
 // This fixture exercises update (existing bridge), so missing-bridge creation must fail.
 await db.exec("create function business_partner_ensure_ledger_party_v1(bigint) returns bigint language plpgsql as $$ begin raise exception 'UNEXPECTED_BRIDGE_CREATION';end;$$");
 const verification=readFileSync('supabase/migrations/20260921170100_add_inventory_payment_verification.sql','utf8');
 await db.exec(verification.slice(0,verification.indexOf('  -- Keep the existing preflight'))+'end;\n$payment_verification$;');
 // Match Production's stored CRLF bodies, not a substituted migration hash.
 for(const [signature,hash] of productionContracts){
  const {definition}=await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature]);
  await db.exec(definition.replace(/\$function\$([\s\S]*)\$function\$/,
   (_,body)=>'$function$'+body.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')+'$function$'));
  assert.equal((await one(db,'select md5(pg_get_functiondef($1::regprocedure)) hash',[signature])).hash,hash);
 }
 if(apply)await db.exec(migration);
 return db;
}
async function receipt(db,{id=3430,item=342,partner=21,date=null,created=null,supplier=name}={}){
 const dateSql=date?"'"+date+"'":"(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date";
 const createdSql=created?"'"+created+"'::timestamptz":"clock_timestamp()";
 await db.query(`insert into inventory_logs(id,item_id,item_name,item_name_vi,category,unit,change_quantity,new_purchase_price,new_supplier,business_date,created_at,source,reason,source_actor_user_id,purchase_supplier_partner_id) values($1,$2,'가스통 22kg','Bình ga 22kg','기타','통',2,1395000,$3,${dateSql},${createdSql},'quick_save','purchase',2,$4)`,[id,item,supplier,partner]);
}
async function fingerprint(db){return (await one(db,`select jsonb_build_object('tx',(select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t),'payables',(select jsonb_agg(to_jsonb(p) order by id) from ledger_payables p),'movements',(select jsonb_agg(to_jsonb(m) order by id) from ledger_movements m),'closures',(select jsonb_agg(to_jsonb(c) order by month) from ledger_month_closures c)) as state`)).state;}

test('new explicit #342/#21 purchase posts gas expense plus unpaid payable without a cash movement; retry is idempotent',async()=>{
 const db=await fixture();try{await receipt(db);assert.equal((await project(db,3430)).status,'synced');
 const tx=await one(db,'select * from ledger_transactions order by id desc limit 1');assert.equal(Number(tx.category_id),23);assert.equal(Number(tx.party_id),21);assert.equal(Number(tx.amount),2790000);assert.equal(tx.source_snapshot.item_id,342);assert.equal(tx.source_snapshot.purchase_supplier_partner_id,21);
 const p=await one(db,'select * from ledger_payables');assert.equal(p.status,'unpaid');assert.equal(Number(p.party_id),21);assert.equal(Number(p.original_amount),2790000);assert.equal(Number((await one(db,'select count(*) n from ledger_movements')).n),0);
 const before=await fingerprint(db);await project(db,3430);assert.deepEqual(await fingerprint(db),before);
 assert.equal(Number((await one(db,"select count(*) n from ledger_audit_logs where action='candidate_confirmed_payable'")).n),1);
 }finally{await db.close();}
});
for(const [label,item,partner,supplier] of [['ordinary other inventory',1,21,name],['changed supplier',342,12,'Postpaid'],['gas text without ID',342,null,'gas supplier'],['unrelated item and gas text',1,12,'gas shop']])test(label+' retains other inventory category',async()=>{
 const db=await fixture();try{await receipt(db,{item,partner,supplier});const result=await project(db,3430);assert.ok(['synced','pending'].includes(result.status));assert.equal(Number((await one(db,'select proposed_category_id from ledger_candidates order by id desc limit 1')).proposed_category_id),90);}finally{await db.close();}
});
test('master supplier changed after receipt does not replace explicit source payee or gas category',async()=>{
 const db=await fixture();try{await receipt(db);await db.exec('update inventory set supplier_partner_id=12 where id=342');await project(db,3430);assert.equal(Number((await one(db,'select party_id from ledger_transactions')).party_id),21);assert.equal(Number((await one(db,'select category_id from ledger_transactions')).category_id),23);}finally{await db.close();}
});
test('legacy batch contract uses explicit gas IDs despite master supplier drift',async()=>{
 const db=await fixture();try{await receipt(db);await db.exec('update inventory set supplier_partner_id=12 where id=342');
 const l=await one(db,'select * from inventory_logs where id=3430');const snapshot={inventory_log_id:3430,item_id:342,purchase_supplier_partner_id:21,category:'기타',supplier:name};
 const row={sourceKey:'inventory-log:3430',fingerprint:'a'.repeat(64),snapshot,businessDate:l.business_date.toISOString().slice(0,10),amount:2790000};
 const result=await one(db,'select ledger_sync_inventory_candidates_v1($1::jsonb,2) as result',[JSON.stringify([row])]);assert.equal(result.result.status,'ok');const tx=await one(db,'select category_id,party_id from ledger_transactions');assert.equal(Number(tx.category_id),23);assert.equal(Number(tx.party_id),21);
 }finally{await db.close();}
});
test('existing paid/closed gas history and pending candidates are not reclassified by rollout or partner move',async()=>{
 const db=await fixture({apply:false});try{
 await db.exec("select setval('ledger_transactions_id_seq',1611,false);select setval('ledger_payables_id_seq',705,false)");
 await receipt(db,{id:16110,date:'2026-09-05',created:'2026-09-05T00:00:00Z'});await db.exec('update inventory_logs set new_purchase_price=1460000 where id=16110');await project(db,16110);
 await db.exec("select setval('ledger_transactions_id_seq',2487,false);select setval('ledger_payables_id_seq',1162,false)");
 await receipt(db,{id:24870,date:'2026-10-09',created:'2026-10-09T00:00:00Z'});await project(db,24870);
 await db.exec("update ledger_transactions set category_id=23 where source_snapshot->>'inventory_log_id'='24870';update ledger_payables set status='paid' where expense_transaction_id=(select id from ledger_transactions where source_snapshot->>'inventory_log_id'='16110');insert into ledger_month_closures(month,status,revision) values('2026-09-01','closed',3)");
 await db.exec("insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,amount,party_id,source_type,source_key,created_by,confirmed_by) values(2488,gen_random_uuid(),'payable_payment','2026-10-08T03:00:00Z','2026-10-08',2920000,21,'payable_payment','fixture:2488',2,2),(2489,gen_random_uuid(),'balance_adjustment','2026-10-08T03:00:00Z','2026-10-08',9,21,'balance_adjustment','fixture:2489',2,2);insert into ledger_movements(transaction_id,fund_account_id,amount) values(2488,2,-2920000),(2489,2,-9);insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(705,2488,2920000)");
 await db.exec("select setval('ledger_transactions_id_seq',2489,true)");assert.equal(Number((await one(db,'select amount from ledger_transactions where id=1611')).amount),2920000);assert.equal(Number((await one(db,'select original_amount from ledger_payables where id=1162')).original_amount),2790000);
 const before=await fingerprint(db);await db.exec(migration);assert.deepEqual(await fingerprint(db),before);
 await db.exec("update business_partners set settlement_mode='scheduled',settlement_rule='net_days',default_payment_term_days=7 where id=21;set baba.migration_actor_user_id='2'");const partnerBefore=await one(db,'select to_jsonb(p) as p from business_partners p where id=21');await db.exec(move);const partnerAfter=await one(db,'select to_jsonb(p) as p from business_partners p where id=21');for(const key of Object.keys(partnerBefore.p).filter(key=>!['partner_type','partner_subtype_id','updated_at'].includes(key)))assert.deepEqual(partnerAfter.p[key],partnerBefore.p[key]);await db.exec(move);assert.equal(Number((await one(db,'select count(*) n from business_partner_audit_logs')).n),1);
 assert.deepEqual(await fingerprint(db),before);const p=await one(db,'select * from business_partners where id=21');assert.equal(p.partner_type,'utilities');assert.equal(Number(p.partner_subtype_id),43);assert.equal(p.payment_mode,'postpaid');assert.equal(p.is_active,true);assert.equal(Number((await one(db,'select ledger_party_id from business_partner_ledger_parties where business_partner_id=21')).ledger_party_id),21);assert.equal(Number((await one(db,'select supplier_partner_id from inventory where id=342')).supplier_partner_id),21);assert.equal(Number((await one(db,'select default_category_id from ledger_parties where id=21')).default_category_id),23);
 await project(db,24870);assert.equal(Number((await one(db,"select category_id from ledger_transactions where source_snapshot->>'inventory_log_id'='24870'")).category_id),23);
 await receipt(db,{id:777,date:'2026-10-09',created:'2026-10-09T01:00:00Z'});assert.equal((await project(db,777)).status,'synced');assert.equal(Number((await one(db,"select category_id from ledger_transactions where source_snapshot->>'inventory_log_id'='777'")).category_id),90);
 await receipt(db,{id:778,date:'2026-09-05'});assert.equal((await project(db,778)).code,'MONTH_CLOSED');assert.equal(Number((await one(db,"select count(*) n from ledger_transactions where source_snapshot->>'inventory_log_id'='778'")).n),0);
 }finally{await db.close();}
});
// Structural unit harness: exercise the exact patch body separately from the
// Production byte-version gate. Full migration executions below retain every pin.
async function verifyPatchContracts(){
 const lf=migration.replace(/\r\n/g,'\n');
 const rawContract=lf.slice(lf.indexOf('do $contract$'),lf.indexOf('commit;'));
 const gateStart=rawContract.indexOf('    expected_md5 := case signature');
 const gateEnd=rawContract.indexOf('    -- Match LF or CRLF');
 const patch=rawContract.slice(0,gateStart)+rawContract.slice(gateEnd);
 const anchor=lf.split('$anchor$')[1],addition=lf.split('$addition$')[1];
 const partyAnchor=lf.split('$party$')[1],partyAddition=lf.split('$party$')[3];
 for(const fileEol of ['LF','CRLF'])for(const bodyEol of ['LF','CRLF']){
  const db=await fixture({apply:false});try{
   const originals=[];
   for(const [signature] of productionContracts){
    let {definition}=await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature]);
    definition=definition.replace(/\$function\$([\s\S]*)\$function\$/,(_,body)=>'$function$'+(bodyEol==='LF'?body.replace(/\r\n/g,'\n'):body)+'$function$');
    await db.exec(definition);originals.push([signature,(await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature])).definition]);
   }
   // The helper must exist while PostgreSQL compiles the amended functions.
   await db.exec(lf.slice(lf.indexOf('create function inventory_ledger_private.purchase_category_for_new_source_v1'),lf.indexOf('-- Amend ONLY')).replace(/select coalesce\([\s\S]*?,p_fallback\);/,()=> 'select p_fallback;'));
   await db.exec(fileEol==='LF'?patch:patch.replace(/\n/g,'\r\n'));
   const eol=v=>bodyEol==='LF'?v:v.replace(/\n/g,'\r\n');
   for(const [signature,original] of originals){
    let expected=original.replace(eol(anchor),()=>eol(anchor+addition));
    if(signature.startsWith('public.'))expected=expected.replace(partyAnchor,()=>eol(partyAddition));
    const actual=(await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature])).definition;
    assert.equal(actual,expected,fileEol+'/'+bodyEol+' preserves all unrelated function bytes');
    assert.ok(!actual.includes('\r\r\n'));
   }
  }finally{await db.close();}
 }
 // Raw migrations in both file encodings must pass the unmodified Production pins.
 for(const sql of [lf,lf.replace(/\n/g,'\r\n')]){
  const db=await fixture({apply:false});try{await db.exec(sql);}finally{await db.close();}
 }
 for(const mode of ['first-version','second-version','missing-anchor','duplicate-anchor']){
  const db=await fixture({apply:false});try{
   const signature=productionContracts[mode==='second-version'?1:0][0];
   let {definition}=await one(db,'select pg_get_functiondef($1::regprocedure) definition',[signature]);
   const storedAnchor=anchor.replace(/\n/g,'\r\n');
   definition=mode==='missing-anchor'?definition.replace(storedAnchor,()=>storedAnchor.replace('limit 1','limit 2')):
    mode==='duplicate-anchor'?definition.replace(storedAnchor,()=>storedAnchor+'\r\n'+storedAnchor):definition.replace('declare',()=> 'declare\r\n  -- unexpected version');
   await db.exec(definition);
   const before=await db.query('select oid,md5(pg_get_functiondef(oid)) hash from pg_proc where oid in ($1::regprocedure,$2::regprocedure)',productionContracts.map(([signature])=>signature));
   await assert.rejects(db.exec(lf),/GAS_PURCHASE_FUNCTION_VERSION_MISMATCH/);await db.exec('rollback');
   assert.deepEqual((await db.query('select oid,md5(pg_get_functiondef(oid)) hash from pg_proc where oid in ($1::regprocedure,$2::regprocedure)',productionContracts.map(([signature])=>signature))).rows,before.rows);
   assert.equal((await one(db,"select to_regclass('inventory_ledger_private.purchase_category_rules') relation")).relation,null);
   assert.equal((await one(db,"select to_regprocedure('inventory_ledger_private.purchase_category_for_new_source_v1(jsonb,bigint)') helper")).helper,null);
   if(mode.endsWith('anchor')){
    await db.exec('begin');await assert.rejects(db.exec(patch),/GAS_PURCHASE_CATEGORY_CONTRACT_MISMATCH/);await db.exec('rollback');
    assert.deepEqual((await db.query('select oid,md5(pg_get_functiondef(oid)) hash from pg_proc where oid in ($1::regprocedure,$2::regprocedure)',productionContracts.map(([signature])=>signature))).rows,before.rows);
   }
  }finally{await db.close();}
 }
}

test('rule is private and unexpected deployed category body rolls migration back atomically',async()=>{
 await verifyPatchContracts();
 const db=await fixture({apply:false});try{await db.exec("create or replace function inventory_ledger_private.sync_candidate(p_rows jsonb,p_actor_user_id bigint) returns jsonb language sql as $$ select '{}'::jsonb $$");await assert.rejects(db.exec(migration),/GAS_PURCHASE_FUNCTION_VERSION_MISMATCH/);await db.exec('rollback');assert.equal((await one(db,"select to_regclass('inventory_ledger_private.purchase_category_rules') as relation")).relation,null);}finally{await db.close();}
 const secured=await fixture();try{for(const role of ['anon','authenticated','service_role']){assert.equal((await one(secured,"select has_table_privilege($1,'inventory_ledger_private.purchase_category_rules','SELECT') allowed",[role])).allowed,false);assert.equal((await one(secured,"select has_function_privilege($1,'inventory_ledger_private.purchase_category_for_new_source_v1(jsonb,bigint)','EXECUTE') allowed",[role])).allowed,false);}}finally{await secured.close();}
});

test('pending before rollout keeps its original category, and category mapping and subtype rows are untouched',async()=>{
 const db=await fixture({apply:false});try{await receipt(db);await db.exec("update business_partners set payment_mode='unspecified' where id=21");assert.equal((await project(db,3430)).status,'pending');const before=(await one(db,'select proposed_category_id from ledger_candidates')).proposed_category_id;await db.exec("update business_partners set payment_mode='postpaid' where id=21");await db.exec(migration);await project(db,3430);assert.equal((await one(db,'select proposed_category_id from ledger_candidates')).proposed_category_id,before);assert.equal(Number(before),90);assert.equal(Number((await one(db,"select ledger_category_id from ledger_inventory_category_mappings where inventory_category='기타'")).ledger_category_id),90);assert.deepEqual((await db.query('select id,code,partner_type from business_partner_subtypes')).rows,[{id:43,code:'utility_gas',partner_type:'utilities'}]);assert.equal((await one(db,'select partner_type from business_partners where id=21')).partner_type,'consumable');}finally{await db.close();}
});

test('protected classification move requires actual manager actor and preserves state on stale subtype or audit failure',async()=>{
 for(const mode of ['actor','stale','audit']){const db=await fixture();try{
 const before=await one(db,'select to_jsonb(p) p from business_partners p where id=21');
 if(mode==='actor')await db.exec("set baba.migration_actor_user_id='1'");
 if(mode==='stale')await db.exec("set baba.migration_actor_user_id='2';update business_partner_subtypes set code='unexpected' where id=43");
 if(mode==='audit')await db.exec("set baba.migration_actor_user_id='2';create function fail_utility_audit() returns trigger language plpgsql as $$ begin raise exception 'TEST_AUDIT_FAILURE';end;$$;create trigger fail_utility_audit before insert on business_partner_audit_logs for each row execute function fail_utility_audit()");
 await assert.rejects(db.exec(move),new RegExp(mode==='actor'?'PETROLIMEX_MIGRATION_OWNER_ACTOR_REQUIRED':mode==='stale'?'PETROLIMEX_UTILITY_GAS_SUBTYPE_MISMATCH':'TEST_AUDIT_FAILURE'));await db.exec('rollback');assert.deepEqual((await one(db,'select to_jsonb(p) p from business_partners p where id=21')).p,before.p);assert.equal(Number((await one(db,'select count(*) n from business_partner_audit_logs')).n),0);
 }finally{await db.close();}}
});

test('new gas payable settles through existing payment RPC and later source drift cannot overwrite paid expense',async()=>{
 const db=await fixture();try{
 const payments=readFileSync('supabase/migrations/202608210004_add_ledger_payable_payments.sql','utf8');await db.exec(payments.slice(0,payments.indexOf('alter table public.ledger_parties')));const start=payments.indexOf('create or replace function public.ledger_pay_payables_v1');await db.exec(payments.slice(start,payments.indexOf('end $$;',start)+8));
 await receipt(db);await project(db,3430);const paid=await one(db,"select ledger_pay_payables_v1(21,2,clock_timestamp(),2790000,null,'Gas payment fixture',2) result");assert.equal(paid.result.status,'paid');assert.equal((await one(db,'select status from ledger_payables')).status,'paid');assert.equal(Number((await one(db,'select sum(amount) amount from ledger_movements')).amount),-2790000);assert.equal(Number((await one(db,"select category_id from ledger_transactions where type='expense'")).category_id),23);
 const before=await fingerprint(db);await db.exec('update inventory_logs set new_purchase_price=1395001 where id=3430');assert.equal((await project(db,3430)).code,'PAYABLE_ALREADY_PAID');assert.deepEqual(await fingerprint(db),before);
 }finally{await db.close();}
});

test('rollout business date follows existing 03:00 cutoff, and older backdated purchase stays other inventory',async()=>{
 const db=await fixture();try{await db.exec("update inventory_ledger_private.purchase_category_rules set starts_at='2026-10-11T18:00:00Z'");await receipt(db,{id:3430,date:'2026-10-11',created:'2026-10-11T18:10:00Z'});await project(db,3430);assert.equal(Number((await one(db,"select category_id from ledger_transactions where source_snapshot->>'inventory_log_id'='3430'")).category_id),23);await receipt(db,{id:3431,date:'2026-10-10',created:'2026-10-11T18:10:00Z'});await project(db,3431);assert.equal(Number((await one(db,"select category_id from ledger_transactions where source_snapshot->>'inventory_log_id'='3431'")).category_id),90);}finally{await db.close();}
});
