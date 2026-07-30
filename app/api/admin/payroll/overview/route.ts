import { supabaseServer } from "@/lib/supabase/server";
import { loadPayrollMonthSnapshot, validPayrollMonth } from "@/lib/payroll/monthly-run";
import { buildPayrollOverviewEmployee, type PayrollMonthlyAdjustment } from "@/lib/payroll/overview";
import { getPayrollOverviewPeriod } from "@/lib/payroll/overview-period";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const month = validPayrollMonth(new URL(request.url).searchParams.get("month"));
  if (!month) return payrollJson({ ok: false, code: "INVALID_MONTH" }, 400);

  try {
    const period = getPayrollOverviewPeriod(month);
    const [snapshot, adjustmentResult] = await Promise.all([
      loadPayrollMonthSnapshot(month, { calculationEndDate: period.calculationEndDate }),
      supabaseServer.from("payroll_monthly_adjustments").select("id,user_id,kind,category,amount,business_date,reason,note,created_at").eq("payroll_month",`${month}-01`).is("cancelled_at",null),
    ]);
    if(adjustmentResult.error)throw new Error("PAYROLL_ADJUSTMENT_READ_FAILED");const adjustmentsByUser=new Map<number,PayrollMonthlyAdjustment[]>();for(const row of adjustmentResult.data??[]){const list=adjustmentsByUser.get(Number(row.user_id))??[];list.push({id:Number(row.id),kind:row.kind as "incentive"|"penalty",category:String(row.category),amount:Number(row.amount),businessDate:String(row.business_date),reason:String(row.reason),note:row.note?String(row.note):null,createdAt:String(row.created_at)});adjustmentsByUser.set(Number(row.user_id),list);}
    const userById = new Map(snapshot.context.users.map((user) => [user.id, user]));
    const contractsByUser = new Map<number, typeof snapshot.context.contracts>();
    for (const contract of snapshot.context.contracts) {
      const list = contractsByUser.get(contract.userId) ?? [];
      list.push(contract);
      contractsByUser.set(contract.userId, list);
    }
    const employees = snapshot.employees.flatMap((employee) => {
      const user = userById.get(employee.userId);
      if (!user) return [];
      return [buildPayrollOverviewEmployee({
        employee,
        user,
        contracts: contractsByUser.get(employee.userId) ?? [],
        adjustments: adjustmentsByUser.get(employee.userId) ?? [],
        period,
      })];
    });
    return payrollJson({ ok: true, month, asOfDate: period.asOfDate, future: period.future, employees });
  } catch {
    return payrollJson({ ok: false, code: "PAYROLL_OVERVIEW_READ_FAILED" }, 500);
  }
}
