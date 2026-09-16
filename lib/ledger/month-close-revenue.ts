type Sale = {
  type: string;
  source_type: string;
  source_key: string | null;
  amount: number | string;
  economic_effect_sign: number;
};

export function calculateMonthCloseRevenue(rows: Sale[]) {
  const buckets = { cash: 0, transfer: 0, card: 0, other: 0 };
  let total = 0;
  for (const row of rows) {
    if (row.type !== "sales") continue;
    const effect = Number(row.amount) * Number(row.economic_effect_sign ?? 1);
    total += effect;
    if (row.source_type !== "pos_sales_daily_payment") continue;
    const bucket = row.source_key?.split(":").at(-1) as keyof typeof buckets;
    if (bucket in buckets) buckets[bucket] += effect;
  }
  const base = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  return { ...buckets, adjustment: total - base, total };
}
