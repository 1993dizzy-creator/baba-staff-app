import { createHash } from "node:crypto";
import { stripVolatilePosSyncFields } from "./sales-receipt-sync-compare";
import { getPaymentSnapshotFromInvoicePayload } from "./payment-snapshot";

type ObjectValue = Record<string, unknown>;
export type CollectedInvoice = { refId: string; invoice: ObjectValue; detail: ObjectValue; hash: string; amount: number };
export type CollectionPass = {
  total: number; pages: number; count: number; amount: number; hash: string;
  invoices: CollectedInvoice[];
};
export class CollectionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export const contentHash = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(stripVolatilePosSyncFields(value))).digest("hex");
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: ObjectValue) => value.RefId ?? value.RefID ?? value.refId ?? value.refID;
const canonicalId = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const amount = (value: ObjectValue) => value.FinalAmount ?? value.TotalAmount ?? value.SaleAmount ?? value.Amount;
const numeric = (value: unknown) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value));
const detailFields = ["SAInvoiceDetails", "saInvoiceDetails", "Details", "details", "InvoiceDetails", "invoiceDetails"];

// Total describes the unfiltered provider enumeration, never just the business day.
// Two identical observations are evidence of stability, not a provider snapshot token.
export async function collectStableInvoices(options: {
  branchId: string; from: string; to: string; limit: number;
  page: (page: number) => Promise<unknown>;
  detail: (refId: string) => Promise<unknown>;
  maxPages?: number;
}): Promise<{ first: CollectionPass; second: CollectionPass; collectionComplete: true; automaticConfirmation: false }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 ||
      !Number.isFinite(Date.parse(options.from)) || !Number.isFinite(Date.parse(options.to)) ||
      Date.parse(options.from) >= Date.parse(options.to)) throw new CollectionError("invalid_collection_scope");
  const scan = async (): Promise<CollectionPass> => {
    const seen = new Set<string>();
    const invoices: CollectedInvoice[] = [];
    let total = -1, pages = 0;
    for (let page = 1; ; page++) {
      if (page > (options.maxPages ?? 1000)) throw new CollectionError("collection_page_bound");
      const response = await options.page(page);
      if (!object(response) || response.Success !== true || !Array.isArray(response.Data) ||
          !Number.isSafeInteger(response.Total) || Number(response.Total) < 0) throw new CollectionError("invalid_page_contract");
      if (total < 0) total = Number(response.Total);
      if (total !== response.Total) throw new CollectionError("page_total_changed");
      const expected = Math.min(options.limit, Math.max(0, total - (page - 1) * options.limit));
      if (response.Data.length !== expected) throw new CollectionError("page_count_mismatch");
      pages++;
      // Serial detail reads also avoid CUKCUK's documented concurrent-request 102.
      for (const invoice of response.Data) {
        if (!object(invoice)) throw new CollectionError("invalid_invoice");
        const refId = typeof identity(invoice) === "string" ? String(identity(invoice)).trim() : "";
        const normalizedRef = canonicalId(refId);
        if (!normalizedRef || seen.has(normalizedRef)) throw new CollectionError("duplicate_or_missing_receipt");
        seen.add(normalizedRef);
        if (canonicalId(invoice.BranchId ?? invoice.BranchID) !== canonicalId(options.branchId)) throw new CollectionError("invoice_branch_mismatch");
        const date = invoice.RefDate ?? invoice.PostedDate;
        if (typeof date !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(date) || !Number.isFinite(Date.parse(date))) throw new CollectionError("invoice_time_uncertain");
        // Enumerate all pages before concluding completeness; out-of-day rows still
        // participate in the ID/hash manifest and detail validation.
        const responseDetail = await options.detail(refId);
        if (!object(responseDetail) || responseDetail.Success !== true || !object(responseDetail.Data)) throw new CollectionError("invalid_detail_contract");
        const detail = responseDetail.Data;
        // The documented /detail endpoint can contain child arrays only. Do not
        // fabricate a detail header: validate child RefIDs against the list ID.
        if (identity(detail) !== undefined && canonicalId(identity(detail)) !== normalizedRef ||
            (detail.BranchId ?? detail.BranchID) !== undefined && canonicalId(detail.BranchId ?? detail.BranchID) !== canonicalId(options.branchId)) throw new CollectionError("detail_identity_mismatch");
        if (detail.RefDate !== undefined && detail.RefDate !== date) throw new CollectionError("detail_header_time_mismatch");
        const arrays = detailFields.filter(key => Object.hasOwn(detail, key));
        const lines = detail[arrays[0]];
        if (!arrays.length || !Array.isArray(lines) || !arrays.every(key => contentHash(detail[key]) === contentHash(lines))) throw new CollectionError("line_snapshot_unavailable");
        const lineIds = new Set<string>();
        for (const line of lines) {
          if (!object(line)) throw new CollectionError("invalid_line");
          const lineId = canonicalId(line.RefDetailID ?? line.RefDetailId);
          if (!lineId || lineIds.has(lineId) || !numeric(line.Quantity)) throw new CollectionError("line_identity_or_quantity_uncertain");
          lineIds.add(lineId);
        }
        const payments = getPaymentSnapshotFromInvoicePayload(detail);
        if (!payments.available) throw new CollectionError("payment_snapshot_unavailable");
        const children = [...lines, ...payments.payments] as ObjectValue[];
        if (children.some(child => identity(child) !== undefined && canonicalId(identity(child)) !== normalizedRef) ||
            identity(detail) === undefined && (!children.length || children.some(child => canonicalId(identity(child)) !== normalizedRef))) throw new CollectionError("detail_identity_mismatch");
        if (invoice.PaymentStatus !== undefined && detail.PaymentStatus !== undefined && invoice.PaymentStatus !== detail.PaymentStatus) throw new CollectionError("detail_header_changed");
        const status = detail.PaymentStatus ?? invoice.PaymentStatus;
        if (!Number.isInteger(status) || Number(status) < 0 || Number(status) > 5) throw new CollectionError("invoice_status_uncertain");
        if (amount(detail) !== undefined && amount(invoice) !== undefined && Number(amount(detail)) !== Number(amount(invoice))) throw new CollectionError("detail_header_changed");
        const totalAmount = amount(detail) ?? amount(invoice);
        if (!numeric(totalAmount)) throw new CollectionError("invalid_invoice_amount");
        invoices.push({ refId, invoice, detail, hash: contentHash({ invoice, detail }), amount: Number(totalAmount) });
      }
      if (seen.size === total) break;
    }
    const sorted = invoices.sort((a, b) => a.refId.localeCompare(b.refId));
    return { total, pages, count: seen.size, amount: sorted.reduce((sum, item) => sum + item.amount, 0),
      hash: contentHash(sorted.map(item => [item.refId, item.hash])), invoices: sorted };
  };
  const first = await scan(), second = await scan();
  if (first.total !== second.total || first.amount !== second.amount || first.hash !== second.hash) throw new CollectionError("collection_unstable");
  return { first, second, collectionComplete: true, automaticConfirmation: false };
}

// No cursor is advanced on failure. A closed-date rescan is the same idempotent
// operation as a normal collection; older outage gaps are explicit caller input.
export function recoveryBusinessDates(today: string, recentDays = 7, gapDates: string[] = []) {
  if (!Number.isInteger(recentDays) || recentDays < 1 || recentDays > 14 || !Array.isArray(gapDates) || gapDates.length > 31) throw new CollectionError("invalid_recovery_scope");
  const valid = (date: string) => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(today) || gapDates.some(date => !valid(date) || date > today)) throw new CollectionError("invalid_recovery_date");
  return [...new Set([...Array.from({ length: recentDays }, (_, n) => new Date(Date.parse(today) - n * 86400000).toISOString().slice(0, 10)), ...gapDates])].sort();
}
