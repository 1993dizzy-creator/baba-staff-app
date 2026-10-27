import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { nativeRecloseFixture, preserved } from './helpers/ledger-aug-sep-reclose-native-fixture.mjs';
import { signature, expectedBodyHash, migrations } from '../scripts/ledger/m-stage-bundles.mjs';

const lf=s=>s.replace(/\r\n?/g,'\n');
const crlf=s=>lf(s).replaceAll('\n','\r\n');
const mixed=s=>lf(s).split('\n').map((line,i,lines)=>line+(i===lines.length-1?'':i%2?'\r\n':'\n')).join('');
const bareCR=s=>lf(s).replaceAll('\n','\r');
const legacy=lf(readFileSync('supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql','utf8'));
const install=lf(readFileSync('scripts/ledger/m-stage-install.sql','utf8'));
const register=lf(readFileSync('scripts/ledger/m-stage-register.sql','utf8'));
const one=async(c,sql,args=[]) => (await c.query(sql,args)).rows[0];
const exists=async c=>(await one(c,'select to_regprocedure($1)::text name',[signature])).name;
const hash=async c=>(await one(c,"select md5(regexp_replace(prosrc,'\\s+','','g')) hash from pg_proc where oid=$1::regprocedure",[signature])).hash;
const patchStart=install.indexOf('-- M_STAGE_FIX_BEGIN');
const patchEnd=install.indexOf('-- M_STAGE_FIX_END');
const legacyBundle=install.slice(0,patchStart)+'-- M_STAGE_FIX_BEGIN\n'+legacy+'\n'+install.slice(patchEnd);

test('SQL Editor line endings: native PostgreSQL 17.6 failure reproduction and portable installation',{
  skip:!process.env.QA_POSTGRES_BIN && 'No local PostgreSQL configured',timeout:120000,
},async t=>{
  const runtime=await nativeInventoryPostgres({testContext:t});t.diagnostic(runtime.version);
  const results={version:runtime.version,legacyVersion:'20261027160650',activeVersions:migrations.map(m=>m.version),cases:[],logDir:runtime.logDir};
  t.after(()=>{
    results.cleanup=runtime.cleanupResult;mkdirSync('.tmp-baba/m-line-endings',{recursive:true});
    writeFileSync('.tmp-baba/m-line-endings/results.json',JSON.stringify(results,null,2));
  });
  async function scenario(name,fn) {
    await t.test(name,{timeout:12000},async()=>{
      const db=await nativeRecloseFixture(runtime.Database,{installCorrections:false});
      await db.exec('create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[])');
      const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
      const row={name};results.cases.push(row);
      try {
        const before=await preserved(db),closures=(await db.query('select * from ledger_month_closures order by id')).rows;
        const audits=(await db.query('select * from ledger_audit_logs order by id')).rows;
        await fn({db,a,b,row});
        assert.deepEqual(await preserved(db),before);
        assert.deepEqual((await db.query('select * from ledger_month_closures order by id')).rows,closures);
        assert.deepEqual((await db.query('select * from ledger_audit_logs order by id')).rows,audits);row.status='PASS';
      } catch(e){row.status='FAIL';row.error={code:e.code,message:e.message};throw e;}
      finally {await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});await a.end();await b.end();await db.close();}
    });
  }

  const cases=[
    ['LF original + LF legacy patch',s=>s,false],
    ['whole bundle CRLF (Windows/SQL Editor paste)',crlf,true],
    ['whole bundle mixed LF/CRLF',mixed,true],
    ['CRLF original, LF patch',s=>crlf(s.slice(0,patchStart))+s.slice(patchStart),false],
    ['LF original, CRLF patch',s=>s.slice(0,patchStart)+crlf(s.slice(patchStart)),true],
  ];
  for(const [name,format,fails] of cases) await scenario('BEFORE: '+name,async({db,a,row})=>{
    const sql=format(legacyBundle);
    if(fails) {
      const split=sql.indexOf('-- M_STAGE_FIX_BEGIN');await a.query(sql.slice(0,split));
      const old=sql.match(/\$old\$([\s\S]*?)\$old\$/)[1];
      row.diagnostic=await one(a,`select md5(regexp_replace(prosrc,'\\s+','','g')) before_hash,
        strpos(replace(pg_get_functiondef(oid),E'\\r\\n',E'\\n'),$2) old_position,
        strpos(replace(replace(pg_get_functiondef(oid),E'\\r\\n',E'\\n'),E'\\r',E'\\n'),replace(replace($2,E'\\r\\n',E'\\n'),E'\\r',E'\\n')) normalized_position
        from pg_proc where oid=$1::regprocedure`,[signature,old]);
      assert.equal(row.diagnostic.before_hash,'5429554141424f2fa75aa3492350eb2c');
      assert.equal(row.diagnostic.old_position,0);assert.ok(row.diagnostic.normalized_position>0);
      await a.query('rollback');
      await assert.rejects(a.query(sql),e=>{
        row.sqlstate=e.code;row.message=e.message;row.where=e.where;
        return e.code==='P0001' && /RECLOSE_LOCK_ORDER_PATCH_NOT_FOUND/.test(e.message);
      });
      await a.query('rollback');assert.equal(await exists(db),null);
    } else {await a.query(sql);assert.equal(await hash(db),expectedBodyHash);row.sqlstate='00000';}
    assert.equal((await one(db,'select count(*)::int n from supabase_migrations.schema_migrations')).n,0);
  });

  const changePart=(sql,tag,format)=>sql.replace(new RegExp('\\$'+tag+'\\$([\\s\\S]*?)\\$'+tag+'\\$'),(_,body)=>'$'+tag+'$'+format(body)+'$'+tag+'$');
  const corrected=[
    ['LF',install,register],
    ['Windows CRLF entire paste',crlf(install),crlf(register)],
    ['mixed LF/CRLF entire paste',mixed(install),mixed(register)],
    ['CR-only paste',bareCR(install),bareCR(register)],
    ['CRLF original, LF replacement',crlf(install.slice(0,patchStart))+install.slice(patchStart),crlf(register)],
    ['LF original, CRLF replacement',install.slice(0,patchStart)+crlf(install.slice(patchStart)),mixed(register)],
    ['only dollar-quoted old/new blocks changed by paste',changePart(changePart(install,'old',crlf),'new',mixed),crlf(register)],
  ];
  for(const [name,sql,registration] of corrected) await scenario('AFTER: '+name,async({db,a,b,row})=>{
    await a.query(sql);assert.equal(await hash(db),expectedBodyHash);row.finalBodyMd5=await hash(db);
    row.metadata=await one(db,`select p.prosecdef,pg_get_userbyid(p.proowner) owner,p.proconfig,
      has_function_privilege('anon',p.oid,'execute') anon_execute,
      has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
      has_function_privilege('service_role',p.oid,'execute') service_execute
      from pg_proc p where p.oid=$1::regprocedure`,[signature]);
    assert.equal(row.metadata.owner,'postgres');assert.equal(row.metadata.prosecdef,true);
    assert.deepEqual(row.metadata.proconfig,['search_path=pg_catalog, public','lock_timeout=5s']);
    assert.equal(row.metadata.anon_execute,false);assert.equal(row.metadata.authenticated_execute,false);assert.equal(row.metadata.service_execute,true);
    for(const role of ['anon','authenticated']) {
      await b.query('set role '+role);
      await assert.rejects(b.query("select public.ledger_aug_sep_reclose_corrections_v1('2026-09-01'::date,1::bigint,1::bigint)"),e=>e.code==='42501');
      await b.query('reset role');
    }
    await a.query(registration);
    const rows=(await db.query('select * from supabase_migrations.schema_migrations order by version')).rows;
    assert.equal(rows.length,2);row.registered=rows.map(r=>r.version);
    assert.ok(!rows.some(r=>r.version==='20261027160650'),'retired failed migration must not be falsely registered');
    row.statementHashes={};
    for(const m of migrations) {
      const stored=rows.find(r=>r.version===m.version);assert.deepEqual(stored,{version:m.version,name:m.name,statements:[m.sql]});
      row.statementHashes[m.version]=createHash('sha256').update(stored.statements[0]).digest('hex');
      assert.equal(row.statementHashes[m.version],m.sha256);assert.ok(!stored.statements[0].includes('\r'));
    }
    await a.query(register);assert.deepEqual((await db.query('select * from supabase_migrations.schema_migrations order by version')).rows,rows,'different clipboard EOL must still be idempotent');
    await assert.rejects(a.query(sql),e=>e.code==='P0001' && /M_STAGE_FUNCTION_ALREADY_EXISTS/.test(e.message));await a.query('rollback');
    assert.equal(await hash(db),expectedBodyHash);row.sqlstate='00000';
  });

  for(const [name,format] of [['CRLF',crlf],['mixed',mixed],['CR-only',bareCR]]) {
    for(const stage of ['before replacement','before commit']) await scenario('ROLLBACK: '+name+' '+stage,async({db,a,row})=>{
      const failing=stage==='before replacement'?install.replace('-- M_STAGE_FIX_BEGIN','select 1/0;\n-- M_STAGE_FIX_BEGIN'):install.replace('\ncommit;','\nselect 1/0;\ncommit;');
      await assert.rejects(a.query(format(failing)),e=>{row.sqlstate=e.code;return e.code==='22012';});await a.query('rollback');
      assert.equal(await exists(db),null);assert.equal((await one(db,'select count(*)::int n from supabase_migrations.schema_migrations')).n,0);
    });
  }
});
