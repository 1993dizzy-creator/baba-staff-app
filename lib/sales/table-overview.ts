import {
  buildOpenOrderKpi, classifyOrdersForBusinessDate, classifyOrderStatus,
  DEFAULT_STALE_AFTER_MS, singlePaidOrderReceipt, type CollectedOrder, type OpenOrderSyncState, type ReceiptLink,
} from "../pos/cukcuk/open-orders-core.ts";

import { addStoreDays, calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import { evaluateOpenOrdersCronWindow } from "../pos/cukcuk/open-orders-cron-policy.ts";

export type TableReceipt = ReceiptLink & { tableName?: string | null; paidAt?: string | null };
export type TableState = "idle" | "unknown" | "occupied" | "reserved" | "paid" | "free";
export type CatalogTable = { id: string; name: string; areaId: string; areaName: string; available: boolean | null;
  displayArea?: "bar" | "floor1" | "floor2" };
export type TableCatalog = { status: "ok" | "not_enabled" | "unavailable"; collectedAt: string | null; tables: CatalogTable[];
  kind?: "verified_static" };
export type TableOrder = {
  id: string; number: string | null; tableName: string | null; startedAt: string; collectedAt: string | null;
  amount: number; verifiedOpen: boolean; detailsNeedReview: boolean;
  lines: { id: string; name: string; quantity: number; price: number; amount: number; option: boolean; canceled: boolean }[] | null;
};
export type TableTile = CatalogTable & { state: TableState; orders: TableOrder[]; lastPaidAt: string | null; area: string };
export type TableOverview = {
  businessDate: string; serverNow: string; snapshotAt: string | null; catalogAt: string | null;
  catalogStatus: TableCatalog["status"]; snapshotStatus: string; unlinkedReceiptCount: number;
  tables: TableTile[]; unlinked: TableOrder[];
  summary: { total: number | null; occupied: number | null; reserved: null; paid: number | null; free: null; unknown: number };
};

const nameKey = (value: string) => value.normalize("NFC").trim().toLocaleLowerCase("vi-VN");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 200;

/** Official Tables envelope, fail closed on malformed/duplicate identities. No sample inventory. */
export function parseTableCatalog(value: unknown, collectedAt: string): TableCatalog {
  if (!object(value) || value.Success !== true || value.Code !== 200 || (value.ErrorType != null && value.ErrorType !== 0)) throw Error("TABLES_INVALID");
  let data: unknown = value.Data;
  if (typeof data === "string") data = JSON.parse(data);
  if (!object(data) || !Array.isArray(data.ListTable) || data.ListTable.length > 2000) throw Error("TABLES_INVALID");
  const ids = new Set<string>();
  const tables = data.ListTable.map((row: unknown): CatalogTable => {
    if (!object(row) || !text(row.MapObjectID) || !uuid.test(row.MapObjectID) || !text(row.MapObjectName)
      || !text(row.AreaID) || !uuid.test(row.AreaID) || !text(row.AreaName) || typeof row.IsAvailable !== "boolean") throw Error("TABLES_INVALID");
    const id = row.MapObjectID.toLowerCase();
    if (ids.has(id)) throw Error("TABLES_DUPLICATE_ID");
    ids.add(id);
    return { id, name: row.MapObjectName.trim(), areaId: row.AreaID.toLowerCase(), areaName: row.AreaName.trim(), available: row.IsAvailable };
  });
  return { status: "ok", collectedAt, tables };
}

/** Only literal area labels are recognized; unfamiliar source areas remain visible under their own name. */
export function tableArea(name: string) {
  const key = nameKey(name);
  if (key === "bar") return "bar";
  if (["1층", "tầng 1", "floor 1"].includes(key)) return "floor1";
  if (["2층", "tầng 2", "floor 2"].includes(key)) return "floor2";
  return "other:" + name;
}

export function buildTableOverview(input: {
  businessDate: string; now: Date; catalog: TableCatalog; sync: OpenOrderSyncState | null;
  orders: CollectedOrder[]; receipts: TableReceipt[]; enabled: boolean; readFailed?: boolean;
  cutoff?: string; collectionExpected?: boolean;
}): TableOverview {
  const { businessDate, now, catalog, sync } = input;
  const canonicalReceipts = new Map<number, TableReceipt>();
  let receiptConflict = false;
  for (const row of input.receipts) {
    if (row.businessDate && ![businessDate, addStoreDays(businessDate, 1)].includes(row.businessDate)) continue;
    const receipt = { orderId: row.orderId.trim().toLowerCase(), receiptId: row.receiptId,
      paymentStatus: row.paymentStatus, isCanceled: row.isCanceled, businessDate: row.businessDate,
      tableName: row.tableName?.trim() || null, paidAt: row.paidAt ?? null };
    const previous = canonicalReceipts.get(receipt.receiptId);
    if (!Number.isSafeInteger(receipt.receiptId) || receipt.receiptId <= 0 ||
      previous && JSON.stringify(previous) !== JSON.stringify(receipt)) receiptConflict = true;
    else canonicalReceipts.set(receipt.receiptId, receipt);
  }
  const receipts = [...canonicalReceipts.values()];
  const byId = new Map<string, CollectedOrder>();
  let conflict = false;
  for (const order of input.orders) {
    const id = order.orderId.trim().toLowerCase();
    const normalized = { ...order, orderId: id, raw: {} };
    const previous = byId.get(id);
    if (!id || (previous && JSON.stringify(previous) !== JSON.stringify(normalized))) conflict = true;
    else byId.set(id, normalized);
  }
  const orders = [...byId.values()];
  const classified = classifyOrdersForBusinessDate(orders, receipts, businessDate);
  const kpi = buildOpenOrderKpi({ enabled: input.enabled, businessDate, now, sync,
    classified: conflict ? null : classified, isLiveBusinessDay: true, isClosed: false, paid: { amount: 0, receiptCount: 0 } });
  // A failed latest attempt or a future timestamp cannot certify a current physical seat.
  const age = sync?.lastSuccessAt ? now.getTime() - Date.parse(sync.lastSuccessAt) : NaN;
  const snapshotOk = kpi.status === "ok" && !sync?.lastErrorCode && age >= 0 && !input.readFailed && !receiptConflict;
  const collectionExpected = input.collectionExpected ?? evaluateOpenOrdersCronWindow(now).allowed;
  const currentSync = sync?.businessDate === businessDate ? sync : null;
  // Outside the collector's service window, absence of a first snapshot is normal.
  // An explicit read/collection failure is never re-labelled as waiting.
  const waiting = input.enabled && !collectionExpected && !input.readFailed && !currentSync?.lastErrorCode
    && !conflict && !receiptConflict && !(age < 0);
  const globalFailure = !snapshotOk && !waiting;
  const catalogAge = catalog.collectedAt ? now.getTime() - Date.parse(catalog.collectedAt) : NaN;
  // Verified static identities do not expire like live availability. Order freshness still gates occupancy.
  const catalogOk = catalog.status === "ok" && (catalog.kind === "verified_static" || catalogAge >= 0 && catalogAge <= DEFAULT_STALE_AFTER_MS);
  const openIds = new Set(classified.open.map(order => order.orderId));
  // Reuse the same receipt policy for each excluded order: confirmed paid predecessors
  // are history, not competing occupancy candidates. Unknown/conflicting orders still block.
  const convertedIds = new Set(orders.filter(order => order.businessDate === businessDate && !openIds.has(order.orderId)
    && classifyOrdersForBusinessDate([order], receipts, businessDate).converted === 1).map(order => order.orderId));
  const revokedIds = new Set(orders.filter(order => order.businessDate === businessDate
    && classifyOrderStatus(order.status) === "paid_candidate"
    && classifyOrdersForBusinessDate([order], receipts, businessDate).receiptCanceled === 1).map(order => order.orderId));
  const paidByOrder = new Map<string, TableReceipt>();
  const currentPaid = receipts.filter(receipt => receipt.businessDate === businessDate
    && receipt.paymentStatus === 3 && receipt.isCanceled === false);
  for (const receipt of currentPaid) {
    const single = singlePaidOrderReceipt(receipt.orderId, businessDate, receipts);
    const paidTime = receipt.paidAt ? Date.parse(receipt.paidAt) : NaN;
    const sourceOrder = byId.get(receipt.orderId);
    if (single?.receiptId === receipt.receiptId && receipt.orderId && receipt.tableName && Number.isFinite(paidTime)
      && (!sourceOrder || Date.parse(sourceOrder.orderDate) <= paidTime)
      && paidTime <= now.getTime() && calculateStoreBusinessDate(new Date(paidTime), input.cutoff) === businessDate) {
      paidByOrder.set(receipt.orderId, receipt);
    }
  }
  const reviewIds = new Set(kpi.detailWarnings?.map(review => review.orderId) ?? []);
  const projected = orders.filter(order => order.businessDate === businessDate && classifyOrderStatus(order.status) !== "canceled").map((order): TableOrder => {
    const observedAge = order.providerObservedAt ? now.getTime() - Date.parse(order.providerObservedAt) : NaN;
    return { id: order.orderId, number: order.orderNo, tableName: order.tableName?.trim() || paidByOrder.get(order.orderId)?.tableName || null,
      startedAt: order.orderDate, collectedAt: order.providerObservedAt ?? null, amount: order.totalAmount,
      verifiedOpen: snapshotOk && openIds.has(order.orderId) && observedAge >= 0 && observedAge <= DEFAULT_STALE_AFTER_MS
        && Date.parse(order.providerObservedAt!) <= Date.parse(sync!.lastSuccessAt!)
        && Date.parse(order.orderDate) <= Date.parse(order.providerObservedAt!)
        && Date.parse(order.orderDate) <= now.getTime()
        && calculateStoreBusinessDate(order.orderDate, input.cutoff) === businessDate,
      detailsNeedReview: reviewIds.has(order.orderId) || !order.lines,
      lines: order.lines?.map(line => ({ id: line.detailId, name: line.itemName, quantity: line.quantity, price: line.price,
        amount: line.amount, option: line.isOption, canceled: line.isCanceled })) ?? null };
  });
  const contradictoryNames = new Set<string>();
  for (const order of orders) {
    const receipt = paidByOrder.get(order.orderId);
    if (order.businessDate === businessDate && order.tableName?.trim() && receipt
      && nameKey(order.tableName) !== nameKey(receipt.tableName!)) {
      contradictoryNames.add(nameKey(order.tableName));
      contradictoryNames.add(nameKey(receipt.tableName!));
    }
  }
  const nameCounts = new Map<string, number>();
  for (const table of catalog.tables) nameCounts.set(nameKey(table.name), (nameCounts.get(nameKey(table.name)) ?? 0) + 1);
  const uniqueName = (name: string | null | undefined) => !!name && nameCounts.get(nameKey(name)) === 1;
  const assigned = new Set(projected.filter(order => uniqueName(order.tableName)).map(order => order.id));
  const unlinked = projected.filter(order => !assigned.has(order.id));
  const unlocatedOrder = unlinked.some(order => !convertedIds.has(order.id) && !revokedIds.has(order.id));
  const unlinkedReceiptCount = currentPaid.filter(receipt => !paidByOrder.has(receipt.orderId)
    || !uniqueName(receipt.tableName)).length;
  const tables = catalog.tables.map((table): TableTile => {
    const unique = nameCounts.get(nameKey(table.name)) === 1;
    const matches = unique ? projected.filter(order => order.tableName && nameKey(order.tableName) === nameKey(table.name)) : [];
    const candidates = matches.filter(order => !convertedIds.has(order.id) && !revokedIds.has(order.id));
    const settlements = [...paidByOrder.values()].filter(receipt => unique && nameKey(receipt.tableName!) === nameKey(table.name));
    const last = settlements.sort((a, b) => Date.parse(b.paidAt!) - Date.parse(a.paidAt!))[0];
    const receiptIssue = receipts.some(receipt => receipt.businessDate === businessDate && receipt.tableName
      && nameKey(receipt.tableName) === nameKey(table.name) && !paidByOrder.has(receipt.orderId)
      && !(receipt.isCanceled === true || receipt.paymentStatus === 4 || receipt.paymentStatus === 5));
    const mismatchedReceipt = matches.some(order => {
      const receipt = paidByOrder.get(order.id);
      return receipt && nameKey(receipt.tableName!) !== nameKey(table.name);
    });
    let state: TableState = "idle";
    if (!catalogOk || globalFailure || !unique || conflict || receiptConflict || mismatchedReceipt || contradictoryNames.has(nameKey(table.name))) state = "unknown";
    else if (candidates.length) state = snapshotOk && candidates.every(order => order.verifiedOpen) ? "occupied" : "unknown";
    else if (unlocatedOrder || receiptIssue || matches.some(order => convertedIds.has(order.id) && !paidByOrder.has(order.id))) state = "unknown";
    else if (snapshotOk && last) state = "paid";
    return { ...table, area: table.displayArea ?? tableArea(table.areaName), state, orders: matches,
      lastPaidAt: last?.paidAt ?? null };
  });
  const unknown = tables.filter(table => table.state === "unknown").length;
  const countable = catalogOk && snapshotOk && unknown === 0 && !unlocatedOrder;
  return {
    businessDate, serverNow: now.toISOString(), snapshotAt: kpi.lastSuccessAt, catalogAt: catalog.collectedAt,
    catalogStatus: catalog.status, snapshotStatus: snapshotOk ? "ok" : waiting ? "waiting"
      : kpi.status === "ok" ? "unavailable" : kpi.status,
    tables, unlinked, unlinkedReceiptCount,
    // idle and paid never certify physical vacancy. Unknown totals remain null, not zero.
    summary: { total: catalog.status === "ok" ? tables.length : null,
      occupied: countable ? tables.filter(table => table.state === "occupied").length : null,
      paid: countable && unlinkedReceiptCount === 0 ? tables.filter(table => table.state === "paid").length : null,
      reserved: null, free: null, unknown },
  };
}
