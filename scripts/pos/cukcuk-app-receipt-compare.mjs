// READ-ONLY comparison of a CUKCUK paging-with-detail probe (cukcuk-paging-with-detail-probe.mjs)
// against an APP pos_sales_receipts snapshot (read-only SQL export). No network, no database.
//   node scripts/pos/cukcuk-app-receipt-compare.mjs --app <app.json|mcp.txt> [--cukcuk <probe.json>] --out <report.json>
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
if (!args.app || !args.out) throw new Error("--app and --out are required");

// Keg tracking mappings (inventory_keg_tracking_mappings → pos_products.item_id), read 2026-11-04.
const KEG = {
  "4978dbec-dbcc-48d4-9294-6ebc153fc57e": { code: "L7", item: "사포로 생맥주", ml: 2700, note: "Sapporo tower (POS name 3000cc)" },
  "40a6b2e9-b562-4823-a087-8107c460a16d": { code: "L6", item: "블랑", ml: 3000 },
  "7f2a0167-78ba-4866-ae9e-11b3807be335": { code: "L5", item: "칼스버그", ml: 3000 },
  "e1e001ff-af3f-4727-b33a-7914ccfcaf5a": { code: "L4", item: "사포로 흑맥주", ml: 330 },
  "f597ce4d-8cb8-498d-b5eb-a65dbaae1c8d": { code: "L3", item: "사포로 생맥주", ml: 330 },
  "ce7cede6-fd0f-4e75-a200-3c5be3202687": { code: "L2", item: "블랑", ml: 330 },
  "e140488a-0e1c-4994-a2d5-7c44e8c0706a": { code: "L1", item: "칼스버그", ml: 330 },
  "bd4867de-036d-4465-b7e9-cfdbcba106c0": { code: "K3", item: "솔티드라임", ml: 330 },
  "94cb5043-a91d-4070-b98c-40b73737d646": { code: "K2", item: "나이트로 흑맥주", ml: 330 },
  "3d0d050d-9899-4974-a879-e189d9b51a19": { code: "K1", item: "자스민 IPA", ml: 330 },
};
const EXPECTED = { receipts: 56, kegMl: 48930 };
const id = value => typeof value === "string" ? value.trim().toLowerCase() : "";
const num = value => value === null || value === undefined || value === "" ? null : Number(value);

function readApp(path) {
  const text = readFileSync(path, "utf8");
  let value = JSON.parse(text);
  if (typeof value?.result === "string") { // MCP export: JSON rows inside the result text
    const body = value.result; value = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1));
  }
  if (Array.isArray(value) && value[0]?.j) value = value[0].j;
  return value.map(r => ({
    refId: id(r.ref_id), refNo: r.ref_no, businessDate: r.business_date, refDate: r.ref_date, paymentStatus: num(r.payment_status),
    canceled: r.is_canceled === true, modified: r.is_modified === true, amount: num(r.final_amount),
    lines: (r.lines ?? []).map(l => ({ detailId: id(l.d), parent: id(l.p), itemId: id(l.i), code: l.c, name: l.n, quantity: num(l.q),
      type: num(l.t), option: l.o === true, excluded: l.x === true, canceled: l.lc === true, manual: String(l.d ?? "").startsWith("manual-") })),
  }));
}
function readCukcuk(path) {
  const probe = JSON.parse(readFileSync(path, "utf8"));
  const receipts = probe.invoices.map(invoice => {
    const h = invoice.header;
    const status = num(h.PaymentStatus);
    const cancelFlag = [h.IsCancel, h.IsCanceled, h.Cancel].find(value => typeof value === "boolean");
    return { refId: id(h.RefId ?? h.RefID), refNo: h.RefNo ?? null, businessDate: invoice.businessDate, refDate: h.RefDate ?? h.PostedDate,
      paymentStatus: status, canceled: cancelFlag ?? status === 4, amount: num(h.FinalAmount ?? h.TotalAmount ?? h.SaleAmount ?? h.Amount),
      lines: invoice.lines.map(l => ({ detailId: id(l.RefDetailID ?? l.RefDetailId), parent: id(l.ParentID ?? l.ParentId), itemId: id(l.ItemID ?? l.ItemId),
        code: l.ItemCode ?? null, name: l.ItemName ?? null, quantity: num(l.Quantity), type: num(l.RefDetailType),
        canceled: [l.IsCancel, l.IsCanceled, l.IsDeleted].some(value => value === true) })) };
  });
  return { probe, receipts };
}
const kegMl = (receipts, lineFilter) => {
  const byDay = {}, byItem = {};
  for (const r of receipts) for (const l of r.lines) {
    const keg = KEG[l.itemId]; if (!keg || !lineFilter(r, l)) continue;
    const ml = (l.quantity ?? 0) * keg.ml;
    byDay[r.businessDate] = (byDay[r.businessDate] ?? 0) + ml;
    const key = `${keg.code} ${keg.item} (${keg.ml}ml)`; byItem[key] = (byItem[key] ?? 0) + ml;
  }
  return { total: Object.values(byDay).reduce((a, b) => a + b, 0), byDay, byItem };
};

const app = readApp(args.app);
const report = { readOnly: true, expected: EXPECTED, app: {
  receipts: app.length, perDay: Object.fromEntries([...new Set(app.map(r => r.businessDate))].sort().map(d => [d, app.filter(r => r.businessDate === d).length])),
  canceled: app.filter(r => r.canceled).map(r => ({ refNo: r.refNo, refId: r.refId, paymentStatus: r.paymentStatus })),
  modified: app.filter(r => r.modified).map(r => r.refNo),
  // Provider view: CUKCUK lines as received (APP manual lines removed, excluded originals kept).
  kegProviderLines: kegMl(app, (r, l) => !r.canceled && !l.canceled && !l.manual),
  // APP effective: after APP receipt modification (excluded originals removed, manual lines added).
  kegAppEffective: kegMl(app, (r, l) => !r.canceled && !l.canceled && !l.excluded),
  appOnlyManualLines: app.flatMap(r => r.lines.filter(l => l.manual).map(l => ({ refNo: r.refNo, code: l.code, quantity: l.quantity, ml: KEG[l.itemId] ? l.quantity * KEG[l.itemId].ml : null }))),
  excludedOriginalLines: app.flatMap(r => r.lines.filter(l => l.excluded).map(l => ({ refNo: r.refNo, detailId: l.detailId, code: l.code, quantity: l.quantity, ml: KEG[l.itemId] ? l.quantity * KEG[l.itemId].ml : null }))),
} };

if (args.cukcuk) {
  const { probe, receipts: cuk } = readCukcuk(args.cukcuk);
  const appById = new Map(app.map(r => [r.refId, r])), cukById = new Map(cuk.map(r => [r.refId, r]));
  const receiptDiffs = [], lineDiffs = [];
  for (const c of cuk) {
    const a = appById.get(c.refId);
    if (!a) { receiptDiffs.push({ kind: "missing_in_app", refId: c.refId, refNo: c.refNo, businessDate: c.businessDate, paymentStatus: c.paymentStatus }); continue; }
    const fields = [["businessDate", a.businessDate, c.businessDate], ["paymentStatus", a.paymentStatus, c.paymentStatus],
      ["canceled", a.canceled, c.canceled], ["refNo", a.refNo, c.refNo], ["amount", a.modified ? null : a.amount, a.modified ? null : c.amount]];
    for (const [field, appValue, cukValue] of fields) if (appValue !== cukValue && !(appValue == null && cukValue == null))
      receiptDiffs.push({ kind: "field", refNo: a.refNo, refId: a.refId, field, app: appValue, cukcuk: cukValue, appModified: a.modified });
    const appLines = new Map(a.lines.filter(l => !l.manual).map(l => [l.detailId, l]));
    for (const cl of c.lines) {
      const al = appLines.get(cl.detailId);
      if (!al) { lineDiffs.push({ kind: "line_missing_in_app", refNo: a.refNo, detailId: cl.detailId, code: cl.code, quantity: cl.quantity }); continue; }
      appLines.delete(cl.detailId);
      if (al.quantity !== cl.quantity || al.itemId !== cl.itemId || al.canceled !== cl.canceled)
        lineDiffs.push({ kind: "line_field", refNo: a.refNo, detailId: cl.detailId, code: cl.code, app: { itemId: al.itemId, quantity: al.quantity, canceled: al.canceled },
          cukcuk: { itemId: cl.itemId, quantity: cl.quantity, canceled: cl.canceled }, appExcluded: al.excluded });
    }
    for (const al of appLines.values()) lineDiffs.push({ kind: "line_missing_in_cukcuk", refNo: a.refNo, detailId: al.detailId, code: al.code, quantity: al.quantity, appExcluded: al.excluded });
  }
  for (const a of app) if (!cukById.has(a.refId)) receiptDiffs.push({ kind: "missing_in_cukcuk", refId: a.refId, refNo: a.refNo, businessDate: a.businessDate });
  const towers = cuk.flatMap(r => r.lines.filter(l => KEG[l.itemId]?.code === "L7").map(l => ({ refNo: r.refNo, businessDate: r.businessDate, canceled: r.canceled,
    detailId: l.detailId, quantity: l.quantity, ml: l.quantity * 2700, app: appById.get(r.refId)?.lines.find(x => x.detailId === l.detailId) ?? null })));
  report.cukcuk = {
    endpoint: probe.endpoint, capturedAt: probe.capturedAt, pages: probe.pages, providerTotal: probe.providerTotal, enumerated: probe.enumerated,
    receipts: cuk.length, perDay: probe.perDay, receiptsMatchExpected: cuk.length === EXPECTED.receipts,
    canceled: cuk.filter(r => r.canceled).map(r => ({ refNo: r.refNo, refId: r.refId, paymentStatus: r.paymentStatus, businessDate: r.businessDate })),
    keg: kegMl(cuk, (r, l) => !r.canceled && !l.canceled), sapporoTowers: towers,
    detailKeys: [...new Set(probe.invoices.map(i => i.detailKey))], lineCount: cuk.reduce((n, r) => n + r.lines.length, 0),
  };
  report.cukcuk.kegMatchesExpected = report.cukcuk.keg.total === EXPECTED.kegMl;
  report.diffs = { receipts: receiptDiffs, lines: lineDiffs,
    kegProviderVsCukcuk: report.app.kegProviderLines.total - report.cukcuk.keg.total,
    kegAppEffectiveVsCukcuk: report.app.kegAppEffective.total - report.cukcuk.keg.total };
}
writeFileSync(args.out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ out: args.out, appReceipts: report.app.receipts, appKegProvider: report.app.kegProviderLines.total, appKegEffective: report.app.kegAppEffective.total,
  cukcukReceipts: report.cukcuk?.receipts ?? null, cukcukKeg: report.cukcuk?.keg.total ?? null,
  receiptDiffs: report.diffs?.receipts.length ?? null, lineDiffs: report.diffs?.lines.length ?? null }, null, 1));
