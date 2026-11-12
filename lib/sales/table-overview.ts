import {
  buildOpenOrderKpi, classifyOrdersForBusinessDate, classifyOrderStatus,
  DEFAULT_STALE_AFTER_MS, type CollectedOrder, type OpenOrderSyncState, type ReceiptLink,
} from "../pos/cukcuk/open-orders-core.ts";

export type TableState = "unknown" | "occupied" | "reserved" | "paid" | "free";
export type CatalogTable = { id: string; name: string; areaId: string; areaName: string; available: boolean | null;
  displayArea?: "bar" | "floor1" | "floor2" };
export type TableCatalog = { status: "ok" | "not_enabled" | "unavailable"; collectedAt: string | null; tables: CatalogTable[];
  kind?: "verified_static" };
export type TableOrder = {
  id: string; number: string | null; tableName: string | null; startedAt: string; collectedAt: string | null;
  amount: number; verifiedOpen: boolean; detailsNeedReview: boolean;
  lines: { id: string; name: string; quantity: number; price: number; amount: number; option: boolean; canceled: boolean }[] | null;
};
export type TableTile = CatalogTable & { state: TableState; orders: TableOrder[]; area: string };
export type TableOverview = {
  businessDate: string; serverNow: string; snapshotAt: string | null; catalogAt: string | null;
  catalogStatus: TableCatalog["status"]; snapshotStatus: string;
  tables: TableTile[]; unlinked: TableOrder[];
  summary: { total: number | null; occupied: number | null; reserved: null; paid: null; free: null; unknown: number };
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
  orders: CollectedOrder[]; receipts: ReceiptLink[]; enabled: boolean;
}): TableOverview {
  const { businessDate, now, catalog, sync, receipts } = input;
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
  const snapshotOk = kpi.status === "ok" && !sync?.lastErrorCode && age >= 0;
  const catalogAge = catalog.collectedAt ? now.getTime() - Date.parse(catalog.collectedAt) : NaN;
  // Verified static identities do not expire like live availability. Order freshness still gates occupancy.
  const catalogOk = catalog.status === "ok" && (catalog.kind === "verified_static" || catalogAge >= 0 && catalogAge <= DEFAULT_STALE_AFTER_MS);
  const openIds = new Set(classified.open.map(order => order.orderId));
  const reviewIds = new Set(kpi.detailWarnings?.map(review => review.orderId) ?? []);
  const projected = orders.filter(order => order.businessDate === businessDate && classifyOrderStatus(order.status) !== "canceled").map((order): TableOrder => {
    const observedAge = order.providerObservedAt ? now.getTime() - Date.parse(order.providerObservedAt) : NaN;
    return { id: order.orderId, number: order.orderNo, tableName: order.tableName,
      startedAt: order.orderDate, collectedAt: order.providerObservedAt ?? null, amount: order.totalAmount,
      verifiedOpen: snapshotOk && openIds.has(order.orderId) && observedAge >= 0 && observedAge <= DEFAULT_STALE_AFTER_MS,
      detailsNeedReview: reviewIds.has(order.orderId) || !order.lines,
      lines: order.lines?.map(line => ({ id: line.detailId, name: line.itemName, quantity: line.quantity, price: line.price,
        amount: line.amount, option: line.isOption, canceled: line.isCanceled })) ?? null };
  });
  const nameCounts = new Map<string, number>();
  for (const table of catalog.tables) nameCounts.set(nameKey(table.name), (nameCounts.get(nameKey(table.name)) ?? 0) + 1);
  const assigned = new Set<string>();
  const tables = catalog.tables.map((table): TableTile => {
    const unique = nameCounts.get(nameKey(table.name)) === 1;
    // Exact names only. Never split composite names, nor assign a bare BAR order to every bar seat.
    const matches = unique ? projected.filter(order => order.tableName && nameKey(order.tableName) === nameKey(table.name)) : [];
    matches.forEach(order => assigned.add(order.id));
    const occupied = catalogOk && snapshotOk && matches.length > 0 && matches.every(order => order.verifiedOpen) && !table.available;
    return { ...table, area: table.displayArea ?? tableArea(table.areaName), state: occupied ? "occupied" : "unknown", orders: matches };
  });
  return {
    businessDate, serverNow: now.toISOString(), snapshotAt: kpi.lastSuccessAt, catalogAt: catalog.collectedAt,
    catalogStatus: catalog.status, snapshotStatus: snapshotOk ? "ok" : kpi.status === "ok" ? "unavailable" : kpi.status,
    tables, unlinked: projected.filter(order => !assigned.has(order.id)),
    // Reservation/current paid/availability semantics have not been field-verified. Null means unknown, never zero.
    summary: { total: catalog.status === "ok" ? tables.length : null, occupied: catalogOk && snapshotOk ? tables.filter(table => table.state === "occupied").length : null,
      reserved: null, paid: null, free: null, unknown: tables.filter(table => table.state === "unknown").length },
  };
}
