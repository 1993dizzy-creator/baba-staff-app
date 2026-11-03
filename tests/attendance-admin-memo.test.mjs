import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('memo-only admin mutation preserves normalized/confirmed decisions, times, paid lock and audit', async () => {
  const original = { id: 12, user_id: 1, work_date: '2026-11-01', status: 'done', note: 'before',
    check_in_at: '2026-11-01T09:05:00Z', check_out_at: null, late_minutes: 0,
    early_leave_minutes: 0, work_minutes: 123, early_leave_resolution: 'normal' };
  let row = { ...original }, paid = false;
  const writes = [], audits = [];
  const supabaseServer = { from(table) {
    let patch;
    const result = () => ({ data: table === 'payroll_employee_payments' ? (paid ? [{ id: 1 }] : []) :
      table === 'users' ? { id: 1, attendance_tracking_enabled: true } : patch ? (row = { ...row, ...patch }) : row, error: null });
    const q = { then: resolve => Promise.resolve(result()).then(resolve),
      update(value) { patch = value; writes.push(value); return q; },
      single: async () => result(), maybeSingle: async () => result() };
    for (const method of ['select', 'eq', 'limit']) q[method] = () => q;
    return q;
  } };
  const exports = {};
  const code = ts.transpileModule(readFileSync('app/api/attendance/admin/route.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies = {
    'next/server': { NextResponse: { json: (data, options) => ({ ...data, status: options?.status ?? 200 }) } },
    '@/lib/supabase/server': { supabaseServer },
    '@/lib/attendance/server-api': { requireAttendanceActor: async () => ({ ok: true, actor: { id: 99, role: 'owner' } }) },
    '@/lib/attendance/api-policy': { isAttendanceAdminRole: role => role === 'owner' },
    '@/lib/attendance/status': { ATTENDANCE_STATUS: { LEAVE: 'leave', UNAUTHORIZED_ABSENCE: 'unauthorized_absence' } },
    '@/lib/attendance/tracking-policy': { isAttendanceTrackingUser: () => true },
    '@/lib/attendance/early-leave-review': { EARLY_LEAVE_REVIEW_START_DATE: '2026-10-01' },
    '@/lib/attendance/audit-log': { recordAttendanceAuditLog: async audit => audits.push(audit) },
    '@/lib/attendance/policy-resolution-adapter': { resolveAttendanceRecordPolicy: () => { throw new Error('memo re-evaluated policy'); } },
  };
  vm.runInNewContext(code, { exports, console, require: name => dependencies[name] ?? {} });
  const save = () => exports.POST({ json: async () => ({ action: 'update_record', attendance_id: 12,
    user_id: 1, work_date: '2026-11-01', note: 'memo only' }) });
  const response = await save();
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['note', 'updated_at']);
  for (const key of Object.keys(original).filter(key => key !== 'note')) assert.equal(row[key], original[key], key);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorUserId, 99);
  assert.equal(audits[0].beforeSnapshot.note, 'before');
  assert.equal(audits[0].afterSnapshot.note, 'memo only');
  paid = true;
  assert.equal((await save()).code, 'PAYROLL_PAID_LOCKED');
  assert.equal(writes.length, 1);
});
