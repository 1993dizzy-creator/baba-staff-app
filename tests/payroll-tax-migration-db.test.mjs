import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync("supabase/migrations/20260908115312_add_payroll_tax_versions.sql", "utf8");
const brackets = JSON.stringify([
  { lowerBoundAmount: 0, upperBoundAmount: 10_000_000, rateBp: 500 },
  { lowerBoundAmount: 10_000_000, upperBoundAmount: 30_000_000, rateBp: 1_000 },
  { lowerBoundAmount: 30_000_000, upperBoundAmount: 60_000_000, rateBp: 2_000 },
  { lowerBoundAmount: 60_000_000, upperBoundAmount: 100_000_000, rateBp: 3_000 },
  { lowerBoundAmount: 100_000_000, upperBoundAmount: null, rateBp: 3_500 },
]).replaceAll("'", "''");

test("tax migration creates validated append-only versions and paid-month locks without seed data", async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.users(id bigint primary key, role text, is_system_account boolean not null default false);
    insert into public.users values (1, 'owner', false), (7, 'staff', false);
    create table public.payroll_payment_batches(
      id bigint primary key, payroll_month date not null, actual_company_cost_total bigint not null default 0,
      director_insurance_amount bigint not null default 0, updated_at timestamptz not null default now()
    );
    create table public.payroll_employee_payments(
      payroll_batch_id bigint not null, user_id bigint not null, payment_status text not null,
      calculation_snapshot jsonb, actual_paid_amount bigint, employee_insurance_amount bigint, employer_insurance_amount bigint
    );
    create function public.payroll_assert_actor_v2(p_actor_user_id bigint) returns void language plpgsql as $$
    begin if not exists(select 1 from public.users where id=p_actor_user_id and role in ('owner','master')) then raise exception 'FORBIDDEN'; end if; end $$;
    create function public.payroll_pay_employee_v1(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,text,jsonb,bigint)
      returns jsonb language sql as $$ select jsonb_build_object('runId', 1) $$;
    create function public.payroll_cancel_employee_payment_v1(bigint,bigint,text,bigint)
      returns jsonb language sql as $$ select jsonb_build_object('runId', 1) $$;
  `);
  await db.exec(migration);

  assert.equal((await db.query("select count(*)::integer count from public.payroll_tax_policy_versions")).rows[0].count, 0);
  assert.equal((await db.query("select count(*)::integer count from public.payroll_tax_setting_versions")).rows[0].count, 0);
  const createdPolicy = await db.query(`select public.payroll_create_tax_policy_version_v1('2026-01-01',15500000,6200000,'${brackets}'::jsonb,1,'fixture') result`);
  assert.equal(createdPolicy.rows[0].result.revision, 1);
  const createdProfile = await db.query("select public.payroll_create_tax_setting_version_v1(7,'2026-01-01','resident_progressive',1,'company_bears','KIM MIN JAE','manual',900000,1,'tax-only insurance') result");
  assert.equal(createdProfile.rows[0].result.revision, 1);
  assert.equal(createdProfile.rows[0].result.accounting_name, "KIM MIN JAE");

  const gapBrackets = JSON.stringify([{ lowerBoundAmount: 0, upperBoundAmount: 10, rateBp: 500 }, { lowerBoundAmount: 11, upperBoundAmount: null, rateBp: 1000 }]).replaceAll("'", "''");
  await assert.rejects(
    db.exec(`insert into public.payroll_tax_policy_versions(effective_month,personal_deduction_amount,dependent_deduction_amount,brackets,revision,created_by) values('2027-01-01',1,1,'${gapBrackets}'::jsonb,2,1)`),
    /payroll_tax_policy_brackets_check/,
  );
  await assert.rejects(
    db.exec("insert into public.payroll_tax_setting_versions(user_id,effective_month,tax_mode,dependent_count,burden_mode,accounting_name,insurance_deduction_mode,manual_insurance_deduction_amount,revision,created_by,note) values(7,'2027-01-01','resident_progressive',0,'employee_deducted','Employee Seven','manual',1,2,1,null)"),
    /payroll_tax_setting_manual_note_check/,
  );

  await db.exec("insert into public.payroll_payment_batches(id,payroll_month) values(10,'2026-08-01'); insert into public.payroll_employee_payments(payroll_batch_id,user_id,payment_status) values(10,7,'paid')");
  await assert.rejects(
    db.query("select public.payroll_create_tax_setting_version_v1(7,'2026-08-01','resident_progressive',0,'employee_deducted','Employee Seven','payroll',0,1,'change')"),
    /PAYROLL_TAX_SETTING_LOCKED_FOR_PAID_EMPLOYEE/,
  );
  await assert.rejects(
    db.query(`select public.payroll_create_tax_policy_version_v1('2026-08-01',15500000,6200000,'${brackets}'::jsonb,1,'change')`),
    /PAYROLL_TAX_POLICY_LOCKED_FOR_PAID_MONTH/,
  );

  await db.exec(`
    insert into public.payroll_payment_batches(id,payroll_month,director_insurance_amount)
    values(11,'2026-07-01',300000);
    insert into public.payroll_employee_payments(
      payroll_batch_id,user_id,payment_status,calculation_snapshot,
      actual_paid_amount,employee_insurance_amount,employer_insurance_amount
    ) values(
      11,7,'paid',
      '{"employee":{"tax":{"employeePitDeductionAmount":500000,"companyPitAmount":200000},"amounts":{"advanceAmount":1000000}}}'::jsonb,
      7000000,400000,800000
    );
    select public.payroll_refresh_payment_tax_totals_v1(11);
  `);
  const batchCost = (await db.query(`select employee_pit_total,company_pit_total,advance_total,actual_company_cost_total from public.payroll_payment_batches where id=11`)).rows[0];
  assert.deepEqual(batchCost, {
    employee_pit_total: 500000,
    company_pit_total: 200000,
    advance_total: 1000000,
    actual_company_cost_total: 10200000,
  });
  const separatelyReportedMealAllowance = 600000;
  assert.equal(batchCost.actual_company_cost_total + separatelyReportedMealAllowance, 10800000);

  const privileges = await db.query(`select
    has_table_privilege('authenticated','public.payroll_tax_setting_versions','select') authenticated_table,
    has_function_privilege('authenticated','public.payroll_create_tax_setting_version_v1(bigint,date,text,integer,text,text,text,bigint,bigint,text)','execute') authenticated_rpc,
    has_function_privilege('service_role','public.payroll_create_tax_setting_version_v1(bigint,date,text,integer,text,text,text,bigint,bigint,text)','execute') service_rpc`);
  assert.deepEqual(privileges.rows[0], { authenticated_table: false, authenticated_rpc: false, service_rpc: true });
  await db.close();
});
