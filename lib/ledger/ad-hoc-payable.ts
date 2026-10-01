// @ts-expect-error Node tests require the explicit TypeScript extension.
import { planPartialPayablePayment } from "./partial-payable-payment.ts";
import type { OutstandingPayable } from "./payables";

export const AD_HOC_PAYABLE_PARTY_MARKER = "system:ad_hoc_payable";
export type AdHocPayableParty = { ledgerPartyId: number; name: string };

export function isAdHocPayableParty(party: { memo?: unknown } | null | undefined) {
  return party?.memo === AD_HOC_PAYABLE_PARTY_MARKER;
}

// The existing allocation planner only sees explicitly selected individual items.
export function planSelectedAdHocPayment(rows: readonly OutstandingPayable[], selectedIds: ReadonlySet<number>, amount: number) {
  return planPartialPayablePayment(rows.filter((row) => selectedIds.has(row.id)), amount);
}
