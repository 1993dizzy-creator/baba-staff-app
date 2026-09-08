import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  "supabase/migrations/20260908110641_add_payroll_advance_adjustment.sql",
  "utf8",
);
const paymentMigration = readFileSync(
  "supabase/migrations/202608050001_add_employee_payment_batches.sql",
  "utf8",
);

test("advance migration applies without rewriting existing adjustment rows", async () => {
  const db = new PGlite();
  await db.exec(`
    create table public.payroll_monthly_adjustments (
      id bigint generated always as identity primary key,
      user_id bigint not null,
      payroll_month date not null,
      kind text not null check (kind in ('incentive', 'penalty')),
      category text not null check (category in ('sales','performance','service','late','early_leave','absence','damage','discipline','manual','other')),
      amount bigint not null,
      cancelled_at timestamptz
    );
    insert into public.payroll_monthly_adjustments (user_id, payroll_month, kind, category, amount)
    values (1, '2026-08-01', 'incentive', 'sales', 100000), (1, '2026-08-01', 'penalty', 'manual', 50000);
  `);

  const before = await db.query("select id, kind, category, amount from public.payroll_monthly_adjustments order by id");
  await db.exec(migration);
  const after = await db.query("select id, kind, category, amount from public.payroll_monthly_adjustments order by id");
  assert.deepEqual(after.rows, before.rows);

  await db.exec("insert into public.payroll_monthly_adjustments (user_id, payroll_month, kind, category, amount) values (1, '2026-08-01', 'advance', 'advance', 250000)");
  await assert.rejects(
    db.exec("insert into public.payroll_monthly_adjustments (user_id, payroll_month, kind, category, amount) values (1, '2026-08-01', 'advance', 'manual', 1)"),
    /payroll_monthly_adjustments_advance_category_check/,
  );
  await assert.rejects(
    db.exec("insert into public.payroll_monthly_adjustments (user_id, payroll_month, kind, category, amount) values (1, '2026-08-01', 'penalty', 'advance', 1)"),
    /payroll_monthly_adjustments_advance_category_check/,
  );

  await db.exec(`
    create table public.payroll_payment_batches (
      id bigint primary key,
      payroll_month date not null
    );
    create table public.payroll_employee_payments (
      payroll_batch_id bigint not null,
      user_id bigint not null,
      payment_status text not null
    );
  `);
  const paidLockSql = paymentMigration.match(
    /create function public\.payroll_lock_paid_month_adjustments_v1\(\)[\s\S]*?create trigger payroll_monthly_adjustments_paid_lock[\s\S]*?;/,
  )?.[0];
  assert.ok(paidLockSql);
  await db.exec(paidLockSql);
  await db.exec(`
    insert into public.payroll_payment_batches values (10, '2026-08-01');
    insert into public.payroll_employee_payments values (10, 1, 'paid');
  `);
  await assert.rejects(
    db.exec("insert into public.payroll_monthly_adjustments (user_id, payroll_month, kind, category, amount) values (1, '2026-08-01', 'advance', 'advance', 1)"),
    /PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE/,
  );
  await assert.rejects(
    db.exec("update public.payroll_monthly_adjustments set cancelled_at = now() where id = 3"),
    /PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE/,
  );
  await db.close();
});
