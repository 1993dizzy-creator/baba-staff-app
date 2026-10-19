import test from 'node:test';import assert from 'node:assert/strict';
import {entriesApi} from './helpers/ledger-entries-api-fixture.mjs';import {entriesTables} from './helpers/ledger-entries-tables.mjs';
for(const scope of ['dashboard','entries','accounts',''])test(`ledger ${scope||'default'} timings expose durations only, retain required response fields`,async()=>{
 const api=entriesApi(entriesTables()),r=await api.get('2026-10',scope?'&scope='+scope:''),body=await r.json();assert.equal(r.status,200);const header=r.headers.get('server-timing');assert.ok(header);
 for(const token of header.split(', '))assert.match(token,/^(auth|closure_read|base_reads|prior_movements|profit_processing|card_allocations_read|card_gross_processing|card_fee_read|cash_processing|cash_inputs|accounting_processing|inventory_display|postprocess|serialize|total);dur=\d+(\.\d{2})$/);
 assert.match(header,/auth;dur=/);assert.match(header,/serialize;dur=/);assert.match(header,/total;dur=/);assert.equal(body.month,'2026-10');assert.ok(Array.isArray(body.accounts));
 if(scope==='entries')assert.match(header,/inventory_display;dur=/);if(scope==='dashboard'||scope==='accounts')assert.doesNotMatch(header,/inventory_display/);
 if(scope!=='accounts')assert.ok(body.summary);if(scope==='entries'||!scope)assert.ok(Array.isArray(body.entries));
});
test('denied ledger reads perform no DB queries even with timing instrumentation',async()=>{const api=entriesApi(entriesTables(),{denied:true});const r=await api.get('2026-10','&scope=entries');assert.equal(r.status,403);assert.equal(api.calls.length,0);});
