import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loadInventoryRepairPreview } from "./inventory-repair";
import { canReviewPurchaseCorrection } from "@/lib/inventory/purchase-repair-contract";
import { buildPurchaseCases, type PurchaseCaseLog, type PurchaseCaseIssue, type PurchaseCaseCandidate,
  type PurchaseCaseTransaction, type PurchaseCaseAudit } from "@/lib/inventory/purchase-cases";

const logColumns = "id,item_id,item_name,item_name_vi,correction_of_inventory_log_id,business_date,created_at,reason,source,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,unit,actor_name,actor_username";

export async function loadPurchaseCases(start: string, end: string, actorUserId: number) {
  const issues: PurchaseCaseIssue[] = [];
  const logs = new Map<number, PurchaseCaseLog>();
  // Pagination must finish before aggregation, otherwise one receipt can appear
  // on multiple pages or be falsely marked complete with missing corrections.
  for (let from=0; ; from+=1000) {
    const {data,error} = await supabaseServer.from("ledger_inventory_projection_status")
      .select(`inventory_log_id,status,code,source:inventory_logs!inner(${logColumns})`)
      .or("status.in.(failed,review_required),and(status.eq.synced,code.eq.NOT_A_PURCHASE)")
      .gte("source.business_date",start).lt("source.business_date",end)
      .order("inventory_log_id").range(from,from+999);
    if (error) throw error;
    for (const row of data ?? []) {
      const source = (Array.isArray(row.source) ? row.source[0] : row.source) as unknown as PurchaseCaseLog;
      if (!source || (row.status==="synced" && !(source.reason==="purchase" && source.source==="quick_save" && Number(source.change_quantity)<0 && source.correction_of_inventory_log_id==null))) continue;
      logs.set(Number(row.inventory_log_id),{...source,id:Number(row.inventory_log_id)});
      const delta=Number(source.change_quantity ?? 0);
      issues.push({inventoryLogId:Number(row.inventory_log_id),status:row.status==="synced"?"review_required":row.status,
        code:row.status==="synced"?"PURCHASE_CORRECTION_REFERENCE_REQUIRED":row.code,
        itemName:source.item_name || source.item_name_vi || "-",itemNameVi:source.item_name_vi,
        itemId:Number(source.item_id),supplier:source.new_supplier?.trim() || null,businessDate:source.business_date,
        createdAt:source.created_at,quantityDelta:delta,amountDelta:delta*Number(source.new_purchase_price ?? 0),originalQuantity:null});
    }
    if ((data?.length ?? 0)<1000) break;
  }
  if (!issues.length) return [];
  const roots=[...new Set([...logs.values()].map(log=>Number(log.correction_of_inventory_log_id ?? log.id)))];
  const candidates: PurchaseCaseCandidate[]=[];
  const transactions: PurchaseCaseTransaction[]=[];
  const audits: PurchaseCaseAudit[]=[];
  for (let offset=0;offset<roots.length;offset+=200) {
    const ids=roots.slice(offset,offset+200);
    // Root lookup is explicit even when its business date is outside the month.
    const {data,error}=await supabaseServer.from("inventory_logs").select(logColumns).in("id",ids);
    if(error) throw error;
    for(const log of data ?? []) logs.set(Number(log.id),log as unknown as PurchaseCaseLog);
    for(let from=0; ;from+=1000){
      const result=await supabaseServer.from("inventory_logs").select(logColumns).in("correction_of_inventory_log_id",ids).order("id").range(from,from+999);
      if(result.error) throw result.error;
      for(const log of result.data ?? []) logs.set(Number(log.id),log as unknown as PurchaseCaseLog);
      if((result.data?.length ?? 0)<1000)break;
    }
    for(let from=0; ;from+=1000){
      const result=await supabaseServer.from("ledger_candidates")
        .select("id,source_key,status,dismissal_reason,resolved_transaction_id,proposed_amount,source_snapshot")
        .eq("source_type","inventory_purchase_log").in("source_key",ids.map(id=>`inventory-log:${id}`)).order("id").range(from,from+999);
      if(result.error)throw result.error;
      candidates.push(...(result.data ?? []) as PurchaseCaseCandidate[]);
      if((result.data?.length ?? 0)<1000)break;
    }
  }
  // Same-item/day stock checks are chronology context only, never receipt members.
  const itemIds=[...new Set([...logs.values()].map(log=>Number(log.item_id)))];
  const dates=[...new Set([...logs.values()].map(log=>log.business_date))];
  for(let offset=0;offset<itemIds.length;offset+=200){
    for(let dateOffset=0;dateOffset<dates.length;dateOffset+=100){
      for(let from=0; ;from+=1000){
        const result=await supabaseServer.from("inventory_logs").select(logColumns).in("item_id",itemIds.slice(offset,offset+200))
          .in("business_date",dates.slice(dateOffset,dateOffset+100)).in("reason",["stock_check","purchase"]).order("id").range(from,from+999);
        if(result.error)throw result.error;
        for(const log of result.data ?? [])logs.set(Number(log.id),log as unknown as PurchaseCaseLog);
        if((result.data?.length ?? 0)<1000)break;
      }
    }
  }
  // Indexed audit entity lookups; no month-wide audit scan or per-log fetch loop.
  const readAudits=async(type:string,ids:number[])=>{
    for(let offset=0;offset<ids.length;offset+=200)for(let from=0; ;from+=1000){
      const result=await supabaseServer.from("ledger_audit_logs").select("id,entity_type,entity_id,action,created_at,actor_user_id,before_snapshot,after_snapshot")
        .eq("entity_type",type).in("entity_id",ids.slice(offset,offset+200)).order("id").range(from,from+999);
      if(result.error)throw result.error;
      audits.push(...(result.data ?? []) as PurchaseCaseAudit[]);
      if((result.data?.length ?? 0)<1000)break;
    }
  };
  await readAudits("inventory_log",[...logs.keys()]);
  await readAudits("candidate",candidates.map(row=>Number(row.id)));
  const transactionIds=new Set(candidates.map(row=>Number(row.resolved_transaction_id)).filter(id=>id>0));
  for(const audit of audits){
    const after=audit.after_snapshot;
    const beforeCandidate=audit.before_snapshot?.candidate as Record<string,unknown> | undefined;
    for(const value of [after?.transactionId,(after?.projection as Record<string,unknown> | undefined)?.transactionId,beforeCandidate?.resolved_transaction_id]){
      if(Number(value)>0)transactionIds.add(Number(value));
    }
  }
  // Follow only explicit transaction correction IDs to include reversals and
  // rebooks from earlier steps, including a cancellation with no replacement.
  let frontier=[...transactionIds];
  while(frontier.length){
    const next:number[]=[];
    for(let offset=0;offset<frontier.length;offset+=200)for(let from=0; ;from+=1000){
      const result=await supabaseServer.from("ledger_transactions").select("id,amount,status")
        .in("correction_of_id",frontier.slice(offset,offset+200)).order("id").range(from,from+999);
      if(result.error)throw result.error;
      for(const row of result.data ?? [])if(!transactionIds.has(Number(row.id))){transactionIds.add(Number(row.id));next.push(Number(row.id));}
      if((result.data?.length ?? 0)<1000)break;
    }
    frontier=next;
  }
  const txIds=[...transactionIds];
  for(let offset=0;offset<txIds.length;offset+=200){
    const result=await supabaseServer.from("ledger_transactions").select("id,amount,status").in("id",txIds.slice(offset,offset+200));
    if(result.error)throw result.error;
    transactions.push(...(result.data ?? []) as PurchaseCaseTransaction[]);
  }
  await readAudits("transaction",txIds);
  const actors=new Map<number,string>();
  const actorIds=[...new Set(audits.map(row=>Number(row.actor_user_id)).filter(id=>id>0))];
  for(let offset=0;offset<actorIds.length;offset+=200){
    const result=await supabaseServer.from("users").select("id,name,username").in("id",actorIds.slice(offset,offset+200));
    if(result.error)throw result.error;
    for(const actor of result.data ?? [])actors.set(Number(actor.id),actor.name || actor.username || `#${actor.id}`);
  }
  const cases=buildPurchaseCases({issues,logs:[...logs.values()],candidates,transactions,audits,actors});
  for(let offset=0;offset<cases.length;offset+=10){
    await Promise.all(cases.slice(offset,offset+10).map(async issue=>{
      if(!canReviewPurchaseCorrection(issue.code))return;
      // Advisory preview never hides a warning on failure. POST revalidates locks.
      try {issue.resolution=await loadInventoryRepairPreview(issue.inventoryLogId,actorUserId);}
      catch {issue.resolution={candidates:[],recommended:false};}
    }));
  }
  return cases;
}
