import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const external = createRequire(import.meta.url);
const cache = new Map();
let businessDate = '2026-10-01';
let rpcError = null;
function load(file) {
  const path = resolve(file);
  if (cache.has(path)) return cache.get(path).exports;
  const loaded = { exports: {} };
  cache.set(path, loaded);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const localRequire = name => {
    if (name === 'server-only') return {};
    if (name === '@/lib/supabase/server') return { supabaseServer: {
      async rpc(name, args) {
        assert.equal(name, 'store_business_date_for_timestamp_v1');
        assert.ok(Number.isFinite(Date.parse(args.p_timestamp)));
        return { data: businessDate, error: rpcError };
      },
      from() { throw new Error('Remote database access forbidden'); },
    } };
    if (name.startsWith('.') || name.startsWith('@/')) {
      let child = name.startsWith('@/') ? resolve(name.slice(2)) : resolve(dirname(path), name);
      if (!existsSync(child)) child += '.ts';
      return load(child);
    }
    return external(name);
  };
  new Function('require', 'module', 'exports', code)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
const { resolvePayrollOverviewPeriod } = load('lib/payroll/monthly-run.ts');
const { getPayrollOverviewPeriod } = load('lib/payroll/overview-period.ts');
const { buildPayrollOverviewEmployee } = load('lib/payroll/overview.ts');
test('first business day keeps October accruals unavailable and updates its level date', async () => {
  businessDate = '2026-10-01';
  assert.deepEqual(await resolvePayrollOverviewPeriod('2026-10'), {
    month: '2026-10', asOfDate: '2026-10-01', calculationEndDate: null, future: true, levelAsOfDate: '2026-10-01',
  });
});
test('true future and past months retain their existing behavior', async () => {
  businessDate = '2026-10-01';
  for (const month of ['2026-11', '2026-09', '2026-08']) {
    assert.deepEqual(await resolvePayrollOverviewPeriod(month), getPayrollOverviewPeriod(month, '2026-09-30'));
  }
});
test('after October 1 closes, accruals use October 1 and levels use October 2', async () => {
  businessDate = '2026-10-02';
  assert.deepEqual(await resolvePayrollOverviewPeriod('2026-10'), {
    month: '2026-10', asOfDate: '2026-10-01', calculationEndDate: '2026-10-01', future: false, levelAsOfDate: '2026-10-02',
  });
});
test('October 1 promotion appears in actual overview salary composition before accrual starts', async () => {
  businessDate = '2026-10-01';
  const period = await resolvePayrollOverviewPeriod('2026-10');
  const contract = { id: 1, userId: 9, payType: 'monthly', calculationBasis: 'minute', baseSalary: 9000000, fixedRaiseAmount: 100000, standardWorkdays: 26, standardMinutesPerDay: 540, effectiveFrom: '2026-07-01', effectiveTo: null };
  const user = { id: 9, name: 'Promotion', username: 'promotion', role: 'staff', hire_date: '2026-07-01', termination_date: null, is_system_account: false, level_program_enabled: true, level_base_date_override: null };
  const employee = { userId: 9, items: [], reviews: [], recognizedWorkdays: 0, recognizedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, partTimeExtraWork: [], attendanceSnapshot: { days: [] }, insuranceSnapshot: { isEnrolled: false, employeeDeductionAmount: 0, companyPaidInsuranceTaxableAmount: 0, insuranceBaseAmount: 0, employerAmount: 0 } };
  const current = buildPayrollOverviewEmployee({ employee, user, contracts: [contract], period });
  const previous = buildPayrollOverviewEmployee({ employee, user, contracts: [contract], period: { ...period, levelAsOfDate: '2026-09-30' } });
  assert.equal(current.levelInfo.level, previous.levelInfo.level + 1);
  assert.equal(current.levelInfo.earnedRaiseCount, previous.levelInfo.earnedRaiseCount + 1);
  assert.equal(current.amounts.levelRaiseAmount, previous.amounts.levelRaiseAmount + current.levelInfo.raiseAmountPerStep);
  assert.equal(current.amounts.combinedSalary, previous.amounts.combinedSalary + current.levelInfo.raiseAmountPerStep);
  assert.equal(current.levelApplication.currentLevel, current.levelInfo.level);
  assert.equal(current.calculationStatus, 'unavailable');
  assert.equal(current.amounts.currentAmount, null);
  assert.equal(current.amounts.workAppliedAmount, null);
  assert.equal(current.amounts.accruedWorkAmount, 0);
});
test('RPC failure uses local current business date at the captured timestamp', async () => {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-01T09:00:00+07:00'])); }
  };
  rpcError = { message: 'Unavailable' };
  businessDate = null;
  try {
    assert.deepEqual(await resolvePayrollOverviewPeriod('2026-10'), {
      month: '2026-10', asOfDate: '2026-10-01', calculationEndDate: null, future: true, levelAsOfDate: '2026-10-01',
    });
  } finally {
    globalThis.Date = RealDate;
    rpcError = null;
    businessDate = '2026-10-01';
  }
});
