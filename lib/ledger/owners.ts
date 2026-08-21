import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { allocateOwnerPool } from "@/lib/ledger/owner-allocation-core";

export const OWNER_MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;

export async function loadOwnerDashboard(throughMonth:string){
 const monthDate=`${throughMonth}-01`;
 const[capacityResult,participantResult,investmentResult,settlementResult,allocationResult,policyResult,accountResult,userResult,closureResult,settingsResult]=await Promise.all([
  supabaseServer.rpc("ledger_owner_financial_capacity_v1",{p_through_month:monthDate}),
  supabaseServer.from("ledger_owner_participants").select("id,user_id,is_eligible,effective_from,effective_to,sort_order").lte("effective_from",monthDate).or(`effective_to.is.null,effective_to.gte.${monthDate}`).eq("is_eligible",true).order("sort_order"),
  supabaseServer.from("ledger_owner_investments").select("participant_id,signed_amount,entry_type"),
  supabaseServer.from("ledger_owner_settlements").select("id,through_month,status,confirmed_pool,policy_snapshot,confirmed_at").order("through_month",{ascending:false}),
  supabaseServer.from("ledger_owner_settlement_allocations").select("id,settlement_id,participant_id,rate_snapshot,assigned_amount,recovery_amount,pure_profit_amount,paid_amount,recovery_paid_amount,pure_profit_paid_amount"),
  supabaseServer.from("ledger_owner_settlement_policies").select("id,effective_month,revision,note,lines:ledger_owner_settlement_policy_lines(participant_id,settlement_rate)").lte("effective_month",monthDate).order("effective_month",{ascending:false}).order("revision",{ascending:false}).limit(1).maybeSingle(),
  supabaseServer.from("ledger_fund_accounts").select("id,display_name,type,is_active,is_business_fund").eq("is_active",true).eq("is_business_fund",true).in("type",["cash","bank","personal_custody"]).order("sort_order"),
  supabaseServer.from("users").select("id,name,full_name,username,role,is_active").in("role",["owner","master"]).eq("is_active",true).order("id"),
  supabaseServer.from("ledger_month_closures").select("month,status").order("month",{ascending:false}),
  supabaseServer.from("ledger_owner_profit_settings").select("profit_tracking_start_month,opening_undistributed_profit").maybeSingle(),
 ]);
 const results=[capacityResult,participantResult,investmentResult,settlementResult,allocationResult,policyResult,accountResult,userResult,closureResult,settingsResult];for(const result of results)if(result.error)throw result.error;
 const participants=participantResult.data??[],participantUser=new Map(participants.map(row=>[Number(row.id),Number(row.user_id)])),allParticipantResult=await supabaseServer.from("ledger_owner_participants").select("id,user_id");if(allParticipantResult.error)throw allParticipantResult.error;const allParticipantUser=new Map((allParticipantResult.data??[]).map(row=>[Number(row.id),Number(row.user_id)]));
 const owners=participants.map(participant=>{const user=(userResult.data??[]).find(row=>Number(row.id)===Number(participant.user_id)),ids=[...allParticipantUser.entries()].filter(([,userId])=>userId===Number(participant.user_id)).map(([id])=>id),invested=(investmentResult.data??[]).filter(row=>ids.includes(Number(row.participant_id))).reduce((sum,row)=>sum+Number(row.signed_amount),0),allocations=(allocationResult.data??[]).filter(row=>ids.includes(Number(row.participant_id))),recoveryAllocated=allocations.reduce((sum,row)=>sum+Number(row.recovery_amount),0),recoveryPaid=allocations.reduce((sum,row)=>sum+Number(row.recovery_paid_amount),0),profitAllocated=allocations.reduce((sum,row)=>sum+Number(row.pure_profit_amount),0),profitPaid=allocations.reduce((sum,row)=>sum+Number(row.pure_profit_paid_amount),0),unpaid=allocations.reduce((sum,row)=>sum+Number(row.assigned_amount)-Number(row.paid_amount),0);return{participantId:participant.id,userId:participant.user_id,name:user?.name||user?.full_name||user?.username||`#${participant.user_id}`,sortOrder:participant.sort_order,cumulativeInvested:invested,recoveryAllocated,recoveryPaid,unrecoveredForAllocation:Math.max(0,invested-recoveryAllocated),cashUnrecovered:Math.max(0,invested-recoveryPaid),recoveryRate:invested>0?recoveryPaid/invested:null,pureProfitAllocated:profitAllocated,pureProfitPaid:profitPaid,unpaidSettlement:unpaid}});
 const policy=policyResult.data,previewLines=policy?allocateOwnerPool(String((capacityResult.data as Record<string,unknown>)?.recommendedMax??0),(policy.lines??[]).map(line=>({participantId:Number(line.participant_id),rate:String(line.settlement_rate),sortOrder:Number(participants.find(p=>Number(p.id)===Number(line.participant_id))?.sort_order??0)}))):[];
 return{capacity:capacityResult.data,participants,owners,users:userResult.data??[],accounts:accountResult.data??[],settlements:(settlementResult.data??[]).map(row=>({...row,allocations:(allocationResult.data??[]).filter(item=>Number(item.settlement_id)===Number(row.id))})),policy,previewLines,closedMonths:(closureResult.data??[]).map(row=>String(row.month).slice(0,7)),settings:settingsResult.data,participantUser:Object.fromEntries(participantUser)};
}
