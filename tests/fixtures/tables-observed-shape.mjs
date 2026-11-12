// Reconstructed from the Owner's supplied DB findings, NOT an exported raw snapshot.
// Only dates, table names and classification counts are observed facts. Order/receipt IDs,
// exact 1/3 statuses, item names, amounts and reference clocks below are synthetic.
// Preserves anonymous OrderId linkage; contains no customer/employee data or credentials.
import { order } from '../helpers/table-overview-fixture.mjs';

export const observedFacts = {
  current: { checkedAt: '2026-11-12T18:30:54Z', businessDate: '2026-11-12',
    orderCount: 20, status4Count: 20, openCount: 0, lastSuccessAt: '2026-11-12T18:27:19Z', lastErrorCode: null, consecutiveFailures: 0 },
  historical: { businessDate: '2026-11-10', tableNames: ['1','2','4','11','16','18','BAR4','BAR6'],
    menuDetailsPresent: 8, paidReceiptLinks: 7, paidReceiptUnconfirmedTable: 'BAR6' },
};

/** Counterfactual replay shape. Never evidence of physical occupancy at the reference clock. */
export function replayOrders({ businessDate, at, status = 1 }) {
  return observedFacts.historical.tableNames.map((tableName,i) => order(`anonymous-order-${i+1}`,tableName,{
    businessDate, orderDate: at, providerObservedAt: at, status, raw: {},
  }));
}

/** Seven anonymous paid links; absence of BAR6 evidence is not proof of being unpaid/occupied. */
export function replayPaidLinks(businessDate) {
  return observedFacts.historical.tableNames.flatMap((tableName,i) => tableName === 'BAR6' ? [] : [{
    orderId: `anonymous-order-${i+1}`, receiptId: 500+i, paymentStatus: 3, isCanceled: false, businessDate,
  }]);
}
