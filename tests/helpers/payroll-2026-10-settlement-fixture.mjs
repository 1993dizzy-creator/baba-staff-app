// Synthetic 2026-10 special-settlement fixture shared by the applied-migration
// regression test and the RPC retirement test. Synthetic data only.
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {install,read,closeMonth,state as baseState} from './payroll-batch-safety-fixture.mjs';
import {stablePayrollSourceHash} from '../../lib/payroll/source-export/stable-hash.ts';
export function parseSettlementPlan(raw){
  const employees=raw.employees.map(e=>({userId:e.userId,label:e.label??null,actualPaidAmount:e.actualPaidAmount,
    allocations:e.allocations.map(a=>({paymentDate:a.paymentDate,fundAccountId:a.fundAccountId,amount:a.amount,kind:a.kind,note:a.note??null})),note:e.note??null}));
  for(const e of employees)assert.equal(e.allocations.reduce((n,a)=>n+a.amount,0),e.actualPaidAmount,'synthetic allocation sum');
  const plan={version:1,payrollMonth:'2026-10',sourceTitle:raw.sourceTitle,employees,residuals:raw.residuals,expectedGroups:raw.expectedGroups,expectedTotal:raw.expectedTotal};
  return {ok:true,plan,planHash:stablePayrollSourceHash(plan)};
}
export function settlementDifferenceReason({sourceTitle,calculatedNetAmount,actualPaidAmount,note}){
  const d=actualPaidAmount-calculatedNetAmount;if(d===0)return null;
  const base=`2026-10 회계사 정정본(${sourceTitle}) 실지급 기준 · APP 계산 ${calculatedNetAmount}₫ → 실지급 ${actualPaidAmount}₫ (차액 ${d>0?'+':'−'}${Math.abs(d)}₫)`;
  return note?`${base} · ${note}`:base;
}

// Synthetic employees and amounts only. Real October data lives in the private
// server-only plan and is never part of this repository.
export const MIGRATION='supabase/migrations/20261116163616_payroll_2026_10_special_settlement.sql';
export const OCT='2026-10-01',BANK=2,CASH=1,D10='2026-11-10',D14='2026-11-14';
export const IDS=Array.from({length:17},(_,i)=>201+i);
export const SPLIT=212,CASH_ONLY=216,FREELANCE=217;
export const INS={employee:100,employer:200};
export const OWNER=1,MASTER=2,STAFF=3,INACTIVE_MASTER=4,NO_LOGIN_MASTER=5;

export function syntheticPlan(){
  const employees=IDS.map(userId=>{
    if(userId===CASH_ONLY)return{userId,actualPaidAmount:7000000,allocations:[{paymentDate:D10,fundAccountId:CASH,amount:7000000,kind:'salary'}],note:'synthetic cash payee'};
    if(userId===FREELANCE)return{userId,actualPaidAmount:2500000,allocations:[{paymentDate:D14,fundAccountId:CASH,amount:2500000,kind:'salary'}]};
    if(userId===SPLIT)return{userId,actualPaidAmount:4150000,allocations:[{paymentDate:D10,fundAccountId:BANK,amount:4000000,kind:'salary'},{paymentDate:D10,fundAccountId:CASH,amount:150000,kind:'penalty_refund',note:'synthetic cancelled penalty returned in cash'}]};
    const amount=5000000+userId*1001;return{userId,actualPaidAmount:amount,allocations:[{paymentDate:D10,fundAccountId:BANK,amount,kind:'salary'}]};
  });
  const bank=employees.flatMap(e=>e.allocations).filter(a=>a.fundAccountId===BANK).reduce((n,a)=>n+a.amount,0)+1;
  const raw={version:1,payrollMonth:'2026-10',sourceTitle:'synthetic corrected payroll',employees,
    residuals:[{paymentDate:D10,fundAccountId:BANK,amount:1,reason:'synthetic batch transfer rounding residual'}],
    expectedGroups:[{paymentDate:D10,fundAccountId:BANK,amount:bank},{paymentDate:D10,fundAccountId:CASH,amount:7150000},{paymentDate:D14,fundAccountId:CASH,amount:2500000}],
    expectedTotal:bank+7150000+2500000};
  const parsed=parseSettlementPlan(raw);assert.equal(parsed.ok,true,JSON.stringify(parsed.errors));return parsed;
}
export const calculatedNet=e=>e.userId===CASH_ONLY?e.actualPaidAmount+5555:e.userId===SPLIT?e.actualPaidAmount-2:e.actualPaidAmount;
export const snapshot=()=>({employee:{amounts:{employeeInsuranceDeductionAmount:INS.employee,employerInsuranceAmount:INS.employer,advanceAmount:0},tax:{employeePitDeductionAmount:0,companyPitAmount:0}},automaticItemsSnapshot:[]});
export const targets=(ids=IDS,blocked=null)=>ids.map(userId=>({userId,employeeName:`QA ${userId}`,part:null,position:null,isPayable:userId!==blocked,failureCodes:userId===blocked?['BLOCKING_REVIEW']:[]}));
export function payments(plan,userIds=IDS){
  return plan.employees.filter(e=>userIds.includes(e.userId)).map(e=>({userId:e.userId,calculationSnapshot:snapshot(),calculationHash:`hash-${e.userId}`,calculatedNetAmount:calculatedNet(e),actualPaidAmount:e.actualPaidAmount,
    differenceReason:settlementDifferenceReason({sourceTitle:'synthetic',calculatedNetAmount:calculatedNet(e),actualPaidAmount:e.actualPaidAmount,note:e.note}),allocations:structuredClone(e.allocations)}));
}
export const hex=c=>c.repeat(64);
export async function settle(db,{plan,planHash},o={}){
  const args=[o.month??OCT,JSON.stringify(o.targets??targets()),JSON.stringify(o.payments??payments(plan)),JSON.stringify(o.residuals??plan.residuals),JSON.stringify(o.expected??plan.expectedGroups),
    o.key??'request-key-0001-abcdef',o.hash??hex('a'),o.planHash??planHash,o.actor??OWNER];
  return (await db.query(`select payroll_settle_2026_10_v1($1::date,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,'monthly-payroll-v12','{}'::jsonb,0) r`,args)).rows[0].r;
}
export async function database(){
  const db=await install(new PGlite({extensions:{btree_gist}}));
  await db.exec(read(MIGRATION));
  await db.exec(`insert into users(id,username,password,name,role,hire_date,is_active,app_login_enabled) values
      (2,'master','x','Master','master','2025-01-01',true,true),(3,'staff','x','Staff','staff','2025-01-01',true,true),
      (4,'old-master','x','Old master','master','2025-01-01',false,true),(5,'no-login-master','x','No login','master','2025-01-01',true,false);
    insert into users(id,username,password,name,role,hire_date) select g,'qa'||g,'x','QA '||g,'staff','2025-01-01' from generate_series(201,217) g;`);
  assert.equal((await closeMonth(db,OCT)).status,'closed');
  return db;
}
export async function state(db){
  const s=await baseState(db);
  for(const t of ['payroll_employee_payment_allocations','payroll_payment_group_residuals','payroll_special_settlement_requests','ledger_month_closures'])s[t]=(await db.query(`select * from ${t} order by id`)).rows;
  return s;
}
