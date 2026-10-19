import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsApi} from './helpers/ledger-settings-api-fixture.mjs';
for(const month of ['2026-08','2026-09','2026-10'])test(`settings real GET handlers retain lightweight reads and calculation fields (${month})`,async()=>{
 const api=settingsApi();
 const request=async(path,queries)=>{const n=api.calls.length+api.accounts.calls.length,r=await api.request(path);assert.equal(r.status,200);assert.equal(api.calls.length+api.accounts.calls.length-n,queries);return r.json();};
 const accounts=await request(`/api/admin/ledger?month=${month}&scope=accounts`,5);
 assert.ok(accounts.accounts.length>0);assert.equal(accounts.entries,undefined);assert.equal(api.accounts.spies.entries,0);
 const owners=await request(`/api/admin/ledger/owners?throughMonth=${month}&mode=settings`,4);
 assert.equal(owners.mode,'settings');assert.equal(owners.participants.length,3);assert.equal(owners.users.length,3);
 assert.equal(owners.policy.revision,3);assert.equal(owners.policy.lines.reduce((s,l)=>s+Number(l.settlement_rate),0),1);
 const reserves=await request('/api/admin/ledger/reserves',4);
 assert.equal(reserves.plans[0].currentAmount,10000);assert.equal(reserves.plans[0].remainingAmount,90000);assert.equal(reserves.freeCash,reserves.liquidFunds-reserves.activeReserve);
 assert.equal(reserves.plans[0].fundAccount.id,1);assert.ok(reserves.eligibleAccounts.length>0);
 const partners=await request('/api/admin/partners',8);
 assert.equal(partners.partners.length,2);assert.equal(partners.supplierAliases.filter(a=>a.status==='pending').length,1);
 assert.ok(partners.fundAccounts.every(a=>a.type!=='card_clearing'));assert.deepEqual(api.rpcs,[]);
});
