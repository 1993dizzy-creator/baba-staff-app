import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
// User-confirmed operating contract, not a production export. Historical SQL is untouched.
const engines=[
 ['reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text)','b10b5f8b4d51563570f05f3e30d96262738ef7490cdc71c9c49b0d882b4f19ba'],
 ['rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text)','63c86abd5d7e99a602db115bbf48e88b590e82cab2f538d9f448842feddd2648']
];
export async function reproduceOperatingInventoryContract(db){
 const evidence=[];
 for(const [signature,expectedLF] of engines){
  const original=(await db.query('select pg_get_functiondef($1::regprocedure) d',['public.'+signature])).rows[0].d;
  assert.equal((original.match(/\bprocessed_line_id\b/g)||[]).length,2);
  let definition=original.replace(/\r\n?/g,'\n');
  definition=definition.replace(/^[ \t]*processed_line_id,\n/m,'').replace(/^[ \t]*v_active\.processed_line_id,\n/m,'');
  definition=definition.replace(/processed_line_id, /,'').replace(/v_active\.processed_line_id, /,'');
  assert.equal(definition.includes('processed_line_id'),false);
  await db.exec(definition.replace(/\n/g,'\r\n'));
  const stored=(await db.query('select pg_get_functiondef($1::regprocedure) d',['public.'+signature])).rows[0].d;
  const sha256=createHash('sha256').update(stored.replace(/\r\n?/g,'\n')).digest('hex');
  assert.equal(sha256,expectedLF,'Operating LF fingerprint must match after only the documented two-reference removal');
  evidence.push({signature,removedReferences:2,lfSHA256:sha256,rawSHA256:createHash('sha256').update(stored).digest('hex'),expectedLF,hashMatch:sha256===expectedLF,definition:stored});
 }
 await db.exec('alter table public.pos_inventory_deductions drop column processed_line_id');
 assert.equal((await db.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='pos_inventory_deductions' and column_name='processed_line_id'")).rows[0].n,0);
 return evidence;
}
