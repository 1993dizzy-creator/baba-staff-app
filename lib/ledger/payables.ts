export type OutstandingPayable={id:number;businessDate:string;outstandingAmount:number};
export type PayableAllocation={payableId:number;allocatedAmount:number};
export function buildOldestFirstAllocations(payables:OutstandingPayable[],amount:number){let remaining=amount;const allocations:PayableAllocation[]=[];for(const payable of [...payables].sort((a,b)=>a.businessDate.localeCompare(b.businessDate)||a.id-b.id)){if(remaining<=0)break;const allocatedAmount=Math.min(remaining,payable.outstandingAmount);if(allocatedAmount>0)allocations.push({payableId:payable.id,allocatedAmount});remaining=Math.round((remaining-allocatedAmount)*1000)/1000}return{allocations,unallocatedAmount:remaining}}

// "Paid" portion of a month's recognized expense, computed per originating
// transaction ("root") rather than as a single recognizedTotal-minus-outstanding
// subtraction. This matters because ledger_create_correction_v1 always books its
// correction into a DIFFERENT (open) month than the original's (closed) month —
// the RPC's own guards make it structurally impossible for them to share a
// recognition_month (ledger_month_is_closed_v1 must be true for the original's
// month and ledger_assert_month_open_v1 must hold for the correction's month).
// A plain recognizedTotal-minus-outstanding formula would therefore either leave
// a corrected payable's outstanding stale (understating paid) or, worse, let an
// unrelated downward correction booked into a sparse month drag that month's
// total negative (nothing in "outstanding" there to offset it). Attributing every
// correction back to its root's own family sidesteps both failure modes.
export type PaidExpenseCorrection={amount:number;economicEffectSign:number};
export type PaidExpenseRoot={
  id:number;
  amount:number;
  economicEffectSign:number;
  sourceType:string;
  // Only present for inventory_purchase_reversal rows — used to find and skip
  // the original transaction they superseded (same treatment as lib/ledger/entries.ts).
  correctionOfId:number|null;
  // null = no linked payable at all (immediate payment or expense_recognition).
  payableStatus:string|null;
  allocatedAmount:number;
  // Only confirmed source_type='ledger_correction' children of this root,
  // regardless of which month they were themselves recognized in.
  corrections:readonly PaidExpenseCorrection[];
};
export function computePaidExpenseTotal(roots:readonly PaidExpenseRoot[]){
  // Rebook is append-only: the reversal transaction nets the voided original to
  // zero and the (separately fetched, independently-rooted) rebook transaction
  // carries the current, valid amount/payable. Neither the reversal itself nor
  // the original it voided should count as an independent root here.
  const reversedRootIds=new Set(roots.filter(row=>row.sourceType==="inventory_purchase_reversal"&&row.correctionOfId!=null).map(row=>row.correctionOfId as number));
  let total=0;
  for(const root of roots){
    if(root.sourceType==="ledger_correction"||root.sourceType==="inventory_purchase_reversal")continue;
    if(reversedRootIds.has(root.id))continue;
    const correctionEffect=root.corrections.reduce((sum,correction)=>sum+correction.amount*correction.economicEffectSign,0);
    // A recognized expense's true economic amount can't go negative even after
    // corrections; this floor is per-root (never masks another root's math),
    // unlike clamping the final aggregate total.
    const effectiveRecognized=Math.max(0,root.amount*root.economicEffectSign+correctionEffect);
    const contribution=root.payableStatus==null?effectiveRecognized:Math.min(effectiveRecognized,root.allocatedAmount);
    total+=contribution;
  }
  return total;
}
