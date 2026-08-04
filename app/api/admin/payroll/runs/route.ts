import {supabaseServer} from "@/lib/supabase/server";
import {payrollJson,requirePayrollActor} from "@/lib/payroll/server";
export const dynamic="force-dynamic";
export async function GET(){const auth=await requirePayrollActor();if(auth.response)return auth.response;const{data,error}=await supabaseServer.from("payroll_payment_batches").select("*").order("payroll_month",{ascending:false});return error?payrollJson({ok:false,code:"PAYROLL_RUNS_READ_FAILED"},500):payrollJson({ok:true,runs:data??[]})}
