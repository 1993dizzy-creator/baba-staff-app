import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  getAuthenticatedActor,
  type AuthenticatedActor,
} from "@/lib/auth/server-auth";
import { roundDecimal } from "@/lib/inventory/number";
import {
  fetchKegProgressByItemId,
  type KegProgress,
} from "@/lib/inventory/keg-progress";
import {
  buildInventoryItemsResponse,
  canToggleInventoryItemActiveStatus,
  fetchActiveKegTrackingMappings,
  fetchInventoryItems,
  getInventoryKegCandidateIds,
} from "@/lib/inventory/items-server";
import {
  normalizeInventoryCode,
  normalizeInventoryName,
} from "@/lib/inventory/normalize";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import {
  purchaseCorrectionIdentityMatches,
  purchaseFamilyAllowsDelta,
  type PurchaseRoot,
} from "@/lib/inventory/purchase-correction-policy";
import { insertInventoryPriceLog } from "@/lib/inventory/price-logs";
import { projectInventoryPurchaseLog } from "@/lib/ledger/inventory-projection";
import { applyResolvedInventorySupplier, resolveInventorySupplier } from "@/lib/inventory/supplier-partners-server";
import {
  type InventoryReasonValue,
  type InventorySourceValue,
  getReasonByRegistrationType,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";
import {
  INVENTORY_PART_VALUES,
  validateInventoryPartPayload,
} from "@/lib/inventory/parts";

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

const canDeleteInventoryItem = (role: unknown) =>
  role === "owner" || role === "master";

const canCorrectInventoryPurchase = (role: unknown) =>
  role === "owner" || role === "master";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const INTERNAL_ERROR_MESSAGE = "Inventory request failed";

const authenticatedActorResponse = async () => {
  const auth = await getAuthenticatedActor();

  if (!auth.ok) {
    return {
      actor: null,
      response: NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      ),
    };
  }

  return {
    // getAuthenticatedActor already confirmed that the current users row is active.
    actor: { ...auth.actor, is_active: true },
    response: null,
  };
};

const withServerActorMetadata = (
  payload: Record<string, unknown>,
  actor: AuthenticatedActor
): Record<string, unknown> => {
  const sanitized = { ...payload };

  delete sanitized.actor;
  delete sanitized.actorId;
  delete sanitized.actorName;
  delete sanitized.actorUsername;
  delete sanitized.actor_id;
  delete sanitized.actor_name;
  delete sanitized.actor_username;
  delete sanitized.updated_by_name;
  delete sanitized.updated_by_username;

  return {
    ...sanitized,
    updated_by_name: actor.name,
    updated_by_username: actor.username,
  };
};

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

const formatInventoryPartValuesList = () => {
  const values = [...INVENTORY_PART_VALUES];
  const last = values.pop();
  return `${values.join(", ")}, or ${last}`;
};

const invalidInventoryPartResponse = () =>
  jsonError(
    "invalid_inventory_part",
    `Inventory part must be one of ${formatInventoryPartValuesList()}.`,
    400
  );

// 실제 판정(순수 함수)은 lib/inventory/parts.ts의 validateInventoryPartPayload가 맡는다.
// 여기서는 그 판정을 HTTP 응답으로 감싸고, 유효하면 trim된 값을 payload에 반영만 한다
// (공백이 섞인 값이 그대로 저장되지 않게). POST(required: true)/PATCH(required: false)가
// 이 한 함수를 공유한다.
const enforceInventoryPartPayload = (
  payload: Record<string, unknown>,
  options: { required: boolean }
): NextResponse | null => {
  const result = validateInventoryPartPayload(payload, options);

  if (!result.ok) return invalidInventoryPartResponse();
  if (result.normalizedPart !== undefined) {
    payload.part = result.normalizedPart;
  }

  return null;
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
  is_active: boolean | null;
};

const findDuplicateInventoryItem = async (
  itemName: unknown,
  itemNameVi: unknown,
  code: unknown,
  options: { excludeId?: number; activeOnly: boolean }
) => {
  const normalizedItemName = normalizeInventoryName(itemName);
  const normalizedItemNameVi = normalizeInventoryName(itemNameVi);

  if (!normalizedItemName && !normalizedItemNameVi) return null;

  const normalizedCode = normalizeInventoryCode(code);
  let query = supabaseAdmin
    .from("inventory")
    .select("id, item_name, item_name_vi, code, part, category, category_vi, is_active");

  if (options.excludeId !== undefined) {
    query = query.neq("id", options.excludeId);
  }

  if (options.activeOnly) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;

  if (error) throw error;

  return ((data || []) as DuplicateInventoryItem[]).find((item) => {
    const sameName =
      (normalizedItemName !== "" &&
        normalizeInventoryName(item.item_name) === normalizedItemName) ||
      (normalizedItemNameVi !== "" &&
        normalizeInventoryName(item.item_name_vi) === normalizedItemNameVi);

    return (
      sameName &&
      normalizeInventoryCode(item.code) === normalizedCode
    );
  }) ?? null;
};

const duplicateInventoryItemResponse = (duplicateItem: DuplicateInventoryItem) =>
  NextResponse.json(
    {
      ok: false,
      error: "inventory_item_duplicate_name_code",
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
  const businessDate =
    meta.businessDate ?? (await resolveInventoryBusinessDate()).businessDate;
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

export async function GET(req: Request) {
  try {
    const { actor, response } = await authenticatedActorResponse();
    if (response) return response;

    const { searchParams } = new URL(req.url);
    const selectedId = searchParams.get("itemId");
    if (selectedId !== null) {
      const itemId = Number(selectedId);
      if (!Number.isSafeInteger(itemId) || itemId <= 0) return jsonError("invalid_item_id", "Invalid item id", 400);
      const [itemResult, partners, aliases] = await Promise.all([
        supabaseAdmin.from("inventory").select("*").eq("id", itemId).maybeSingle(),
        supabaseAdmin.from("business_partners").select("id,name").eq("is_active", true),
        supabaseAdmin.from("business_partner_supplier_aliases").select("id,supplier_name,status,business_partner_id").in("status", ["pending", "linked", "ignored"]),
      ]);
      if (itemResult.error) throw itemResult.error;
      if (partners.error) throw partners.error;
      if (aliases.error) throw aliases.error;
      if (!itemResult.data) return jsonError("inventory_item_not_found", "Item not found", 404);
      if (itemResult.data.is_active !== true && !canToggleInventoryItemActiveStatus(actor.role)) return jsonError("inventory_item_inactive_list_forbidden", "Inactive inventory items require leader permission.", 403);
      return NextResponse.json({ ok: true, data: [itemResult.data], supplierPartners: partners.data ?? [], supplierAliases: (aliases.data ?? []).map(row => ({ id: row.id, supplierName: row.supplier_name, status: row.status, businessPartnerId: row.business_partner_id })) }, { headers: { "Cache-Control": "no-store" } });
    }
    const includeInactive = searchParams.get("includeInactive") === "true";
    const includeKegProgress =
      searchParams.get("includeKegProgress") !== "false";
    let canIncludeInactive = false;

    if (includeInactive) {
      if (!canToggleInventoryItemActiveStatus(actor.role)) {
        return jsonError(
          "inventory_item_inactive_list_forbidden",
          "Inactive inventory items require leader permission.",
          403
        );
      }

      canIncludeInactive = true;
    }

    const [items, partnerResult] = await Promise.all([
      fetchInventoryItems({ supabase: supabaseAdmin, includeInactive: canIncludeInactive }),
      supabaseAdmin.from("business_partners").select("id,name").eq("is_active", true),
    ]);
    if (partnerResult.error) throw partnerResult.error;
    const supplierPartnerNames = new Map((partnerResult.data ?? []).map(row => [Number(row.id), row.name]));
    const kegCandidateIds = getInventoryKegCandidateIds(items);
    const activeMappings = await fetchActiveKegTrackingMappings({
      supabase: supabaseAdmin,
      kegCandidateIds,
    });
    const kegProgressByItemId = includeKegProgress
      ? await fetchKegProgressByItemId({
          supabase: supabaseAdmin,
          inventoryItems: items,
          kegCandidateIds,
          preloadedMappings: activeMappings,
        })
      : new Map<number, KegProgress>();

    return NextResponse.json({
      ok: true,
      data: buildInventoryItemsResponse({
        items,
        activeMappings,
        kegProgressByItemId,
        supplierPartnerNames,
      }),
    });
  } catch (error) {
    console.error("[INVENTORY_ITEMS_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, error: "inventory_request_failed", message: INTERNAL_ERROR_MESSAGE },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const { actor, response } = await authenticatedActorResponse();
    if (response) return response;

    const body = await req.json();
    const { payload, registrationType, reason } = body;

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

    const partValidationError = enforceInventoryPartPayload(payload, {
      required: true,
    });
    if (partValidationError) return partValidationError;

    const supplierResolution = await resolveInventorySupplier({
      supabase: supabaseAdmin,
      payload,
      actorUserId: actor.id,
    });
    const serverPayload = applyResolvedInventorySupplier(
      withServerActorMetadata(payload, actor),
      supplierResolution
    );

    const duplicateItem = await findDuplicateInventoryItem(
      serverPayload.item_name,
      serverPayload.item_name_vi,
      serverPayload.code,
      { activeOnly: false }
    );

    if (duplicateItem) {
      return duplicateInventoryItemResponse(duplicateItem);
    }

    const { data: insertedData, error } = await supabaseAdmin
      .from("inventory")
      .insert([serverPayload])
      .select()
      .single();

    if (error || !insertedData) throw error;

    const logReason =
      registrationType === "existing_stock" || registrationType === "new_purchase"
        ? getReasonByRegistrationType(registrationType)
        : normalizeInventoryReason(reason, "unclassified");

    const businessDate = (await resolveInventoryBusinessDate()).businessDate;

    const purchaseLog = await insertInventoryLog(
      {
        item_id: insertedData.id,
        source_actor_user_id: actor.id,
        purchase_supplier_partner_id: insertedData.supplier_partner_id ?? null,
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

    const ledgerSync = logReason === "purchase"
      ? await projectInventoryPurchaseLog(Number(purchaseLog.id), actor.id)
      : undefined;
    return NextResponse.json({ ok: true, data: insertedData, ledgerSync });
  } catch (error) {
    console.error("[INVENTORY_POST_ERROR]", error);
    return NextResponse.json(
      { ok: false, error: "inventory_request_failed", message: INTERNAL_ERROR_MESSAGE },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const { actor, response } = await authenticatedActorResponse();
    if (response) return response;

    const body = await req.json();
    const {
      mode,
      id,
      payload,
      expectedQuantity,
      reason,
    } = body;

    const correctionPurchaseLogId = body.correction_of_inventory_log_id == null
      ? null : Number(body.correction_of_inventory_log_id);
    // Ordinary edit UI confirmation is separate from the privileged emergency path.
    const selectedPurchaseRootId = body.selectedPurchaseRootId == null ? null : Number(body.selectedPurchaseRootId);
    if (selectedPurchaseRootId !== null && (!Number.isSafeInteger(selectedPurchaseRootId) || selectedPurchaseRootId <= 0
      || mode === "quick-save" || body.source !== "edit_form" || normalizeInventoryReason(reason) !== "purchase"
      || correctionPurchaseLogId !== null || expectedQuantity === undefined)) {
      return jsonError("invalid_purchase_correction", "Invalid purchase selection.", 400);
    }
    if (correctionPurchaseLogId !== null && !canCorrectInventoryPurchase(actor.role)) {
      return jsonError(
        "inventory_purchase_correction_forbidden",
        "Purchase correction requires owner or master permission.",
        403
      );
    }
    if (correctionPurchaseLogId !== null && (!Number.isSafeInteger(correctionPurchaseLogId) || correctionPurchaseLogId <= 0
      || mode === "quick-save" || normalizeInventoryReason(reason) !== "purchase" || expectedQuantity === undefined)) {
      return jsonError("invalid_purchase_correction", "Select an original purchase and supply the expected quantity.", 400);
    }

    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0 || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json(
        { ok: false, message: "Missing id or payload" },
        { status: 400 }
      );
    }

    if (Object.hasOwn(body, "expectedUpdatedAt") && body.expectedUpdatedAt !== null &&
      (typeof body.expectedUpdatedAt !== "string" || !Number.isFinite(Date.parse(body.expectedUpdatedAt)))) {
      return jsonError("invalid_inventory_version", "Invalid expected item version.", 400);
    }
    if (Object.hasOwn(payload, "is_active") && mode !== "active-status") {
      return jsonError("invalid_active_status_mode", "Use the active status action.", 400);
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

    // part가 payload에 없으면(quick-save, active-status, 사진·수량 관련 흐름) 그대로
    // 통과한다. part가 포함된 일반 품목 수정에서만 유효한 재고 파트인지 검사한다.
    const partValidationError = enforceInventoryPartPayload(payload, {
      required: false,
    });
    if (partValidationError) return partValidationError;

    let serverPayload = withServerActorMetadata(payload, actor);

    if (mode === "active-status") {
      if (!canToggleInventoryItemActiveStatus(actor.role)) {
        return jsonError(
          "inventory_item_active_status_forbidden",
          "Inventory item active status update requires leader permission.",
          403
        );
      }

      const nextIsActive = serverPayload.is_active;

      if (typeof nextIsActive !== "boolean") {
        return jsonError(
          "invalid_active_status",
          "is_active must be boolean.",
          400
        );
      }

      if (nextIsActive === false) {
        const { count, error: activeSessionError } = await supabaseAdmin
          .from("inventory_keg_sessions")
          .select("id", { count: "exact", head: true })
          .eq("inventory_item_id", Number(id))
          .eq("status", "active");

        if (activeSessionError) throw activeSessionError;

        if ((count ?? 0) > 0) {
          return jsonError(
            "inventory_item_has_active_keg_session",
            "This inventory item has an active keg tracking session.",
            409
          );
        }
      }

      const { data: updatedItem, error: activeUpdateError } =
        await supabaseAdmin
          .from("inventory")
          .update({
            is_active: nextIsActive,
            updated_by_name: actor.name || "",
            updated_by_username: actor.username || "",
          })
          .eq("id", Number(id))
          .select("*")
          .single();

      if (activeUpdateError || !updatedItem) throw activeUpdateError;

      return NextResponse.json({ ok: true, data: updatedItem });
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
    supplier_partner_id,
    low_stock_threshold,
    low_stock_enabled,
    package_content_quantity,
    package_content_unit,
    image_path,
    updated_at,
    is_active
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

    if (prevItem.is_active === false && !canToggleInventoryItemActiveStatus(actor.role)) {
      return jsonError("inventory_item_inactive_edit_forbidden", "Inactive inventory items require leader permission.", 403);
    }
    if (Object.hasOwn(body, "expectedUpdatedAt") && body.expectedUpdatedAt !== (prevItem.updated_at ?? null)) {
      return jsonError("INVENTORY_CONFLICT", "Item changed. Reload before saving.", 409);
    }
    if (expectedQuantity !== undefined && (!Number.isFinite(Number(expectedQuantity)) ||
      roundDecimal(Number(expectedQuantity)) !== roundDecimal(Number(prevItem.quantity ?? 0)))) {
      return jsonError("QUANTITY_CONFLICT", "Quantity changed. Reload before saving.", 409);
    }
    const supplierResolution = await resolveInventorySupplier({ supabase: supabaseAdmin, payload, actorUserId: actor.id });
    serverPayload = applyResolvedInventorySupplier(serverPayload, supplierResolution);

    // Purchase reductions require explicit confirmation of a compatible prior root,
    // including previous days. Stock checks and sales never imply purchase intent.
    let autoCorrectionRootId: number | null = null;
    let autoCorrectionBusinessDate: string | null = null;
    if (mode !== "quick-save" && body.source === "edit_form" && normalizeInventoryReason(reason) === "purchase" && correctionPurchaseLogId === null &&
        Object.hasOwn(serverPayload, "quantity")) {
      const previousQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
      const nextQuantity = roundDecimal(Number(serverPayload.quantity));
      const delta = roundDecimal(nextQuantity - previousQuantity);
      // An explicit positive "purchase" is a new receipt, even when an older
      // receipt exists today. Other edits correct the nearest prior receipt.
      if (Number.isFinite(delta) && delta !== 0 &&
          delta < 0) {
        const { businessDate } = await resolveInventoryBusinessDate();
        const before = new Date().toISOString();
        const purchaseReduction = normalizeInventoryReason(reason) === "purchase" && delta < 0;
        let rootQuery = supabaseAdmin.from("inventory_logs")
          .select("id,item_id,business_date,created_at,reason,change_quantity,correction_of_inventory_log_id,unit,new_supplier,purchase_supplier_partner_id,new_purchase_price")
          .eq("item_id", Number(id)).eq("reason", "purchase")
          .gt("change_quantity", 0).is("correction_of_inventory_log_id", null)
          .lte("created_at", before).order("created_at", { ascending: false })
          .order("id", { ascending: false });
        rootQuery = purchaseReduction ? rootQuery.lte("business_date", businessDate).limit(1001)
          : rootQuery.eq("business_date", businessDate).limit(2);
        if (selectedPurchaseRootId !== null) rootQuery = rootQuery.eq("id", selectedPurchaseRootId);
        const { data: possibleRoots, error: rootError } = await rootQuery;
        if (rootError) throw rootError;
        const correctionIdentity = {
          unit: serverPayload.unit ?? prevItem.unit, supplier: serverPayload.supplier ?? prevItem.supplier,
          supplier_partner_id: Object.hasOwn(serverPayload, "supplier_partner_id") ? serverPayload.supplier_partner_id : prevItem.supplier_partner_id,
          purchase_price: serverPayload.purchase_price ?? prevItem.purchase_price,
        };
        const compatibleRoots = ((possibleRoots ?? []) as PurchaseRoot[]).filter(row => purchaseCorrectionIdentityMatches(row, correctionIdentity));
        if (purchaseReduction && selectedPurchaseRootId === null) {
          return NextResponse.json({ ok: false, error: compatibleRoots.length ? "purchase_correction_selection_required" : "purchase_correction_root_not_found",
            candidates: compatibleRoots.slice(0, 1000),
            recommended: compatibleRoots.length === 1 && (possibleRoots?.length ?? 0) < 1001,
          }, { status: 409 });
        }
        const root = compatibleRoots.find(row => row.id === selectedPurchaseRootId) ?? null;
        if (purchaseReduction && !root) return jsonError("invalid_purchase_correction", "Select a compatible original purchase.", 409);
        if (root) {
          if (!purchaseCorrectionIdentityMatches(root, correctionIdentity))
            return jsonError("purchase_correction_review_required", "Purchase details do not match the receipt.", 409);
          const { data: corrections, error: correctionError } = await supabaseAdmin.from("inventory_logs")
            .select("change_quantity").eq("correction_of_inventory_log_id", root.id);
          if (correctionError) throw correctionError;
          if (!purchaseFamilyAllowsDelta(Number(root.change_quantity),
            (corrections ?? []).map(row => Number(row.change_quantity)), delta)) {
            return jsonError("purchase_correction_exceeds_purchase", "Correction exceeds the original purchase.", 409);
          }
          const { data: closure, error: closureError } = await supabaseAdmin.from("ledger_month_closures")
            .select("month").eq("month", `${root.business_date.slice(0, 7)}-01`).eq("status", "closed").maybeSingle();
          if (closureError) throw closureError;
          if (closure) return jsonError("purchase_correction_review_required", "The purchase month is closed.", 409);
          if (root.business_date.slice(0, 7) !== businessDate.slice(0, 7)) {
            const { data: issueClosure, error: issueClosureError } = await supabaseAdmin.from("ledger_month_closures")
              .select("month").eq("month", `${businessDate.slice(0, 7)}-01`).eq("status", "closed").maybeSingle();
            if (issueClosureError) throw issueClosureError;
            if (issueClosure) return jsonError("purchase_correction_review_required", "The correction month is closed.", 409);
          }
          const { data: candidate, error: candidateError } = await supabaseAdmin.from("ledger_candidates")
            .select("status,proposed_amount,resolved_transaction_id,proposed_recognition_month")
            .eq("source_type", "inventory_purchase_log").eq("source_key", `inventory-log:${root.id}`)
            .order("id", { ascending: false }).limit(1).maybeSingle();
          if (candidateError) throw candidateError;
          if (candidate?.status === "dismissed") return jsonError("purchase_correction_review_required", "Purchase requires manual review.", 409);
          if (candidate?.proposed_recognition_month && candidate.proposed_recognition_month !== `${root.business_date.slice(0, 7)}-01`) {
            const { data: recognitionClosure, error: recognitionError } = await supabaseAdmin.from("ledger_month_closures")
              .select("month").eq("month", candidate.proposed_recognition_month).eq("status", "closed").maybeSingle();
            if (recognitionError) throw recognitionError;
            if (recognitionClosure) return jsonError("purchase_correction_review_required", "The recognition month is closed.", 409);
          }
          if (candidate?.status === "confirmed") {
            const { data: transaction, error: transactionError } = await supabaseAdmin.from("ledger_transactions")
              .select("amount,business_date,recognition_month,status,type,source_type").eq("id", candidate.resolved_transaction_id).maybeSingle();
            if (transactionError) throw transactionError;
            if (!transaction || Number(transaction.amount) !== Number(candidate.proposed_amount))
              return jsonError("purchase_correction_review_required", "Purchase has a manual Ledger override.", 409);
            if (transaction.status !== "confirmed" || transaction.type !== "expense" ||
                !["inventory_purchase_candidate", "inventory_purchase_rebook"].includes(transaction.source_type)) {
              return jsonError("purchase_correction_review_required", "Linked Ledger transaction requires review.", 409);
            }
            const { data: payable, error: payableError } = await supabaseAdmin.from("ledger_payables")
              .select("id,status").eq("expense_transaction_id", candidate.resolved_transaction_id).maybeSingle();
            if (payableError) throw payableError;
            if (payable) {
              const { data: allocations, error: allocationError } = await supabaseAdmin.from("ledger_payable_allocations")
                .select("allocated_amount").eq("payable_id", payable.id).gt("allocated_amount", 0).limit(1);
              if (allocationError) throw allocationError;
              if (payable.status !== "unpaid" || (allocations?.length ?? 0) > 0)
                return jsonError("purchase_correction_review_required", "Purchase payment requires manual review.", 409);
            }
            for (const month of [transaction.business_date?.slice(0, 7), transaction.recognition_month?.slice(0, 7)]) {
              if (!month || month === businessDate.slice(0, 7)) continue;
              const { data: otherClosure, error: otherClosureError } = await supabaseAdmin.from("ledger_month_closures")
                .select("month").eq("month", `${month}-01`).eq("status", "closed").maybeSingle();
              if (otherClosureError) throw otherClosureError;
              if (otherClosure) return jsonError("purchase_correction_review_required", "A linked Ledger month is closed.", 409);
            }
          }
          autoCorrectionRootId = root.id;
          autoCorrectionBusinessDate = businessDate;
        }
      }
    }

    if (selectedPurchaseRootId !== null && (autoCorrectionRootId === null ||
      roundDecimal(Number(expectedQuantity)) !== roundDecimal(Number(prevItem.quantity)))) {
      return jsonError("QUANTITY_CONFLICT", "Quantity changed. Reload before correcting the purchase.", 409);
    }

    if (
      mode !== "quick-save" &&
      correctionPurchaseLogId === null && autoCorrectionRootId === null &&
      normalizeInventoryReason(reason) === "purchase"
    ) {
      const previousQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
      const nextQuantity = roundDecimal(Number(serverPayload.quantity));

      if (!Number.isFinite(nextQuantity) || nextQuantity <= previousQuantity) {
        return jsonError(
          "inventory_purchase_quantity_must_increase",
          "Purchase receipt can only be selected when inventory quantity increases.",
          400
        );
      }
    }

    if ((mode === "quick-save" || correctionPurchaseLogId !== null) && expectedQuantity !== undefined) {
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
      const nextItemName = Object.prototype.hasOwnProperty.call(
        serverPayload,
        "item_name"
      )
        ? serverPayload.item_name
        : prevItem.item_name;
      const nextItemNameVi = Object.prototype.hasOwnProperty.call(
        serverPayload,
        "item_name_vi"
      )
        ? serverPayload.item_name_vi
        : prevItem.item_name_vi;
      const nextCode = Object.prototype.hasOwnProperty.call(serverPayload, "code")
        ? serverPayload.code
        : prevItem.code;
      const duplicateItem = await findDuplicateInventoryItem(
        nextItemName,
        nextItemNameVi,
        nextCode,
        { excludeId: Number(prevItem.id), activeOnly: true }
      );

      if (duplicateItem) {
        return duplicateInventoryItemResponse(duplicateItem);
      }
    }

    const quickSaveLogReason =
      mode === "quick-save"
        ? normalizeInventoryReason(reason, "stock_check")
        : null;
    const quickSaveNextQuantity =
      mode === "quick-save" && Object.prototype.hasOwnProperty.call(serverPayload, "quantity")
        ? roundDecimal(Number(serverPayload.quantity ?? 0))
        : null;

    if (mode === "quick-save" && quickSaveLogReason === "purchase" && quickSaveNextQuantity !== null &&
      quickSaveNextQuantity < roundDecimal(Number(prevItem.quantity ?? 0))) {
      return jsonError("inventory_purchase_quantity_must_increase", "Select an original purchase in the edit form to reduce a receipt.", 400);
    }

    if (
      mode === "quick-save" &&
      quickSaveLogReason !== "stock_check" &&
      quickSaveNextQuantity !== null &&
      quickSaveNextQuantity === roundDecimal(Number(prevItem.quantity ?? 0))
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "quantity_no_change",
          message: "Quantity was not changed.",
        },
        { status: 400 }
      );
    }

    if (correctionPurchaseLogId !== null || autoCorrectionRootId !== null) {
      const businessDate = autoCorrectionBusinessDate ?? (await resolveInventoryBusinessDate()).businessDate;
      const { data: correction, error } = await supabaseAdmin.rpc("inventory_apply_purchase_correction_v2", {
        p_item_id: Number(id), p_purchase_log_id: correctionPurchaseLogId ?? autoCorrectionRootId,
        p_expected_quantity: autoCorrectionRootId !== null ? Number(prevItem.quantity) : Number(expectedQuantity),
        p_expected_item: prevItem, p_payload: serverPayload,
        p_business_date: businessDate, p_actor_user_id: actor.id,
      });
      if (error) throw error;
      if (correction?.status !== "ok") {
        return jsonError(correction?.status ?? "purchase_correction_failed", "Purchase correction was not saved.",
          ["quantity_conflict", "inventory_conflict"].includes(correction?.status) ? 409 : correction?.status === "forbidden" ? 403 : correction?.status === "not_found" ? 404 : 400);
      }
      const ledgerSync = await projectInventoryPurchaseLog(Number(correction.inventoryLogId),actor.id);
      return NextResponse.json({ok:true,mode,ledgerSync});
    }

    const prevQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
    const newQuantity = roundDecimal(Number(Object.hasOwn(serverPayload, "quantity") ? serverPayload.quantity : prevItem.quantity ?? 0));
    const changeQuantity = roundDecimal(newQuantity - prevQuantity);
    const fallbackLogReason = changeQuantity !== 0 ? "stock_check" : "other";
    const logReason = mode === "quick-save"
      ? quickSaveLogReason ?? "stock_check"
      : Object.hasOwn(body, "reason") ? normalizeInventoryReason(reason, fallbackLogReason) : fallbackLogReason;
    const logSource = mode === "quick-save" ? "quick_save" : "edit_form";
    const businessDate = (await resolveInventoryBusinessDate()).businessDate;
    // A single DB transaction commits the item, required source audit and price history.
    // Never fall back to separate writes if the migration/RPC is unavailable.
    const { data: saved, error: saveError } = await supabaseAdmin.rpc("inventory_update_with_audit_v1", {
      p_item_id: Number(id), p_expected_item: prevItem, p_payload: serverPayload,
      p_business_date: businessDate, p_actor_user_id: actor.id, p_reason: logReason, p_source: logSource,
      p_price_business_date: mode !== "quick-save" && typeof body.business_date === "string" ? body.business_date : businessDate,
    });
    if (saveError) throw saveError;
    if (saved?.status !== "ok") {
      const status = ["inventory_conflict", "purchase_correction_required"].includes(saved?.status) ? 409 : saved?.status === "forbidden" ? 403 : saved?.status === "not_found" ? 404 : 400;
      return jsonError(saved?.status === "inventory_conflict" ? "INVENTORY_CONFLICT" : saved?.status ?? "inventory_save_failed",
        "Item was not saved. Reload before retrying if it changed.", status);
    }
    const ledgerSync = logReason === "purchase"
      ? await projectInventoryPurchaseLog(Number(saved.inventoryLogId), actor.id)
      : undefined;
    return NextResponse.json({ ok: true, mode, ledgerSync });
  } catch (error) {
    console.error("[INVENTORY_PATCH_ERROR]", error);
    return NextResponse.json(
      { ok: false, error: "inventory_request_failed", message: INTERNAL_ERROR_MESSAGE },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const { actor, response } = await authenticatedActorResponse();
    if (response) return response;

    const body = await req.json();
    const {
      id,
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

    if (!canDeleteInventoryItem(actor.role)) {
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
        low_stock_enabled,
        package_content_quantity,
        package_content_unit,
        image_path
      `)
      .eq("id", itemId)
      .maybeSingle();

    if (selectError) {
      return jsonError(
        "inventory_item_select_failed",
        INTERNAL_ERROR_MESSAGE,
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
        INTERNAL_ERROR_MESSAGE,
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
          INTERNAL_ERROR_MESSAGE,
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
          INTERNAL_ERROR_MESSAGE,
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
          INTERNAL_ERROR_MESSAGE,
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
          INTERNAL_ERROR_MESSAGE,
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
          INTERNAL_ERROR_MESSAGE,
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
        INTERNAL_ERROR_MESSAGE,
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
      INTERNAL_ERROR_MESSAGE,
      500
    );
  }
}
