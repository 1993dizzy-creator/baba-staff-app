import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { roundDecimal } from "@/lib/inventory/number";
import {
  normalizeInventoryCode,
  normalizeInventoryName,
} from "@/lib/inventory/normalize";
import { getBusinessDate } from "@/lib/common/business-time";
import { insertInventoryPriceLog } from "@/lib/inventory/price-logs";
import {
  type InventoryReasonValue,
  type InventorySourceValue,
  getReasonByRegistrationType,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const INVENTORY_IMAGE_BUCKET = "inventory-images";
const POS_ITEM_MAPPING_FK_CONSTRAINT =
  "pos_item_mappings_inventory_item_id_fkey";
const POS_INVENTORY_DEDUCTION_FK_CONSTRAINT =
  "pos_inventory_deductions_inventory_item_id_fkey";
const INVENTORY_RELATED_HISTORY_FK_TARGETS = [
  "inventory_logs",
  "inventory_price_logs",
  "inventory_snapshot_items",
];
const POS_SALES_PAGE_SIZE = 1000;

type KegTrackingMappingRow = {
  inventory_item_id: number | string | null;
  pos_product_id: number | string | null;
  quantity_per_pos_unit: number | string | null;
};

type ActiveKegSessionRow = {
  id: number | string;
  inventory_item_id: number | string;
  started_at: string;
  capacity_quantity: number | string;
  capacity_unit: string | null;
};

type PosProductRow = {
  id: number | string;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
};

type PosReceiptLineRow = {
  id: number | string;
  receipt_id: number | string | null;
  item_id: string | null;
  item_code: string | null;
  quantity: number | string | null;
  is_option: boolean | null;
  is_excluded: boolean | null;
  is_canceled: boolean | null;
  payment_status: number | null;
  ref_date: string | null;
  synced_at: string | null;
  updated_at: string | null;
};

type PosReceiptRow = {
  id: number | string;
  ref_date: string | null;
  synced_at: string | null;
  updated_at: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
};

type KegProgress = {
  activeSessionId: number;
  startedAt: string;
  capacityMl: number;
  soldMl: number;
  usagePercent: number;
  remainingPercent: number;
};

const jsonError = (
  error: string,
  message: string,
  status = 500,
  extra?: Record<string, unknown>
) =>
  NextResponse.json(
    {
      ok: false,
      error,
      message,
      ...extra,
    },
    { status }
  );

const getActor = async (actorUsername?: string) => {
  if (!actorUsername) return null;

  const { data } = await supabaseAdmin
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  return data;
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const asPositiveNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const asOptionalKey = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const getLineReferenceTime = (
  line: PosReceiptLineRow,
  receipt: PosReceiptRow | undefined
) => {
  const candidates = [
    line.ref_date,
    receipt?.ref_date,
    line.synced_at,
    receipt?.synced_at,
    line.updated_at,
    receipt?.updated_at,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const time = Date.parse(candidate);
    if (Number.isFinite(time)) return time;
  }

  return null;
};

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const buildKegProgress = (params: {
  session: ActiveKegSessionRow;
  capacityMl: number;
  soldMl: number;
}) => {
  const soldMl = roundDecimal(params.soldMl);
  const usagePercent = roundDecimal((soldMl / params.capacityMl) * 100);
  const remainingPercent = roundDecimal(Math.max(0, 100 - usagePercent));

  return {
    activeSessionId: Number(params.session.id),
    startedAt: params.session.started_at,
    capacityMl: params.capacityMl,
    soldMl,
    usagePercent,
    remainingPercent,
  } satisfies KegProgress;
};

async function fetchKegProgressByItemId(
  inventoryItems: Array<Record<string, unknown>>,
  kegCandidateIds: number[]
) {
  const progressByItemId = new Map<number, KegProgress>();
  if (kegCandidateIds.length === 0) return progressByItemId;

  const { data: mappingsData, error: mappingError } = await supabaseAdmin
    .from("inventory_keg_tracking_mappings")
    .select("inventory_item_id, pos_product_id, quantity_per_pos_unit")
    .in("inventory_item_id", kegCandidateIds)
    .eq("is_active", true)
    .eq("target_type", "product");

  if (mappingError) throw mappingError;

  const mappings = (mappingsData || []) as KegTrackingMappingRow[];
  if (mappings.length === 0) return progressByItemId;

  const activeTrackingItemIds = Array.from(
    new Set(
      mappings
        .map((mapping) => Number(mapping.inventory_item_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  const { data: sessionsData, error: sessionError } = await supabaseAdmin
    .from("inventory_keg_sessions")
    .select("id, inventory_item_id, started_at, capacity_quantity, capacity_unit")
    .in("inventory_item_id", activeTrackingItemIds)
    .eq("status", "active");

  if (sessionError) throw sessionError;

  const activeSessionByItemId = new Map<number, ActiveKegSessionRow>();
  for (const session of (sessionsData || []) as ActiveKegSessionRow[]) {
    const itemId = Number(session.inventory_item_id);
    if (Number.isFinite(itemId) && itemId > 0) {
      activeSessionByItemId.set(itemId, session);
    }
  }

  if (activeSessionByItemId.size === 0) return progressByItemId;

  const productIds = Array.from(
    new Set(
      mappings
        .map((mapping) => Number(mapping.pos_product_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  const inventoryById = new Map(
    inventoryItems.map((item) => [Number(item.id), item])
  );

  for (const itemId of activeTrackingItemIds) {
    const session = activeSessionByItemId.get(itemId);
    const inventoryItem = inventoryById.get(itemId);
    if (!session || !inventoryItem) continue;

    const sessionStartTime = Date.parse(session.started_at);
    const capacityMl =
      asPositiveNumber(session.capacity_quantity) ||
      asPositiveNumber(inventoryItem.package_content_quantity);
    if (!Number.isFinite(sessionStartTime) || capacityMl <= 0) continue;

    progressByItemId.set(
      itemId,
      buildKegProgress({ session, capacityMl, soldMl: 0 })
    );
  }

  if (productIds.length === 0) return progressByItemId;

  const productRows: PosProductRow[] = [];
  for (const ids of chunkArray(productIds, 500)) {
    const { data, error } = await supabaseAdmin
      .from("pos_products")
      .select("id, pos_item_id, item_id, item_code")
      .in("id", ids);

    if (error) throw error;
    productRows.push(...((data || []) as PosProductRow[]));
  }

  const productById = new Map(
    productRows.map((product) => [Number(product.id), product])
  );
  const earliestStartedAt = Array.from(activeSessionByItemId.values()).reduce(
    (earliest, session) =>
      !earliest || session.started_at < earliest ? session.started_at : earliest,
    ""
  );

  const receiptRows: PosReceiptRow[] = [];
  for (let from = 0; ; from += POS_SALES_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("pos_sales_receipts")
      .select("id, ref_date, synced_at, updated_at, payment_status, is_canceled")
      .eq("payment_status", 3)
      .or(
        `ref_date.gte.${earliestStartedAt},synced_at.gte.${earliestStartedAt},updated_at.gte.${earliestStartedAt}`
      )
      .order("ref_date", { ascending: false, nullsFirst: false })
      .range(from, from + POS_SALES_PAGE_SIZE - 1);

    if (error) throw error;
    receiptRows.push(...((data || []) as PosReceiptRow[]));
    if (!data || data.length < POS_SALES_PAGE_SIZE) break;
  }

  const lineRowsById = new Map<string, PosReceiptLineRow>();
  const receiptIds = receiptRows
    .map((receipt) => Number(receipt.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  for (const ids of chunkArray(receiptIds, 500)) {
    const { data, error } = await supabaseAdmin
      .from("pos_sales_receipt_lines")
      .select(
        "id, receipt_id, item_id, item_code, quantity, is_option, is_excluded, is_canceled, payment_status, ref_date, synced_at, updated_at"
      )
      .in("receipt_id", ids)
      .eq("payment_status", 3);

    if (error) throw error;
    for (const line of (data || []) as PosReceiptLineRow[]) {
      lineRowsById.set(String(line.id), line);
    }
  }

  for (let from = 0; ; from += POS_SALES_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("pos_sales_receipt_lines")
      .select(
        "id, receipt_id, item_id, item_code, quantity, is_option, is_excluded, is_canceled, payment_status, ref_date, synced_at, updated_at"
      )
      .eq("payment_status", 3)
      .or(
        `ref_date.gte.${earliestStartedAt},synced_at.gte.${earliestStartedAt},updated_at.gte.${earliestStartedAt}`
      )
      .order("ref_date", { ascending: false, nullsFirst: false })
      .range(from, from + POS_SALES_PAGE_SIZE - 1);

    if (error) throw error;
    for (const line of (data || []) as PosReceiptLineRow[]) {
      lineRowsById.set(String(line.id), line);
    }
    if (!data || data.length < POS_SALES_PAGE_SIZE) break;
  }

  const lineRows = Array.from(lineRowsById.values());
  const missingReceiptIds = Array.from(
    new Set(
      lineRows
        .map((line) => Number(line.receipt_id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .filter((id) => !receiptIds.includes(id))
    )
  );
  for (const ids of chunkArray(missingReceiptIds, 500)) {
    const { data, error } = await supabaseAdmin
      .from("pos_sales_receipts")
      .select("id, ref_date, synced_at, updated_at, payment_status, is_canceled")
      .in("id", ids);

    if (error) throw error;
    receiptRows.push(...((data || []) as PosReceiptRow[]));
  }

  const receiptById = new Map(
    receiptRows.map((receipt) => [Number(receipt.id), receipt])
  );
  const linesByKey = new Map<string, PosReceiptLineRow[]>();

  for (const line of lineRows) {
    if (
      line.is_option === true ||
      line.is_excluded === true ||
      line.is_canceled === true ||
      Number(line.payment_status) !== 3
    ) {
      continue;
    }

    const receipt = receiptById.get(Number(line.receipt_id));
    if (
      !receipt ||
      receipt.is_canceled === true ||
      Number(receipt.payment_status) !== 3
    ) {
      continue;
    }

    const itemId = asOptionalKey(line.item_id);
    const itemCode = asOptionalKey(line.item_code);
    const keys = [
      itemId ? `item_id:${itemId}` : null,
      itemCode ? `item_code:${itemCode}` : null,
    ].filter((key): key is string => Boolean(key));

    for (const key of keys) {
      const existing = linesByKey.get(key) || [];
      existing.push(line);
      linesByKey.set(key, existing);
    }
  }

  for (const itemId of activeTrackingItemIds) {
    const session = activeSessionByItemId.get(itemId);
    const inventoryItem = inventoryById.get(itemId);
    if (!session || !inventoryItem) continue;

    const sessionStartTime = Date.parse(session.started_at);
    const capacityMl =
      asPositiveNumber(session.capacity_quantity) ||
      asPositiveNumber(inventoryItem.package_content_quantity);
    if (!Number.isFinite(sessionStartTime) || capacityMl <= 0) continue;

    let soldMl = 0;
    const itemMappings = mappings.filter(
      (mapping) => Number(mapping.inventory_item_id) === itemId
    );

    for (const mapping of itemMappings) {
      const product = productById.get(Number(mapping.pos_product_id));
      const quantityPerPosUnit = asPositiveNumber(
        mapping.quantity_per_pos_unit
      );
      if (!product || quantityPerPosUnit <= 0) continue;

      const posItemId = asOptionalKey(product.pos_item_id);
      const itemIdKey = asOptionalKey(product.item_id);
      const itemCode = asOptionalKey(product.item_code);
      const productKeys = [
        posItemId ? `item_id:${posItemId}` : null,
        itemIdKey ? `item_id:${itemIdKey}` : null,
        itemCode ? `item_code:${itemCode}` : null,
      ].filter((key): key is string => Boolean(key));

      const countedLineIds = new Set<string>();
      for (const key of productKeys) {
        for (const line of linesByKey.get(key) || []) {
          const lineId = String(line.id);
          if (countedLineIds.has(lineId)) continue;
          const receipt = receiptById.get(Number(line.receipt_id));
          const referenceTime = getLineReferenceTime(line, receipt);
          if (referenceTime === null || referenceTime < sessionStartTime) {
            continue;
          }

          countedLineIds.add(lineId);
          soldMl += asPositiveNumber(line.quantity) * quantityPerPosUnit;
        }
      }
    }

    progressByItemId.set(itemId, buildKegProgress({ session, capacityMl, soldMl }));
  }

  return progressByItemId;
}

const getSupabaseErrorField = (error: unknown, field: string) => {
  if (!error || typeof error !== "object") return undefined;

  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
};

const PACKAGE_CONTENT_UNITS = new Set(["ml", "g"]);

const normalizeOptionalPositiveNumber = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const normalizePackageContentPayload = (payload: Record<string, unknown>) => {
  const hasQuantity = Object.prototype.hasOwnProperty.call(
    payload,
    "package_content_quantity"
  );
  const hasUnit = Object.prototype.hasOwnProperty.call(
    payload,
    "package_content_unit"
  );

  if (!hasQuantity && !hasUnit) {
    return true;
  }

  const quantity = normalizeOptionalPositiveNumber(
    payload.package_content_quantity
  );
  const unit =
    typeof payload.package_content_unit === "string"
      ? payload.package_content_unit.trim().toLowerCase()
      : payload.package_content_unit === undefined ||
          payload.package_content_unit === null
        ? ""
        : undefined;

  if (quantity === undefined || unit === undefined) {
    return false;
  }

  if (quantity === null && unit === "") {
    payload.package_content_quantity = null;
    payload.package_content_unit = null;
    return true;
  }

  if (quantity === null || unit === "" || !PACKAGE_CONTENT_UNITS.has(unit)) {
    return false;
  }

  payload.package_content_quantity = quantity;
  payload.package_content_unit = unit;
  return true;
};

const isPosReferenceFkError = (error: unknown) => {
  const code = getSupabaseErrorField(error, "code");
  const message = getErrorMessage(error);
  const details = getSupabaseErrorField(error, "details") ?? "";
  const constraint = getSupabaseErrorField(error, "constraint") ?? "";

  return (
    code === "23503" &&
    (message.includes(POS_ITEM_MAPPING_FK_CONSTRAINT) ||
      details.includes(POS_ITEM_MAPPING_FK_CONSTRAINT) ||
      constraint.includes(POS_ITEM_MAPPING_FK_CONSTRAINT) ||
      message.includes(POS_INVENTORY_DEDUCTION_FK_CONSTRAINT) ||
      details.includes(POS_INVENTORY_DEDUCTION_FK_CONSTRAINT) ||
      constraint.includes(POS_INVENTORY_DEDUCTION_FK_CONSTRAINT))
  );
};

const isInventoryRelatedHistoryFkError = (error: unknown) => {
  const code = getSupabaseErrorField(error, "code");
  const message = getErrorMessage(error);
  const details = getSupabaseErrorField(error, "details") ?? "";
  const constraint = getSupabaseErrorField(error, "constraint") ?? "";

  return (
    code === "23503" &&
    INVENTORY_RELATED_HISTORY_FK_TARGETS.some(
      (target) =>
        message.includes(target) ||
        details.includes(target) ||
        constraint.includes(target)
    )
  );
};

type InventoryLogPayload = Record<string, unknown>;

type DuplicateInventoryItem = {
  id: number;
  item_name: string | null;
  item_name_vi: string | null;
  code: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
};

const findDuplicateInventoryItem = async (
  itemNameVi: unknown,
  code: unknown,
  excludeId?: number
) => {
  const normalizedName = normalizeInventoryName(itemNameVi);

  if (!normalizedName) return null;

  const normalizedCode = normalizeInventoryCode(code);
  let query = supabaseAdmin
    .from("inventory")
    .select("id, item_name, item_name_vi, code, part, category, category_vi");

  if (excludeId !== undefined) {
    query = query.neq("id", excludeId);
  }

  const { data, error } = await query;

  if (error) throw error;

  return ((data || []) as DuplicateInventoryItem[]).find((item) => {
    return (
      normalizeInventoryName(item.item_name_vi) === normalizedName &&
      normalizeInventoryCode(item.code) === normalizedCode
    );
  }) ?? null;
};

const duplicateInventoryItemResponse = (duplicateItem: DuplicateInventoryItem) =>
  NextResponse.json(
    {
      ok: false,
      error: "inventory_item_duplicate_name_vi",
      message: "Duplicate inventory item.",
      duplicateItem,
    },
    { status: 409 }
  );

const insertInventoryLog = async (
  payload: InventoryLogPayload,
  meta: {
    reason: InventoryReasonValue;
    source: InventorySourceValue;
    businessDate?: string;
  }
) => {
  const businessDate = meta.businessDate ?? getBusinessDate();
  const logPayload = {
    ...payload,
    reason: meta.reason,
    source: meta.source,
    business_date: businessDate,
  };

  const { data, error } = await supabaseAdmin
    .from("inventory_logs")
    .insert([logPayload])
    .select("id, reason, source, business_date")
    .single();

  if (error) throw error;

  if (data && (!data.reason || !data.source || !data.business_date)) {
    const { error: metadataError } = await supabaseAdmin
      .from("inventory_logs")
      .update({
        reason: meta.reason,
        source: meta.source,
        business_date: businessDate,
      })
      .eq("id", data.id);

    if (metadataError) throw metadataError;
  }

  return data;
};

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("inventory")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const items = data || [];
    const kegCandidateIds = items
      .filter((item) => {
        const unit = String(item.unit || "").trim().toLowerCase();
        const packageUnit = String(item.package_content_unit || "")
          .trim()
          .toLowerCase();
        const packageQuantity = Number(item.package_content_quantity ?? 0);

        return unit === "keg" && packageUnit === "ml" && packageQuantity > 0;
      })
      .map((item) => Number(item.id))
      .filter((id) => Number.isFinite(id) && id > 0);
    const activeKegTrackingIds = new Set<number>();
    const kegProgressByItemId = await fetchKegProgressByItemId(
      items,
      kegCandidateIds
    );

    if (kegCandidateIds.length > 0) {
      const { data: mappings, error: mappingError } = await supabaseAdmin
        .from("inventory_keg_tracking_mappings")
        .select("inventory_item_id")
        .in("inventory_item_id", kegCandidateIds)
        .eq("is_active", true)
        .eq("target_type", "product");

      if (mappingError) throw mappingError;

      (mappings || []).forEach((mapping) => {
        const id = Number(mapping.inventory_item_id);
        if (Number.isFinite(id) && id > 0) {
          activeKegTrackingIds.add(id);
        }
      });
    }

    return NextResponse.json({
      ok: true,
      data: items.map((item) => ({
        ...item,
        has_active_keg_tracking: activeKegTrackingIds.has(Number(item.id)),
        kegProgress: kegProgressByItemId.get(Number(item.id)) ?? null,
      })),
    });
  } catch (error) {
    console.error("[INVENTORY_ITEMS_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { payload, actorUsername, registrationType, reason } = body;

    if (!payload) {
      return NextResponse.json(
        { ok: false, message: "Missing payload" },
        { status: 400 }
      );
    }

    if (!normalizePackageContentPayload(payload)) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "package_content_quantity and package_content_unit must both be valid when provided.",
        },
        { status: 400 }
      );
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    const duplicateItem = await findDuplicateInventoryItem(
      payload.item_name_vi,
      payload.code
    );

    if (duplicateItem) {
      return duplicateInventoryItemResponse(duplicateItem);
    }

    const { data: insertedData, error } = await supabaseAdmin
      .from("inventory")
      .insert([payload])
      .select()
      .single();

    if (error || !insertedData) throw error;

    const logReason =
      registrationType === "existing_stock" || registrationType === "new_purchase"
        ? getReasonByRegistrationType(registrationType)
        : normalizeInventoryReason(reason, "unclassified");

    const businessDate = getBusinessDate();

    await insertInventoryLog(
      {
        item_id: insertedData.id,
        item_name: insertedData.item_name ?? null,
        item_name_vi: insertedData.item_name_vi ?? null,
        action: "create",

        part: insertedData.part ?? null,
        category: insertedData.category ?? null,
        category_vi: insertedData.category_vi ?? null,

        prev_quantity: 0,
        new_quantity: insertedData.quantity ?? 0,
        change_quantity: insertedData.quantity ?? 0,

        prev_purchase_price: null,
        new_purchase_price: insertedData.purchase_price ?? null,

        prev_note: null,
        new_note: insertedData.note ?? null,

        prev_supplier: null,
        new_supplier: insertedData.supplier ?? null,

        prev_code: null,
        new_code: insertedData.code ?? null,

        prev_unit: null,
        new_unit: insertedData.unit ?? null,

        prev_category: null,
        new_category: insertedData.category ?? null,

        prev_category_vi: null,
        new_category_vi: insertedData.category_vi ?? null,

        prev_part: null,
        new_part: insertedData.part ?? null,

        unit: insertedData.unit ?? null,
        code: insertedData.code ?? null,

        actor_name: actor.name || "",
        actor_username: actor.username || "",

        prev_low_stock_threshold: null,
        new_low_stock_threshold: insertedData.low_stock_threshold ?? 1,
      },
      {
        reason: logReason,
        source: "create",
        businessDate,
      }
    );

    await insertInventoryPriceLog({
      supabase: supabaseAdmin,
      itemId: insertedData.id,
      itemName: insertedData.item_name,
      itemCode: insertedData.code,
      oldPrice: null,
      newPrice: insertedData.purchase_price,
      businessDate,
      source: "create",
      reason: "create",
      actorUsername: actor.username,
    });

    return NextResponse.json({ ok: true, data: insertedData });
  } catch (error) {
    console.error("[INVENTORY_POST_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const {
      mode,
      id,
      payload,
      actorUsername,
      expectedQuantity,
      reason,
    } = body;

    if (!id || !payload) {
      return NextResponse.json(
        { ok: false, message: "Missing id or payload" },
        { status: 400 }
      );
    }

    if (!normalizePackageContentPayload(payload)) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "package_content_quantity and package_content_unit must both be valid when provided.",
        },
        { status: 400 }
      );
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    const { data: prevItem, error: prevError } = await supabaseAdmin
      .from("inventory")
      .select(`
    id,
    item_name,
    item_name_vi,
    part,
    category,
    category_vi,
    quantity,
    purchase_price,
    note,
    unit,
    code,
    supplier,
    low_stock_threshold,
    package_content_quantity,
    package_content_unit,
    image_path
  `)
      .eq("id", Number(id))
      .maybeSingle();

    if (prevError) throw prevError;

    if (!prevItem) {
      return NextResponse.json(
        { ok: false, message: "Target not found" },
        { status: 404 }
      );
    }

    if (mode === "quick-save" && expectedQuantity !== undefined) {
      const currentQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
      const baseQuantity = roundDecimal(Number(expectedQuantity));

      if (!Number.isFinite(baseQuantity)) {
        return NextResponse.json(
          { ok: false, message: "Invalid expected quantity" },
          { status: 400 }
        );
      }

      if (currentQuantity !== baseQuantity) {
        return NextResponse.json(
          {
            ok: false,
            code: "QUANTITY_CONFLICT",
            message:
              "Inventory quantity was changed by another user. Refresh and try again.",
            currentQuantity,
          },
          { status: 409 }
        );
      }
    }

    if (mode !== "quick-save") {
      const nextItemNameVi = Object.prototype.hasOwnProperty.call(
        payload,
        "item_name_vi"
      )
        ? payload.item_name_vi
        : prevItem.item_name_vi;
      const nextCode = Object.prototype.hasOwnProperty.call(payload, "code")
        ? payload.code
        : prevItem.code;
      const duplicateItem = await findDuplicateInventoryItem(
        nextItemNameVi,
        nextCode,
        Number(prevItem.id)
      );

      if (duplicateItem) {
        return duplicateInventoryItemResponse(duplicateItem);
      }
    }

    const { data: updatedItem, error: updateError } = await supabaseAdmin
      .from("inventory")
      .update(payload)
      .eq("id", Number(id))
      .select(`
    id,
    item_name,
    item_name_vi,
    part,
    category,
    category_vi,
    quantity,
    purchase_price,
    note,
    unit,
    code,
    supplier,
    low_stock_threshold,
    package_content_quantity,
    package_content_unit,
    image_path
  `)
      .single();

    if (updateError || !updatedItem) throw updateError;

    const prevQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
    const newQuantity = roundDecimal(Number(updatedItem.quantity ?? 0));
    const changeQuantity = roundDecimal(newQuantity - prevQuantity);
    const fallbackLogReason = changeQuantity !== 0 ? "stock_check" : "other";
    const logReason =
      mode === "quick-save"
        ? normalizeInventoryReason(reason, "stock_check")
        : Object.prototype.hasOwnProperty.call(body, "reason")
          ? normalizeInventoryReason(reason, fallbackLogReason)
          : fallbackLogReason;
    const logSource = mode === "quick-save" ? "quick_save" : "edit_form";

    const businessDate = getBusinessDate();

    await insertInventoryLog(
      {
        item_id: updatedItem.id,
        item_name: updatedItem.item_name ?? null,
        item_name_vi: updatedItem.item_name_vi ?? null,
        action: "update",

        part: updatedItem.part ?? null,
        category: updatedItem.category ?? null,
        category_vi: updatedItem.category_vi ?? null,

        prev_quantity: prevQuantity,
        new_quantity: newQuantity,
        change_quantity: changeQuantity,

        prev_purchase_price: prevItem.purchase_price ?? null,
        new_purchase_price: updatedItem.purchase_price ?? null,

        prev_note: prevItem.note ?? null,
        new_note: updatedItem.note ?? null,

        prev_supplier: prevItem.supplier ?? null,
        new_supplier: updatedItem.supplier ?? null,

        prev_code: prevItem.code ?? null,
        new_code: updatedItem.code ?? null,

        prev_unit: prevItem.unit ?? null,
        new_unit: updatedItem.unit ?? null,

        prev_category: prevItem.category ?? null,
        new_category: updatedItem.category ?? null,

        prev_category_vi: prevItem.category_vi ?? null,
        new_category_vi: updatedItem.category_vi ?? null,

        prev_part: prevItem.part ?? null,
        new_part: updatedItem.part ?? null,

        unit: updatedItem.unit ?? null,
        code: updatedItem.code ?? null,

        actor_name: actor.name || "",
        actor_username: actor.username || "",

        prev_low_stock_threshold: prevItem.low_stock_threshold ?? 1,
        new_low_stock_threshold: updatedItem.low_stock_threshold ?? 1,
      },
      {
        reason: logReason,
        source: logSource,
        businessDate,
      }
    );

    if (mode === "quick-save" && logReason === "purchase") {
      await insertInventoryPriceLog({
        supabase: supabaseAdmin,
        itemId: updatedItem.id,
        itemName: updatedItem.item_name,
        itemCode: updatedItem.code,
        oldPrice: prevItem.purchase_price,
        newPrice: updatedItem.purchase_price,
        businessDate,
        source: "quick_save",
        reason: "purchase",
        actorUsername: actor.username,
      });
    }

    if (
      mode !== "quick-save" &&
      Object.prototype.hasOwnProperty.call(payload, "purchase_price")
    ) {
      await insertInventoryPriceLog({
        supabase: supabaseAdmin,
        itemId: updatedItem.id,
        itemName: updatedItem.item_name,
        itemCode: updatedItem.code,
        oldPrice: prevItem.purchase_price,
        newPrice: updatedItem.purchase_price,
        businessDate: typeof body.business_date === "string" ? body.business_date : businessDate,
        source: "edit_form",
        reason: "manual_price_update",
        actorUsername: actor.username,
      });
    }

    return NextResponse.json({ ok: true, mode });
  } catch (error) {
    console.error("[INVENTORY_PATCH_ERROR]", error);
    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const {
      id,
      actorUsername,
      deleteRelatedHistory,
      deletePosMappings,
      deletePosReferences,
    } = body;
    const itemId = Number(id);
    const shouldDeleteRelatedHistory = deleteRelatedHistory === true;
    const shouldDeletePosReferences =
      shouldDeleteRelatedHistory ||
      deletePosReferences === true ||
      deletePosMappings === true;

    if (!id) {
      return jsonError("missing_item_id", "Missing id", 400);
    }

    if (!Number.isFinite(itemId) || itemId <= 0) {
      return jsonError("invalid_item_id", "Invalid id", 400);
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return jsonError("missing_actor", "Invalid user", 401);
    }

    if (actor.role !== "owner" && actor.role !== "master") {
      return jsonError(
        "inventory_item_delete_forbidden",
        "Inventory item deletion requires admin permission.",
        403
      );
    }

    const { data: targetItem, error: selectError } = await supabaseAdmin
      .from("inventory")
      .select(`
        id,
        item_name,
        item_name_vi,
        part,
        category,
        category_vi,
        quantity,
        purchase_price,
        note,
        unit,
        code,
        supplier,
        low_stock_threshold,
        package_content_quantity,
        package_content_unit,
        image_path
      `)
      .eq("id", itemId)
      .maybeSingle();

    if (selectError) {
      return jsonError(
        "inventory_item_select_failed",
        selectError.message,
        500
      );
    }

    if (!targetItem) {
      return jsonError("inventory_item_not_found", "Target not found", 404);
    }

    const deletedItem = targetItem;

    const [
      mappingCountResult,
      appliedDeductionCountResult,
      failedDeductionCountResult,
      inventoryLogCountResult,
      inventoryPriceLogCountResult,
      inventorySnapshotItemCountResult,
    ] = await Promise.all([
      supabaseAdmin
        .from("pos_item_mappings")
        .select("id", { count: "exact", head: true })
        .eq("inventory_item_id", itemId),
      supabaseAdmin
        .from("pos_inventory_deductions")
        .select("id", { count: "exact", head: true })
        .eq("inventory_item_id", itemId)
        .or(
          "status.eq.applied,status.eq.success,applied_at.not.is.null,inventory_log_id.not.is.null"
        ),
      supabaseAdmin
        .from("pos_inventory_deductions")
        .select("id", { count: "exact", head: true })
        .eq("inventory_item_id", itemId)
        .eq("status", "failed")
        .is("applied_at", null)
        .is("inventory_log_id", null),
      supabaseAdmin
        .from("inventory_logs")
        .select("id", { count: "exact", head: true })
        .eq("item_id", itemId),
      supabaseAdmin
        .from("inventory_price_logs")
        .select("id", { count: "exact", head: true })
        .eq("item_id", itemId),
      supabaseAdmin
        .from("inventory_snapshot_items")
        .select("id", { count: "exact", head: true })
        .eq("item_id", itemId),
    ]);

    const relatedHistoryCountError =
      mappingCountResult.error ||
      appliedDeductionCountResult.error ||
      failedDeductionCountResult.error ||
      inventoryLogCountResult.error ||
      inventoryPriceLogCountResult.error ||
      inventorySnapshotItemCountResult.error;

    if (relatedHistoryCountError) {
      return jsonError(
        "inventory_item_delete_failed",
        relatedHistoryCountError.message,
        500
      );
    }

    const posMappingCount = mappingCountResult.count ?? 0;
    const appliedDeductionCount = appliedDeductionCountResult.count ?? 0;
    const failedDeductionCount = failedDeductionCountResult.count ?? 0;
    const inventoryLogCount = inventoryLogCountResult.count ?? 0;
    const inventoryPriceLogCount = inventoryPriceLogCountResult.count ?? 0;
    const inventorySnapshotItemCount =
      inventorySnapshotItemCountResult.count ?? 0;
    const relatedHistoryCounts = {
      inventoryLogCount,
      inventoryPriceLogCount,
      inventorySnapshotItemCount,
      posMappingCount,
      failedDeductionCount,
      appliedDeductionCount,
    };
    const hasRelatedInventoryHistory =
      inventoryLogCount > 0 ||
      inventoryPriceLogCount > 0 ||
      inventorySnapshotItemCount > 0;
    const hasPosReferences =
      posMappingCount > 0 ||
      failedDeductionCount > 0 ||
      appliedDeductionCount > 0;

    if (!shouldDeleteRelatedHistory && hasRelatedInventoryHistory) {
      return jsonError(
        "inventory_item_has_related_history",
        "This inventory item has related inventory history.",
        409,
        relatedHistoryCounts
      );
    }

    if (!shouldDeletePosReferences && hasPosReferences) {
      return jsonError(
        "inventory_item_has_pos_references",
        "This inventory item is linked to POS references.",
        409,
        relatedHistoryCounts
      );
    }

    if (shouldDeletePosReferences) {
      const { error: deductionDeleteError } = await supabaseAdmin
        .from("pos_inventory_deductions")
        .delete()
        .eq("inventory_item_id", itemId);

      if (deductionDeleteError) {
        return jsonError(
          "pos_inventory_deductions_delete_failed",
          deductionDeleteError.message,
          500,
          relatedHistoryCounts
        );
      }
    }

    if (shouldDeletePosReferences) {
      const { error: mappingDeleteError } = await supabaseAdmin
        .from("pos_item_mappings")
        .delete()
        .eq("inventory_item_id", itemId);

      if (mappingDeleteError) {
        return jsonError(
          "pos_item_mappings_delete_failed",
          mappingDeleteError.message,
          500,
          relatedHistoryCounts
        );
      }
    }

    if (shouldDeleteRelatedHistory) {
      const { error: inventoryLogDeleteError } = await supabaseAdmin
        .from("inventory_logs")
        .delete()
        .eq("item_id", itemId);

      if (inventoryLogDeleteError) {
        return jsonError(
          "inventory_logs_delete_failed",
          inventoryLogDeleteError.message,
          500,
          relatedHistoryCounts
        );
      }
    }

    if (shouldDeleteRelatedHistory) {
      const { error: priceLogDeleteError } = await supabaseAdmin
        .from("inventory_price_logs")
        .delete()
        .eq("item_id", itemId);

      if (priceLogDeleteError) {
        return jsonError(
          "inventory_price_logs_delete_failed",
          priceLogDeleteError.message,
          500,
          relatedHistoryCounts
        );
      }
    }

    if (shouldDeleteRelatedHistory) {
      const { error: snapshotItemDeleteError } = await supabaseAdmin
        .from("inventory_snapshot_items")
        .delete()
        .eq("item_id", itemId);

      if (snapshotItemDeleteError) {
        return jsonError(
          "inventory_snapshot_items_delete_failed",
          snapshotItemDeleteError.message,
          500,
          relatedHistoryCounts
        );
      }
    }

    const { error: deleteError } = await supabaseAdmin
      .from("inventory")
      .delete()
      .eq("id", itemId);

    if (deleteError) {
      if (isInventoryRelatedHistoryFkError(deleteError)) {
        return jsonError(
          "inventory_item_has_related_history",
          "This inventory item has related inventory history.",
          409,
          relatedHistoryCounts
        );
      }

      if (isPosReferenceFkError(deleteError)) {
        return jsonError(
          "inventory_item_has_pos_references",
          "This inventory item is linked to POS references.",
          409,
          relatedHistoryCounts
        );
      }

      return jsonError(
        "inventory_item_delete_failed",
        deleteError.message,
        500
      );
    }

    let photoCleanupWarning: string | undefined;

    if (deletedItem.image_path) {
      const { error: removeImageError } = await supabaseAdmin.storage
        .from(INVENTORY_IMAGE_BUCKET)
        .remove([deletedItem.image_path]);

      if (removeImageError) {
        photoCleanupWarning = "inventory_photo_cleanup_warning";
        console.warn("[INVENTORY_DELETE_IMAGE_CLEANUP_ERROR]", {
          itemId,
          imagePath: deletedItem.image_path,
          message: removeImageError.message,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      warning: photoCleanupWarning,
    });
  } catch (error) {
    console.error("[INVENTORY_DELETE_ERROR]", error);
    return jsonError(
      "inventory_item_delete_failed",
      getErrorMessage(error),
      500
    );
  }
}
