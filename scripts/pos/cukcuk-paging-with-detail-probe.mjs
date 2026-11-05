// READ-ONLY CUKCUK probe: POST /api/v1/sainvoices/paging-with-detail for business days
// (16:00 ~ next 03:00 Asia/Ho_Chi_Minh). Reuses the existing loginCukcuk() (env only).
// No database access, no writes anywhere except the --out JSON file. The access token and
// any credential are never printed or written.
//
// Run from the repository that holds the env file (operator only):
//   node --conditions=react-server --experimental-strip-types --env-file=.env.local \
//     <worktree>/scripts/pos/cukcuk-paging-with-detail-probe.mjs --from 2026-11-01 --to 2026-11-03 --out <file.json> [--legacy 1]
// Prints login/fetch timing and which builder fields the new API returns (key names only).
// --legacy also times the current production read (sainvoices/paging + per-receipt detail, per business day)
// for the same windows and counts builder-field differences between the two sources (counts only).
import { writeFileSync } from "node:fs";
import { register } from "node:module";

// lib/pos/cukcuk/auth.ts guards itself with `import "server-only"` (provided by Next at build time).
// Outside Next, resolve only that marker to an empty module, then load the unchanged auth module.
register(`data:text/javascript,${encodeURIComponent(
  'export async function resolve(s,c,n){return s==="server-only"?{url:"data:text/javascript,export{}",shortCircuit:true}:n(s,c);}')}`);
const { loginCukcuk } = await import("../../lib/pos/cukcuk/auth.ts");

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
const from = args.from ?? "2026-11-01", to = args.to ?? "2026-11-03";
const branchId = (args.branch ?? "c39228ba-a452-4cf9-bf34-424ffb151fb8").toLowerCase();
const limit = Number(args.limit ?? 100), maxPages = Number(args.maxPages ?? 200);
if (!args.out) throw new Error("--out <file.json> is required");
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error("invalid --from/--to");
const baseUrl = (process.env.CUKCUK_BASE_URL?.trim() || "https://graphapi.cukcuk.vn").replace(/\/$/, "");

const day = (date, offset) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const windows = [];
for (let d = from; d <= to; d = day(d, 1)) windows.push({ businessDate: d, start: `${d}T16:00:00+07:00`, end: `${day(d, 1)}T03:00:00+07:00` });
const windowOf = refDate => windows.find(w => Date.parse(refDate) >= Date.parse(w.start) && Date.parse(refDate) < Date.parse(w.end))?.businessDate ?? null;

const pick = (object, pattern) => Object.fromEntries(Object.entries(object ?? {}).filter(([key, value]) => pattern.test(key) && (value === null || typeof value !== "object")));
const headerKeys = /^(RefId|RefID|RefNo|RefDate|PostedDate|BranchId|BranchID|PaymentStatus|IsCancel|IsCanceled|Cancel|CancelDate|CancelReason|Status|TotalAmount|FinalAmount|SaleAmount|Amount|VATAmount|DiscountAmount|ModifiedDate|CreatedDate|TableName|Revision|Version)/i;
const lineKeys = /^(RefDetailID|RefDetailId|RefID|RefId|ParentID|ParentId|ItemID|ItemId|ItemCode|ItemName|UnitID|UnitName|Quantity|UnitPrice|Price|Amount|DiscountAmount|PromotionAmount|FinalAmount|TaxRate|TaxAmount|PreTaxAmount|TaxReductionAmount|RefDetailType|InventoryItemType|IsOption|IsCancel|IsCanceled|IsDeleted|Cancel|SortOrder|Status)/i;
// Fields the unchanged sync builders read (sales-receipt-sync.ts buildReceiptRow/buildLineRow/buildPaymentRow).
const BUILDER_FIELDS = {
  header: ["RefNo", "RefDate", "PaymentStatus", "BranchId", "BranchCode", "BranchName", "TableName", "CustomerName", "FinalAmount", "TotalAmount", "SaleAmount", "Amount", "DiscountAmount", "PromotionAmount", "VATAmount", "ReturnAmount"],
  line: ["RefDetailID", "ParentID", "RefDetailType", "ItemID", "ItemCode", "ItemName", "UnitID", "UnitName", "Quantity", "UnitPrice", "Amount", "DiscountAmount", "PromotionAmount", "FinalAmount", "TaxRate", "TaxAmount", "PreTaxAmount", "TaxReductionAmount", "InventoryItemType", "SortOrder"],
  payment: ["PaymentType", "PaymentName", "CardID", "CardName", "Amount"],
};
const keyUnion = rows => [...new Set(rows.flatMap(row => Object.keys(row ?? {})))].sort();
const detailArrays = ["SAInvoiceDetails", "saInvoiceDetails", "Details", "details", "InvoiceDetails", "invoiceDetails"];
const paymentArrays = ["SAInvoicePayments", "saInvoicePayments", "Payments", "payments", "InvoicePayments", "invoicePayments"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const loginStartedAt = Date.now();
const login = await loginCukcuk();
const loginMs = Date.now() - loginStartedAt;
const rawInvoices = []; // kept in memory only for the optional --legacy comparison; never written
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.accessToken}`, CompanyCode: login.companyCode };
// Official paging-with-detail contract: Page, Limit, BranchId, FromDate, ToDate (no LastSyncDate).
// FromDate = first business-day open (16:00), ToDate = last business-day close (next day 03:00).
const fromDate = windows[0].start, toDate = windows.at(-1).end;
const requestShape = { Page: "<n>", Limit: limit, BranchId: branchId, FromDate: fromDate, ToDate: toDate };
const pages = []; const invoices = []; let total = null;
const fetchStartedAt = Date.now(); let requestMs = 0;
for (let page = 1; page <= maxPages; page++) {
  let response, json;
  const pageStartedAt = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(`${baseUrl}/api/v1/sainvoices/paging-with-detail`, { method: "POST", headers, cache: "no-store",
      body: JSON.stringify({ Page: page, Limit: limit, BranchId: branchId, FromDate: fromDate, ToDate: toDate }) });
    json = await response.json().catch(() => null);
    if (json?.Code !== 102) break; // documented concurrent-request code: back off and retry serially
    await sleep(1500 * attempt);
  }
  const data = Array.isArray(json?.Data) ? json.Data : null;
  const elapsedMs = Date.now() - pageStartedAt; requestMs += elapsedMs;
  pages.push({ page, http: response.status, success: json?.Success ?? null, code: json?.Code ?? null, total: json?.Total ?? null,
    count: data?.length ?? null, elapsedMs, message: json?.Success === true ? null : String(json?.Message ?? "").slice(0, 200) });
  if (!response.ok || json?.Success !== true || !data) break;
  total ??= json.Total;
  for (const invoice of data) {
    rawInvoices.push(invoice);
    const detailKey = detailArrays.find(key => Array.isArray(invoice?.[key]));
    const paymentKey = paymentArrays.find(key => Array.isArray(invoice?.[key]));
    const refDate = invoice?.RefDate ?? invoice?.PostedDate ?? null;
    invoices.push({
      businessDate: typeof refDate === "string" ? windowOf(refDate) : null,
      header: pick(invoice, headerKeys),
      detailKey: detailKey ?? null, paymentKey: paymentKey ?? null,
      lines: (detailKey ? invoice[detailKey] : []).map(line => pick(line, lineKeys)),
      payments: (paymentKey ? invoice[paymentKey] : []).map(payment => pick(payment, /^(PaymentID|PaymentId|RefID|RefId|PaymentType|PaymentName|CardName|Amount)/i)),
      topLevelKeys: Object.keys(invoice ?? {}).sort(),
    });
  }
  // Total-driven paging: keep going until Total receipts / ceil(Total/Limit) pages are fetched.
  if (data.length === 0) break;
  if (Number.isSafeInteger(total) ? invoices.length >= total || page >= Math.ceil(total / limit) : data.length < limit) break;
  await sleep(400);
}
const fetchMs = Date.now() - fetchStartedAt;
const rawDetail = invoice => invoice[detailArrays.find(key => Array.isArray(invoice?.[key]))] ?? [];
const rawPayments = invoice => invoice[paymentArrays.find(key => Array.isArray(invoice?.[key]))] ?? [];
// Key names only (no values): which builder fields the new API actually returns.
const fieldCoverage = {
  lineKeys: keyUnion(rawInvoices.flatMap(rawDetail)), paymentKeys: keyUnion(rawInvoices.flatMap(rawPayments)),
  missingBuilderFields: {
    header: BUILDER_FIELDS.header.filter(key => !rawInvoices.some(i => Object.hasOwn(i, key))),
    line: BUILDER_FIELDS.line.filter(key => !rawInvoices.flatMap(rawDetail).some(l => Object.hasOwn(l, key))),
    payment: BUILDER_FIELDS.payment.filter(key => !rawInvoices.flatMap(rawPayments).some(p => Object.hasOwn(p, key))),
  },
};

// --legacy: time the current production read (sainvoices/paging + parallel per-receipt detail, per business day)
// for the same windows, and compare builder fields between the two sources. Values are compared, never written.
let legacy = null;
if (args.legacy !== undefined) {
  const byRef = new Map(rawInvoices.map(invoice => [String(invoice.RefId ?? invoice.RefID ?? "").toLowerCase(), invoice]));
  const same = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && Number.isFinite(Number(a)) && Number(a) === Number(b));
  const diffFields = (oldRow, newRow, fields) => fields.filter(key => Object.hasOwn(oldRow ?? {}, key) && !same(oldRow[key], newRow?.[key]));
  const days = []; const fieldDiffs = {}; const keysOnlyInLegacy = new Set(); let compared = 0, missingInNew = 0, lineSetDiffs = 0;
  const legacyStartedAt = Date.now();
  for (const w of windows) {
    const dayStartedAt = Date.now();
    const listResponse = await fetch(`${baseUrl}/api/v1/sainvoices/paging`, { method: "POST", headers, cache: "no-store",
      body: JSON.stringify({ Page: 1, Limit: 100, BranchId: branchId, LastSyncDate: new Date(w.start).toISOString() }) });
    const listJson = await listResponse.json().catch(() => null);
    const listMs = Date.now() - dayStartedAt;
    const list = (Array.isArray(listJson?.Data) ? listJson.Data : []).filter(i => windowOf(i.RefDate ?? i.PostedDate ?? "") === w.businessDate);
    const detailStartedAt = Date.now();
    const details = await Promise.all(list.map(async i => {
      const refId = i.RefId ?? i.RefID;
      const r = await fetch(`${baseUrl}/api/v1/sainvoices/${encodeURIComponent(refId)}`, { headers, cache: "no-store" });
      const j = await r.json().catch(() => null);
      return { refId, ok: r.ok && j?.Success !== false, data: j?.Data && typeof j.Data === "object" ? j.Data : j };
    }));
    const detailMs = Date.now() - detailStartedAt;
    days.push({ businessDate: w.businessDate, listHttp: listResponse.status, listCount: list.length, listMs, detailCalls: details.length,
      detailFailures: details.filter(d => !d.ok).length, detailMs, totalMs: Date.now() - dayStartedAt });
    for (const d of details.filter(x => x.ok)) {
      const fresh = byRef.get(String(d.refId).toLowerCase());
      if (!fresh) { missingInNew++; continue; }
      compared++;
      for (const key of Object.keys(d.data ?? {})) if (!Object.hasOwn(fresh, key)) keysOnlyInLegacy.add(`header.${key}`);
      for (const key of diffFields(d.data, fresh, BUILDER_FIELDS.header)) fieldDiffs[`header.${key}`] = (fieldDiffs[`header.${key}`] ?? 0) + 1;
      const freshLines = new Map(rawDetail(fresh).map(l => [String(l.RefDetailID ?? l.RefDetailId).toLowerCase(), l]));
      const oldLines = rawDetail(d.data);
      if (oldLines.length !== freshLines.size) lineSetDiffs++;
      for (const l of oldLines) {
        const nl = freshLines.get(String(l.RefDetailID ?? l.RefDetailId).toLowerCase());
        if (!nl) { lineSetDiffs++; continue; }
        for (const key of Object.keys(l)) if (!Object.hasOwn(nl, key)) keysOnlyInLegacy.add(`line.${key}`);
        for (const key of diffFields(l, nl, BUILDER_FIELDS.line)) fieldDiffs[`line.${key}`] = (fieldDiffs[`line.${key}`] ?? 0) + 1;
      }
      const sortPay = rows => [...rows].sort((a, b) => Number(a.PaymentType) - Number(b.PaymentType) || Number(a.Amount) - Number(b.Amount));
      const op = sortPay(rawPayments(d.data)), np = sortPay(rawPayments(fresh));
      if (op.length !== np.length) fieldDiffs["payment.count"] = (fieldDiffs["payment.count"] ?? 0) + 1;
      op.forEach((p, index) => { for (const key of Object.keys(p)) if (!Object.hasOwn(np[index] ?? {}, key)) keysOnlyInLegacy.add(`payment.${key}`);
        for (const key of diffFields(p, np[index], BUILDER_FIELDS.payment)) fieldDiffs[`payment.${key}`] = (fieldDiffs[`payment.${key}`] ?? 0) + 1; });
    }
    await sleep(400);
  }
  legacy = { totalMs: Date.now() - legacyStartedAt, days, compared, missingInNew, lineSetDiffs, builderFieldDiffs: fieldDiffs,
    keysOnlyInLegacy: [...keysOnlyInLegacy].sort() };
}

const inWindow = invoices.filter(invoice => invoice.businessDate);
const expectedPages = Number.isSafeInteger(total) ? Math.ceil(total / limit) : null;
const okPages = pages.filter(p => p.success === true).length;
const totalCheck = { providerTotal: total, limit, expectedPages, fetchedPages: okPages, enumerated: invoices.length,
  complete: pages.at(-1)?.success === true && Number.isSafeInteger(total) && invoices.length === total && okPages === expectedPages,
  hitMaxPages: pages.length >= maxPages && !(Number.isSafeInteger(total) && invoices.length >= total) };
const output = {
  readOnly: true, endpoint: "POST /api/v1/sainvoices/paging-with-detail", capturedAt: new Date().toISOString(),
  branchId, windows, fromDate, toDate, requestShape, pages, totalCheck, providerTotal: total, enumerated: invoices.length,
  timing: { loginMs, fetchMs, requestMs }, fieldCoverage, legacy,
  inWindowCount: inWindow.length,
  perDay: windows.map(w => ({ businessDate: w.businessDate, receipts: inWindow.filter(i => i.businessDate === w.businessDate).length })),
  invoices: inWindow,
  outOfWindowRefDates: invoices.filter(invoice => !invoice.businessDate).map(invoice => invoice.header.RefDate ?? invoice.header.PostedDate ?? null),
};
writeFileSync(args.out, JSON.stringify(output, null, 1));
console.log(JSON.stringify({ out: args.out, fromDate, toDate, pages: pages.length, lastPage: pages.at(-1), totalCheck,
  inWindow: inWindow.length, perDay: output.perDay, timing: output.timing, missingBuilderFields: fieldCoverage.missingBuilderFields,
  legacy: legacy && { totalMs: legacy.totalMs, days: legacy.days, compared: legacy.compared, missingInNew: legacy.missingInNew,
    lineSetDiffs: legacy.lineSetDiffs, builderFieldDiffs: legacy.builderFieldDiffs, keysOnlyInLegacy: legacy.keysOnlyInLegacy } }, null, 1));
