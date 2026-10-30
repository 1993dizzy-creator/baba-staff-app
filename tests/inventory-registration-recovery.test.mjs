import assert from 'node:assert/strict';
import test from 'node:test';
import {createInventoryRegistration} from '../lib/inventory/registration-recovery.ts';

const item={id:632,item_name_vi:'Bếp chiên ngập dầu',code:'632'};
const saved=()=>Response.json({ok:true,data:item});
const options=(overrides={})=>({create:saved,recover:async()=>null,onConfirmed:()=>{},refresh:async()=>{},...overrides});

for(const photo of ['success','failure','exception'])test('confirmed ID precedes photo '+photo+'; concurrent and later submissions cannot create again',async()=>{
 const attempt=createInventoryRegistration();let posts=0,release;const events=[];
 const gate=new Promise(resolve=>{release=resolve;});
 const args=options({create:async()=>{posts++;return saved();},onConfirmed:(value,kind)=>events.push([kind,value.id]),
  refresh:async()=>{events.push('refresh');throw Error('refresh unavailable');},upload:async id=>{assert.deepEqual(events[0],['saved',632]);assert.equal(id,632);await gate;if(photo==='exception')throw Error('network');return photo==='success';}});
 const pending=attempt.submit(args);await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await attempt.submit(args)).kind,'busy');assert.equal(posts,1);assert.ok(events.includes('refresh'));
 release();const result=await pending;assert.equal(result.kind,'saved');assert.equal(result.photoFailed,photo!=='success');
 assert.deepEqual(await attempt.submit(args),result);assert.equal(posts,1);
});

for(const response of ['network','invalid-json','missing-id','server-error'])test('lost/ambiguous response '+response+' is recovered by lookup without uploading to or creating another item',async()=>{
 const attempt=createInventoryRegistration();let posts=0,lookups=0,photos=0,confirmed;
 const result=await attempt.submit(options({create:async()=>{posts++;if(response==='network')throw Error('response lost');if(response==='invalid-json')return new Response('<html>');if(response==='server-error')return Response.json({ok:false},{status:500});return Response.json({ok:true,data:{}});},
  recover:async()=>{lookups++;return item;},onConfirmed:value=>{confirmed=value.id;},upload:async()=>{photos++;return true;}}));
 assert.deepEqual(result,{kind:'existing',item,recovered:true});assert.equal(confirmed,632);assert.equal(lookups,1);assert.equal(posts,1);assert.equal(photos,0);
});

test('an unresolved request only checks its original identity on later clicks, even when lookup fails or is temporarily empty',async()=>{
 const attempt=createInventoryRegistration();let posts=0,reads=0;
 const args=options({create:async()=>{posts++;throw Error('response lost');},recover:async()=>{reads++;if(reads===1)return null;if(reads===2)throw Error('offline');return item;}});
 assert.equal((await attempt.submit(args)).kind,'uncertain');
 assert.equal((await attempt.submit(options({create:()=>{throw Error('must not POST');},recover:async()=>{throw Error('must retain original lookup');}}))).kind,'uncertain');
 assert.equal((await attempt.submit(args)).kind,'existing');assert.equal(posts,1);assert.equal(reads,3);
});

test('a duplicate 409 keeps its existing ID and refreshes, while a rejected validation can be corrected',async()=>{
 const attempt=createInventoryRegistration();let posts=0,refreshes=0;
 const args=options({create:async()=>{posts++;return Response.json({ok:false,error:'inventory_item_duplicate_name_code',duplicateItem:item},{status:409});},refresh:async value=>{assert.equal(value.id,632);refreshes++;}});
 const result=await attempt.submit(args);assert.deepEqual(result,{kind:'existing',item,recovered:false});
 await attempt.submit(args);assert.equal(posts,1);assert.equal(refreshes,1);
 const validation=createInventoryRegistration();assert.equal((await validation.submit(options({create:async()=>Response.json({ok:false,error:'invalid_payload'},{status:400})}))).kind,'rejected');
 assert.equal((await validation.submit(options())).kind,'saved');
});
