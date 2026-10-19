import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {buildPosBusinessDaySource} from '../lib/ledger/pos-sales-source.ts';
import {nativeInventoryPostgres as nativePostgres} from './helpers/inventory-native-postgres.mjs';
import {paymentFixture,paymentMigration,productionDefinitionMd5,applyPaymentMigration,previousPaymentMigration,incidentRef,oldPaymentId,newPaymentId,
  addReceipt,payment,seed,reconcile,snapshot,payments,protectedState} from './helpers/pos-payment-reconciliation-fixture.mjs';

// No .env loading, remote URLs, existing clusters or production credentials.
assert.ok(process.env.QA_POSTGRES_BIN, 'QA_POSTGRES_BIN must name local PostgreSQL binaries; this suite never silently skips');
const cash={payment_type:1,payment_name:'CASH',card_id:null,card_name:null};
const transfer={payment_type:3,payment_name:'TRANSFER',card_id:null,card_name:null};
const call=(db,rows)=>reconcile(db,[snapshot(rows)]);
const unchanged=async(db,before)=>assert.deepEqual(await payments(db),before);

test('native PostgreSQL payment reconciliation with real UNIQUE index', {timeout:120000}, async t=>{
  const runtime=await nativePostgres({testContext:t});
  console.log(runtime.version);
  const fixture=options=>paymentFixture(runtime.Database,options);
  async function scenario(name,run){await t.test(name,async()=>{const db=await fixture();try{await run(db);}finally{await db.close();}});}
  try {
    await t.test('October 15 old RPC reproduces 23505; follow-up migration fixes it and is idempotent',async()=>{
      const db=await fixture({upgrade:false});
      try {
        const id=await addReceipt(db);await seed(db,id);await db.query('insert into pos_sales_receipt_lines values(1,$1,1900000)',[id]);
        const before=await payments(db),protectedBefore=await protectedState(db);
        const oldMetadata=(await db.query("select proowner,proacl,prosecdef,proconfig from pg_proc where oid='public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure")).rows;
        const indexBefore=(await db.query("select indexdef from pg_indexes where indexname='pos_sales_receipt_payments_unique_payment'")).rows;
        await assert.rejects(call(db,[payment()]),e=>e.code==='23505');await unchanged(db,before);
        await applyPaymentMigration(db);
        assert.deepEqual((await db.query("select proowner,proacl,prosecdef,proconfig from pg_proc where oid='public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure")).rows,oldMetadata);
        const result=await call(db,[payment()]);assert.equal(result.createdCount,1);assert.equal(result.deletedCount,1);
        const rows=await payments(db);assert.equal(rows.length,1);assert.equal(Number(rows[0].amount),2074200);assert.equal(rows[0].raw_json.SAInvoicePaymentID,newPaymentId);
        assert.deepEqual(await protectedState(db),protectedBefore);
        assert.deepEqual((await db.query("select indexdef from pg_indexes where indexname='pos_sales_receipt_payments_unique_payment'")).rows,indexBefore);
        const repeat=await call(db,[payment()]);assert.equal(repeat.createdCount+repeat.updatedCount+repeat.deletedCount,0);await unchanged(db,rows);
      }finally{await db.close();}
    });
    await t.test('unmodified production migration rejects a different definition without changing function ACL index or data',async()=>{
      const db=await fixture({upgrade:false});
      try{
        const id=await addReceipt(db);await seed(db,id);
        assert.notEqual(db.fixtureDefinitionMd5,productionDefinitionMd5);
        assert.ok(paymentMigration.includes(productionDefinitionMd5));
        const state=async()=>({
          function:(await db.query("select pg_get_functiondef(oid) definition,proowner,proacl,proconfig,prosecdef from pg_proc where oid='public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure")).rows,
          indexes:(await db.query("select indexname,indexdef from pg_indexes where tablename='pos_sales_receipt_payments' order by indexname")).rows,
          payments:await payments(db),protected:await protectedState(db),
        });
        const before=await state();
        await assert.rejects(applyPaymentMigration(db,paymentMigration),e=>e.code==='55000'&&e.message==='pos_payment_reconciliation_definition_mismatch');
        assert.deepEqual(await state(),before);
      }finally{await db.close();}
    });
    await t.test('matching fixture MD5 allows migration; changed body is rejected against the captured baseline',async()=>{
      const db=await fixture({upgrade:false});
      try{
        const id=await addReceipt(db);await seed(db,id);const before=await payments(db);
        const definition=(await db.query("select pg_get_functiondef('public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure) definition")).rows[0].definition;
        await db.exec(definition.replace('  v_snapshot jsonb;', '  -- isolated drift test\n  v_snapshot jsonb;'));
        const drifted=(await db.query("select pg_get_functiondef('public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure) definition")).rows[0].definition;
        assert.notEqual(drifted,definition);
        await assert.rejects(applyPaymentMigration(db),e=>e.code==='55000');
        assert.equal((await db.query("select pg_get_functiondef('public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure) definition")).rows[0].definition,drifted);
        await unchanged(db,before);
        await db.exec(definition);await applyPaymentMigration(db);await call(db,[payment()]);
        assert.equal(Number((await payments(db))[0].amount),2074200);
      }finally{await db.close();}
    });
    await t.test('missing baseline function aborts migration before any function or ACL is created',async()=>{
      const db=await fixture({upgrade:false});
      try{
        await db.exec('drop function public.reconcile_sales_receipt_payments_v1(jsonb);');
        await assert.rejects(applyPaymentMigration(db,paymentMigration),e=>e.code==='55000');
        assert.equal((await db.query("select to_regprocedure('public.reconcile_sales_receipt_payments_v1(jsonb)') fn")).rows[0].fn,null);
      }finally{await db.close();}
    });
    await t.test('preflight mismatch leaves a transaction aborted so separately submitted DDL cannot proceed',async()=>{
      const db=await fixture({upgrade:false});
      try{
        const id=await addReceipt(db);await seed(db,id);const before=await payments(db);
        const boundary=paymentMigration.indexOf('create or replace function');
        await db.exec('begin;');
        await assert.rejects(db.exec(paymentMigration.slice(0,boundary)),e=>e.code==='55000');
        await assert.rejects(db.exec(paymentMigration.slice(boundary)),e=>e.code==='25P02');
        await db.exec('rollback;');
        assert.equal((await db.query("select md5(pg_get_functiondef('public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure)) hash")).rows[0].hash,db.fixtureDefinitionMd5);
        await unchanged(db,before);
      }finally{await db.exec('rollback;');await db.close();}
    });
    await scenario('space-padded duplicate receipt IDs are rejected before either snapshot changes payments',async db=>{
      const id=await addReceipt(db);await seed(db,id);const before=await payments(db),protectedBefore=await protectedState(db);
      for(const refs of [[incidentRef,' '+incidentRef+' '],[' '+incidentRef,incidentRef+' ']]){
        await assert.rejects(reconcile(db,refs.map(ref=>snapshot([payment()],ref))),e=>e.code==='22023'&&e.message==='duplicate_payment_snapshot_receipt');
        await unchanged(db,before);assert.deepEqual(await protectedState(db),protectedBefore);
      }
      await call(db,[payment()]);assert.equal(Number((await payments(db))[0].amount),2074200);
    });
    for(const [name,oldId,newId,oldExtra,newExtra,keep] of [
      ['same ID amount change',oldPaymentId,oldPaymentId,{amount:1900000},{},true],
      ['changed ID same amount',oldPaymentId,newPaymentId,{},{},false],
      ['changed ID and amount',oldPaymentId,newPaymentId,{amount:1900000},{},false],
      ['same ID method change',oldPaymentId,oldPaymentId,{},cash,false],
      ['ID method amount all change',oldPaymentId,newPaymentId,{amount:1900000},transfer,false],
      ['legacy missing ID becomes identified',null,newPaymentId,{amount:1900000},{},false],
      ['both IDs absent fallback',null,null,{amount:1900000},{},true],
      ['stable ID card identity changes',oldPaymentId,oldPaymentId,{}, {card_id:'replacement-card'},true],
    ]) await scenario(name,async db=>{
      const id=await addReceipt(db);const previous=await seed(db,id,payment(incidentRef,oldId,oldExtra));
      await call(db,[payment(incidentRef,newId,newExtra)]);const rows=await payments(db);assert.equal(rows.length,1);
      assert.equal(Number(rows[0].amount),2074200);assert.equal(rows[0].id===previous,keep);assert.equal(rows[0].card_id,newExtra.card_id===undefined?'visa-card':newExtra.card_id);
      await call(db,[payment(incidentRef,newId,newExtra)]);await unchanged(db,rows);
    });
    await scenario('incoming ID lost blocks ambiguous replacement and preserves rows',async db=>{
      const id=await addReceipt(db);await seed(db,id);const before=await payments(db);
      await assert.rejects(call(db,[payment(incidentRef,null)]),e=>e.code==='22023'&&e.message==='payment_external_id_missing'&&JSON.parse(e.detail).identityEvent==='id_missing');await unchanged(db,before);
    });
    for(const [name,rows,error] of [
      ['duplicate external ID',[payment(incidentRef,'dup',{amount:1000000}),payment(incidentRef,'dup',{...cash,amount:1074200})],'duplicate_payment_external_id'],
      ['duplicate VISA method distinct IDs',[payment(incidentRef,'a',{amount:1000000}),payment(incidentRef,'b',{amount:1074200})],'duplicate_payment_composite_identity'],
      ['missing array',null,'payment_snapshot_unavailable'],
      ['empty paid array',[],'paid_payment_snapshot_empty'],
      ['truncated paid amount',[payment(incidentRef,'a',{amount:1000000})],'payment_snapshot_amount_mismatch'],
      ['negative amount',[payment(incidentRef,'a',{amount:-1})],'invalid_payment_snapshot_row'],
      ['string amount',[payment(incidentRef,'a',{amount:'2074200'})],'invalid_payment_snapshot_row'],
      ['null element',[null],'invalid_payment_snapshot_row'],
      ['manual source in POS row',[payment(incidentRef,'a',{source:'manual'})],'invalid_payment_snapshot_row'],
      ['row RefID mismatch',[payment('wrong-ref')],'invalid_payment_snapshot_row'],
      ['raw RefID mismatch',[payment(incidentRef,'a',{raw_json:{SAInvoicePaymentID:'a',RefID:'different'}})],'invalid_payment_snapshot_identity'],
      ['conflicting ID aliases',[payment(incidentRef,'a',{raw_json:{SAInvoicePaymentID:'a',SAInvoicePaymentId:'b'}})],'invalid_payment_snapshot_identity'],
    ]) await scenario(name+' is atomic',async db=>{
      const id=await addReceipt(db);await seed(db,id);const before=await payments(db);
      await assert.rejects(call(db,rows),new RegExp(error));await unchanged(db,before);
    });
    await scenario('split preserves stable rows; external IDs and method keys can swap safely',async db=>{
      const id=await addReceipt(db);const a=payment(incidentRef,'a',{amount:1000000});const b=payment(incidentRef,'b',{...cash,amount:1074200});
      await seed(db,id,a);await seed(db,id,b);const before=await payments(db);
      await call(db,[a,b]);await unchanged(db,before);
      const swapped=[{...b,raw_json:a.raw_json},{...a,raw_json:b.raw_json}];await call(db,swapped);
      assert.deepEqual((await payments(db)).map(p=>[p.raw_json.SAInvoicePaymentID,p.payment_name,Number(p.amount)]).sort(),[['a','CASH',1074200],['b','VISA',1000000]]);
      const stable=await payments(db);await call(db,swapped);await unchanged(db,stable);
    });
    await scenario('a changed method colliding with a removed row is safely replaced; unaffected split row retains ID',async db=>{
      const id=await addReceipt(db);await seed(db,id,payment(incidentRef,'a',{amount:500000}));await seed(db,id,payment(incidentRef,'b',{...cash,amount:574200}));
      const retained=await seed(db,id,payment(incidentRef,'c',{...transfer,amount:1000000}));
      await call(db,[payment(incidentRef,'a',{...cash,amount:1074200}),payment(incidentRef,'c',{...transfer,amount:1000000})]);
      const rows=await payments(db);assert.equal(rows.length,2);assert.equal(rows.find(p=>p.payment_name==='TRANSFER').id,retained);
    });
    await scenario('duplicate existing external IDs are rejected instead of picking latest',async db=>{
      const id=await addReceipt(db);await seed(db,id,payment(incidentRef,'dup',{amount:1000000}));await seed(db,id,payment(incidentRef,'dup',{...cash,amount:1074200}));const before=await payments(db);
      await assert.rejects(call(db,[payment()]),/ambiguous_existing_payment_external_id/);await unchanged(db,before);
    });
    await scenario('whole RPC rollback includes an earlier corrected receipt; corrected retry succeeds',async db=>{
      const first='a-first',second='z-second';const a=await addReceipt(db,first),b=await addReceipt(db,second);
      await seed(db,a,payment(first,oldPaymentId,{amount:1900000}));await seed(db,b,payment(second,oldPaymentId,{amount:1900000}));const before=await payments(db);
      await assert.rejects(reconcile(db,[snapshot([payment(second,'bad',{amount:1})],second),snapshot([payment(first)],first)]),/payment_snapshot_amount_mismatch/);await unchanged(db,before);
      await reconcile(db,[snapshot([payment(first)],first),snapshot([payment(second)],second)]);assert.equal((await payments(db)).length,2);
      assert.ok((await payments(db)).every(p=>Number(p.amount)===2074200));
    });
    await scenario('manual modified receipt and history are protected before validating its snapshot',async db=>{
      const id=await addReceipt(db,incidentRef,{modified:true});await seed(db,id,payment(incidentRef,null,{source:'manual',amount:2074200}));await db.query("insert into pos_sales_receipt_modifications values(1,$1,'manual edit')",[id]);
      const before=await payments(db),protectedBefore=await protectedState(db);const result=await call(db,[payment()]);assert.equal(result.skippedModifiedReceiptCount,1);
      await unchanged(db,before);assert.deepEqual(await protectedState(db),protectedBefore);
    });
    await scenario('manual payment without modified flag fails closed',async db=>{
      const id=await addReceipt(db);await seed(db,id,payment(incidentRef,null,{source:'manual'}));const before=await payments(db);
      await assert.rejects(call(db,[payment()]),/manual_payment_protected/);await unchanged(db,before);
    });
    await scenario('canceled authoritative empty snapshot removes stale rows; unavailable never does',async db=>{
      const id=await addReceipt(db,incidentRef,{canceled:true,status:4});await seed(db,id);const before=await payments(db);
      await assert.rejects(call(db,null),/payment_snapshot_unavailable/);await unchanged(db,before);
      await call(db,[]);assert.equal((await payments(db)).length,0);
    });
    await scenario('October 14 normal VISA and another receipt retain row identity and historical data',async db=>{
      const ref='79efd6e9-3b00-4128-823c-03f257c8eb98',ext='6a971506-4f5a-42ce-85cd-6cbadfe8de20';
      const id=await addReceipt(db,ref,{date:'2026-10-14',total:1911400,number:'2601006894'});
      const row=payment(ref,ext,{amount:1911400});const oldId=await seed(db,id,{...row,amount:1750000});
      const other=await addReceipt(db,'other',{date:'2026-09-30',total:100});await seed(db,other,payment('other','other',{amount:100}));
      const before=await protectedState(db);await reconcile(db,[snapshot([row],ref)]);const ps=await payments(db);
      assert.equal(ps.find(p=>p.receipt_id===id).id,oldId);assert.equal(Number(ps.find(p=>p.receipt_id===other).amount),100);assert.deepEqual(await protectedState(db),before);
    });
    await scenario('function signature owner ACL security search_path survive migration and rollback',async db=>{
      const metadata=async()=> (await db.query(`select pg_get_userbyid(proowner) owner,proacl::text acl,prosecdef,proconfig,pg_get_function_identity_arguments(oid) args from pg_proc where oid='public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure`)).rows;
      const before=await metadata();assert.equal(before[0].owner,'postgres');assert.equal(before[0].prosecdef,false);assert.equal(before[0].args,'p_snapshots jsonb');
      const grants=(await db.query(`select has_function_privilege('anon','public.reconcile_sales_receipt_payments_v1(jsonb)','EXECUTE') anon,has_function_privilege('authenticated','public.reconcile_sales_receipt_payments_v1(jsonb)','EXECUTE') authenticated,has_function_privilege('service_role','public.reconcile_sales_receipt_payments_v1(jsonb)','EXECUTE') service`)).rows[0];
      assert.deepEqual(grants,{anon:false,authenticated:false,service:true});
      await db.exec('begin;'+previousPaymentMigration.replace('create function','create or replace function')+'rollback;');assert.deepEqual(await metadata(),before);
      await assert.rejects(applyPaymentMigration(db),/pos_payment_reconciliation_definition_mismatch/);
      assert.deepEqual(await metadata(),before);
    });
    await scenario('safe diagnostics include receipt context but never PostgreSQL failing row details',async db=>{
      const id=await addReceipt(db);await seed(db,id);await db.exec(`create function reject_payment() returns trigger language plpgsql as $$begin raise unique_violation using message='sensitive customer data',detail='private customer phone';end$$;create trigger reject_payment before insert on pos_sales_receipt_payments for each row execute function reject_payment();`);
      const before=await payments(db);await assert.rejects(call(db,[payment()]),e=>{assert.equal(e.code,'23505');const detail=JSON.parse(e.detail);assert.equal(detail.receiptNo,'2601006921');assert.equal(detail.receiptRefId,incidentRef);assert.equal(detail.businessDate,'2026-10-15');assert.equal(detail.failureType,'payment_unique_conflict');assert.equal(detail.uniqueConflict,true);assert.ok(!e.message.includes('sensitive'));assert.ok(!e.detail.includes('private'));return true;});await unchanged(db,before);
    });

    await scenario('isolated 32-receipt recovery restores 19 missing payments and preserves three manual edits',async db=>{
      // Synthetic recovery rehearsal using reported totals, not a current CUKCUK snapshot.
      const rows=[];const id=await addReceipt(db);await seed(db,id);rows.push(snapshot([payment()]));
      const manualAmounts=[877400,584400,440000];
      for(let i=0;i<12;i++){
        const manual=i<3,ref='synthetic-existing-'+i,amount=manual?manualAmounts[i]:(i===11?1160700:900000);
        const rid=await addReceipt(db,ref,{modified:manual,total:amount,number:ref});
        const p=payment(ref,manual?null:ref,{amount,...(manual?{...cash,payment_name:'Ti\u1ec1n m\u1eb7t'}:{}),source:manual?'manual':'cukcuk'});await seed(db,rid,p);
        if(manual)await db.query('insert into pos_sales_receipt_modifications values($1,$2,$3)',[i+1,rid,'preserve']);
        rows.push(snapshot([payment(ref,ref,{amount})],ref));
      }
      const missing=[1104000,1161600,876000,1150000,2306800,154000,1326000,1661400,963000,890600,1969000,891000,915000,885600,2501600,1377000,809000,800400,568000];
      assert.equal(missing.reduce((a,b)=>a+b,0),22310000);
      for(let i=0;i<missing.length;i++){const ref=String(2601006922+i);await addReceipt(db,ref,{total:missing[i],number:ref});rows.push(snapshot([payment(ref,ref,{amount:missing[i]})],ref));}
      const protectedBefore=await protectedState(db),before=await payments(db);assert.equal(before.length,13);
      assert.equal(before.reduce((sum,p)=>sum+Number(p.amount),0),12162500);
      const manualBefore=before.filter(p=>p.source==='manual');
      const result=await reconcile(db,rows);assert.equal(result.skippedModifiedReceiptCount,3);const after=await payments(db);
      assert.equal(after.length,32);assert.equal(after.reduce((sum,p)=>sum+Number(p.amount),0),34646700);
      assert.deepEqual(after.filter(p=>p.source==='manual'),manualBefore);assert.deepEqual(await protectedState(db),protectedBefore);
      const receipts=(await db.query('select * from pos_sales_receipts')).rows.map(r=>({...r,id:Number(r.id),business_date:'2026-10-15',revision:0,updated_at:null}));
      const normalized=after.map(p=>({...p,id:Number(p.id),receipt_id:Number(p.receipt_id),amount:Number(p.amount),business_date:'2026-10-15'}));
      const source=buildPosBusinessDaySource('2026-10-15',receipts,normalized);assert.equal(source.receiptCount,32);assert.equal(source.paymentTotal,source.receiptTotal);
      await reconcile(db,rows);await unchanged(db,after);
    });

    await scenario('duplicate receipt snapshots and missing receipt cannot change any payments',async db=>{
      const id=await addReceipt(db);await seed(db,id);const before=await payments(db);
      await assert.rejects(reconcile(db,[snapshot([payment()]),snapshot([payment()])]),/duplicate_payment_snapshot_receipt/);await unchanged(db,before);
      await assert.rejects(reconcile(db,[snapshot([payment('not-found')],'not-found')]),/payment_snapshot_receipt_not_found/);await unchanged(db,before);
      await db.query("update pos_sales_receipts set source='manual' where id=$1",[id]);
      await assert.rejects(call(db,[payment()]),/payment_snapshot_receipt_not_found/);await unchanged(db,before);
    });

    await scenario('cash transfer and VISA transitions work in both directions',async db=>{
      const methods=[cash,transfer,{payment_type:2,payment_name:'VISA',card_name:'VISA',card_id:'visa-card'}];
      for(let i=0;i<3;i++)for(let j=0;j<3;j++){if(i===j)continue;const ref='method-'+i+'-'+j;
        const rid=await addReceipt(db,ref);await seed(db,rid,payment(ref,'old',methods[i]));
        const next=payment(ref,i===0?'new':'old',methods[j]);await reconcile(db,[snapshot([next],ref)]);
        const rows=(await payments(db)).filter(p=>p.receipt_id===rid);assert.equal(rows.length,1);assert.equal(rows[0].payment_name,methods[j].payment_name);assert.equal(Number(rows[0].amount),2074200);
      }
    });
    await scenario('failure on a later split insert rolls back earlier UPDATE and selective deletes',async db=>{
      const id=await addReceipt(db);await seed(db,id);const before=await payments(db);
      await db.exec(`create function reject_cash() returns trigger language plpgsql as $$begin if new.payment_name='CASH' then raise exception 'injected_split_failure'; end if; return new; end$$;create trigger reject_cash before insert on pos_sales_receipt_payments for each row execute function reject_cash();`);
      await assert.rejects(call(db,[payment(incidentRef,oldPaymentId,{amount:1000000}),payment(incidentRef,'cash',{...cash,amount:1074200})]),e=>e.code==='P0001'&&e.message==='payment_reconciliation_failed');await unchanged(db,before);
    });
    await scenario('both legacy IDs absent but distinct card IDs fail closed',async db=>{
      const id=await addReceipt(db);await seed(db,id,payment(incidentRef,null));const before=await payments(db);
      await assert.rejects(call(db,[payment(incidentRef,null,{card_id:'different-card'})]),/ambiguous_legacy_payment_card_identity/);await unchanged(db,before);
    });
    await scenario('batch input order keeps the same sorted receipt lock order',async db=>{
      const refs=['a-receipt','z-receipt'];for(const ref of refs){const id=await addReceipt(db,ref);await seed(db,id,payment(ref,oldPaymentId,{amount:1900000}));}
      const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
      try{
        await a.query('begin');await b.query("set statement_timeout='10s'");const batch=refs.map(ref=>snapshot([payment(ref)],ref));
        await reconcile(a,batch);const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
        const pending=reconcile(b,[...batch].reverse());pending.catch(()=>{});let blocked=false;
        for(let i=0;i<100;i++){if((await db.query('select cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n>0){blocked=true;break;}await delay(10);}assert.equal(blocked,true);
        await a.query('commit');const result=await pending;assert.equal(result.unchangedReceiptCount,2);
        assert.equal(Number((await db.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks),0);
      }finally{await a.query('rollback');await a.end();await b.end();}
    });
    await scenario('mixed space-padded multi-receipt calls lock normalized IDs first without deadlock',async db=>{
      const refs=['a-receipt','m-receipt','z-receipt'],ids=[];
      for(const ref of refs){const id=await addReceipt(db,ref);ids.push(id);await seed(db,id,payment(ref,oldPaymentId,{amount:1900000}));}
      const a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
      try{
        await a.query("begin;set local statement_timeout='5s'");await b.query("set statement_timeout='5s'");
        await a.query('select id from pos_sales_receipts where id=$1 for update',[ids[0]]);
        const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
        // Raw sorting would grab z before waiting on a, creating an opposite lock order.
        const batchB=[snapshot([payment(refs[2])],'  '+refs[2]+' '),snapshot([payment(refs[1])],refs[1]+' '),snapshot([payment(refs[0])],refs[0])];
        pending=reconcile(b,batchB);pending.catch(()=>{});let blocked=false;
        for(let i=0;i<100;i++){if((await db.query('select cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n>0){blocked=true;break;}await delay(10);}assert.equal(blocked,true);
        // b must be waiting on a before touching either m or z.
        await db.exec('begin;');
        try{await db.query('select id from pos_sales_receipts where id=any($1::bigint[]) order by id for update nowait',[ids.slice(1)]);}finally{await db.exec('rollback;');}
        await reconcile(a,refs.map((ref,i)=>snapshot([payment(ref)],' '+ref+' '.repeat(i))));await a.query('commit');
        assert.equal((await pending).unchangedReceiptCount,3);
        assert.equal((await payments(db)).length,3);
        assert.equal(Number((await db.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks),0);
      }finally{await a.query('rollback');if(pending)await pending.catch(()=>{});await a.end();await b.end();}
    });
    await scenario('concurrent administrator edit is rechecked after receipt lock wait',async db=>{
      const id=await addReceipt(db);await seed(db,id);const before=await payments(db);
      const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
      try{
        await a.query('begin');await b.query("set statement_timeout='10s'");await a.query('update pos_sales_receipts set is_modified=true where id=$1',[id]);
        const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;const pending=call(b,[payment()]);pending.catch(()=>{});let blocked=false;
        for(let i=0;i<100;i++){if((await db.query('select cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n>0){blocked=true;break;}await delay(10);}assert.equal(blocked,true);
        await a.query('commit');assert.equal((await pending).skippedModifiedReceiptCount,1);await unchanged(db,before);
      }finally{await a.query('rollback');await a.end();await b.end();}
    });
    await scenario('real concurrent calls wait on the receipt lock and become idempotent',async db=>{
      const id=await addReceipt(db);await seed(db,id);const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
      try {
        await a.query("begin;set local statement_timeout='10s'");await b.query("set statement_timeout='10s'");
        await call(a,[payment()]);const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
        const pending=call(b,[payment()]);pending.catch(()=>{});
        let blocked=false;for(let i=0;i<100;i++){if((await db.query('select cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n>0){blocked=true;break;}await delay(10);}assert.equal(blocked,true);
        await a.query('commit');const result=await pending;assert.equal(result.createdCount+result.updatedCount+result.deletedCount,0);assert.equal((await payments(db)).length,1);
      }finally{await a.query('rollback');await a.end();await b.end();}
    });
  } finally {await runtime.stop();}
});
