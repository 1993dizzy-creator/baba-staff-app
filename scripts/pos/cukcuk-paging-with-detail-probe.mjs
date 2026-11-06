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
// --legacy also passes both sources through the unchanged app builders (buildReceiptRow/buildLineRow/
// buildPaymentRow) and compares the values that would be stored, plus raw_json re-save / inventory
// reprocess effects. [--sample N] [--exclude <refIds.json>] limit it to N receipts not in the exclude list
// (e.g. manually modified receipts). The Supabase client is replaced by a stub that throws on any use.
import { readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";

// lib/pos/cukcuk/auth.ts guards itself with `import "server-only"` (provided by Next at build time).
// Outside Next, resolve that marker to an empty module, "@/lib/supabase/server" to a throwing stub
// (no database access is possible), and other "@/..." aliases to the repository files.
const repoRoot = new URL("../../", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`const root=${JSON.stringify(repoRoot)};
const db="data:text/javascript,"+encodeURIComponent('export const supabaseServer=new Proxy({},{get(){throw new Error("DB access disabled in probe")}});');
export async function resolve(s,c,n){
 if(s==="server-only")return{url:"data:text/javascript,export{}",shortCircuit:true};
 if(s==="@/lib/supabase/server")return{url:db,shortCircuit:true};
 if(s.startsWith("@/"))return n(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?"":".ts"),root).href,c);
 return n(s,c);}`)}`);
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
  const exclude = new Set(args.exclude ? JSON.parse(readFileSync(args.exclude, "utf8")).map(id => String(id).toLowerCase()) : []);
  const sample = args.sample === undefined ? Infinity : Number(args.sample);
  let sampled = 0;
  const storage = await storageComparer();
  const legacyStartedAt = Date.now();
  for (const w of windows) {
    const dayStartedAt = Date.now();
    const listResponse = await fetch(`${baseUrl}/api/v1/sainvoices/paging`, { method: "POST", headers, cache: "no-store",
      body: JSON.stringify({ Page: 1, Limit: 100, BranchId: branchId, LastSyncDate: new Date(w.start).toISOString() }) });
    const listJson = await listResponse.json().catch(() => null);
    const listMs = Date.now() - dayStartedAt;
    const list = (Array.isArray(listJson?.Data) ? listJson.Data : []).filter(i => windowOf(i.RefDate ?? i.PostedDate ?? "") === w.businessDate)
      .filter(i => !exclude.has(String(i.RefId ?? i.RefID ?? "").toLowerCase()))
      .filter(() => sampled < sample && ++sampled > 0);
    const detailStartedAt = Date.now();
    const details = await Promise.all(list.map(async i => {
      const refId = i.RefId ?? i.RefID;
      const r = await fetch(`${baseUrl}/api/v1/sainvoices/${encodeURIComponent(refId)}`, { headers, cache: "no-store" });
      const j = await r.json().catch(() => null);
      return { refId, listRow: i, ok: r.ok && j?.Success !== false, data: j?.Data && typeof j.Data === "object" ? j.Data : j };
    }));
    const detailMs = Date.now() - detailStartedAt;
    days.push({ businessDate: w.businessDate, listHttp: listResponse.status, listCount: list.length, listMs, detailCalls: details.length,
      detailFailures: details.filter(d => !d.ok).length, detailMs, totalMs: Date.now() - dayStartedAt });
    for (const d of details.filter(x => x.ok)) {
      const fresh = byRef.get(String(d.refId).toLowerCase());
      if (!fresh) { missingInNew++; continue; }
      compared++;
      storage.compare(w.businessDate, d.listRow, d.data, fresh);
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
    keysOnlyInLegacy: [...keysOnlyInLegacy].sort(), excluded: exclude.size, storage: storage.result() };
}

// Stored-value comparison through the unchanged app builders, mirroring sync-to-sales/route.ts:
// legacy = buildReceiptRow({ invoice: list row, detailPayload: detail }); new (paging-with-detail) =
// the same receipt object as both invoice and detailPayload. Lines/payments as in the route.
async function storageComparer() {
  const sync = await import("../../lib/pos/cukcuk/sales-receipt-sync.ts");
  const { stripVolatilePosSyncFields } = await import("../../lib/pos/cukcuk/sales-receipt-sync-compare.ts");
  const { hasInventoryAffectingSalesLineChanged } = await import("../../lib/pos/cukcuk/sales-receipt-inventory-change.ts");
  const syncedAt = "2000-01-01T00:00:00.000Z";
  const META = new Set(["raw_json", "synced_at", "updated_at"]);
  const norm = v => Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : v;
  const eq = (a, b) => (a ?? null) === (b ?? null) || (typeof a === "number" || typeof b === "number") && a != null && b != null && Number(a) === Number(b)
    || JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  const keyDiff = (a = {}, b = {}) => ({ onlyLegacy: Object.keys(a).filter(k => !Object.hasOwn(b, k)), onlyNew: Object.keys(b).filter(k => !Object.hasOwn(a, k)),
    valueDiff: Object.keys(a).filter(k => Object.hasOwn(b, k) && JSON.stringify(norm(a[k])) !== JSON.stringify(norm(b[k]))) });
  const out = { receipts: 0, lines: 0, payments: 0, receiptFieldDiffs: {}, lineFieldDiffs: {}, paymentFieldDiffs: {}, examples: [],
    lineSetMismatch: 0, paymentSnapshotUnavailable: { legacy: 0, new: 0 }, paymentExternalId: { legacyOnly: 0, newOnly: 0, both: 0, neither: 0 },
    saleAmount: { differing: 0, differingWithStoredDiff: 0 },
    rawJson: { receiptResave: 0, lineResave: 0, paymentResave: 0, inventoryReprocess: 0, receiptKeys: {}, lineKeys: {}, paymentKeys: {} } };
  const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  const addKeys = (map, diff) => { for (const [kind, keys] of Object.entries(diff)) for (const k of keys) bump(map, `${kind}:${k}`); };
  const diffRow = (a, b, map, where) => { let n = 0; for (const k of Object.keys(a)) if (!META.has(k) && !eq(a[k], b[k])) {
    n++; bump(map, k); if (out.examples.length < 20) out.examples.push({ where, field: k, legacy: a[k], new: b[k] }); } return n; };
  const build = (businessDate, invoice, payload) => {
    const receipt = sync.buildReceiptRow({ invoice, detailPayload: payload, businessDate, syncedAt });
    const lines = sync.getDetailsFromInvoicePayload(payload).map((detail, index) => sync.buildLineRow({ receiptId: null, receiptRefId: receipt.ref_id,
      detail, businessDate, refDate: receipt.ref_date, paymentStatus: receipt.payment_status, isCanceled: receipt.is_canceled, sortOrder: index + 1, syncedAt }));
    const snapshot = sync.getPaymentSnapshotFromInvoicePayload(payload);
    const payments = snapshot.available ? snapshot.payments.map(payment => sync.buildPaymentRow({ receiptId: null, receiptRefId: receipt.ref_id,
      businessDate, refDate: receipt.ref_date, payment, syncedAt })) : null;
    return { receipt, lines, payments };
  };
  const extId = p => sync.getString(p.raw_json, ["SAInvoicePaymentID", "SAInvoicePaymentId", "saInvoicePaymentID", "saInvoicePaymentId"]);
  const payKey = p => extId(p) ?? `${p.payment_type}|${p.payment_name ?? ""}|${p.card_name ?? ""}`;
  return {
    compare(businessDate, listRow, detail, fresh) {
      const o = build(businessDate, listRow, detail), n = build(businessDate, fresh, fresh);
      const ref = o.receipt.ref_no ?? o.receipt.ref_id;
      out.receipts++;
      const receiptDiffs = diffRow(o.receipt, n.receipt, out.receiptFieldDiffs, `receipt ${ref}`);
      // hasReceiptChanged: raw_json compared after stripVolatilePosSyncFields.
      if (JSON.stringify(stripVolatilePosSyncFields(o.receipt.raw_json)) !== JSON.stringify(stripVolatilePosSyncFields(n.receipt.raw_json))) {
        out.rawJson.receiptResave++;
        addKeys(out.rawJson.receiptKeys, keyDiff(stripVolatilePosSyncFields(o.receipt.raw_json), stripVolatilePosSyncFields(n.receipt.raw_json)));
      }
      const saleDiff = !eq(detail?.SaleAmount, fresh?.SaleAmount);
      let storedDiff = receiptDiffs;
      const newLines = new Map(n.lines.map(l => [String(l.ref_detail_id).toLowerCase(), l]));
      if (o.lines.length !== n.lines.length) out.lineSetMismatch++;
      for (const l of o.lines) {
        const nl = newLines.get(String(l.ref_detail_id).toLowerCase());
        if (!nl) { out.lineSetMismatch++; continue; }
        out.lines++;
        storedDiff += diffRow(l, nl, out.lineFieldDiffs, `line ${ref}/${l.sort_order}`);
        // hasLineChanged: raw_json compared without stripping volatile fields.
        if (JSON.stringify(norm(l.raw_json)) !== JSON.stringify(norm(nl.raw_json))) { out.rawJson.lineResave++; addKeys(out.rawJson.lineKeys, keyDiff(l.raw_json, nl.raw_json)); }
        const inv = row => ({ refDetailId: row.ref_detail_id, parentRefDetailId: row.parent_ref_detail_id, itemId: row.item_id, itemCode: row.item_code,
          quantity: row.quantity, refDetailType: row.ref_detail_type, inventoryItemType: row.inventory_item_type, isOption: row.is_option, isExcluded: false, isCanceled: row.is_canceled });
        if (hasInventoryAffectingSalesLineChanged(inv(l), inv(nl))) out.rawJson.inventoryReprocess++;
      }
      if (!o.payments) out.paymentSnapshotUnavailable.legacy++;
      if (!n.payments) out.paymentSnapshotUnavailable.new++;
      if (o.payments && n.payments) {
        if (o.payments.length !== n.payments.length) { bump(out.paymentFieldDiffs, "count"); storedDiff++; }
        const newPays = new Map(n.payments.map(p => [payKey(p), p]));
        for (const p of o.payments) {
          const np = newPays.get(payKey(p)) ?? n.payments.find(x => x.payment_type === p.payment_type && eq(x.amount, p.amount));
          bump(out.paymentExternalId, extId(p) && np && extId(np) ? "both" : extId(p) ? "legacyOnly" : np && extId(np) ? "newOnly" : "neither");
          if (!np) { bump(out.paymentFieldDiffs, "missing"); storedDiff++; continue; }
          out.payments++;
          storedDiff += diffRow(p, np, out.paymentFieldDiffs, `payment ${ref}`);
          if (JSON.stringify(norm(p.raw_json)) !== JSON.stringify(norm(np.raw_json))) { out.rawJson.paymentResave++; addKeys(out.rawJson.paymentKeys, keyDiff(p.raw_json, np.raw_json)); }
        }
      }
      if (saleDiff) { out.saleAmount.differing++; if (storedDiff > 0) out.saleAmount.differingWithStoredDiff++; }
    },
    result: () => out,
  };
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
    lineSetDiffs: legacy.lineSetDiffs, builderFieldDiffs: legacy.builderFieldDiffs, keysOnlyInLegacy: legacy.keysOnlyInLegacy,
    excluded: legacy.excluded, storage: legacy.storage } }, null, 1));
