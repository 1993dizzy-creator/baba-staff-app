import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {git,gitOut,repoRoot,insideRoot} from '../scripts/agent/lib/common.mjs';
import {retiredMigration as retired,migrationRetirementEvidence} from '../scripts/agent/lib/migration-retirement.mjs';
import {migrations,buildBundles} from '../scripts/ledger/m-stage-bundles.mjs';

const root=repoRoot();
const bytes=readFileSync(retired.destination);
const record={path:retired.destination,from:retired.source,committed:'R',working:null,deleted:false};
function fixture({alterBaseline=false}={}) {
  const parent=insideRoot(root,'.tmp-baba/retirement-tests');mkdirSync(parent,{recursive:true});
  const path=mkdtempSync(join(parent,'case-'));git(path,['init','-q']);
  const hooks=join(path,'.hooks');mkdirSync(hooks);
  for(const [key,value] of [['core.hooksPath',hooks],['core.autocrlf','false'],['user.name','BABA retirement test'],['user.email','test@example.invalid']])git(path,['config',key,value]);
  mkdirSync(dirname(join(path,retired.source)),{recursive:true});writeFileSync(join(path,retired.source),alterBaseline?Buffer.concat([bytes,Buffer.from('\n')]):bytes);
  git(path,['add','--',retired.source]);git(path,['-c','commit.gpgsign=false','commit','-qm','baseline']);
  const base=gitOut(path,['rev-parse','HEAD']);mkdirSync(dirname(join(path,retired.destination)),{recursive:true});
  git(path,['mv','--',retired.source,retired.destination]);
  writeFileSync(join(path,'docs/history/migrations-retired/README.md'),readFileSync('docs/history/migrations-retired/README.md'));
  return {path,base};
}

test('archive preserves exact approved SHA-256/blob and is absent from filesystem and indexed active inventories',()=>{
  assert.equal(createHash('sha256').update(bytes).digest('hex'),retired.sha256);
  assert.equal(gitOut(root,['hash-object','--no-filters',retired.destination]),retired.blob);
  assert.equal(existsSync(retired.source),false);
  const active=readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql'));
  const indexed=gitOut(root,['ls-files','supabase/migrations/*.sql']).split('\n');
  assert.ok(!active.some(n=>n.startsWith('20261027160650_')));
  assert.ok(!indexed.some(n=>n.includes('/20261027160650_')));
  for(const version of ['20261027112354','20261027175537']) {
    assert.ok(active.some(n=>n.startsWith(version+'_')));assert.ok(indexed.some(n=>n.includes('/'+version+'_')));
  }
  assert.deepEqual(migrations.map(m=>m.version),['20261027112354','20261027175537']);
  const bundled=buildBundles();
  assert.equal(bundled.install,readFileSync('scripts/ledger/m-stage-install.sql','utf8').replace(/\r\n?/g,'\n'));
  assert.equal(bundled.register,readFileSync('scripts/ledger/m-stage-register.sql','utf8').replace(/\r\n?/g,'\n'));
});

test('verifier accepts only this exact rename with immutable original bytes and README',()=>{
  const f=fixture();const evidence=migrationRetirementEvidence(f.path,f.base,record);
  assert.equal(evidence.allowed,true);assert.equal(evidence.blob,retired.blob);assert.equal(evidence.sha256,retired.sha256);
});
test('changed archive bytes never bypass the existing migration guard',()=>{
  const f=fixture();writeFileSync(join(f.path,retired.destination),Buffer.concat([bytes,Buffer.from('\r\n')]));
  assert.deepEqual(migrationRetirementEvidence(f.path,f.base,record),{allowed:false,reason:'ARCHIVE_BYTES_CHANGED'});
});
test('another applied migration or another destination is not an archival exception',()=>{
  const f=fixture();
  for(const changed of [{...record,from:'supabase/migrations/20261027112354_aug_sep_reclose_corrections.sql'},
    {...record,path:'docs/history/elsewhere.sql'},{...record,deleted:true},
    {...record,committed:'M',from:undefined}])assert.equal(migrationRetirementEvidence(f.path,f.base,changed).allowed,false);
});
test('copy, baseline drift, or missing retirement policy are refused',()=>{
  const f=fixture();writeFileSync(join(f.path,retired.source),bytes);
  assert.equal(migrationRetirementEvidence(f.path,f.base,record).reason,'SOURCE_STILL_ACTIVE');
  const other=fixture({alterBaseline:true});assert.equal(migrationRetirementEvidence(other.path,other.base,record).reason,'BASELINE_BLOB_MISMATCH');
  const missing=fixture();writeFileSync(join(missing.path,'docs/history/migrations-retired/README.md'),'not a retirement policy');
  assert.equal(migrationRetirementEvidence(missing.path,missing.base,record).reason,'ARCHIVE_README_INCOMPLETE');
});

test('LF applies to active SQL while the individual -text exception and other paths retain their original attributes',()=>{
  const active=readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).map(n=>'supabase/migrations/'+n);
  const exception='supabase/migrations/20261002062405_fix_preflight_inactive_recurring_plans.sql';
  const output=gitOut(root,['check-attr','text','eol','--',...active,'docs/reports/example.md',retired.destination]);
  for(const path of active) {
    assert.ok(output.includes(`${path}: text: ${path===exception?'unset':'set'}`));
    assert.ok(output.includes(`${path}: eol: ${path===exception?'unspecified':'lf'}`));
  }
  for(const path of ['docs/reports/example.md',retired.destination]) {
    assert.ok(output.includes(`${path}: text: unspecified`));assert.ok(output.includes(`${path}: eol: unspecified`));
  }
  const f=fixture();writeFileSync(join(f.path,'.gitattributes'),readFileSync('.gitattributes'));
  const normal='supabase/migrations/20261028000000_test.sql';
  const crlf='select 1;\r\n';for(const path of [normal,exception])writeFileSync(join(f.path,path),crlf);
  git(f.path,['-c','core.autocrlf=true','add','--','.gitattributes',normal,exception]);
  assert.equal(git(f.path,['show',':'+normal]).stdout,'select 1;\n');
  assert.equal(git(f.path,['show',':'+exception]).stdout,crlf,'-text exception must preserve raw CRLF even on Windows');
});
