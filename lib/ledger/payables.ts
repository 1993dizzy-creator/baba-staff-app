export type OutstandingPayable={id:number;businessDate:string;outstandingAmount:number};
export function payableMonthBounds(month:string){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error("INVALID_MONTH");
  const [year,value]=month.split("-").map(Number);
  return {monthStart:`${month}-01`,nextMonthStart:`${String(value===12?year+1:year).padStart(4,"0")}-${String(value===12?1:value+1).padStart(2,"0")}-01`};
}

// DB numeric(16,3): accumulate integer thousandths, including above Number's
// safe integer range. Convert only the final API values to numbers.
function amountUnits(value:number|string):bigint{
  const [whole,fraction=""]=String(value).split(".");
  return BigInt(whole)*BigInt(1000)+BigInt(fraction.padEnd(3,"0").slice(0,3))*(whole.startsWith("-")?BigInt(-1):BigInt(1));
}
const amountValue=(units:bigint)=>Number(units)/1000;
export const sumPayableAmounts=(values:readonly (number|string)[])=>amountValue(values.reduce<bigint>((sum,value)=>sum+amountUnits(value),BigInt(0)));
export type PayableBalanceSource={id:number;party_id:number;original_amount:number|string;status:string;expense:{business_date:string;status:string}|null};
export type DatedPayableAllocation={payable_id:number;allocated_amount:number|string;payment:{business_date:string;status:string}|null};
export type PayablePeriodSummary={openingOutstanding:number;periodPurchases:number;periodPayments:number;closingOutstanding:number};
export function calculatePayableBalances<T extends PayableBalanceSource>(sources:readonly T[],allocations:readonly DatedPayableAllocation[],month?:string){
  const bounds=month===undefined?null:payableMonthBounds(month);
  const byPayable=new Map<number,DatedPayableAllocation[]>();
  for(const allocation of allocations){
    if(allocation.payment?.status!=="confirmed")continue;
    const items=byPayable.get(allocation.payable_id)??[];items.push(allocation);byPayable.set(allocation.payable_id,items);
  }
  let opening=BigInt(0),purchases=BigInt(0),payments=BigInt(0),closing=BigInt(0);
  const partyTotals=new Map<number,{opening:bigint;purchases:bigint;payments:bigint;closing:bigint}>();
  const payables:Array<T & {allocatedAmount:number;outstandingAmount:number}>=[];
  for(const source of sources){
    if(source.status==="cancelled"||source.expense?.status!=="confirmed")continue;
    const date=source.expense.business_date;
    if(bounds&&date>=bounds.nextMonthStart)continue;
    const original=amountUnits(source.original_amount);
    let before=BigInt(0),through=BigInt(0),inPeriod=BigInt(0);
    for(const allocation of byPayable.get(source.id)??[]){
      const paymentDate=allocation.payment!.business_date,amount=amountUnits(allocation.allocated_amount);
      if(!bounds||paymentDate<bounds.nextMonthStart)through+=amount;
      if(bounds&&paymentDate<bounds.monthStart)before+=amount;
      if(bounds&&paymentDate>=bounds.monthStart&&paymentDate<bounds.nextMonthStart)inPeriod+=amount;
    }
    const outstanding=original>through?original-through:BigInt(0);
    closing+=outstanding;
    if(bounds){
      const party=partyTotals.get(Number(source.party_id))??{opening:BigInt(0),purchases:BigInt(0),payments:BigInt(0),closing:BigInt(0)};
      if(date<bounds.monthStart){const balance=original>before?original-before:BigInt(0);opening+=balance;party.opening+=balance}
      else {purchases+=original;party.purchases+=original}
      payments+=inPeriod;
      party.payments+=inPeriod;party.closing+=outstanding;
      partyTotals.set(Number(source.party_id),party);
    }
    if(outstanding>BigInt(0))payables.push({...source,allocatedAmount:amountValue(through),outstandingAmount:amountValue(outstanding)});
  }
  const partySummaries=[...partyTotals].filter(([,row])=>row.opening>BigInt(0)||row.purchases>BigInt(0)||row.payments>BigInt(0)||row.closing>BigInt(0)).map(([partyId,row])=>({partyId,openingOutstanding:amountValue(row.opening),periodPurchases:amountValue(row.purchases),periodPayments:amountValue(row.payments),closingOutstanding:amountValue(row.closing)}));
  return {payables,totalOutstanding:amountValue(closing),...(bounds?{summary:{openingOutstanding:amountValue(opening),periodPurchases:amountValue(purchases),periodPayments:amountValue(payments),closingOutstanding:amountValue(closing)},partySummaries}:{})};
}
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
  // Links an append-only reversal or rebook to an earlier transaction.
  // Negative-sign children offset that transaction; positive rebooks remain roots.
  correctionOfId:number|null;
  // null = no linked payable at all (immediate payment or expense_recognition).
  payableStatus:string|null;
  allocatedAmount:number;
  // Only confirmed source_type='ledger_correction' children of this root,
  // regardless of which month they were themselves recognized in.
  corrections:readonly PaidExpenseCorrection[];
};
export function computePaidExpenseTotal(roots:readonly PaidExpenseRoot[]){
  // Apply each append-only reversal to its referenced transaction exactly once.
  // A positive-sign rebook is a separate valid root, even when it has a link.
  const reversalEffectByRoot=new Map<number,number>();
  for(const row of roots){
    if(row.sourceType==="ledger_correction"||row.correctionOfId==null||row.economicEffectSign>=0)continue;
    reversalEffectByRoot.set(row.correctionOfId,(reversalEffectByRoot.get(row.correctionOfId)??0)+row.amount*row.economicEffectSign);
  }
  let total=0;
  for(const root of roots){
    if(root.sourceType==="ledger_correction"||(root.correctionOfId!=null&&root.economicEffectSign<0))continue;
    const correctionEffect=root.corrections.reduce((sum,correction)=>sum+correction.amount*correction.economicEffectSign,0);
    // A recognized expense's true economic amount can't go negative even after
    // corrections; this floor is per-root (never masks another root's math),
    // unlike clamping the final aggregate total.
    const effectiveRecognized=Math.max(0,root.amount*root.economicEffectSign+correctionEffect+(reversalEffectByRoot.get(root.id)??0));
    const contribution=root.payableStatus==null?effectiveRecognized:Math.min(effectiveRecognized,root.allocatedAmount);
    total+=contribution;
  }
  return total;
}
