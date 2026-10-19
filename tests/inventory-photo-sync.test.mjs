import assert from 'node:assert/strict';
import test from 'node:test';
import {findInventoryLogNameSyncItems,planInventoryLogNameUpdates} from '../lib/inventory/snapshot-name-sync.ts';
import {photoSync622} from './helpers/inventory-photo-sync-fixture.mjs';
const find=f=>findInventoryLogNameSyncItems(f.businessDate,f.logs,[f.master]);
const economic=f=>find(f)[0]?.targets[0]?.syncItem;
const edit=(f,overrides={})=>({...f.photo,id:13629,source:'edit_form',created_at:f.businessDate+'T03:03:00Z',new_purchase_price:350000,new_supplier:'Other Shop',purchase_supplier_partner_id:27,...overrides});
test('#622 photo with missing partner followed by stock check has no false daily sync target or writes',()=>{
 const f=photoSync622(),before=JSON.stringify(f);assert.deepEqual(find(f),[]);assert.deepEqual(planInventoryLogNameUpdates(f.businessDate,f.logs,[f.master]),[]);assert.equal(JSON.stringify(f),before);assert.equal(f.root.purchase_supplier_partner_id,7);assert.equal(f.master.quantity,4);
});
for(const note of ['품목 사진 추가','품목 사진 변경','품목 사진 삭제'])test(note+' never supplies money/payee, even if its snapshots are stale or populated',()=>{
 for(const fields of [{purchase_supplier_partner_id:null},{purchase_supplier_partner_id:99,new_supplier:'Stale Shop',new_purchase_price:999999}, {purchase_supplier_partner_id:null,new_supplier:null,new_purchase_price:null}]){const f=photoSync622();Object.assign(f.photo,{new_note:note},fields);assert.deepEqual(find(f),[]);}
});
test('photo then actual supplier/price edit uses the genuine edit and retains financial review',()=>{
 const f=photoSync622();f.logs.push(edit(f));const target=find(f)[0].targets[0];assert.equal(target.correctionLogId,13629);assert.equal(target.syncItem.supplier,'Other Shop');assert.equal(target.syncItem.supplier_partner_id,27);assert.equal(target.syncItem.purchase_price,350000);assert.ok(target.changes.some(c=>c.field==='supplier_partner_id'));
});
test('actual supplier/price edit then one or more stale photos preserves the last valid economics',()=>{
 const f=photoSync622();f.logs.push(edit(f),{...f.photo,id:13630,created_at:f.businessDate+'T03:04:00Z',new_supplier:'Shopee',new_purchase_price:300000},{...f.photo,id:13631,created_at:f.businessDate+'T03:05:00Z',purchase_supplier_partner_id:99});const result=find(f)[0],target=result.targets[0];assert.equal(target.correctionLogId,13629);assert.equal(target.syncItem.supplier,'Other Shop');assert.equal(target.syncItem.supplier_partner_id,27);assert.equal(target.syncItem.purchase_price,350000);
});
test('sparse nonphoto display edit inherits preceding valid economics instead of rolling back to the root',()=>{
 const f=photoSync622();f.logs.push(edit(f),edit(f,{id:13630,created_at:f.businessDate+'T03:04:00Z',new_supplier:null,new_purchase_price:null,purchase_supplier_partner_id:null}));assert.equal(economic(f).supplier,'Other Shop');assert.equal(economic(f).supplier_partner_id,27);assert.equal(economic(f).purchase_price,350000);
});
test('real explicit partner unlink is retained and cannot be undone by a later photo with an ID',()=>{
 const f=photoSync622();f.logs.push(edit(f,{new_supplier:'Shopee',new_purchase_price:300000,purchase_supplier_partner_id:null}),{...f.photo,id:13630,created_at:f.businessDate+'T03:04:00Z',purchase_supplier_partner_id:7});const target=find(f)[0].targets[0];assert.equal(target.syncItem.supplier_partner_id,null);assert.deepEqual(target.changes.map(c=>c.field),['supplier_partner_id']);assert.equal(target.correctionLogId,13629);
});
test('photo plus name change preserves original partner, while stock changes are never synchronized',()=>{
 const f=photoSync622();f.master.item_name='새 표시명';const result=find(f)[0];assert.deepEqual(result.changes.map(c=>c.field),['item_name']);assert.equal(result.targets[0].syncItem.supplier_partner_id,7);assert.equal('quantity' in result.targets[0].syncItem,false);assert.equal(result.quantityReviewRequired,false);
});
test('photos cannot cause quantity review but a genuine inconsistent zero-quantity edit still does',()=>{
 const f=photoSync622();f.photo.new_quantity=4;assert.deepEqual(find(f),[]);f.logs.push(edit(f,{new_quantity:4,prev_quantity:3}));assert.equal(find(f)[0].quantityReviewRequired,true);
});
test('multiple receipts retain segment-specific historical economics across edits and photos',()=>{
 const f=photoSync622();const firstEdit=edit(f);const next={...f.root,id:13640,created_at:f.businessDate+'T04:00:00Z',new_supplier:'Later Shop',purchase_supplier_partner_id:40,new_purchase_price:400000};const nextPhoto={...f.photo,id:13641,created_at:f.businessDate+'T04:01:00Z',new_supplier:'Wrong Shop',new_purchase_price:999999};f.logs.push(firstEdit,next,nextPhoto);Object.assign(f.master,{supplier:'Later Shop',supplier_partner_id:40,purchase_price:400000});const items=find(f);assert.deepEqual(items[0].logIds,[13626]);assert.equal(items[0].targets[0].syncItem.supplier,'Other Shop');assert.equal(next.purchase_supplier_partner_id,40);
});
test('all eligible dates from 2026-09-23 through 2026-10-20 handle legacy photos without backfill',()=>{
 for(let day=Date.parse('2026-09-23T00:00:00Z');day<=Date.parse('2026-10-20T00:00:00Z');day+=86400000){const f=photoSync622(new Date(day).toISOString().slice(0,10));assert.deepEqual(find(f),[]);const changed=edit(f);f.logs.push(changed,{...f.photo,id:13630,created_at:f.businessDate+'T05:00:00Z'});assert.equal(economic(f).supplier_partner_id,27);}
});
