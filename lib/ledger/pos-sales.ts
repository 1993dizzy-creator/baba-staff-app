import "server-only";
import { createHash } from "node:crypto";
import { supabaseServer } from "@/lib/supabase/server";
import { buildPaymentSummary, classifyPaymentBucket, filterPaidPayments, findPaymentReconciliationMismatches, getPaidReceiptTotal, paymentSummaryByBucket, toPaymentNumber, type PosPaymentBucket, type PosPaymentRow } from "@/lib/sales/payment-summary";

type ReceiptRow = { id:number; ref_no:string|null; business_date:string; ref_date:string|null; payment_status:number|null; is_canceled:boolean|null; final_amount:number|string|null; revision:number|null; updated_at:string|null };
type PaymentRow = PosPaymentRow & { id:number };
export type PosLedgerSourceRow = { businessDate:string; bucket:PosPaymentBucket; amount:number; fingerprint:string; snapshot:Record<string,unknown> };
const BUCKETS:PosPaymentBucket[]=["cash","transfer","card","other"];

export function validLedgerMonth(value:unknown):value is string{return typeof value==="string"&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value)}
export function ledgerMonthRange(month:string){const [year,number]=month.split("-").map(Number);const last=new Date(Date.UTC(year,number,0)).getUTCDate();return{fromDate:`${month}-01`,toDate:`${month}-${String(last).padStart(2,"0")}`}}
function fingerprint(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex")}

export async function loadPosLedgerSource(month:string){
  const {fromDate,toDate}=ledgerMonthRange(month);
  const [receiptResult,paymentResult]=await Promise.all([
    supabaseServer.from("pos_sales_receipts").select("id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at").gte("business_date",fromDate).lte("business_date",toDate).order("id"),
    supabaseServer.from("pos_sales_receipt_payments").select("id,receipt_id,business_date,payment_type,payment_name,card_name,amount").gte("business_date",fromDate).lte("business_date",toDate).order("id"),
  ]);
  if(receiptResult.error)throw new Error(`Failed to load POS receipts: ${receiptResult.error.message}`);
  if(paymentResult.error)throw new Error(`Failed to load POS payments: ${paymentResult.error.message}`);
  const receipts=(receiptResult.data??[]) as ReceiptRow[];const payments=(paymentResult.data??[]) as PaymentRow[];
  const eligible=filterPaidPayments(receipts,payments);const receiptById=new Map(receipts.map(receipt=>[receipt.id,receipt]));
  const mismatches=findPaymentReconciliationMismatches(receipts,eligible);
  if(mismatches.length>0){throw new Error(`POS_PAYMENT_RECONCILIATION_MISMATCH: ${JSON.stringify(mismatches)}`)}
  const dates:string[]=[];const cursor=new Date(`${fromDate}T00:00:00Z`);const end=new Date(`${toDate}T00:00:00Z`);while(cursor<=end){dates.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1)}
  const rows:PosLedgerSourceRow[]=[];
  for(const businessDate of dates){for(const bucket of BUCKETS){
    const detail=eligible.filter(payment=>payment.business_date===businessDate&&classifyPaymentBucket(payment)===bucket).map(payment=>{const receipt=receiptById.get(Number(payment.receipt_id));return{paymentId:payment.id,receiptId:payment.receipt_id,refNo:receipt?.ref_no??null,refDate:receipt?.ref_date??null,paymentMethod:payment.payment_name||payment.card_name||null,paymentAmount:toPaymentNumber(payment.amount),receiptFinalAmount:toPaymentNumber(receipt?.final_amount),receiptRevision:receipt?.revision??0,receiptUpdatedAt:receipt?.updated_at??null}});
    const amount=detail.reduce((sum,item)=>sum+item.paymentAmount,0);const snapshot={businessDate,bucket,receiptCount:new Set(detail.map(item=>item.receiptId)).size,payments:detail};
    rows.push({businessDate,bucket,amount,fingerprint:fingerprint(snapshot),snapshot});
  }}
  const salesSummary=buildPaymentSummary(eligible);const receiptTotalAmount=getPaidReceiptTotal(receipts);const totalsByBucket=paymentSummaryByBucket(salesSummary);const allocatedTotal=Object.values(totalsByBucket).reduce((sum,amount)=>sum+amount,0);
  if(Math.abs(allocatedTotal-receiptTotalAmount)>=0.01){throw new Error(`POS_PAYMENT_BUCKET_ALLOCATION_MISMATCH: receipt=${receiptTotalAmount}, allocated=${allocatedTotal}`)}
  salesSummary.paymentTotalAmount=receiptTotalAmount;return{range:{fromDate,toDate},rows,salesSummary,totalsByBucket};
}

export async function loadPosLedgerParity(month:string){
  const source=await loadPosLedgerSource(month);const {data,error}=await supabaseServer.from("ledger_transactions").select("source_key,amount,status").eq("source_type","pos_sales_daily_payment").gte("business_date",source.range.fromDate).lte("business_date",source.range.toDate).eq("status","confirmed");if(error)throw error;
  const ledger={cash:0,transfer:0,card:0,other:0} satisfies Record<PosPaymentBucket,number>;
  for(const row of data??[]){const bucket=String(row.source_key).split(":").at(-1) as PosPaymentBucket;if(BUCKETS.includes(bucket))ledger[bucket]+=Number(row.amount)}
  const sales=source.totalsByBucket;const salesTotal=source.salesSummary.paymentTotalAmount;const ledgerTotal=Object.values(ledger).reduce((a,b)=>a+b,0);
  return{sales,ledger,salesTotal,ledgerTotal,matches:BUCKETS.every(bucket=>sales[bucket]===ledger[bucket])&&salesTotal===ledgerTotal};
}

export async function loadPosDrilldown(transactionId:number){
  const {data:transaction,error}=await supabaseServer.from("ledger_transactions").select("id,business_date,amount,source_type,source_key,status").eq("id",transactionId).maybeSingle();if(error)throw error;
  if(!transaction||transaction.source_type!=="pos_sales_daily_payment")return null;
  const bucket=String(transaction.source_key).split(":").at(-1) as PosPaymentBucket;const month=String(transaction.business_date).slice(0,7);const source=await loadPosLedgerSource(month);const row=source.rows.find(item=>item.businessDate===transaction.business_date&&item.bucket===bucket);const payments=(row?.snapshot.payments??[]) as Array<Record<string,unknown>>;const total=payments.reduce((sum,item)=>sum+Number(item.paymentAmount??0),0);
  return{transactionId,businessDate:transaction.business_date,bucket,ledgerAmount:Number(transaction.amount),sourceAmount:total,matches:Number(transaction.amount)===total,payments};
}
