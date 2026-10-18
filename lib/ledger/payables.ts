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
export type PayableBalanceSource={id:number;party_id:number;original_amount:number|string;status:string;expense:{id?:number|string;business_date:string;status:string}|null};
export type PayablePayment={id?:number|string;type?:string;source_type?:string;source_key?:string|null;source_snapshot?:Record<string,unknown>|null;amount?:number|string;economic_effect_sign?:number|string;memo?:string|null;business_date:string;status:string;movements?:readonly {amount?:number|string;fund_account?:{id?:number|string;code?:string|null;display_name?:string|null}|null}[]};
export type DatedPayableAllocation={payable_id:number;allocated_amount:number|string;payment?:PayablePayment|null};
export type SettlementContext={payableId?:number|string;transactionId?:number|string};
export type PurchaseSettlement={originalAmount:number;adjustmentAmount:number;effectiveAmount:number;cashPaidAmount:number;remainingAmount:number;status:"unpaid"|"partial"|"paid";adjustments:{transactionId:number;businessDate:string;amount:number;reason:string;sourceKey:string;sourceSnapshot:Record<string,unknown>}[];payments:{transactionId:number|null;businessDate:string;amount:number}[]};
type SettlementAllocation={payable_id?:number|string;allocated_amount:number|string;payment?:PayablePayment|null};

// Existing writeoffs already credit ledger_payable_allocations. Recognize only
// the explicit, internally consistent noncash contract; never infer from size,
// memo, a rounded amount, a date cutoff, or the paid flag.
export function isPayableNonCashAdjustment(allocation:SettlementAllocation,originalAmount:number|string,context:SettlementContext={}){
  const p=allocation.payment,s=p?.source_snapshot;
  return p?.status==="confirmed"&&p.type==="expense"&&p.source_type==="ledger_correction"&&Number(p.economic_effect_sign)===-1
    &&s?.adjustmentType==="payable_small_difference_writeoff"&&s.nonCash===true&&s.cashMovementAmount===0
    &&Number(s.payableId)>0&&Number(s.originalTransactionId)>0
    &&p.source_key===`payable-small-diff:${p.business_date.slice(0,7)}:${s.payableId}`
    &&Number(s.originalAmount)===Number(originalAmount)&&Number(s.writeoffAmount)>0
    &&Number(s.writeoffAmount)===Number(p.amount)&&Number(p.amount)===Number(allocation.allocated_amount)
    &&(allocation.payable_id==null||Number(allocation.payable_id)===Number(s.payableId))
    &&(context.payableId==null||Number(context.payableId)===Number(s.payableId))
    &&(context.transactionId==null||Number(context.transactionId)===Number(s.originalTransactionId))
    &&Array.isArray(p.movements)&&p.movements.every(m=>Number(m.amount)===0);
}
export function calculatePurchaseSettlement(originalAmount:number|string,allocations:readonly SettlementAllocation[],context:SettlementContext={}):PurchaseSettlement{
  const confirmed=allocations.filter(a=>a.payment?.status==="confirmed");
  const noncash=confirmed.filter(a=>isPayableNonCashAdjustment(a,originalAmount,context));
  const adjustmentUnits=noncash.reduce((total,a)=>total-amountUnits(a.allocated_amount),BigInt(0));
  const cashUnits=confirmed.filter(a=>!noncash.includes(a)).reduce((total,a)=>total+amountUnits(a.allocated_amount),BigInt(0));
  const effectiveUnits=amountUnits(originalAmount)+adjustmentUnits;
  const remainingUnits=effectiveUnits>cashUnits?effectiveUnits-cashUnits:BigInt(0);
  const adjustmentAmount=amountValue(adjustmentUnits),cashPaidAmount=amountValue(cashUnits),effectiveAmount=amountValue(effectiveUnits),remainingAmount=amountValue(remainingUnits);
  return {originalAmount:Number(originalAmount),adjustmentAmount,effectiveAmount,cashPaidAmount,remainingAmount,
    status:remainingAmount===0?"paid":cashPaidAmount>0?"partial":"unpaid",
    adjustments:noncash.map(a=>({transactionId:Number(a.payment!.id),businessDate:a.payment!.business_date,amount:-Number(a.allocated_amount),reason:a.payment!.memo||"",sourceKey:a.payment!.source_key!,sourceSnapshot:a.payment!.source_snapshot!})),
    payments:confirmed.filter(a=>!noncash.includes(a)).map(a=>({transactionId:a.payment?.id==null?null:Number(a.payment.id),businessDate:a.payment!.business_date,amount:Number(a.allocated_amount)}))};
}
export function confirmedAllocationThroughMonth(allocation:Pick<DatedPayableAllocation,"payment">,nextMonthStart?:string){
  return allocation.payment?.status==="confirmed"&&(!nextMonthStart||allocation.payment.business_date<nextMonthStart);
}
export function confirmedAllocationsThroughMonth<T extends Pick<DatedPayableAllocation,"payment">>(allocations:readonly T[],month?:string){
  const nextMonthStart=month===undefined?undefined:payableMonthBounds(month).nextMonthStart;
  return allocations.filter(row=>confirmedAllocationThroughMonth(row,nextMonthStart));
}
export function sumConfirmedAllocationsThroughMonth(allocations:readonly Pick<DatedPayableAllocation,"allocated_amount"|"payment">[],month:string){
  return sumPayableAmounts(confirmedAllocationsThroughMonth(allocations,month).map(row=>row.allocated_amount));
}
export function payableDisplayAsOf(originalAmount:number|string,allocations:readonly SettlementAllocation[],month:string,context:SettlementContext={}){
  const confirmed=confirmedAllocationsThroughMonth(allocations,month);
  const settlement=calculatePurchaseSettlement(originalAmount,confirmed,context);
  const paidAmount=settlement.cashPaidAmount,remainingAmount=settlement.remainingAmount,status=settlement.status;
  const accounts=new Map<string,string>();
  for(const allocation of confirmed)for(const movement of allocation.payment?.movements??[]){
    if(isPayableNonCashAdjustment(allocation,originalAmount,context)||Number(movement.amount)>=0||!movement.fund_account)continue;
    const account=movement.fund_account;
    const name=account.display_name?.trim();
    if(name)accounts.set(String(account.id??account.code??name),name);
  }
  return {status,paidAmount,remainingAmount,accountName:accounts.size>1?"복수계정":accounts.values().next().value??null};
}
export type PayablePeriodSummary={openingOutstanding:number;periodPurchases:number;periodPayments:number;closingOutstanding:number};
export function calculatePayableBalances<T extends PayableBalanceSource>(sources:readonly T[],allocations:readonly DatedPayableAllocation[],month?:string){
  const bounds=month===undefined?null:payableMonthBounds(month);
  const byPayable=new Map<number,DatedPayableAllocation[]>();
  for(const allocation of confirmedAllocationsThroughMonth(allocations,month)){
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
    let before=BigInt(0),through=BigInt(0),inPeriod=BigInt(0),periodAdjustment=BigInt(0);
    for(const allocation of byPayable.get(source.id)??[]){
      const paymentDate=allocation.payment!.business_date,amount=amountUnits(allocation.allocated_amount);
      through+=amount;
      if(bounds&&paymentDate<bounds.monthStart)before+=amount;
      if(bounds&&paymentDate>=bounds.monthStart&&paymentDate<bounds.nextMonthStart){
        if(isPayableNonCashAdjustment(allocation,source.original_amount,{payableId:source.id,transactionId:source.expense?.id}))periodAdjustment-=amount;
        else inPeriod+=amount;
      }
    }
    const outstanding=original>through?original-through:BigInt(0);
    closing+=outstanding;
    if(bounds){
      const party=partyTotals.get(Number(source.party_id))??{opening:BigInt(0),purchases:BigInt(0),payments:BigInt(0),closing:BigInt(0)};
      if(date<bounds.monthStart){const balance=original>before?original-before:BigInt(0);opening+=balance;party.opening+=balance}
      else {purchases+=original;party.purchases+=original}
      purchases+=periodAdjustment;party.purchases+=periodAdjustment;
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
