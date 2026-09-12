// All migrations and mutations below run only in a fresh in-memory PostgreSQL.
import assert from 'node:assert/strict';
import test from 'node:test';
import { posCloseDatabase, daySource, closeDay, syncDays, ledgerState, addCardSettlement } from './helpers/pos-business-day-close-fixture.mjs';

test('initial close projects reconciled final amounts and creates revision 1 with audit evidence', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    const result = await closeDay(db, source, { syncRunId: 1 });
    assert.equal(result.status, 'closed');
    assert.equal(result.revision, 1);
    const state = await ledgerState(db);
    assert.equal(state.transactions.length, 2);
    assert.equal(state.transactions.reduce((sum, row) => sum + Number(row.amount), 0), 100000);
    assert.deepEqual(state.closures[0].source_snapshot, source.sourceSnapshot);
    assert.equal(state.closures[0].source_fingerprint, source.sourceFingerprint);
    assert.equal(state.closures[0].sync_run_id, 1);
    assert.equal(state.closures[0].closed_at, state.closures[0].created_at);
    assert.ok(state.audits.some(row => row.action === 'pos_sales_day_closed'));
    assert.equal((await db.query('select count(*)::int n from pos_sales_close_private.projection_permissions')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('same fingerprint close and v3 sync are strict no-ops, including Ledger timestamps and audit', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    await closeDay(db, source);
    const before = await ledgerState(db);
    assert.equal((await closeDay(db, source)).status, 'already_closed');
    assert.equal((await syncDays(db, [source])).unchangedCount, 4);
    assert.deepEqual(await ledgerState(db), before);
  } finally { await db.close(); }
});

test('closed-day drift cannot overwrite; explicit manual reclose appends revision and updates projection', async () => {
  const db = await posCloseDatabase();
  try {
    await closeDay(db, await daySource(db));
    const before = await ledgerState(db);
    await db.exec('update pos_sales_receipts set final_amount=120000,revision=2 where id=1; update pos_sales_receipt_payments set amount=80000 where id=2;');
    const changed = await daySource(db);
    assert.equal((await closeDay(db, changed)).status, 'source_changed_after_close');
    const sync = await syncDays(db, [changed]);
    assert.equal(sync.dailyCloseDrift.length, 1);
    assert.equal(sync.updatedCount, 0);
    assert.deepEqual(await ledgerState(db), before);
    const reclose = await closeDay(db, changed, { reclose: true, actor: 2 });
    assert.equal(reclose.status, 'reclosed');
    assert.equal(reclose.revision, 2);
    const after = await ledgerState(db);
    assert.deepEqual(after.closures[0], before.closures[0]);
    assert.equal(after.closures[1].closed_by, 2);
    assert.equal(after.transactions.reduce((sum, row) => sum + Number(row.amount), 0), 120000);
    assert.equal((await closeDay(db, changed)).status, 'already_closed');
    await assert.rejects(closeDay(db, changed, { reclose: true, method: 'automatic' }), /INVALID_POS_SALES_CLOSE_REQUEST/);
  } finally { await db.close(); }
});

test('owner/master accepted, inactive actors denied and manager cannot use general sync or automation', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    for (const actor of [4, 999]) {
      assert.equal((await closeDay(db, source, { actor })).status, 'forbidden');
      assert.equal((await syncDays(db, [source], actor)).status, 'forbidden');
    }
    assert.equal((await syncDays(db, [source], 3)).status, 'forbidden');
    assert.equal((await closeDay(db, source, { actor: 3, method: 'automatic' })).status, 'forbidden');
    await assert.rejects(closeDay(db, source, { syncRunId: 2 }), /POS_SALES_SUCCESSFUL_SYNC_RUN_REQUIRED/);
    assert.equal((await closeDay(db, source, { actor: 2, method: 'automatic', syncRunId: 1 })).status, 'closed');
    assert.equal((await closeDay(db, source, { actor: 1 })).status, 'already_closed');
  } finally { await db.close(); }
});

test('month close blocks both initial close and explicit reclose; v3 retains month drift protection', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    await syncDays(db, [source]);
    await db.exec("insert into ledger_month_closures(month) values ('2026-08-01')");
    assert.equal((await closeDay(db, source)).status, 'month_closed');
    assert.equal((await closeDay(db, source, { reclose: true })).status, 'month_closed');
    const before = (await ledgerState(db)).transactions;
    await db.exec('update pos_sales_receipts set final_amount=110000 where id=1; update pos_sales_receipt_payments set amount=70000 where id=2');
    const result = await syncDays(db, [await daySource(db)]);
    assert.equal(result.closedMonth, true);
    assert.equal(result.driftCount, 2);
    assert.deepEqual((await ledgerState(db)).transactions, before);
  } finally { await db.close(); }
});

test('zero-sales days and zero final-amount receipts can close without synthetic Ledger income', async () => {
  const db = await posCloseDatabase();
  try {
    const empty = await daySource(db, '2026-08-21');
    assert.equal(empty.receiptTotal, 0);
    assert.equal((await closeDay(db, empty)).status, 'closed');
    await db.exec("insert into pos_sales_receipts values (4,'Free','2026-08-22',null,3,false,0,1,null)");
    const free = await daySource(db, '2026-08-22');
    assert.equal(free.receiptCount, 1);
    assert.equal((await closeDay(db, free)).status, 'closed');
    assert.equal((await ledgerState(db)).transactions.length, 0);
  } finally { await db.close(); }
});

test('stale or forged source, incomplete rows, payment and bucket mismatch all fail closed', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    await assert.rejects(closeDay(db, { ...source, rows: source.rows.slice(1) }), /POS_SOURCE_CHANGED_BEFORE_PROJECTION/);
    await assert.rejects(closeDay(db, { ...source, sourceFingerprint: 'a'.repeat(64) }), /POS_SOURCE_CHANGED_BEFORE_PROJECTION/);
    await db.exec('update pos_sales_receipt_payments set amount=50000 where id=2');
    await assert.rejects(closeDay(db, source), /POS_PAYMENT_RECONCILIATION_MISMATCH/);
    await db.exec("update pos_sales_receipt_payments set amount=60000,payment_name='unknown' where id=2");
    await assert.rejects(closeDay(db, source), /POS_PAYMENT_BUCKET_ALLOCATION_MISMATCH/);
    assert.equal((await ledgerState(db)).transactions.length, 0);
    assert.equal((await ledgerState(db)).closures.length, 0);
  } finally { await db.close(); }
});

test('projection failure after the first bucket rolls back all Ledger rows, close rows and audit', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    await db.exec("delete from ledger_payment_method_mappings where bucket='transfer'");
    const before = await ledgerState(db);
    await assert.rejects(closeDay(db, source), /POS_SALES_LEDGER_PROJECTION_FAILED/);
    assert.deepEqual(await ledgerState(db), before);
    await assert.rejects(syncDays(db, [source]), /POS_SALES_LEDGER_PROJECTION_FAILED/);
    assert.deepEqual(await ledgerState(db), before);
    assert.equal((await db.query('select count(*)::int n from pos_sales_close_private.projection_permissions')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('immutable history, legacy v1/v2 and movement guards cannot bypass daily close', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    await closeDay(db, source);
    const before = await ledgerState(db);
    for (const name of ['ledger_sync_pos_sales_v1', 'ledger_sync_pos_sales_v2']) {
      await assert.rejects(db.query(`select ${name}($1::jsonb,1)`, [JSON.stringify(source.rows)]), /POS_SALES_DAY_CLOSED/);
    }
    await assert.rejects(db.exec('update ledger_movements set amount=1'), /POS_SALES_DAY_CLOSED/);
    await assert.rejects(db.exec('update pos_sales_business_day_closures set revision=2'), /POS_SALES_DAY_CLOSURE_IMMUTABLE/);
    await assert.rejects(db.exec('delete from pos_sales_business_day_closures'), /POS_SALES_DAY_CLOSURE_IMMUTABLE/);
    await assert.rejects(db.exec('truncate pos_sales_business_day_closures'), /POS_SALES_DAY_CLOSURE_IMMUTABLE/);
    assert.deepEqual(await ledgerState(db), before);
  } finally { await db.close(); }
});

test('RLS/grants deny public roles and private projection capabilities; service role may close only through RPC', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    await db.exec('set role service_role');
    await assert.rejects(db.exec('insert into pos_sales_close_private.projection_permissions values (1,current_date)'), /permission denied/);
    await assert.rejects(db.exec("insert into pos_sales_business_day_closures(business_date,revision,close_method,closed_by,source_fingerprint,source_snapshot) values ('2026-08-20',1,'manual',1,repeat('a',64),'{}')"), /permission denied/);
    assert.equal((await closeDay(db, source)).status, 'closed');
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`reset role; set role ${role}`);
      await assert.rejects(closeDay(db, source), /permission denied/);
      await assert.rejects(syncDays(db, [source]), /permission denied/);
    }
  } finally { await db.close(); }
});

test('repeated queued closes create one immutable revision and one set of projected buckets', async () => {
  const db = await posCloseDatabase();
  try {
    const source = await daySource(db);
    const results = await Promise.all(Array.from({ length: 10 }, () => closeDay(db, source)));
    assert.equal(results.filter(row => row.status === 'closed').length, 1);
    assert.equal(results.filter(row => row.status === 'already_closed').length, 9);
    assert.equal((await ledgerState(db)).closures.length, 1);
    assert.equal((await ledgerState(db)).transactions.length, 2);
  } finally { await db.close(); }
});

test('August v3 open-day projection matches the existing v2 amounts, accounts and bucket fingerprints', async () => {
  const legacy = await posCloseDatabase();
  const current = await posCloseDatabase();
  try {
    for (const db of [legacy, current]) await db.exec(`
      update pos_sales_receipt_payments set amount=20000 where id=2;
      insert into pos_sales_receipt_payments values
        (4,1,'2026-08-20',2,'Visa',null,30000),(5,1,'2026-08-20',9,'khác',null,10000);
    `);
    const before = await daySource(legacy);
    await legacy.query('select ledger_sync_pos_sales_v2($1::jsonb,1)', [JSON.stringify(before.rows)]);
    assert.equal((await syncDays(current, [await daySource(current)])).createdCount, 4);
    const economic = `select t.source_key,t.amount,t.status,t.source_fingerprint,m.fund_account_id,m.amount movement_amount
      from ledger_transactions t join ledger_movements m on m.transaction_id=t.id order by t.source_key`;
    assert.deepEqual((await current.query(economic)).rows, (await legacy.query(economic)).rows);
  } finally { await legacy.close(); await current.close(); }
});

test('reclose to a zero bucket preserves historical rows and removes that bucket from confirmed sales', async () => {
  const db = await posCloseDatabase();
  try {
    await closeDay(db, await daySource(db));
    await db.exec('update pos_sales_receipt_payments set amount=0 where id=1; update pos_sales_receipt_payments set amount=100000 where id=2;');
    assert.equal((await closeDay(db, await daySource(db), { reclose: true })).status, 'reclosed');
    const rows = (await ledgerState(db)).transactions;
    assert.equal(rows.find(row => row.source_key.endsWith(':cash')).status, 'corrected');
    assert.equal(rows.filter(row => row.status === 'confirmed').reduce((sum, row) => sum + Number(row.amount), 0), 100000);
  } finally { await db.close(); }
});

test('failed reclose and a subsequently closed month preserve the prior Ledger and closure revision', async () => {
  const db = await posCloseDatabase();
  try {
    await closeDay(db, await daySource(db));
    const original = await ledgerState(db);
    await db.exec(`update pos_sales_receipts set final_amount=120000 where id=1;
      insert into pos_sales_receipt_payments values (4,1,'2026-08-20',2,'Visa',null,20000);
      delete from ledger_payment_method_mappings where bucket='card';`);
    const source = await daySource(db);
    await assert.rejects(closeDay(db, source, { reclose: true }), /POS_SALES_LEDGER_PROJECTION_FAILED/);
    assert.deepEqual(await ledgerState(db), original);
    await db.exec("insert into ledger_month_closures(month) values ('2026-08-01')");
    assert.equal((await closeDay(db, source, { reclose: true })).status, 'month_closed');
    assert.equal((await syncDays(db, [source])).dailyCloseDrift.length, 1);
    assert.deepEqual(await ledgerState(db), original);
  } finally { await db.close(); }
});

test('canonical database and TypeScript source agree on escaped Unicode metadata and normalized payment names', async () => {
  const db = await posCloseDatabase();
  try {
    await db.query('update pos_sales_receipts set ref_no=$1 where id=1', ['東京 "quoted" \\ path\nnext']);
    await db.query('update pos_sales_receipt_payments set payment_name=$1 where id=1', ['\t TIỀN MẶT\n']);
    const source = await daySource(db);
    assert.equal(source.cash, 40000);
    assert.equal((await closeDay(db, source)).status, 'closed');
  } finally { await db.close(); }
});

for (const [status, cashOnly, expected, metadataOnly] of [
  [null,false,'reclosed'], ['matched',true,'reclosed'], ['partial',false,'card_settlement_locked'],
  ['matched',false,'card_settlement_locked'], ['cancelled',false,'reclosed'], ['matched',false,'card_settlement_locked',true],
]) test(`card reclose guard: settlement=${status}, cashOnly=${cashOnly}, metadataOnly=${metadataOnly} -> ${expected}`, async () => {
  const db=await posCloseDatabase();
  try {
    await db.exec(`update pos_sales_receipt_payments set payment_type=2,payment_name='Visa' where id=2;
      insert into pos_sales_receipts values (5,'Cash only','2026-08-20',null,3,false,20000,1,null);
      insert into pos_sales_receipt_payments values (5,5,'2026-08-20',1,'tiền mặt',null,20000);`);
    await closeDay(db,await daySource(db));
    if(status) await addCardSettlement(db,status);
    const before=await ledgerState(db);
    const settlementsBefore=(await db.query('select to_jsonb(r) row from ledger_card_reconciliations r')).rows;
    const linesBefore=(await db.query('select to_jsonb(l) row from ledger_card_reconciliation_lines l')).rows;
    if(metadataOnly) await db.exec("update pos_sales_receipt_payments set payment_name='Mastercard' where id=2");
    else if(cashOnly) await db.exec('update pos_sales_receipts set final_amount=30000 where id=5; update pos_sales_receipt_payments set amount=30000 where id=5');
    else await db.exec('update pos_sales_receipts set final_amount=110000 where id=1; update pos_sales_receipt_payments set amount=70000 where id=2');
    const changed=await daySource(db);
    assert.equal((await closeDay(db,changed,{reclose:true})).status,expected);
    const after=await ledgerState(db);
    if(expected==='card_settlement_locked') assert.deepEqual(after,before);
    else {
      assert.equal(after.closures.length,2);
      assert.deepEqual(after.closures[0],before.closures[0]);
      const card=after.transactions.find(t=>t.source_key?.endsWith(':card'));
      assert.equal(Number(card.amount),cashOnly?60000:70000);
    }
    assert.deepEqual((await db.query('select to_jsonb(r) row from ledger_card_reconciliations r')).rows,settlementsBefore);
    assert.deepEqual((await db.query('select to_jsonb(l) row from ledger_card_reconciliation_lines l')).rows,linesBefore);
  } finally {await db.close();}
});

test('manager initial close projects as the actual actor; existing dates cannot be changed/reclosed by manager', async()=>{
  const db=await posCloseDatabase();
  try{
    await syncDays(db,[await daySource(db)]);
    await db.exec('update pos_sales_receipts set final_amount=110000 where id=1; update pos_sales_receipt_payments set amount=70000 where id=2');
    const source=await daySource(db);
    assert.equal((await closeDay(db,source,{actor:3})).status,'closed');
    const before=await ledgerState(db);
    assert.equal(before.closures[0].closed_by,3);
    assert.ok(before.audits.some(a=>a.action==='pos_sync_drift_updated'&&Number(a.actor_user_id)===3));
    assert.equal((await closeDay(db,source,{actor:3})).status,'already_closed');
    assert.equal((await closeDay(db,source,{actor:3,reclose:true})).status,'forbidden');
    await db.exec('update pos_sales_receipts set final_amount=120000 where id=1; update pos_sales_receipt_payments set amount=80000 where id=2');
    const changed=await daySource(db);
    for(const reclose of [false,true]) assert.equal((await closeDay(db,changed,{actor:3,reclose})).status,'forbidden');
    assert.deepEqual(await ledgerState(db),before);
    assert.equal((await closeDay(db,changed,{actor:1,reclose:true})).status,'reclosed');
  }finally{await db.close();}
});

test('v3 mixed dates never forwards closed drift rows to v2; only open day is projected',async()=>{
 const db=await posCloseDatabase();
 try{
  await closeDay(db,await daySource(db));
  const before=await ledgerState(db);
  await db.exec(`update pos_sales_receipts set final_amount=110000 where id=1; update pos_sales_receipt_payments set amount=70000 where id=2;
   insert into pos_sales_receipts values (5,'Open','2026-08-21',null,3,false,30000,1,null);
   insert into pos_sales_receipt_payments values (5,5,'2026-08-21',1,'tiền mặt',null,30000);`);
  const result=await syncDays(db,[await daySource(db,'2026-08-21'),await daySource(db)]);
  assert.equal(result.dailyCloseDrift.length,1);
  assert.equal(result.createdCount,1);
  const after=await ledgerState(db);
  assert.deepEqual(after.transactions.filter(t=>t.business_date==='2026-08-20'),before.transactions);
  assert.deepEqual(after.movements.filter(m=>before.transactions.some(t=>t.id===m.transaction_id)),before.movements);
  assert.deepEqual(after.closures,before.closures);
  assert.equal(Number(after.transactions.find(t=>t.business_date==='2026-08-21').amount),30000);
 }finally{await db.close();}
});

test('daily guard permits unrelated manual correction, card deposit, payroll, expense and transfer writes',async()=>{
 const db=await posCloseDatabase();
 try{
  await closeDay(db,await daySource(db));
  const before=(await ledgerState(db)).transactions;
  for(const sourceType of ['manual_correction','card_settlement_deposit','payroll','expense','transfer']){
   const {rows}=await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,amount,status,source_type,created_by,confirmed_by,source_fingerprint,source_synced_at)
    values(gen_random_uuid(),'transfer',now(),'2026-08-20',1000,'confirmed',$1,1,1,repeat('b',64),now()) returning id`,[sourceType]);
   const id=rows[0].id;
   await db.query('insert into ledger_movements(transaction_id,fund_account_id,amount) select $1,id,1000 from ledger_fund_accounts limit 1',[id]);
   await db.query('update ledger_transactions set amount=2000 where id=$1',[id]);
   await db.query('update ledger_movements set amount=2000 where transaction_id=$1',[id]);
   await db.query('delete from ledger_movements where transaction_id=$1',[id]);
   await db.query('delete from ledger_transactions where id=$1',[id]);
  }
  assert.deepEqual((await ledgerState(db)).transactions,before);
  await assert.rejects(db.query('select pos_sales_close_private.project_business_day($1::jsonb,3)',[JSON.stringify((await daySource(db)).rows)]),/INTERNAL_PROJECTION_FORBIDDEN/);
  const restrictedRows=JSON.stringify((await daySource(db)).rows);
  await db.exec('set role service_role');
  await assert.rejects(db.query('select pos_sales_close_private.project_business_day($1::jsonb,1)',[restrictedRows]),/permission denied/);
 }finally{await db.close();}
});
