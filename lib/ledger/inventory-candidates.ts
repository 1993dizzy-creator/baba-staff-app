import "server-only";

import { createHash } from "node:crypto";
import { calculateInventoryPurchaseAmount } from "@/lib/inventory/purchase-cost";
import { normalizeInventoryReason } from "@/lib/inventory/reasons";
import { supabaseServer } from "@/lib/supabase/server";

export const LEDGER_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type InventoryLog = {
  id: number; item_id: number | null; item_name: string | null; item_name_vi: string | null;
  category: string | null; category_vi: string | null; change_quantity: number | string | null;
  new_purchase_price: number | string | null; new_supplier: string | null; business_date: string | null;
  created_at: string | null; source: string | null; reason: string | null;
};

function monthEnd(month: string) {
  const [year, value] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(year, value, 0)).getUTCDate()).padStart(2, "0")}`;
}

export async function loadInventoryCandidateSource(month: string) {
  const logs: InventoryLog[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseServer.from("inventory_logs")
      .select("id,item_id,item_name,item_name_vi,category,category_vi,change_quantity,new_purchase_price,new_supplier,business_date,created_at,source,reason")
      .gte("business_date", `${month}-01`).lte("business_date", monthEnd(month))
      .order("business_date").order("id").range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as InventoryLog[];
    logs.push(...page);
    if (page.length < pageSize) break;
  }

  const rows: Array<Record<string, unknown>> = [];
  let ignoredCount = 0;
  for (const log of logs) {
    const quantity = Number(log.change_quantity);
    const amount = calculateInventoryPurchaseAmount(quantity, log.new_purchase_price);
    if (normalizeInventoryReason(log.reason) !== "purchase" || quantity <= 0 || amount === null || !log.business_date) {
      ignoredCount += 1;
      continue;
    }
    const snapshot = {
      inventory_log_id: log.id,
      item_id: log.item_id,
      item_name: log.item_name || log.item_name_vi || "-",
      category: log.category,
      category_vi: log.category_vi,
      change_quantity: quantity,
      purchase_price: Number(log.new_purchase_price),
      purchase_amount: amount,
      supplier: log.new_supplier?.trim() || null,
      business_date: log.business_date,
      inventory_log_created_at: log.created_at,
      source: log.source,
      reason: log.reason,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    rows.push({ sourceKey: `inventory-log:${log.id}`, businessDate: log.business_date, amount, snapshot, fingerprint });
  }
  return { rows, scannedLogs: logs.length, ignoredCount };
}
