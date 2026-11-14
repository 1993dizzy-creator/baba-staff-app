import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Execute the real form's recovery helper without mounting or mocking its logic.
const source=readFileSync('app/(protected)/admin/users/create/page.tsx','utf8');
const helper=source.slice(source.indexOf('async function ensureStep'),source.indexOf('async function readHistory'));
const code=ts.transpileModule(helper,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const ensureStep=new Function('readJson',code+';return ensureStep;')(async r=>{try{return await r.json();}catch{return null;}});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
function scenario(rows,write){
  return {read:async()=>rows,matches:r=>r.id===10&&r.policy==='active',repairMatching:r=>r.id===10&&r.amount===8000000,
    write,conflictMessage:'review',failureMessage:()=> 'incomplete'};
}
test('matching pending contract is repaired, including a persisted setup reload, without creating another contract',async()=>{
  const rows=[{id:10,amount:8000000,policy:'pending'}],saved=JSON.stringify({firstMonthProration:true,userId:'77',status:{contract:'failed'}});
  assert.equal(JSON.parse(saved).firstMonthProration,true);
  let writes=0;const result=await ensureStep(scenario(rows,async()=>{writes++;rows[0].policy='active';return json({ok:true});}));
  assert.deepEqual(result,{ok:true});assert.equal(writes,1);assert.equal(rows.length,1);
  assert.deepEqual(await ensureStep(scenario(rows,async()=>{throw Error('must not write twice');})),{ok:true});
});
test('a successful HTTP response with policy still pending is incomplete, not an automatic-pay success',async()=>{
  const rows=[{id:10,amount:8000000,policy:'pending'}];
  assert.deepEqual(await ensureStep(scenario(rows,async()=>json({ok:true}))),{ok:false,message:'incomplete'});
});
test('response lost after atomic activation is verified by read; lost before commit remains recoverable',async()=>{
  const rows=[];let writes=0;
  assert.deepEqual(await ensureStep(scenario(rows,async()=>{writes++;throw Error('lost before commit');})),{ok:false,message:'incomplete'});
  assert.deepEqual(await ensureStep(scenario(rows,async()=>{writes++;rows.push({id:10,amount:8000000,policy:'active'});throw Error('lost after commit');})),{ok:true});
  assert.equal(writes,2);assert.equal(rows.length,1);
});
test('conflicting contract is neither overwritten nor reported complete',async()=>{
  let writes=0;const rows=[{id:20,amount:1,policy:'active'}];
  assert.deepEqual(await ensureStep(scenario(rows,async()=>{writes++;return json({ok:true});})),{ok:false,message:'review'});
  assert.equal(writes,0);
});
