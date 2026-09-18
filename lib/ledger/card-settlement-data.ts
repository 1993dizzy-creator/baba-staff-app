import { supabaseServer } from "@/lib/supabase/server";
import type { CardAllocationLine } from "@/lib/ledger/card-settlements";

export async function loadCardRows<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw error;
    rows.push(...data ?? []);
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

export function loadCardSales(start?: string, end?: string) {
  return loadCardRows((from, to) => {
    let query = supabaseServer.from("ledger_transactions").select("id,business_date,amount,source_key,memo")
      .eq("status", "confirmed").eq("source_type", "pos_sales_daily_payment").like("source_key", "pos:%:card");
    if (start && end) query = query.gte("business_date", start).lt("business_date", end);
    return query.order("business_date").order("id").range(from, to);
  });
}

export async function loadCardAllocationLines(saleIds?: readonly number[]): Promise<CardAllocationLine[]> {
  const chunks = saleIds === undefined ? [null] : Array.from({ length: Math.ceil(saleIds.length / 200) }, (_, i) => saleIds.slice(i * 200, i * 200 + 200));
  const rows: CardAllocationLine[] = [];
  for (const ids of chunks) {
    const lines = await loadCardRows((from, to) => {
      let query = supabaseServer.from("ledger_card_reconciliation_lines")
        .select("id,reconciliation_id,pos_card_transaction_id,allocated_gross_amount,reconciliation:ledger_card_reconciliations!inner(status,deposit_date)")
        .neq("reconciliation.status", "cancelled");
      if (ids) query = query.in("pos_card_transaction_id", ids);
      return query.order("id").range(from, to);
    });
    rows.push(...lines as unknown as CardAllocationLine[]);
  }
  return rows;
}
