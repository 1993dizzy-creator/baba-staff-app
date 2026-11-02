import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { classifyObservationHistory, type DeductionEvidence } from "./inventory-shadow-observation-policy";

export async function receiptObservationPolicy(receiptId: number) {
  try {
  // At the Data API row cap, fail closed instead of claiming a complete history.
  const { data, error } = await supabaseServer.from("pos_inventory_deductions")
    .select("id,operation_type,status,applied_at,inventory_log_id,reversal_of_deduction_id,batch_receipt_id")
    .eq("receipt_id", receiptId).order("id").limit(1000);
  if (error || !Array.isArray(data) || data.length >= 1000) return classifyObservationHistory([], {}, true);
  const rows = data as DeductionEvidence[];
  const ids = [...new Set(rows.filter(d => d.operation_type === "revert").map(d => d.batch_receipt_id).filter(id => id !== null))];
  const workflows: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const result = await supabaseServer.from("pos_inventory_deduction_receipts").select("id,workflow_type").in("id", ids.slice(i, i + 100));
    if (result.error || !Array.isArray(result.data)) return classifyObservationHistory(rows, workflows, true);
    for (const row of result.data) workflows[String(row.id)] = row.workflow_type;
  }
  return classifyObservationHistory(rows, workflows);
  } catch {
    return classifyObservationHistory([], {}, true);
  }
}
