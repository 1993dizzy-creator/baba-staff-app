import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeInventoryPostgres} from './inventory-native-postgres.mjs';
const mode=process.env.NATIVE_PG_CHILD_MODE;
test('lifecycle child '+mode,{timeout:mode==='timeout'?5000:20000},async t=>{
 const runtime=await nativeInventoryPostgres({testContext:t});
 console.log('NATIVE_PATHS='+JSON.stringify({dir:runtime.dir,logDir:runtime.logDir}));
 if(mode==='poisoned'){
  const client=await runtime.connect('postgres');
  assert.equal(client.connectionParameters.host,'127.0.0.1');
  assert.equal(client.connectionParameters.password,'baba-local-test-only');
  assert.equal(client.connectionParameters.options,'-c statement_timeout=0');
  assert.equal((await client.query('select current_database() as name')).rows[0].name,'postgres');
 }
 if(mode==='timeout'){
  const client=await runtime.connect('postgres');
  await client.query('select pg_sleep(60)').catch(()=>{});
 }else if(mode==='failure'){
  try{assert.fail('EXPECTED_NATIVE_TEST_FAILURE');}finally{await runtime.stop();}
 }else{await runtime.stop();}
});
