// READ-ONLY CUKCUK probe: POST /api/v1/sainvoices/paging-with-detail for business days
// (16:00 ~ next 03:00 Asia/Ho_Chi_Minh). Reuses the existing loginCukcuk() (env only).
// No database access, no writes anywhere except the --out JSON file. The access token and
// any credential are never printed or written.
//
// Run from the repository that holds the env file (operator only):
//   node --conditions=react-server --experimental-strip-types --env-file=.env.local \
//     <worktree>/scripts/pos/cukcuk-paging-with-detail-probe.mjs --from 2026-11-01 --to 2026-11-03 --out <file.json>
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
const lineKeys = /^(RefDetailID|RefDetailId|RefID|RefId|ParentID|ParentId|ItemID|ItemId|ItemCode|ItemName|UnitID|UnitName|Quantity|UnitPrice|Amount|DiscountAmount|RefDetailType|InventoryItemType|IsOption|IsCancel|IsCanceled|IsDeleted|Cancel|SortOrder|Status)/i;
const detailArrays = ["SAInvoiceDetails", "saInvoiceDetails", "Details", "details", "InvoiceDetails", "invoiceDetails"];
const paymentArrays = ["SAInvoicePayments", "saInvoicePayments", "Payments", "payments", "InvoicePayments", "invoicePayments"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const login = await loginCukcuk();
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.accessToken}`, CompanyCode: login.companyCode };
// Same list contract the app already uses for /sainvoices/paging; LastSyncDate = first window start.
const requestShape = { Page: "<n>", Limit: limit, BranchId: branchId, LastSyncDate: windows[0].start };
const pages = []; const invoices = []; let total = null;
for (let page = 1; page <= maxPages; page++) {
  let response, json;
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(`${baseUrl}/api/v1/sainvoices/paging-with-detail`, { method: "POST", headers, cache: "no-store",
      body: JSON.stringify({ Page: page, Limit: limit, BranchId: branchId, LastSyncDate: windows[0].start }) });
    json = await response.json().catch(() => null);
    if (json?.Code !== 102) break; // documented concurrent-request code: back off and retry serially
    await sleep(1500 * attempt);
  }
  const data = Array.isArray(json?.Data) ? json.Data : null;
  pages.push({ page, http: response.status, success: json?.Success ?? null, code: json?.Code ?? null, total: json?.Total ?? null,
    count: data?.length ?? null, message: json?.Success === true ? null : String(json?.Message ?? "").slice(0, 200) });
  if (!response.ok || json?.Success !== true || !data) break;
  total ??= json.Total;
  for (const invoice of data) {
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
  if (data.length < limit || (Number.isSafeInteger(total) && invoices.length >= total)) break;
  await sleep(400);
}

const inWindow = invoices.filter(invoice => invoice.businessDate);
const output = {
  readOnly: true, endpoint: "POST /api/v1/sainvoices/paging-with-detail", capturedAt: new Date().toISOString(),
  branchId, windows, requestShape, pages, providerTotal: total, enumerated: invoices.length,
  inWindowCount: inWindow.length,
  perDay: windows.map(w => ({ businessDate: w.businessDate, receipts: inWindow.filter(i => i.businessDate === w.businessDate).length })),
  invoices: inWindow,
  outOfWindowRefDates: invoices.filter(invoice => !invoice.businessDate).map(invoice => invoice.header.RefDate ?? invoice.header.PostedDate ?? null),
};
writeFileSync(args.out, JSON.stringify(output, null, 1));
console.log(JSON.stringify({ out: args.out, pages: pages.length, lastPage: pages.at(-1), providerTotal: total, enumerated: invoices.length,
  inWindow: inWindow.length, perDay: output.perDay }, null, 1));
