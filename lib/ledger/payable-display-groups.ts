// Display-only grouping for 장부작성 > 미납금 현황. Nothing here changes a payable's
// real party, amounts or the API/DB totals.
//
// "기타 · 결제 미확인" is a synthetic group of unresolved payment-verification payables
// (marker present AND remaining > 0). Each item keeps its real partyId/supplier.
//
// The monthly payables API already excludes verification payables from party rows and
// totalOutstanding, so normally nothing is moved. If a verification payable ever does
// appear among a party's ordinary payables, it is taken out of that party's displayed
// amount/count so the same payable is never shown twice.
import {
  sumPayableAmounts,
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
} from "./payables.ts";

export type DisplayPartyRow = { partyId: number; closingOutstanding: number; openCount: number };
export type DisplayPayableRow = { id: number; party_id: number; outstandingAmount: number };
export type DisplayVerificationItem = { payableId: number; partyId: number; remainingAmount: number };

export function groupPayablesForDisplay<P extends DisplayPartyRow, V extends DisplayVerificationItem>(
  parties: readonly P[],
  partyPayables: readonly DisplayPayableRow[],
  verificationItems: readonly V[],
) {
  const unresolved = verificationItems.filter((item) => item.remainingAmount > 0);
  const unresolvedIds = new Set(unresolved.map((item) => Number(item.payableId)));
  const overlapByParty = new Map<number, { amount: number[]; count: number }>();
  for (const row of partyPayables) {
    if (!unresolvedIds.has(Number(row.id)) || row.outstandingAmount <= 0) continue;
    const current = overlapByParty.get(Number(row.party_id)) ?? { amount: [], count: 0 };
    current.amount.push(row.outstandingAmount);
    current.count += 1;
    overlapByParty.set(Number(row.party_id), current);
  }
  // Rows are kept (a month row can legitimately show 0 closing with 당월 activity).
  const displayParties = parties.map((party) => {
    const overlap = overlapByParty.get(Number(party.partyId));
    return overlap ? {
      ...party,
      closingOutstanding: Math.max(0, sumPayableAmounts([party.closingOutstanding, ...overlap.amount.map((amount) => -amount)])),
      openCount: Math.max(0, party.openCount - overlap.count),
    } : party;
  });
  const other = unresolved.length
    ? { items: unresolved, count: unresolved.length, amount: sumPayableAmounts(unresolved.map((item) => item.remainingAmount)) }
    : null;
  return { parties: displayParties, other };
}

// 지급 내역 in the party sheet: one line per business date, oldest → newest (same order as
// 선택 일자 결제). The party detail API already returns only confirmed payable_payment rows.
export function groupPaymentsByDate(payments: readonly { business_date: string; amount: number | string }[]) {
  const byDate = new Map<string, (number | string)[]>();
  for (const payment of payments) byDate.set(payment.business_date, [...(byDate.get(payment.business_date) ?? []), payment.amount]);
  return [...byDate]
    .map(([businessDate, amounts]) => ({ businessDate, amount: sumPayableAmounts(amounts) }))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}

// 기타 · 결제 미확인 sheet: items grouped by their real party (display only; partyId is
// never changed). Groups keep first-appearance order; items inside a group are oldest →
// newest by business date, ties keep the incoming order (Array.sort is stable).
export function groupVerificationItemsByParty<V extends DisplayVerificationItem & { businessDate: string; supplierName: string }>(items: readonly V[]) {
  const groups = new Map<number, V[]>();
  for (const item of items) groups.set(Number(item.partyId), [...(groups.get(Number(item.partyId)) ?? []), item]);
  return [...groups].map(([partyId, rows]) => ({
    partyId,
    name: rows[0].supplierName,
    count: rows.length,
    amount: sumPayableAmounts(rows.map((row) => row.remainingAmount)),
    items: [...rows].sort((a, b) => a.businessDate.localeCompare(b.businessDate)),
  }));
}
