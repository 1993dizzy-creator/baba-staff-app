// Uses only a fresh in-memory PostgreSQL; never connects to Production.
import assert from 'node:assert/strict';
import test from 'node:test';
import { posFinalDatabase, daySource, finalCheck } from './helpers/pos-business-day-final-fixture.mjs';
import { closeDay, ledgerState } from './helpers/pos-business-day-close-fixture.mjs';

for (const method of ['manual', 'automatic']) test(`canceled CUKCUK replaced by manual other receipt: ${method} close projects exact buckets`, async () => {
  const { db, ...context } = await posFinalDatabase();
  try {
    await db.exec('delete from pos_sales_receipt_payments; delete from pos_sales_receipts;');
    const rows = [
      [1, '2601006748', 4, true, 2_325_600], [2, '2601006750', 4, true, 2_325_600],
      [3, 'M-261006-003', 3, false, 2_325_600], [4, 'cash', 3, false, 7_465_700],
      [5, 'transfer', 3, false, 9_552_600], [6, 'card', 3, false, 4_294_200], [7, 'other', 3, false, 280_000],
    ];
    for (const [id, ref, status, canceled, amount] of rows) {
      await db.query('insert into pos_sales_receipts(id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at) values($1,$2,$3,null,$4,$5,$6,1,null)',
        [id, ref, context.date, status, canceled, amount]);
    }
    for (const [id, name, type] of [[3, 'khac', 9], [4, 'ti\u1ec1n m\u1eb7t', 1], [5, 'chuy\u1ec3n kho\u1ea3n', 1], [6, 'Visa', 2], [7, 'khac', 9]]) {
      await db.query('insert into pos_sales_receipt_payments(id,receipt_id,business_date,payment_type,payment_name,card_name,amount) values($1,$1,$2,$3,$4,null,$5)',
        [id, context.date, type, name, rows.find(row => row[0] === id)[4]]);
    }
    const source = await daySource(db, context.date);
    assert.equal(source.receiptCount, 5);
    assert.equal(source.receiptTotal, 23_918_100);
    assert.deepEqual(source.sourceSnapshot.totalsByBucket, { cash: 7_465_700, transfer: 9_552_600, card: 4_294_200, other: 2_605_600 });
    if (method === 'manual') assert.equal((await closeDay(db, source, { actor: 1, syncRunId: 100 })).status, 'closed');
    const check = await finalCheck(db, context, { source });
    assert.equal(check.status, 'verified_unchanged');
    const state = await ledgerState(db);
    assert.equal(state.closures.length, 1);
    assert.equal(state.closures[0].close_method, method);
    assert.equal(state.closures[0].source_fingerprint, source.sourceFingerprint);
    assert.equal(state.transactions.length, 4);
    assert.equal(state.transactions.reduce((sum, row) => sum + Number(row.amount), 0), 23_918_100);
    assert.equal(state.movements.reduce((sum, row) => sum + Number(row.amount), 0), 23_918_100);
    for (const [bucket, amount] of Object.entries(source.sourceSnapshot.totalsByBucket)) {
      assert.equal(Number(state.transactions.find(row => row.source_key === `pos:${context.date}:${bucket}`).amount), amount);
    }
    assert.ok(state.audits.some(row => row.action === 'pos_sales_day_closed'));
  } finally { await db.close(); }
});
