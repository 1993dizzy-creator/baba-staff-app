export const INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE = "2026-09-23";
const INVENTORY_SNAPSHOT_NAME_SYNC_ROLES = new Set(["owner", "master"]);

export type InventorySnapshotNameSyncIssueCode =
  | "missing_ko"
  | "missing_vi"
  | "ko_changed"
  | "vi_changed"
  | "part_changed"
  | "category_changed"
  | "category_vi_changed"
  | "code_changed"
  | "unit_changed"
  | "purchase_price_changed"
  | "supplier_changed"
  | "supplier_partner_changed"
  | "quantity_review_required";

export type InventoryDailySyncField =
  | "item_name" | "item_name_vi" | "part" | "category" | "category_vi"
  | "code" | "unit" | "purchase_price" | "supplier" | "supplier_partner_id";

export type InventoryDailySyncLogRow = {
  id: number;
  item_id: number | null;
  business_date: string | null;
  created_at: string | null;
  reason: string | null;
  change_quantity: number | null;
  prev_quantity: number | null;
  new_quantity: number | null;
  item_name: string | null;
  item_name_vi: string | null;
  part: string | null;
  new_part?: string | null;
  category: string | null;
  category_vi: string | null;
  new_category?: string | null;
  new_category_vi?: string | null;
  code: string | null;
  new_code?: string | null;
  unit: string | null;
  new_unit?: string | null;
  new_purchase_price: number | null;
  new_supplier: string | null;
  purchase_supplier_partner_id: number | null;
};

export type CurrentInventoryDailySyncRow = {
  id: number;
  item_name: string | null;
  item_name_vi: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
  code: string | null;
  unit: string | null;
  purchase_price: number | null;
  supplier: string | null;
  supplier_partner_id: number | null;
  quantity: number | null;
  is_active: boolean | null;
};

export type InventoryDailySyncChange = {
  field: InventoryDailySyncField;
  from: string | number | null;
  to: string | number | null;
};

export type InventoryDailySyncTarget = {
  purchaseLogId: number;
  correctionLogId: number;
  changes: InventoryDailySyncChange[];
  quantityReviewRequired: boolean;
  syncItem: Omit<CurrentInventoryDailySyncRow, "id" | "quantity" | "is_active">;
};

export type InventorySnapshotNameSyncItem = {
  itemId: number;
  logIds: number[];
  currentItemName: string | null;
  currentItemNameVi: string | null;
  issues: InventorySnapshotNameSyncIssueCode[];
  changes: InventoryDailySyncChange[];
  targets: InventoryDailySyncTarget[];
  quantityReviewRequired: boolean;
};

export type InventoryDailySyncPlan = InventorySnapshotNameSyncItem & {
  businessDate: string;
};

const DISPLAY_FIELDS: InventoryDailySyncField[] = [
  "item_name", "item_name_vi", "part", "category", "category_vi", "code", "unit",
];
const ECONOMIC_FIELDS: InventoryDailySyncField[] = [
  "purchase_price", "supplier", "supplier_partner_id",
];
const SYNC_FIELDS = [...DISPLAY_FIELDS, ...ECONOMIC_FIELDS];

export const normalizeInventorySnapshotName = (value: string | null | undefined) =>
  String(value ?? "").trim();

const normalizeText = (value: unknown) => String(value ?? "").trim();
const normalizeNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};
const normalizedValue = (field: InventoryDailySyncField, value: unknown) =>
  field === "purchase_price" || field === "supplier_partner_id"
    ? normalizeNumber(value)
    : normalizeText(value);
const valuesEqual = (field: InventoryDailySyncField, left: unknown, right: unknown) =>
  normalizedValue(field, left) === normalizedValue(field, right);

export const isInventorySnapshotNameSyncEligible = (businessDate: string) =>
  businessDate >= INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE;

export const canRunInventorySnapshotNameSync = (role: string | null | undefined) =>
  INVENTORY_SNAPSHOT_NAME_SYNC_ROLES.has(String(role ?? "").trim().toLowerCase());

const isActualPurchase = (log: InventoryDailySyncLogRow) =>
  String(log.reason ?? "").trim().toLowerCase() === "purchase" &&
  Number(log.change_quantity ?? 0) > 0;
const isZeroQuantityCorrection = (log: InventoryDailySyncLogRow) =>
  Number(log.change_quantity ?? 0) === 0;

const logValue = (log: InventoryDailySyncLogRow, field: InventoryDailySyncField) => {
  if (field === "purchase_price") return log.new_purchase_price;
  if (field === "supplier") return log.new_supplier;
  if (field === "supplier_partner_id") return log.purchase_supplier_partner_id;
  if (field === "part") return log.new_part ?? log.part;
  if (field === "category") return log.new_category ?? log.category;
  if (field === "category_vi") return log.new_category_vi ?? log.category_vi;
  if (field === "code") return log.new_code ?? log.code;
  if (field === "unit") return log.new_unit ?? log.unit;
  return log[field];
};

const issueForChange = (change: InventoryDailySyncChange): InventorySnapshotNameSyncIssueCode => {
  if (change.field === "item_name") return normalizeText(change.from) ? "ko_changed" : "missing_ko";
  if (change.field === "item_name_vi") return normalizeText(change.from) ? "vi_changed" : "missing_vi";
  if (change.field === "purchase_price") return "purchase_price_changed";
  if (change.field === "supplier") return "supplier_changed";
  if (change.field === "supplier_partner_id") return "supplier_partner_changed";
  return `${change.field}_changed` as InventorySnapshotNameSyncIssueCode;
};

const sortLogs = (left: InventoryDailySyncLogRow, right: InventoryDailySyncLogRow) => {
  const timeDifference = String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
  return timeDifference || Number(left.id) - Number(right.id);
};

const toSyncItem = (
  correction: InventoryDailySyncLogRow,
  current: CurrentInventoryDailySyncRow,
  isLatestSegment: boolean
): InventoryDailySyncTarget["syncItem"] => {
  const result = {} as InventoryDailySyncTarget["syncItem"];
  for (const field of SYNC_FIELDS) {
    const correctionValue = logValue(correction, field);
    const value = isLatestSegment ? current[field] : correctionValue;
    Object.assign(result, { [field]: value ?? null });
  }
  return result;
};

const hasQuantityDiscrepancy = (log: InventoryDailySyncLogRow) => {
  const previous = normalizeNumber(log.prev_quantity);
  const next = normalizeNumber(log.new_quantity);
  return previous !== null && next !== null && previous !== next;
};

export function findInventoryLogNameSyncItems(
  businessDate: string,
  logs: readonly InventoryDailySyncLogRow[],
  inventoryItems: readonly CurrentInventoryDailySyncRow[]
): InventorySnapshotNameSyncItem[] {
  if (!isInventorySnapshotNameSyncEligible(businessDate)) return [];

  const activeInventoryById = new Map(
    inventoryItems.filter((item) => item.is_active === true).map((item) => [Number(item.id), item] as const)
  );
  const logsByItemId = new Map<number, InventoryDailySyncLogRow[]>();
  for (const log of logs) {
    const itemId = Number(log.item_id);
    if (log.business_date !== businessDate || !Number.isSafeInteger(itemId) || itemId < 1 || !activeInventoryById.has(itemId)) continue;
    const itemLogs = logsByItemId.get(itemId) ?? [];
    itemLogs.push(log);
    logsByItemId.set(itemId, itemLogs);
  }

  const items: InventorySnapshotNameSyncItem[] = [];
  for (const [itemId, unsortedLogs] of logsByItemId) {
    const current = activeInventoryById.get(itemId)!;
    const itemLogs = [...unsortedLogs].sort(sortLogs);
    const roots = itemLogs.filter(isActualPurchase);
    if (roots.length === 0) continue;

    const targets: InventoryDailySyncTarget[] = [];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      const nextRoot = roots[rootIndex + 1];
      const corrections = itemLogs.filter((log) =>
        isZeroQuantityCorrection(log) && sortLogs(log, root) > 0 && (!nextRoot || sortLogs(log, nextRoot) < 0)
      );
      const correction = corrections.at(-1);
      if (!correction) continue;

      const syncItem = toSyncItem(correction, current, !nextRoot);
      const changes = SYNC_FIELDS.flatMap((field) => {
        const from = logValue(root, field);
        const to = syncItem[field];
        return valuesEqual(field, from, to) ? [] : [{ field, from, to }];
      });
      const quantityReviewRequired = corrections.some(hasQuantityDiscrepancy);
      if (changes.length === 0 && !quantityReviewRequired) continue;
      targets.push({
        purchaseLogId: Number(root.id),
        correctionLogId: Number(correction.id),
        changes,
        quantityReviewRequired,
        syncItem,
      });
    }

    if (targets.length === 0) continue;
    const changes = targets.flatMap((target) => target.changes).filter((change, index, all) =>
      all.findIndex((candidate) => candidate.field === change.field && valuesEqual(change.field, candidate.from, change.from) && valuesEqual(change.field, candidate.to, change.to)) === index
    );
    const quantityReviewRequired = targets.some((target) => target.quantityReviewRequired);
    const issues = Array.from(new Set([
      ...changes.map(issueForChange),
      ...(quantityReviewRequired ? ["quantity_review_required" as const] : []),
    ]));

    items.push({
      itemId,
      logIds: targets.map((target) => target.purchaseLogId),
      currentItemName: current.item_name,
      currentItemNameVi: current.item_name_vi,
      issues,
      changes,
      targets,
      quantityReviewRequired,
    });
  }
  return items;
}

export function planInventoryLogNameUpdates(
  businessDate: string,
  logs: readonly InventoryDailySyncLogRow[],
  inventoryItems: readonly CurrentInventoryDailySyncRow[],
  itemId?: number
): InventoryDailySyncPlan[] {
  return findInventoryLogNameSyncItems(businessDate, logs, inventoryItems)
    .filter((item) => itemId === undefined || item.itemId === itemId)
    .map((item) => ({ ...item, businessDate }));
}
