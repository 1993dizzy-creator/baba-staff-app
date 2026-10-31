import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {relatedTests} from '../scripts/agent/lib/common.mjs';
import {prepareTestSelection} from '../scripts/agent/baba-integrate.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const fixtures=['tests/agent-workflow-integrate.test.mjs','tests/agent-workflow-integrate-policy.test.mjs'];
const ui=['app/login/page.tsx','components/bar/keeping/KeepingProductAutocomplete.tsx'];

test('UI verify and prepare exclude unrelated main tool history and inherited automatic Git fixtures',()=>{
  const direct=relatedTests(root,ui);
  assert.equal(direct.tests.some(t=>t.path.startsWith('tests/agent-workflow-')),false);
  const {testPaths}=prepareTestSelection(root,ui,['scripts/agent/baba-integrate.mjs','tests/agent-workflow-integrate.test.mjs','docs/agents/baba-agent-workflow.md'],{executed:[...fixtures,'tests/login-keeping-recovery.test.mjs']});
  assert.equal(testPaths.some(t=>t.startsWith('tests/agent-workflow-')),false);
  assert.ok(testPaths.includes('tests/login-keeping-recovery.test.mjs'));
});

test('actual agent-tool changes still select both integration fixture files',()=>{
  const {testPaths}=prepareTestSelection(root,['scripts/agent/baba-integrate.mjs'],[],{executed:[]});
  for(const path of fixtures)assert.ok(testPaths.includes(path),path);
});

test('non-agent accounting and database scope is retained instead of being filtered with tooling',()=>{
  const paths=['lib/ledger/entries.ts','supabase/migrations/required-but-not-executed.sql','lib/auth/required-but-not-executed.ts'];
  const expected=relatedTests(root,paths);
  const result=prepareTestSelection(root,ui,paths,{executed:[]});
  assert.ok(expected.tests.length>0);
  for(const entry of expected.tests)assert.ok(result.testPaths.includes(entry.path),entry.path);
  for(const path of expected.untested)assert.ok(result.coverage.untested.includes(path),path);
});

test('explicit tests, D2 execution obligations and missing-proof detection remain unchanged',()=>{
  const unknown=['app','uncovered-selection-source.ts'].join('/');
  const selection={executed:fixtures,explicit:[fixtures[0]],exercised:{[unknown]:[fixtures[1]]}};
  const result=prepareTestSelection(root,[...ui,unknown],[],selection);
  for(const path of fixtures)assert.ok(result.testPaths.includes(path));
  assert.ok(result.coverage.untested.includes(unknown));
});
