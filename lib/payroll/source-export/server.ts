import "server-only";
import { loadMealAllowanceCostSummary } from "../meal-allowance-server";
import { loadPayrollOverview } from "../overview-server";
import { buildPayrollSourceExport } from "./build-export";

export async function loadPayrollSourceExport(month:string,options?:{userId?:number}){
  let mealPromise:ReturnType<typeof loadMealAllowanceCostSummary>|undefined;
  const overview=await loadPayrollOverview(month,{userId:options?.userId,onSnapshotReady:({snapshot,period})=>{
    mealPromise=loadMealAllowanceCostSummary(month,{calculationEndDate:period.calculationEndDate,users:snapshot.context.users,contracts:snapshot.context.contracts,attendance:snapshot.context.attendance,payrollUserIds:snapshot.employees.map(employee=>employee.userId)});
    void mealPromise.catch(()=>undefined);
  }});
  if(!mealPromise){mealPromise=loadMealAllowanceCostSummary(month,{calculationEndDate:overview.period.calculationEndDate,users:overview.snapshot.context.users,contracts:overview.snapshot.context.contracts,attendance:overview.snapshot.context.attendance,payrollUserIds:overview.employees.map(employee=>employee.userId)});}
  return buildPayrollSourceExport({month,overview,mealAllowance:await mealPromise});
}
