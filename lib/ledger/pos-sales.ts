import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { POS_BUCKETS as BUCKETS, buildPosLedgerRangeSource, validPosBusinessDate, type PosSourceReceipt, type PosSourcePayment } from "./pos-sales-source";
import type { PosPaymentBucket } from "@/lib/sales/payment-summary";
export { buildPosBusinessDaySource, posSourceFingerprint, type PosLedgerSourceRow, type PosBusinessDaySource } from "./pos-sales-source";

export function validLedgerMonth(value:unknown):value is string{return typeof value==="string"&&/^\d{4}-(0[1-9]|1[0-2])$/.test(value)}
export function ledgerMonthRange(month:string){if(!validLedgerMonth(month))throw new Error("INVALID_MONTH");const [year,number]=month.split("-").map(Number);const last=new Date(Date.UTC(year,number,0)).getUTCDate();return{fromDate:`${month}-01`,toDate:`${month}-${String(last).padStart(2,"0")}`}}

async function loadPosSourceRange(fromDate: string, toDate: string) {
  // PostgREST caps responses. Explicit count and pagination prevent silently
  // treating the first 1,000 records as a complete source. Close/v3 additionally
  // compare this snapshot against live source inside the database transaction.
  const loadReceipts = async () => {
    const rows: PosSourceReceipt[] = [];
    let expected: number | null = null;
    for (let offset = 0;; offset += 500) {
      const result = await supabaseServer.from("pos_sales_receipts").select("id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount,revision,updated_at", { count: "exact" }).gte("business_date",fromDate).lte("business_date",toDate).order("id").range(offset, offset + 499);
      if (result.error) throw new Error(`Failed to load POS receipts: ${result.error.message}`);
      if (result.count === null || (expected !== null && expected !== result.count)) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
      expected = result.count;
      rows.push(...(result.data ?? []) as PosSourceReceipt[]);
      if (rows.length >= expected) break;
      if (!result.data?.length) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
    }
    if (rows.length !== expected) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
    return rows;
  };
  const loadPayments = async () => {
    const rows: PosSourcePayment[] = [];
    let expected: number | null = null;
    for (let offset = 0;; offset += 500) {
      const result = await supabaseServer.from("pos_sales_receipt_payments").select("id,receipt_id,business_date,payment_type,payment_name,card_name,amount", { count: "exact" }).gte("business_date",fromDate).lte("business_date",toDate).order("id").range(offset, offset + 499);
      if (result.error) throw new Error(`Failed to load POS payments: ${result.error.message}`);
      if (result.count === null || (expected !== null && expected !== result.count)) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
      expected = result.count;
      rows.push(...(result.data ?? []) as PosSourcePayment[]);
      if (rows.length >= expected) break;
      if (!result.data?.length) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
    }
    if (rows.length !== expected) throw new Error("POS_SOURCE_SNAPSHOT_INCOMPLETE");
    return rows;
  };
  const [receipts, payments] = await Promise.all([loadReceipts(), loadPayments()]);
  const dates: string[] = [];
  const cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (cursor <= end) { dates.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return buildPosLedgerRangeSource(dates, receipts, payments);
}

export async function loadPosLedgerSource(month: string) {
  const range = ledgerMonthRange(month);
  return { range, ...await loadPosSourceRange(range.fromDate, range.toDate) };
}

export async function loadPosBusinessDaySource(businessDate: string) {
  if (!validPosBusinessDate(businessDate)) throw new Error("INVALID_POS_BUSINESS_DATE");
  return (await loadPosSourceRange(businessDate, businessDate)).days[0];
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
