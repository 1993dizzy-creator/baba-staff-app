export type CardDifferenceLine = {
  reconciliationId: number;
  businessDate: string;
  allocatedGrossAmount: number | string;
  matchedGrossAmount: number | string;
  differenceAmount: number | string;
};

function milli(value: number | string): bigint {
  const text = String(value);
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(text)) throw new Error("Invalid card amount precision");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const result = BigInt(whole) * BigInt(1000) + BigInt(fraction.padEnd(3, "0"));
  return negative ? -result : result;
}

export function allocateCardDifferenceBySaleMonth(lines: CardDifferenceLine[]): Record<string, number> {
  const groups = new Map<number, CardDifferenceLine[]>();
  for (const line of lines) groups.set(line.reconciliationId, [...(groups.get(line.reconciliationId) ?? []), line]);
  const totals = new Map<string, bigint>();
  for (const group of groups.values()) {
    const gross = milli(group[0].matchedGrossAmount);
    const difference = milli(group[0].differenceAmount);
    if (gross <= BigInt(0) || difference < BigInt(0)) throw new Error("Invalid matched card reconciliation");
    const byMonth = new Map<string, bigint>();
    for (const line of group) {
      if (milli(line.matchedGrossAmount) !== gross || milli(line.differenceAmount) !== difference) throw new Error("Inconsistent card reconciliation");
      const month = line.businessDate.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? BigInt(0)) + milli(line.allocatedGrossAmount));
    }
    if ([...byMonth.values()].reduce((sum, amount) => sum + amount, BigInt(0)) !== gross) throw new Error("Card gross lines do not match reconciliation");
    const shares = [...byMonth].map(([month, amount]) => ({ month, base: difference * amount / gross, remainder: difference * amount % gross }));
    let units = difference - shares.reduce((sum, share) => sum + share.base, BigInt(0));
    shares.sort((a, b) => a.remainder === b.remainder ? a.month.localeCompare(b.month) : a.remainder > b.remainder ? -1 : 1);
    for (const share of shares) {
      if (units > BigInt(0)) { share.base += BigInt(1); units -= BigInt(1); }
      totals.set(share.month, (totals.get(share.month) ?? BigInt(0)) + share.base);
    }
  }
  return Object.fromEntries([...totals].map(([month, amount]) => [month, Number(amount) / 1000]));
}
