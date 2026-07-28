import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { normalizeAttendanceDayFacts } from "./attendance-facts";
import { mapContract, mapSchedule } from "./db-mappers";
import { roundMinutes } from "./projection";
import { isPayrollUserCandidate } from "./eligibility";
import type { PayrollContract, WorkScheduleVersion } from "./types";

export const PAYROLL_RUN_ENGINE_VERSION = "monthly-payroll-v2";
export const PAYROLL_RUN_START_MONTH = "2026-07";

export const CRITICAL_WARNING_CODES = [
  "NO_PAYROLL_CONTRACT", "MISSING_CHECK_IN", "MISSING_CHECK_OUT", "INVALID_TIME_RANGE",
  "SCHEDULE_HISTORY_UNAVAILABLE", "PENDING_LEAVE_APPROVAL", "LEAVE_PAYROLL_TREATMENT_UNSPECIFIED",
  "OVERTIME_APPROVAL_UNAVAILABLE", "CONTRACT_OVERLAP", "CALCULATION_FAILED",
  "STORED_STATUS_POLICY_MISMATCH", "STORED_LATE_MINUTES_MISMATCH",
  "STORED_EARLY_LEAVE_MINUTES_MISMATCH", "STORED_WORK_MINUTES_MISMATCH",
  "LATE_POLICY_REVIEW", "EARLY_LEAVE_POLICY_REVIEW",
] as const;
const BLOCKING_WARNING_CODES=new Set<string>(["NO_PAYROLL_CONTRACT","MISSING_CHECK_IN","MISSING_CHECK_OUT","INVALID_TIME_RANGE","SCHEDULE_HISTORY_UNAVAILABLE","CONTRACT_OVERLAP","CALCULATION_FAILED"]);
const ACTIONABLE_WARNING_CODES=new Set<string>(["PENDING_LEAVE_APPROVAL","LEAVE_PAYROLL_TREATMENT_UNSPECIFIED","OVERTIME_APPROVAL_UNAVAILABLE"]);

type CriticalWarning = typeof CRITICAL_WARNING_CODES[number];
type UserRow={id:number;name:string|null;full_name:string|null;username:string;is_active:boolean;role:string;hire_date:string|null;termination_date:string|null;is_system_account:boolean;payroll_eligible_override:boolean|null};
type AttendanceRow={id:number;user_id:number;status:string;work_date:string;check_in_at:string|null;check_out_at:string|null;late_minutes:number|null;early_leave_minutes:number|null;work_minutes:number|null;approval_status:string|null;updated_at:string|null};
type AutoCategory="base_work"|"paid_leave"|"overtime"|"late_deduction"|"early_leave_deduction";
export type PayrollRunItemInput={itemType:"automatic"|"manual"|"review_adjustment";category:AutoCategory|string;direction:"addition"|"deduction";amount:number;originalAmount:number|null;businessDate:string|null;description:string;sourceSnapshot:Record<string,unknown>};
export type PayrollRunReviewInput={warningCode:CriticalWarning;reviewLevel:"blocking"|"actionable"|"advisory";businessDate:string|null;sourceSnapshot:Record<string,unknown>};
export type PayrollRunEmployeeInput={userId:number;employeeName:string;contractSnapshot:PayrollContract[];attendanceSnapshot:Record<string,unknown>;recognizedWorkdays:number;recognizedMinutes:number;lateMinutes:number;earlyLeaveMinutes:number;overtimeCandidateMinutes:number;items:PayrollRunItemInput[];reviews:PayrollRunReviewInput[]};
type BatchInput={month:string;users:UserRow[];attendance:AttendanceRow[];contracts:PayrollContract[];schedules:WorkScheduleVersion[];settingsByDate:Map<string,{revision:number|null;lateGraceMinutes:number;earlyLeaveGraceMinutes:number}>};

export function validPayrollMonth(value:string|null){return value&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value)?value:null;}
export function isOfficialPayrollMonth(month:string){return month>=PAYROLL_RUN_START_MONTH;}
export function payrollMonthDates(month:string){const[y,m]=month.split("-").map(Number);const count=new Date(Date.UTC(y,m,0)).getUTCDate();return Array.from({length:count},(_,index)=>`${month}-${String(index+1).padStart(2,"0")}`);}
function activeOn<T extends{effectiveFrom:string;effectiveTo:string|null}>(rows:T[],date:string){return rows.filter(row=>row.effectiveFrom<=date&&(!row.effectiveTo||row.effectiveTo>date));}
function intersectsMonth(row:{effectiveFrom:string;effectiveTo:string|null},start:string,endExclusive:string){return row.effectiveFrom<endExclusive&&(!row.effectiveTo||row.effectiveTo>start);}
function employeeName(user:UserRow){return user.name||user.full_name||user.username;}
function rates(contract:PayrollContract){const dayRate=contract.payType==="monthly"?(contract.standardWorkdays?contract.baseSalary/contract.standardWorkdays:0):contract.payType==="daily"?contract.baseSalary:(contract.baseSalary/60)*contract.standardMinutesPerDay;return{dayRate,minuteRate:contract.payType==="hourly"?contract.baseSalary/60:dayRate/contract.standardMinutesPerDay};}
function vnd(value:number){return Math.round(value);}
function item(category:AutoCategory,direction:"addition"|"deduction",amount:number,date:string,description:string,sourceSnapshot:Record<string,unknown>):PayrollRunItemInput{return{itemType:"automatic",category,direction,amount:vnd(Math.max(0,amount)),originalAmount:vnd(Math.max(0,amount)),businessDate:date,description,sourceSnapshot};}
function review(warningCode:CriticalWarning,businessDate:string|null,sourceSnapshot:Record<string,unknown>):PayrollRunReviewInput{return{warningCode,reviewLevel:BLOCKING_WARNING_CODES.has(warningCode)?"blocking":ACTIONABLE_WARNING_CODES.has(warningCode)?"actionable":"advisory",businessDate,sourceSnapshot};}
function isCritical(code:string):code is CriticalWarning{return(CRITICAL_WARNING_CODES as readonly string[]).includes(code);}

export function selectPayrollUsers(input:{users:UserRow[];attendance:AttendanceRow[];contracts:PayrollContract[];month:string}){
  const start=`${input.month}-01`;const next=new Date(`${start}T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);const endExclusive=next.toISOString().slice(0,10);
  const attendanceIds=new Set(input.attendance.map(row=>Number(row.user_id)));const contractIds=new Set(input.contracts.filter(row=>intersectsMonth(row,start,endExclusive)).map(row=>row.userId));
  const monthEnd=new Date(`${endExclusive}T00:00:00Z`);monthEnd.setUTCDate(monthEnd.getUTCDate()-1);const monthEndDate=monthEnd.toISOString().slice(0,10);
  return input.users.filter(user=>{
    const intersects=Boolean(user.hire_date)&&user.hire_date!<=monthEndDate&&(!user.termination_date||user.termination_date>=start);
    return isPayrollUserCandidate({
      user,
      employmentIntersects:intersects,
      hasAttendance:attendanceIds.has(user.id),
      hasContract:contractIds.has(user.id),
    });
  });
}

export function calculatePayrollBatch(input:BatchInput):PayrollRunEmployeeInput[]{
  const users=selectPayrollUsers(input);const attendanceByUser=new Map<number,AttendanceRow[]>();for(const row of input.attendance){const list=attendanceByUser.get(Number(row.user_id))??[];list.push(row);attendanceByUser.set(Number(row.user_id),list);}
  return users.map(user=>{try{return calculateEmployee(user,attendanceByUser.get(user.id)??[],input);}catch(error){return{userId:user.id,employeeName:employeeName(user),contractSnapshot:[],attendanceSnapshot:{month:input.month,engineVersion:PAYROLL_RUN_ENGINE_VERSION,error:error instanceof Error?error.message:"CALCULATION_FAILED"},recognizedWorkdays:0,recognizedMinutes:0,lateMinutes:0,earlyLeaveMinutes:0,overtimeCandidateMinutes:0,items:[],reviews:[review("CALCULATION_FAILED",null,{message:error instanceof Error?error.message:"CALCULATION_FAILED"})]};}});
}

function calculateEmployee(user:UserRow,records:AttendanceRow[],input:BatchInput):PayrollRunEmployeeInput{
  const contracts=input.contracts.filter(row=>row.userId===user.id);const schedules=input.schedules.filter(row=>row.userId===user.id);const items:PayrollRunItemInput[]=[];const reviews:PayrollRunReviewInput[]=[];const days:Record<string,unknown>[]=[];let recognizedMinutes=0,recognizedWorkdays=0,lateMinutes=0,earlyLeaveMinutes=0,overtimeCandidateMinutes=0;
  const eligibleRecords=records.filter(row=>(!user.hire_date||row.work_date>=user.hire_date)&&(!user.termination_date||row.work_date<=user.termination_date)).sort((a,b)=>a.work_date.localeCompare(b.work_date));
  if(contracts.length===0)reviews.push(review("NO_PAYROLL_CONTRACT",null,{userId:user.id,month:input.month}));
  for(const record of eligibleRecords){const date=record.work_date;const contractMatches=activeOn(contracts,date);const scheduleMatches=activeOn(schedules,date);const contract=contractMatches.length===1?contractMatches[0]:null;const schedule=scheduleMatches.length===1?scheduleMatches[0]:null;const settings=input.settingsByDate.get(date)??{revision:null,lateGraceMinutes:0,earlyLeaveGraceMinutes:0};
    const facts=normalizeAttendanceDayFacts({userId:user.id,businessDate:date,attendanceRecord:{id:Number(record.id),status:record.status,checkInAt:record.check_in_at,checkOutAt:record.check_out_at,approvalStatus:record.approval_status,storedLateMinutes:record.late_minutes,storedEarlyLeaveMinutes:record.early_leave_minutes,storedWorkMinutes:record.work_minutes},schedule,hireDate:user.hire_date,storeSettingsRevision:settings.revision,lateGraceMinutes:settings.lateGraceMinutes,earlyLeaveGraceMinutes:settings.earlyLeaveGraceMinutes});
    if(contractMatches.length>1&&!facts.warningCodes.includes("CONTRACT_OVERLAP"))facts.warningCodes.push("CONTRACT_OVERLAP");
    if(!contract&&!facts.warningCodes.includes("NO_PAYROLL_CONTRACT"))facts.warningCodes.push("NO_PAYROLL_CONTRACT");
    for(const code of facts.warningCodes){if(isCritical(code)&&!(code==="LEAVE_PAYROLL_TREATMENT_UNSPECIFIED"&&contract?.paidLeaveMode!=="manual_review"))reviews.push(review(code,date,{attendanceRecordId:record.id,stored:facts.stored,recalculated:{status:facts.attendanceStatus,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes,workMinutes:facts.actualMinutes},candidateMinutes:facts.overtimeCandidateMinutes}));}
    if(!contract||!schedule||contractMatches.length!==1||scheduleMatches.length!==1){days.push({date,facts,contractRevision:contract?.revision??null,scheduleRevision:schedule?.revision??null});continue;}
    const rate=rates(contract);
    const storedWorkMinutes=Number(facts.stored.workMinutes??0);const recalculatedWorkMinutes=Number(facts.actualMinutes??0);
    if(facts.warningCodes.includes("STORED_WORK_MINUTES_MISMATCH"))reviews.push(review("STORED_WORK_MINUTES_MISMATCH",date,{attendanceRecordId:record.id,stored:facts.stored,recalculated:{workMinutes:recalculatedWorkMinutes},amountDelta:vnd(rate.minuteRate*(storedWorkMinutes-recalculatedWorkMinutes))}));
    if(facts.warningCodes.includes("STORED_LATE_MINUTES_MISMATCH"))reviews.push(review("STORED_LATE_MINUTES_MISMATCH",date,{attendanceRecordId:record.id,stored:facts.stored,recalculated:{lateMinutes:facts.lateMinutes},amountDelta:0}));
    if(facts.warningCodes.includes("STORED_EARLY_LEAVE_MINUTES_MISMATCH"))reviews.push(review("STORED_EARLY_LEAVE_MINUTES_MISMATCH",date,{attendanceRecordId:record.id,stored:facts.stored,recalculated:{earlyLeaveMinutes:facts.earlyLeaveMinutes},amountDelta:0}));
    const blocking=facts.warningCodes.some(code=>["MISSING_CHECK_IN","MISSING_CHECK_OUT","INVALID_TIME_RANGE","PENDING_LEAVE_APPROVAL"].includes(code));
    if(record.status==="leave"){
      if(record.approval_status!=="approved"){days.push({date,facts,contractRevision:contract.revision,scheduleRevision:schedule.revision});continue;}
      if(contract.paidLeaveMode==="paid"){items.push(item("paid_leave","addition",rate.dayRate,date,"유급휴무",{dayRate:rate.dayRate,contractRevision:contract.revision,recognizedMinutes:contract.standardMinutesPerDay,recognizedDays:1,lateMinutes:0,earlyLeaveMinutes:0,overtimeCandidateMinutes:0}));recognizedWorkdays+=1;recognizedMinutes+=contract.standardMinutesPerDay;}
      else if(contract.paidLeaveMode==="manual_review")reviews.push(review("LEAVE_PAYROLL_TREATMENT_UNSPECIFIED",date,{dayRate:rate.dayRate,standardMinutesPerDay:contract.standardMinutesPerDay,contractRevision:contract.revision}));
      days.push({date,facts,contractRevision:contract.revision,scheduleRevision:schedule.revision});continue;
    }
    if(blocking||facts.scheduledOverlapMinutes===null){days.push({date,facts,contractRevision:contract.revision,scheduleRevision:schedule.revision});continue;}
    let minutes=facts.scheduledOverlapMinutes;let daysRecognized=minutes/contract.standardMinutesPerDay;
    if(contract.calculationBasis==="hour")minutes=roundMinutes(minutes,contract.timeBlockMinutes,contract.roundingMode);
    if(contract.calculationBasis==="day"){minutes=contract.standardMinutesPerDay;daysRecognized=1;}
    else daysRecognized=minutes/contract.standardMinutesPerDay;
    const baseAmount=contract.calculationBasis==="day"?rate.dayRate:rate.minuteRate*minutes;items.push(item("base_work","addition",baseAmount,date,"기본 근무",{recognizedMinutes:minutes,recognizedDays:daysRecognized,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes,overtimeCandidateMinutes:facts.overtimeCandidateMinutes,minuteRate:rate.minuteRate,dayRate:rate.dayRate,contractRevision:contract.revision}));recognizedMinutes+=minutes;recognizedWorkdays+=daysRecognized;lateMinutes+=facts.lateMinutes;earlyLeaveMinutes+=facts.earlyLeaveMinutes;overtimeCandidateMinutes+=facts.overtimeCandidateMinutes;
    if(contract.calculationBasis==="day"){
      if(facts.lateMinutes>0){if(contract.lateAdjustmentMode==="deduct_minutes")items.push(item("late_deduction","deduction",rate.minuteRate*facts.lateMinutes,date,"지각 공제",{minutes:facts.lateMinutes,minuteRate:rate.minuteRate}));else if(contract.lateAdjustmentMode==="separate")reviews.push(review("LATE_POLICY_REVIEW",date,{minutes:facts.lateMinutes,minuteRate:rate.minuteRate,suggestedDeduction:vnd(rate.minuteRate*facts.lateMinutes)}));}
      if(facts.earlyLeaveMinutes>0){if(contract.earlyLeaveAdjustmentMode==="deduct_minutes")items.push(item("early_leave_deduction","deduction",rate.minuteRate*facts.earlyLeaveMinutes,date,"조퇴 공제",{minutes:facts.earlyLeaveMinutes,minuteRate:rate.minuteRate}));else if(contract.earlyLeaveAdjustmentMode==="separate")reviews.push(review("EARLY_LEAVE_POLICY_REVIEW",date,{minutes:facts.earlyLeaveMinutes,minuteRate:rate.minuteRate,suggestedDeduction:vnd(rate.minuteRate*facts.earlyLeaveMinutes)}));}
    }
    if(facts.overtimeCandidateMinutes>0&&contract.overtimeMode==="requires_approval")reviews.push(review("OVERTIME_APPROVAL_UNAVAILABLE",date,{candidateMinutes:facts.overtimeCandidateMinutes,minuteRate:rate.minuteRate,suggestedAmount:vnd(rate.minuteRate*facts.overtimeCandidateMinutes)}));
    const recalculatedAutomaticItems=items.filter(entry=>entry.itemType==="automatic"&&entry.businessDate===date);
    const storedRaw=Math.max(0,Number(facts.stored.workMinutes??0));const storedRecognizedMinutes=contract.calculationBasis==="hour"?roundMinutes(storedRaw,contract.timeBlockMinutes,contract.roundingMode):contract.calculationBasis==="day"?contract.standardMinutesPerDay:storedRaw;const storedDays=contract.calculationBasis==="day"?1:storedRecognizedMinutes/contract.standardMinutesPerDay;
    const storedAutomaticItems=recalculatedAutomaticItems.filter(entry=>!["base_work","late_deduction","early_leave_deduction"].includes(entry.category));
    if(record.status!=="leave"&&storedRaw>0){storedAutomaticItems.push(item("base_work","addition",contract.calculationBasis==="day"?rate.dayRate:rate.minuteRate*storedRecognizedMinutes,date,"기본 근무",{recognizedMinutes:storedRecognizedMinutes,recognizedDays:storedDays,lateMinutes:Number(facts.stored.lateMinutes??0),earlyLeaveMinutes:Number(facts.stored.earlyLeaveMinutes??0),overtimeCandidateMinutes:facts.overtimeCandidateMinutes,minuteRate:rate.minuteRate,dayRate:rate.dayRate,contractRevision:contract.revision,attendanceSource:"stored"}));if(contract.calculationBasis==="day"&&contract.lateAdjustmentMode==="deduct_minutes"&&Number(facts.stored.lateMinutes??0)>0)storedAutomaticItems.push(item("late_deduction","deduction",rate.minuteRate*Number(facts.stored.lateMinutes),date,"지각 공제",{minutes:Number(facts.stored.lateMinutes),minuteRate:rate.minuteRate,attendanceSource:"stored"}));if(contract.calculationBasis==="day"&&contract.earlyLeaveAdjustmentMode==="deduct_minutes"&&Number(facts.stored.earlyLeaveMinutes??0)>0)storedAutomaticItems.push(item("early_leave_deduction","deduction",rate.minuteRate*Number(facts.stored.earlyLeaveMinutes),date,"조퇴 공제",{minutes:Number(facts.stored.earlyLeaveMinutes),minuteRate:rate.minuteRate,attendanceSource:"stored"}));}
    const recalculatedNet=recalculatedAutomaticItems.reduce((sum,entry)=>sum+(entry.direction==="addition"?entry.amount:-entry.amount),0);const storedNet=storedAutomaticItems.reduce((sum,entry)=>sum+(entry.direction==="addition"?entry.amount:-entry.amount),0);
    for(const entry of reviews){if(entry.businessDate===date&&entry.warningCode.startsWith("STORED_")){entry.sourceSnapshot={...entry.sourceSnapshot,recalculatedAutomaticItems,storedAutomaticItems,recalculatedSummary:{recognizedMinutes:minutes,recognizedDays:daysRecognized,lateMinutes:facts.lateMinutes,earlyLeaveMinutes:facts.earlyLeaveMinutes,overtimeCandidateMinutes:facts.overtimeCandidateMinutes},storedSummary:{recognizedMinutes:storedRecognizedMinutes,recognizedDays:storedDays,lateMinutes:Number(facts.stored.lateMinutes??0),earlyLeaveMinutes:Number(facts.stored.earlyLeaveMinutes??0),overtimeCandidateMinutes:facts.overtimeCandidateMinutes},amountDelta:storedNet-recalculatedNet};}}
    days.push({date,facts,contractRevision:contract.revision,scheduleRevision:schedule.revision,recognizedMinutes:minutes});
  }
  const deduped=[...new Map(reviews.map(entry=>[`${entry.businessDate??"none"}:${entry.warningCode}`,entry])).values()];
  return{userId:user.id,employeeName:employeeName(user),contractSnapshot:contracts,attendanceSnapshot:{month:input.month,engineVersion:PAYROLL_RUN_ENGINE_VERSION,days},recognizedWorkdays,recognizedMinutes,lateMinutes,earlyLeaveMinutes,overtimeCandidateMinutes,items,reviews:deduped};
}

export async function loadPayrollMonthSnapshot(month:string){
  const dates=payrollMonthDates(month);const start=dates[0],end=dates.at(-1)!;const nextMonth=new Date(`${start}T00:00:00Z`);nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1);const endExclusive=nextMonth.toISOString().slice(0,10);
  const[userResult,attendanceResult,contractResult,scheduleResult,settingsResults]=await Promise.all([
    supabaseServer.from("users").select("id,name,full_name,username,is_active,role,hire_date,termination_date,is_system_account,payroll_eligible_override").order("id"),
    supabaseServer.from("attendance_records").select("id,user_id,status,work_date,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,approval_status,updated_at").gte("work_date",start).lte("work_date",end),
    supabaseServer.from("payroll_contract_versions").select("id,user_id,pay_type,calculation_basis,base_salary,standard_workdays,standard_minutes_per_day,time_block_minutes,rounding_mode,late_adjustment_mode,early_leave_adjustment_mode,overtime_mode,paid_leave_mode,effective_from,effective_to,revision").lt("effective_from",endExclusive).or(`effective_to.is.null,effective_to.gt.${start}`),
    supabaseServer.from("employee_work_schedule_versions").select("id,user_id,start_time,end_time,unpaid_break_minutes,effective_from,effective_to,revision,change_reason").lt("effective_from",endExclusive).or(`effective_to.is.null,effective_to.gt.${start}`),
    Promise.all(dates.map(date=>supabaseServer.rpc("store_get_settings_overview_v1",{p_business_date:date}))),
  ]);
  if(userResult.error||attendanceResult.error||contractResult.error||scheduleResult.error||settingsResults.some(result=>result.error))throw new Error("PAYROLL_MONTH_SNAPSHOT_READ_FAILED");
  const settingsByDate=new Map(dates.map((date,index)=>{const overview=settingsResults[index].data as{current?:{revision?:number;attendancePolicy?:{lateGraceMinutes?:number;earlyLeaveGraceMinutes?:number}}|null}|null;return[date,{revision:overview?.current?.revision??null,lateGraceMinutes:overview?.current?.attendancePolicy?.lateGraceMinutes??0,earlyLeaveGraceMinutes:overview?.current?.attendancePolicy?.earlyLeaveGraceMinutes??0}];}));
  const input:BatchInput={month,users:(userResult.data??[]) as UserRow[],attendance:(attendanceResult.data??[]) as AttendanceRow[],contracts:(contractResult.data??[]).map(row=>mapContract(row as Record<string,unknown>)),schedules:(scheduleResult.data??[]).map(row=>mapSchedule(row as Record<string,unknown>)),settingsByDate};
  return{employees:calculatePayrollBatch(input),sourceSnapshot:{engineVersion:PAYROLL_RUN_ENGINE_VERSION,calculatedAt:new Date().toISOString(),attendanceRecordIds:input.attendance.map(row=>row.id),contractRevisions:[...new Set(input.contracts.map(row=>row.revision))],scheduleRevisions:[...new Set(input.schedules.map(row=>row.revision))],storeSettingRevisions:[...new Set([...settingsByDate.values()].map(value=>value.revision).filter(value=>value!==null))]}};
}
