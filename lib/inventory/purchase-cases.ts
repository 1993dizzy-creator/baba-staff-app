import type { PurchaseRepairPreview } from "./purchase-repair-contract";

export type PurchaseCaseLog = {
  id: number; item_id: number; item_name: string | null; item_name_vi?: string | null;
  correction_of_inventory_log_id: number | null; business_date: string; created_at: string;
  reason: string; source?: string; change_quantity: number; new_purchase_price: number | null;
  new_supplier: string | null; purchase_supplier_partner_id?: number | null; unit?: string | null;
  actor_name?: string | null; actor_username?: string | null;
};
export type PurchaseCaseIssue = {
  inventoryLogId: number; status: string; code: string; itemName: string; itemNameVi?: string | null;
  supplier?: string | null; businessDate: string; quantityDelta: number; amountDelta: number;
  itemId?: number; createdAt?: string; originalQuantity: number | null; resolution?: PurchaseRepairPreview;
};
export type PurchaseCaseEvent = {
  id: string; kind: "purchase" | "correction" | "stock_check" | "ledger";
  logId?: number; actor: string | null; occurredAt: string; quantityDelta?: number;
  amount?: number | null; action?: string; transactionId?: number | null;
  beforeAmount?: number | null; reversalTransactionId?: number | null; payableCancelled?: boolean;
};
export type PurchaseCase = PurchaseCaseIssue & {
  rootInventoryLogId: number | null; relatedLogIds: number[]; effectiveQuantity: number | null;
  correctionBusinessDate: string;
  unit: string | null; ledgerAmount: number | null; finalStatus: "review_required" | "failed";
  timeline: PurchaseCaseEvent[];
  receiptEvidence?: {
    booked: { quantity: number | null; price: number | null; amount: number | null; supplier: string | null };
    current: { quantity: number | null; price: number | null; supplier: string | null };
    candidateStatus: string | null; transactionStatus: string | null;
  };
};
export type PurchaseCaseCandidate = {
  id: number; source_key: string; status: string; dismissal_reason?: string | null;
  resolved_transaction_id: number | null; proposed_amount: number;
  source_snapshot: Record<string, unknown> | null;
};
export type PurchaseCaseTransaction = { id: number; amount: number; status: string };
export type PurchaseCaseAudit = {
  id: number; entity_type: string; entity_id: number; action: string; created_at: string;
  actor_user_id: number | null; after_snapshot: Record<string, unknown> | null;
  before_snapshot?: Record<string, unknown> | null;
};

const byTime = (a: {created_at: string; id: number}, b: {created_at: string; id: number}) =>
  Date.parse(a.created_at) - Date.parse(b.created_at) || Number(a.id) - Number(b.id);
const finite = (value: unknown): number | null => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const equal = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.000001;
const normalized = (value: unknown) => String(value ?? "").trim().toLowerCase();

// Explicit root IDs establish identity. Names, stock checks and independent
// positive receipts never establish a correction link or affect receipt totals.
export function buildPurchaseCases({ issues, logs, candidates = [], transactions = [], audits = [], actors = new Map() }: {
  issues: PurchaseCaseIssue[]; logs: PurchaseCaseLog[]; candidates?: PurchaseCaseCandidate[];
  transactions?: PurchaseCaseTransaction[]; audits?: PurchaseCaseAudit[]; actors?: Map<number, string>;
}): PurchaseCase[] {
  const logMap = new Map(logs.map(log => [Number(log.id), log]));
  const groups = new Map<string, {root: PurchaseCaseLog | null; issues: PurchaseCaseIssue[]}>();
  for (const issue of issues) {
    const log = logMap.get(issue.inventoryLogId);
    const candidateRoot = log && logMap.get(Number(log.correction_of_inventory_log_id ?? log.id));
    const root = candidateRoot && candidateRoot.reason === "purchase" && Number(candidateRoot.change_quantity) > 0
      && candidateRoot.correction_of_inventory_log_id == null && candidateRoot.item_id === log?.item_id ? candidateRoot : null;
    const key = root ? `${root.item_id}:${root.id}` : `unlinked:${issue.inventoryLogId}`;
    const group = groups.get(key) ?? {root, issues: []};
    group.issues.push(issue); groups.set(key, group);
  }
  const output: PurchaseCase[] = [];
  for (const {root, issues: members} of groups.values()) {
    // Keep an actionable correction as the resolve target, independent of the
    // original receipt ID used for grouping and display.
    const issue = [...members].sort((a,b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.inventoryLogId-a.inventoryLogId)[0];
    const family = root ? logs.filter(log => log.item_id === root.item_id &&
      (log.id === root.id || (log.reason === "purchase" && log.correction_of_inventory_log_id === root.id))).sort((a,b)=>a.id-b.id)
      : [logMap.get(issue.inventoryLogId)].filter((log): log is PurchaseCaseLog => !!log);
    const latest = family.at(-1);
    const effective = root && family.every(log=>finite(log.change_quantity)!==null)
      ? family.reduce((total,log)=>total+Number(log.change_quantity),0) : null;
    const price = finite(latest?.new_purchase_price);
    const candidate = root ? candidates.filter(row=>row.source_key===`inventory-log:${root.id}`).sort((a,b)=>b.id-a.id)[0] : undefined;
    const transaction = transactions.find(row=>Number(row.id)===Number(candidate?.resolved_transaction_id));
    const snapshot = candidate?.source_snapshot;
    const coveredIds = Array.isArray(snapshot?.inventory_correction_log_ids) ? snapshot.inventory_correction_log_ids.map(Number) : [];
    const supplierMatches = !!latest && !!normalized(latest.new_supplier) && normalized(snapshot?.supplier)===normalized(latest.new_supplier)
      && (snapshot?.purchase_supplier_partner_id == null || Number(snapshot.purchase_supplier_partner_id)===Number(latest.purchase_supplier_partner_id));
    const booked = effective !== null && price !== null && snapshot && supplierMatches
      && equal(finite(snapshot.change_quantity),effective) && equal(finite(snapshot.purchase_price),price)
      && equal(finite(snapshot.purchase_amount),Number((effective*price).toFixed(3)))
      && family.filter(log=>log.id!==root?.id).every(log=>coveredIds.includes(log.id));
    const completed = booked && ((candidate?.status === "dismissed" && candidate.dismissal_reason === "Inventory purchase fully cancelled" && equal(effective,0))
      || (candidate?.status === "confirmed" && transaction?.status === "confirmed"
        && equal(finite(transaction.amount),finite(candidate.proposed_amount)) && equal(finite(transaction.amount),finite(snapshot?.purchase_amount))));
    if (completed) continue;
    const timeline: PurchaseCaseEvent[] = family.map(log=>({id:`inventory:${log.id}`,logId:log.id,
      kind:log.id===root?.id ? "purchase" : "correction", actor:log.actor_name || log.actor_username || null,
      occurredAt:log.created_at,quantityDelta:Number(log.change_quantity)}));
    if (root) {
      const hasPreviousReceipt = logs.some(log=>log.item_id===root.item_id && log.reason==='purchase'
        && log.correction_of_inventory_log_id==null && Number(log.change_quantity)>0 && byTime(log,root)<0 && log.business_date===root.business_date);
      const nextReceipt = logs.filter(log=>log.item_id===root.item_id && log.reason==='purchase'
        && log.correction_of_inventory_log_id==null && Number(log.change_quantity)>0 && byTime(log,root)>0).sort(byTime)[0];
      for (const log of logs.filter(log=>log.item_id===root.item_id && log.reason==='stock_check' && (!hasPreviousReceipt || byTime(log,root)>0)
        && (!nextReceipt || byTime(log,nextReceipt)<0) && log.business_date===root.business_date)) {
        timeline.push({id:`inventory:${log.id}`,logId:log.id,kind:'stock_check',actor:log.actor_name || log.actor_username || null,
          occurredAt:log.created_at,quantityDelta:Number(log.change_quantity)});
      }
    }
    const familyIds = family.map(log=>log.id);
    for (const audit of audits) {
      const after = audit.after_snapshot;
      const auditCandidate = after?.candidate as Record<string, unknown> | undefined;
      const auditSource = after?.sourceSnapshot as Record<string, unknown> | undefined;
      const transactionRelated = audit.entity_type==='transaction' && (auditCandidate?.source_key===`inventory-log:${root?.id}`
        || Number(auditSource?.inventory_log_id)===root?.id || audit.entity_id===transaction?.id);
      const candidateRelated = audit.entity_type==='candidate' && Number(audit.entity_id)===Number(candidate?.id);
      if ((audit.entity_type==='inventory_log' && familyIds.includes(Number(audit.entity_id))) || transactionRelated || candidateRelated) {
        timeline.push({id:`ledger:${audit.id}`,kind:'ledger',occurredAt:audit.created_at,actor:actors.get(Number(audit.actor_user_id)) || null,
          action:audit.action,amount:finite(after?.amount ?? after?.finalAmount ?? (after?.preview as Record<string,unknown> | undefined)?.newAmount),
          beforeAmount:finite((audit.before_snapshot?.transaction as Record<string,unknown> | undefined)?.amount
            ?? (after?.preview as Record<string,unknown> | undefined)?.oldAmount),
          reversalTransactionId:finite(after?.reversalTransactionId),payableCancelled:audit.action==='inventory_source_rebooked' && !!audit.before_snapshot?.payable,
          transactionId:finite(after?.rebookTransactionId ?? after?.reversalTransactionId ?? after?.transactionId)});
      }
    }
    timeline.sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt) || a.id.localeCompare(b.id,undefined,{numeric:true}));
    output.push({...issue,rootInventoryLogId:root?.id ?? null,relatedLogIds:familyIds,
      correctionBusinessDate:issue.businessDate,
      itemName:root?.item_name || issue.itemName,itemNameVi:root?.item_name_vi || issue.itemNameVi,
      businessDate:root?.business_date || issue.businessDate,originalQuantity:root ? Number(root.change_quantity) : issue.originalQuantity,
      effectiveQuantity:effective,quantityDelta:root && effective!==null ? effective-Number(root.change_quantity) : issue.quantityDelta,
      unit:root?.unit || latest?.unit || null,ledgerAmount:finite(transaction?.amount),
      finalStatus:members.some(row=>row.status==='failed') ? 'failed' : 'review_required',timeline,
      receiptEvidence: {
        booked: {quantity:finite(snapshot?.change_quantity),price:finite(snapshot?.purchase_price),amount:finite(transaction?.amount),supplier:typeof snapshot?.supplier==='string'?snapshot.supplier:null},
        current: {quantity:effective,price,supplier:latest?.new_supplier ?? null},
        candidateStatus:candidate?.status ?? null,transactionStatus:transaction?.status ?? null,
      }});
  }
  return output;
}
