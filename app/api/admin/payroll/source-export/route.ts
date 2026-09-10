import { validPayrollMonth } from "@/lib/payroll/monthly-run";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { loadPayrollSourceExport } from "@/lib/payroll/source-export/server";

export const dynamic="force-dynamic";

export async function GET(request:Request){
  const auth=await requirePayrollActor();
  if(auth.response)return auth.response;
  const month=validPayrollMonth(new URL(request.url).searchParams.get("month"));
  if(!month)return payrollJson({ok:false,code:"INVALID_MONTH"},400);
  try{return payrollJson({ok:true,export:await loadPayrollSourceExport(month)});}
  catch(error){console.error("[PAYROLL_SOURCE_EXPORT_FAILED]",error);return payrollJson({ok:false,code:"PAYROLL_SOURCE_EXPORT_FAILED"},500);}
}
