import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { allocateOwnerPool } from "@/lib/ledger/owner-allocation-core";
import { getBusinessMonthEndBoundary } from "@/lib/common/business-time";

export const OWNER_MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
export type OwnerInvestmentView="current"|"month_end";

export async function loadOwnerDashboard(throughMonth:string,{investmentView="month_end"}:{investmentView?:OwnerInvestmentView}={}){
 const monthDate=`${throughMonth}-01`;
 // A live dashboard uses server time; a settlement preview uses the selected
 // business month's 03:00 Asia/Ho_Chi_Minh closing boundary.
 const cutoffAt=investmentView==="current"?new Date(Date.now()).toISOString():getBusinessMonthEndBoundary(throughMonth).cutoffAt;
 const[capacityResult,recoveryResult,participantResult,investmentResult,settlementResult,allocationResult,policyResult,accountResult,userResult,closureResult,settingsResult]=await Promise.all([
  supabaseServer.rpc("ledger_owner_financial_capacity_v1",{p_through_month:monthDate}),
  supabaseServer.rpc("ledger_owner_recovery_capacity_v1"),
  supabaseServer.from("ledger_owner_participants").select("id,user_id,is_eligible,effective_from,effective_to,sort_order").lte("effective_from",monthDate).or(`effective_to.is.null,effective_to.gte.${monthDate}`).eq("is_eligible",true).order("sort_order"),
  supabaseServer.from("ledger_owner_investments").select("participant_id,signed_amount,entry_type").lt("occurred_at",cutoffAt),
  supabaseServer.from("ledger_owner_settlements").select("id,through_month,settlement_type,status,confirmed_pool,policy_snapshot,confirmed_at").lte("through_month",monthDate).order("confirmed_at",{ascending:false}),
  supabaseServer.from("ledger_owner_settlement_allocations").select("id,settlement_id,participant_id,rate_snapshot,assigned_amount,recovery_amount,pure_profit_amount,paid_amount,recovery_paid_amount,pure_profit_paid_amount"),
  supabaseServer.from("ledger_owner_settlement_policies").select("id,effective_month,revision,note,lines:ledger_owner_settlement_policy_lines(participant_id,settlement_rate)").lte("effective_month",monthDate).order("effective_month",{ascending:false}).order("revision",{ascending:false}).limit(1).maybeSingle(),
  supabaseServer.from("ledger_fund_accounts").select("id,display_name,type,is_active,is_business_fund").eq("is_active",true).eq("is_business_fund",true).in("type",["cash","bank","personal_custody"]).order("sort_order"),
  supabaseServer.from("users").select("id,name,full_name,username,role,is_active").in("role",["owner","master"]).eq("is_active",true).neq("username","pos").order("id"),
  supabaseServer.from("ledger_month_closures").select("month,status").eq("status","closed").order("month",{ascending:false}),
  supabaseServer.from("ledger_owner_profit_settings").select("profit_tracking_start_month,opening_undistributed_profit").maybeSingle(),
 ]);
 const results=[capacityResult,recoveryResult,participantResult,investmentResult,settlementResult,allocationResult,policyResult,accountResult,userResult,closureResult,settingsResult];for(const result of results)if(result.error)throw result.error;
 const participants=participantResult.data??[],allParticipantResult=await supabaseServer.from("ledger_owner_participants").select("id,user_id,effective_from,sort_order");if(allParticipantResult.error)throw allParticipantResult.error;const allParticipantUser=new Map((allParticipantResult.data??[]).map(row=>[Number(row.id),Number(row.user_id)]));
 const historicalUserIds=[...new Set(allParticipantUser.values())];
 const historicalUserResult=historicalUserIds.length?await supabaseServer.from("users").select("id,name,full_name,username").in("id",historicalUserIds):{data:[],error:null};if(historicalUserResult.error)throw historicalUserResult.error;
 const visibleSettlementIds=new Set((settlementResult.data??[]).filter(row=>row.status!=="draft").map(row=>Number(row.id)));
 const visibleAllocations=(allocationResult.data??[]).filter(row=>visibleSettlementIds.has(Number(row.settlement_id)));
 // Keep former participants with principal or payments in the dashboard. Recovery belongs
 // to the user across every participant history row, even after eligibility changes.
 const latestByUser=new Map<number,(NonNullable<typeof allParticipantResult.data>)[number]>();
 for(const row of allParticipantResult.data??[]){const key=Number(row.user_id),previous=latestByUser.get(key);if(!previous||String(row.effective_from)>String(previous.effective_from)||String(row.effective_from)===String(previous.effective_from)&&Number(row.id)>Number(previous.id))latestByUser.set(key,row)}
 const displayedByUser=new Map(latestByUser);
 for(const row of participants)displayedByUser.set(Number(row.user_id),row);
 const relevantUsers=new Set<number>(participants.map(row=>Number(row.user_id)));
 for(const row of investmentResult.data??[]){const userId=allParticipantUser.get(Number(row.participant_id));if(userId!==undefined)relevantUsers.add(userId)}
 for(const row of visibleAllocations){const userId=allParticipantUser.get(Number(row.participant_id));if(userId!==undefined)relevantUsers.add(userId)}
 const owners=[...relevantUsers].map(userId=>displayedByUser.get(userId)).filter((row):row is NonNullable<typeof row>=>!!row).sort((a,b)=>Number(a.sort_order)-Number(b.sort_order)||Number(a.id)-Number(b.id)).map(participant=>{const user=(historicalUserResult.data??[]).find(row=>Number(row.id)===Number(participant.user_id)),ids=[...allParticipantUser.entries()].filter(([,userId])=>userId===Number(participant.user_id)).map(([id])=>id),invested=(investmentResult.data??[]).filter(row=>ids.includes(Number(row.participant_id))).reduce((sum,row)=>sum+Number(row.signed_amount),0),allocations=visibleAllocations.filter(row=>ids.includes(Number(row.participant_id))),recoveryAllocated=allocations.reduce((sum,row)=>sum+Number(row.recovery_amount),0),recoveryPaid=allocations.reduce((sum,row)=>sum+Number(row.recovery_paid_amount),0),profitAllocated=allocations.reduce((sum,row)=>sum+Number(row.pure_profit_amount),0),profitPaid=allocations.reduce((sum,row)=>sum+Number(row.pure_profit_paid_amount),0),unpaid=allocations.reduce((sum,row)=>sum+Number(row.assigned_amount)-Number(row.paid_amount),0);return{participantId:participant.id,userId:participant.user_id,name:user?.name||user?.full_name||user?.username||`#${participant.user_id}`,sortOrder:participant.sort_order,cumulativeInvested:invested,recoveryAllocated,recoveryPaid,unrecoveredForAllocation:Math.max(0,invested-recoveryAllocated),cashUnrecovered:Math.max(0,invested-recoveryPaid),recoveryRate:invested>0?recoveryPaid/invested:null,pureProfitAllocated:profitAllocated,pureProfitPaid:profitPaid,unpaidSettlement:unpaid}});
 const policy=policyResult.data,previewLines=policy?allocateOwnerPool(String((capacityResult.data as Record<string,unknown>)?.recommendedMax??0),(policy.lines??[]).map(line=>({participantId:Number(line.participant_id),rate:String(line.settlement_rate),sortOrder:Number(participants.find(p=>Number(p.id)===Number(line.participant_id))?.sort_order??0)}))):[];
 return{capacity:capacityResult.data,profitCapacity:capacityResult.data,recoveryCapacity:recoveryResult.data,participants,owners,users:userResult.data??[],accounts:accountResult.data??[],settlements:(settlementResult.data??[]).map(row=>({...row,allocations:visibleAllocations.filter(item=>Number(item.settlement_id)===Number(row.id))})),policy,previewLines,closedMonths:(closureResult.data??[]).map(row=>String(row.month).slice(0,7)),settings:settingsResult.data,participantUser:Object.fromEntries(allParticipantUser)};
}
