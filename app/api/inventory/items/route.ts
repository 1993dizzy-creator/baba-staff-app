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
import { normalizeInventoryName } from "@/lib/inventory/normalize";
import { matchDuplicateInventoryItem, type DuplicateInventoryItem, type DuplicateMatchedField } from "@/lib/inventory/duplicate-item";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import {
  purchaseCorrectionIdentityMatches,
  purchaseFamilyAllowsDelta,
  type PurchaseRoot,
} from "@/lib/inventory/purchase-correction-policy";
import { parseBilledAmountRequest, type BilledAmountRequest } from "@/lib/inventory/billed-amount";
import { projectInventoryPurchaseLog } from "@/lib/ledger/inventory-projection";
import { applyResolvedInventorySupplier, resolveInventorySupplier } from "@/lib/inventory/supplier-partners-server";
import { PARTNER_OPTION_COLUMNS, PARTNER_SUBTYPE_EMOJI_COLUMNS, partnerSelectOptions } from "@/lib/partners/select-options";
import {
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

async function inventoryWrite(name: string, args: Record<string, unknown>, event?: unknown, retryTransport = true) {
  if (process.env.INVENTORY_WRITER_MODE !== "journal") return supabaseAdmin.rpc(name, args);
  const { inventoryWriterRpc } = await import("@/lib/inventory/writer-rpc");
  return inventoryWriterRpc(supabaseAdmin, name, args, Number(args.p_actor_user_id), event, { retryTransport });
}

async function purchaseCorrectionCountIssue(itemId:number,root:{id:number;created_at:string}) {
  const {data:latestCheck,error}=await supabaseAdmin.from("inventory_logs").select("id,reason,created_at")
    .eq("item_id",itemId).eq("reason","stock_check").order("created_at",{ascending:false}).order("id",{ascending:false}).limit(1).maybeSingle();
  if(error)throw error;
  if(!Number.isFinite(Date.parse(root.created_at)))return "purchase_correction_review_required";
  if(!latestCheck)return null;
  if(latestCheck.reason!=="stock_check" || !Number.isFinite(Date.parse(latestCheck.created_at)))return "purchase_correction_review_required";
  return Date.parse(latestCheck.created_at)>Date.parse(root.created_at) ||
    (Date.parse(latestCheck.created_at)===Date.parse(root.created_at)&&Number(latestCheck.id)>root.id)
    ? "purchase_correction_later_stock_check" : null;
}

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

// 실청구금액 of a new receipt as inventory_logs columns. Auto stores no amount.
const billedAmountColumns = (request: BilledAmountRequest) => ({
  billed_amount_mode: request.mode,
  billed_amount: request.mode === "manual" ? request.amount : null,
});

// The DB refuses a correction without a billed mode on a receipt with a manual billed amount.
const isBilledAmountEditRequired = (error: unknown) =>
  (getSupabaseErrorField(error, "message") ?? getErrorMessage(error)).includes("PURCHASE_BILLED_AMOUNT_EDIT_REQUIRED");

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

const writerContractResponse = (error: unknown) => {
  const code = getSupabaseErrorField(error, "code");
  if (code === "40001" || code === "55P03")
    return jsonError("inventory_busy_refresh_required", "Refresh the item and retry with current quantities.", 409,
      { retryable: true, requiresRefresh: true, retryCondition: "refresh_item_and_receipts", writeState: "not_saved" });
  if (code === "42501")
    return jsonError("inventory_writer_permission_review_required", "The inventory writer contract needs administrator review.", 403,
      { retryable: false, requiresRefresh: false, retryCondition: "operator_contract_review", writeState: "not_saved" });
  if (code === "PGRST202" || code === "42883")
    return jsonError("inventory_writer_migration_required", "The required inventory writer is not available.", 503,
      { retryable: false, requiresRefresh: false, retryCondition: "rpc_installed_and_schema_cache_ready", writeState: "not_saved" });
  if (code && ["08000", "08006", "PGRST000"].includes(code))
    return jsonError("inventory_write_outcome_unknown", "Check the saved item and audit before retrying.", 503,
      { retryable: false, requiresRefresh: true, outcomeUnknown: true, retryCondition: "reconcile_outcome_then_refresh" });
  return null;
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

const findDuplicateInventoryItem = async (
  itemName: unknown,
  itemNameVi: unknown,
  code: unknown,
  options: { excludeId?: number; activeOnly: boolean }
) => {
  if (!normalizeInventoryName(itemName) && !normalizeInventoryName(itemNameVi)) return null;

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

  return matchDuplicateInventoryItem((data || []) as DuplicateInventoryItem[], { itemName, itemNameVi, code });
};

const duplicateInventoryItemResponse = (duplicate: { item: DuplicateInventoryItem; matchedFields: DuplicateMatchedField[] }) =>
  NextResponse.json(
    {
      ok: false,
      error: "inventory_item_duplicate_name_code",
      message: "Duplicate inventory item.",
      duplicateItem: duplicate.item,
      // Which of our names equals the other item's: lets the UI say "#id 이름" instead of a bare duplicate.
      duplicateMatchedFields: duplicate.matchedFields,
    },
    { status: 409 }
  );

export async function GET(req: Request) {
  try {
    const { actor, response } = await authenticatedActorResponse();
    if (response) return response;

    const { searchParams } = new URL(req.url);
    const selectedId = searchParams.get("itemId");
    if (selectedId !== null) {
      const itemId = Number(selectedId);
      if (!Number.isSafeInteger(itemId) || itemId <= 0) return jsonError("invalid_item_id", "Invalid item id", 400);
      if (searchParams.get("saveCheck") === "true" || searchParams.get("itemOnly") === "true") {
        const check = searchParams.get("saveCheck") === "true";
        // Bounded, read-only recovery. Never load POS/Keg enrichment, all stock,
        // supplier masters or purchase-family expansion to check one write.
        const [itemResult, logs] = await Promise.all([
          supabaseAdmin.from("inventory").select("*").eq("id", itemId).maybeSingle(),
          check ? supabaseAdmin.from("inventory_logs").select("id,item_id,source_actor_user_id,source,reason,created_at,prev_quantity,new_quantity,change_quantity,new_supplier,new_purchase_price,purchase_supplier_partner_id,new_note,correction_of_inventory_log_id,billed_amount_mode,billed_amount")
            .eq("item_id", itemId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(20)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (itemResult.error) throw itemResult.error;
        if (logs.error) throw logs.error;
        if (!itemResult.data) return jsonError("inventory_item_not_found", "Item not found", 404);
        if (itemResult.data.is_active !== true && !canToggleInventoryItemActiveStatus(actor.role)) return jsonError("inventory_item_inactive_list_forbidden", "Inactive inventory items require leader permission.", 403);
        return NextResponse.json({ ok: true, data: [itemResult.data], ...(check ? { auditLogs: logs.data, actorId: actor.id } : {}) }, { headers: { "Cache-Control": "no-store" } });
      }
      const [itemResult, partners, subtypes, aliases] = await Promise.all([
        supabaseAdmin.from("inventory").select("*").eq("id", itemId).maybeSingle(),
        supabaseAdmin.from("business_partners").select(PARTNER_OPTION_COLUMNS).eq("is_active", true),
        supabaseAdmin.from("business_partner_subtypes").select(PARTNER_SUBTYPE_EMOJI_COLUMNS),
        supabaseAdmin.from("business_partner_supplier_aliases").select("id,supplier_name,status,business_partner_id").in("status", ["pending", "linked", "ignored"]),
      ]);
      if (itemResult.error) throw itemResult.error;
      if (partners.error) throw partners.error;
      if (subtypes.error) throw subtypes.error;
      if (aliases.error) throw aliases.error;
      if (!itemResult.data) return jsonError("inventory_item_not_found", "Item not found", 404);
      if (itemResult.data.is_active !== true && !canToggleInventoryItemActiveStatus(actor.role)) return jsonError("inventory_item_inactive_list_forbidden", "Inactive inventory items require leader permission.", 403);
      return NextResponse.json({ ok: true, data: [itemResult.data], supplierPartners: partnerSelectOptions(partners.data ?? [], subtypes.data ?? []), supplierAliases: (aliases.data ?? []).map(row => ({ id: row.id, supplierName: row.supplier_name, status: row.status, businessPartnerId: row.business_partner_id })) }, { headers: { "Cache-Control": "no-store" } });
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

    const requestedReason = registrationType === "existing_stock" || registrationType === "new_purchase"
      ? getReasonByRegistrationType(registrationType) : normalizeInventoryReason(reason,"unclassified");
    // Quantities are stored as numeric(10,2): a receipt must still increase stock after that
    // rounding, checked before the item INSERT so a refused receipt never leaves an item behind.
    if (requestedReason === "purchase" && (!Number.isFinite(Number(payload.quantity)) || Math.round(Number(payload.quantity)*100)<=0))
      return jsonError("inventory_purchase_quantity_must_increase","A new receipt needs a positive quantity; use a linked correction for reductions.",400);
    // 실청구금액 belongs to a purchase receipt; manual needs a unit price to compare with.
    const billedRequest = parseBilledAmountRequest(body.purchaseBilledAmount);
    if (billedRequest === "invalid" || (billedRequest?.mode === "manual" &&
        (requestedReason !== "purchase" || !(Number(payload.purchase_price) > 0))))
      return jsonError("invalid_billed_amount", "Invalid billed amount.", 400);

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

    const logReason =
      registrationType === "existing_stock" || registrationType === "new_purchase"
        ? getReasonByRegistrationType(registrationType)
        : normalizeInventoryReason(reason, "unclassified");
    const businessDate = (await resolveInventoryBusinessDate()).businessDate;

    // One DB transaction writes the item, its first log, the first price history and (for a
    // purchase) the Ledger projection. A refused log leaves no item behind; never fall back to
    // separate writes if the RPC is missing.
    const { data: created, error } = await inventoryWrite("inventory_create_with_receipt_v1", {
      p_payload: { ...serverPayload, ...(logReason === "purchase" && billedRequest ? billedAmountColumns(billedRequest) : {}) },
      p_reason: logReason, p_business_date: businessDate, p_actor_user_id: actor.id,
    }, body.inventoryEvent);
    if (error) throw error;
    // The same duplicate found inside the transaction (double submit, retry after a lost response).
    if (created?.status === "duplicate") {
      const { data: existing, error: existingError } = await supabaseAdmin.from("inventory")
        .select("id, item_name, item_name_vi, code, part, category, category_vi, is_active")
        .eq("id", Number(created.duplicateItemId)).maybeSingle();
      if (existingError) throw existingError;
      if (existing) return duplicateInventoryItemResponse({ item: existing, matchedFields: created.matchedFields ?? [] });
      return jsonError("inventory_item_duplicate_name_code", "Duplicate inventory item.", 409);
    }
    if (created?.status !== "ok") {
      const status = created?.status === "forbidden" ? 403 : 400;
      const code = created?.status === "purchase_quantity_must_increase" ? "inventory_purchase_quantity_must_increase"
        : created?.status ?? "inventory_save_failed";
      return jsonError(code, "Item was not saved.", status);
    }
    return NextResponse.json({ ok: true, data: created.item, ledgerSync: created.ledgerSync ?? undefined });
  } catch (error) {
    const contractResponse = writerContractResponse(error);
    if (contractResponse) return contractResponse;
    console.error("[INVENTORY_POST_ERROR]", error);
    return NextResponse.json(
      { ok: false, error: "inventory_request_failed", message: INTERNAL_ERROR_MESSAGE },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const requestStarted = performance.now();
  let writeStarted = false;
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

    const billedRequest = parseBilledAmountRequest(body.purchaseBilledAmount);
    if (billedRequest === "invalid") return jsonError("invalid_billed_amount", "Invalid billed amount.", 400);
    const correctionPurchaseLogId = body.correction_of_inventory_log_id == null
      ? null : Number(body.correction_of_inventory_log_id);
    // Automatic UI corrections only resolve a unique receipt from today.
    const automaticPurchaseCorrection = mode === "quick-save" || body.autoSelectPurchaseRoot === true;
    // Retain the validated legacy explicit edit API; current UI uses automatic resolution.
    const selectedPurchaseRootId = body.selectedPurchaseRootId == null ? null : Number(body.selectedPurchaseRootId);
    if (selectedPurchaseRootId !== null && (automaticPurchaseCorrection || !Number.isSafeInteger(selectedPurchaseRootId) || selectedPurchaseRootId <= 0
      || (mode !== "quick-save" && body.source !== "edit_form") || normalizeInventoryReason(reason) !== "purchase"
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

      writeStarted = true;
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
    // /inventory/snapshots 입고 수정: one receipt's quantity, unit price, supplier, memo and
    // reason. The item's own price/supplier/note never change (enforced in the RPC).
    if (mode === "purchase-receipt-edit") {
      const purchaseLogId = Number(body.purchaseLogId);
      const editKeys = new Set(["quantity", "purchase_price", "supplier", "supplierPartnerId", "note", "reason"]);
      if (!Number.isSafeInteger(purchaseLogId) || purchaseLogId <= 0 || expectedQuantity === undefined ||
          !Object.hasOwn(body, "expectedUpdatedAt") || Object.keys(payload).some(key => !editKeys.has(key))) {
        return jsonError("invalid_purchase_correction", "Invalid receipt edit.", 400);
      }
      // A selected partner is validated and named by the shared resolver. A name-only receipt
      // supplier is passed as recorded: resolving it here would attach a partner id and turn
      // an unchanged supplier into a supplier change (owner/master only in the RPC).
      const partnerId = payload.supplierPartnerId ?? null;
      const resolvedSupplier = (partnerId === null ? null : await resolveInventorySupplier({
        supabase: supabaseAdmin, actorUserId: actor.id,
        payload: { supplier: payload.supplier ?? null, supplierPartnerId: partnerId },
      })) ?? { supplier: payload.supplier ?? null, supplier_partner_id: partnerId };
      const { businessDate } = await resolveInventoryBusinessDate();
      writeStarted = true;
      const { data: edited, error } = await inventoryWrite("inventory_apply_purchase_receipt_edit_v1", {
        p_item_id: Number(id), p_purchase_log_id: purchaseLogId,
        p_expected_quantity: Number(prevItem.quantity), p_expected_item: prevItem,
        p_edit: {
          quantity: payload.quantity, purchase_price: payload.purchase_price,
          supplier: resolvedSupplier.supplier, supplier_partner_id: resolvedSupplier.supplier_partner_id,
          note: payload.note ?? null, reason: payload.reason ?? null,
          ...(billedRequest ? billedAmountColumns(billedRequest) : {}),
        },
        p_business_date: businessDate, p_actor_user_id: actor.id,
      }, body.inventoryEvent);
      if (error) throw error;
      if (edited?.status !== "ok") {
        const status = ["quantity_conflict", "inventory_conflict"].includes(edited?.status) ? 409
          : ["forbidden", "supplier_change_forbidden"].includes(edited?.status) ? 403
          : edited?.status === "not_found" ? 404
          : ["invalid_payload", "no_change", "invalid_purchase_reference"].includes(edited?.status) ? 400 : 409;
        return jsonError(edited?.status ?? "purchase_correction_failed", "Receipt edit was not saved.", status,
          edited?.blockReason ? { blockReason: edited.blockReason, reviewCode: edited.code } : undefined);
      }
      return NextResponse.json({ ok: true, mode, completion: edited.completion, ledgerSync: edited.ledgerSync,
        billedAmount: { mode: edited.billedAmountMode, amount: edited.amount, calculated: edited.calculatedAmount } });
    }
    const supplierResolution = await resolveInventorySupplier({ supabase: supabaseAdmin, payload, actorUserId: actor.id });
    serverPayload = applyResolvedInventorySupplier(serverPayload, supplierResolution);

    // Purchase reductions require explicit confirmation of a compatible prior root,
    // including previous days. Stock checks and sales never imply purchase intent.
    let autoCorrectionRootId: number | null = null;
    let autoCorrectionBusinessDate: string | null = null;
    if ((mode === "quick-save" || body.source === "edit_form") && normalizeInventoryReason(reason) === "purchase" && correctionPurchaseLogId === null &&
        Object.hasOwn(serverPayload, "quantity")) {
      const previousQuantity = roundDecimal(Number(prevItem.quantity ?? 0));
      const nextQuantity = roundDecimal(Number(serverPayload.quantity));
      const delta = roundDecimal(nextQuantity - previousQuantity);
      // An explicit positive "purchase" is a new receipt, even when an older
      // receipt exists today. Other edits correct the nearest prior receipt.
      if (Number.isFinite(delta) && delta !== 0 &&
          delta < 0) {
        if(automaticPurchaseCorrection && expectedQuantity === undefined) return jsonError("invalid_purchase_correction","Reload before correcting the purchase.",400);
        const { businessDate } = await resolveInventoryBusinessDate();
        const before = new Date().toISOString();
        const purchaseReduction = normalizeInventoryReason(reason) === "purchase" && delta < 0;
        let rootQuery = supabaseAdmin.from("inventory_logs")
          .select("id,item_id,business_date,created_at,reason,change_quantity,correction_of_inventory_log_id,unit,new_supplier,purchase_supplier_partner_id,new_purchase_price")
          .eq("item_id", Number(id)).eq("reason", "purchase")
          .gt("change_quantity", 0).is("correction_of_inventory_log_id", null)
          .lte("created_at", before).order("created_at", { ascending: false })
          .order("id", { ascending: false });
        rootQuery = automaticPurchaseCorrection ? rootQuery.eq("business_date", businessDate).limit(1001) : purchaseReduction ? rootQuery.lte("business_date", businessDate).limit(1001)
          : rootQuery.eq("business_date", businessDate).limit(2);
        if (selectedPurchaseRootId !== null) rootQuery = rootQuery.eq("id", selectedPurchaseRootId);
        const { data: possibleRoots, error: rootError } = await rootQuery;
        if (rootError) throw rootError;
        const correctionIdentity = {
          unit: serverPayload.unit ?? prevItem.unit, supplier: serverPayload.supplier ?? prevItem.supplier,
          supplier_partner_id: Object.hasOwn(serverPayload, "supplier_partner_id") ? serverPayload.supplier_partner_id : prevItem.supplier_partner_id,
          purchase_price: serverPayload.purchase_price ?? prevItem.purchase_price,
        };
        let compatibleRoots = ((possibleRoots ?? []) as PurchaseRoot[]).filter(row => purchaseCorrectionIdentityMatches(row, correctionIdentity) && (!automaticPurchaseCorrection ||
          (row.business_date===businessDate && Number(row.new_purchase_price)===Number(correctionIdentity.purchase_price))));
        if (purchaseReduction && selectedPurchaseRootId === null && compatibleRoots.length) {
          const correctionTotals = new Map<number,number>();
          for(let offset=0;offset<compatibleRoots.length;offset+=100){
            const {data:rows,error} = await supabaseAdmin.from("inventory_logs").select("correction_of_inventory_log_id,change_quantity")
              .in("correction_of_inventory_log_id",compatibleRoots.slice(offset,offset+100).map(row=>row.id)).limit(1001);
            if(error)throw error;
            if((rows?.length??0)>=1001)return jsonError("purchase_correction_review_required", "Correction history requires review.", 409, {blockReason:"correction_history_limit"});
            for(const row of rows??[]){if(row.correction_of_inventory_log_id==null)continue;
              const quantity=Number(row.change_quantity);
              if(!Number.isFinite(quantity))return jsonError("purchase_correction_review_required", "Invalid correction history.", 409, {blockReason:"invalid_correction_history"});
              const id=Number(row.correction_of_inventory_log_id);correctionTotals.set(id,(correctionTotals.get(id)??0)+quantity);
            }
          }
          compatibleRoots=compatibleRoots.map(row=>({...row,effectiveQuantity:roundDecimal(Number(row.change_quantity)+(correctionTotals.get(row.id)??0))}))
            .filter(row=>Number(row.effectiveQuantity)>0);
        }
        if (purchaseReduction && selectedPurchaseRootId === null && !automaticPurchaseCorrection) {
          return NextResponse.json({ ok: false, error: compatibleRoots.length ? "purchase_correction_selection_required" : "purchase_correction_root_not_found",
            candidates: compatibleRoots.slice(0, 1000),
            recommended: compatibleRoots.length === 1 && Number(compatibleRoots[0].effectiveQuantity) + delta >= 0 && (possibleRoots?.length ?? 0) < 1001,
          }, { status: 409 });
        }
        if(automaticPurchaseCorrection){
          if((possibleRoots?.length??0)>=1001 || compatibleRoots.length>1) return jsonError("purchase_correction_ambiguous","Unable to identify one receipt from today.",409,
            (possibleRoots?.length??0)>=1001 ? {blockReason:"candidate_limit",candidateCount:compatibleRoots.length,candidateCountExact:false}
              : {blockReason:"multiple_candidates",candidateCount:compatibleRoots.length,candidateCountExact:true});
          if(!compatibleRoots.length)return jsonError("purchase_correction_root_not_found","No matching receipt from today.",409);
        }
        const root = automaticPurchaseCorrection ? compatibleRoots[0] : compatibleRoots.find(row => row.id === selectedPurchaseRootId) ?? null;
        if (purchaseReduction && !root) return jsonError("invalid_purchase_correction", "Select a compatible original purchase.", 409);
        if (root) {
          // A later committed physical count already supersedes receipt-derived
          // stock. Existing expected-item/version checks protect concurrent counts.
          const countIssue=await purchaseCorrectionCountIssue(Number(id),root);
          if(countIssue)return jsonError(countIssue,"A later physical count must be preserved.",409,
            countIssue === "purchase_correction_review_required" ? {blockReason:"physical_count_unverified"} : undefined);
          if (!purchaseCorrectionIdentityMatches(root, correctionIdentity))
            return jsonError("purchase_correction_review_required", "Purchase details do not match the receipt.", 409, {blockReason:"purchase_details_changed"});
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
          if (closure) return jsonError("purchase_correction_review_required", "The purchase month is closed.", 409, {blockReason:"month_closed"});
          if (root.business_date.slice(0, 7) !== businessDate.slice(0, 7)) {
            const { data: issueClosure, error: issueClosureError } = await supabaseAdmin.from("ledger_month_closures")
              .select("month").eq("month", `${businessDate.slice(0, 7)}-01`).eq("status", "closed").maybeSingle();
            if (issueClosureError) throw issueClosureError;
            if (issueClosure) return jsonError("purchase_correction_review_required", "The correction month is closed.", 409, {blockReason:"month_closed"});
          }
          const { data: candidate, error: candidateError } = await supabaseAdmin.from("ledger_candidates")
            .select("status,proposed_amount,resolved_transaction_id,proposed_recognition_month")
            .eq("source_type", "inventory_purchase_log").eq("source_key", `inventory-log:${root.id}`)
            .order("id", { ascending: false }).limit(1).maybeSingle();
          if (candidateError) throw candidateError;
          if (candidate?.status === "dismissed") return jsonError("purchase_correction_review_required", "Purchase requires manual review.", 409, {blockReason:"purchase_dismissed"});
          if (candidate?.proposed_recognition_month && candidate.proposed_recognition_month !== `${root.business_date.slice(0, 7)}-01`) {
            const { data: recognitionClosure, error: recognitionError } = await supabaseAdmin.from("ledger_month_closures")
              .select("month").eq("month", candidate.proposed_recognition_month).eq("status", "closed").maybeSingle();
            if (recognitionError) throw recognitionError;
            if (recognitionClosure) return jsonError("purchase_correction_review_required", "The recognition month is closed.", 409, {blockReason:"month_closed"});
          }
          if (candidate?.status === "confirmed") {
            const { data: transaction, error: transactionError } = await supabaseAdmin.from("ledger_transactions")
              .select("amount,business_date,recognition_month,status,type,source_type").eq("id", candidate.resolved_transaction_id).maybeSingle();
            if (transactionError) throw transactionError;
            if (!transaction || Number(transaction.amount) !== Number(candidate.proposed_amount))
              return jsonError("purchase_correction_review_required", "Purchase has a manual Ledger override.", 409, {blockReason:transaction ? "ledger_amount_changed" : "ledger_transaction_missing"});
            if (transaction.status !== "confirmed" || transaction.type !== "expense" ||
                !["inventory_purchase_candidate", "inventory_purchase_rebook"].includes(transaction.source_type)) {
              return jsonError("purchase_correction_review_required", "Linked Ledger transaction requires review.", 409, {blockReason:"ledger_status_changed"});
            }
            const { data: payable, error: payableError } = await supabaseAdmin.from("ledger_payables")
              .select("id,status").eq("expense_transaction_id", candidate.resolved_transaction_id).maybeSingle();
            if (payableError) throw payableError;
            if (payable) {
              const { data: allocations, error: allocationError } = await supabaseAdmin.from("ledger_payable_allocations")
                .select("allocated_amount").eq("payable_id", payable.id).gt("allocated_amount", 0).limit(1);
              if (allocationError) throw allocationError;
              if (payable.status !== "unpaid" || (allocations?.length ?? 0) > 0)
                return jsonError("purchase_correction_review_required", "Purchase payment requires manual review.", 409,
                  {blockReason:payable.status === "paid" ? "payment_completed" : (allocations?.length??0)>0 ? "payment_allocated" : "payment_state"});
            }
            for (const month of [transaction.business_date?.slice(0, 7), transaction.recognition_month?.slice(0, 7)]) {
              if (!month || month === businessDate.slice(0, 7)) continue;
              const { data: otherClosure, error: otherClosureError } = await supabaseAdmin.from("ledger_month_closures")
                .select("month").eq("month", `${month}-01`).eq("status", "closed").maybeSingle();
              if (otherClosureError) throw otherClosureError;
              if (otherClosure) return jsonError("purchase_correction_review_required", "A linked Ledger month is closed.", 409, {blockReason:"month_closed"});
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

    if (mode === "quick-save" && quickSaveLogReason === "purchase" && autoCorrectionRootId === null && quickSaveNextQuantity !== null &&
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

    if(correctionPurchaseLogId!==null){
      const {data:roots,error}=await supabaseAdmin.from("inventory_logs").select("id,created_at")
        .eq("item_id",Number(id)).eq("id",correctionPurchaseLogId).limit(1);
      if(error)throw error;
      if(!roots?.[0])return jsonError("invalid_purchase_correction","Original purchase not found.",400);
      const countIssue=await purchaseCorrectionCountIssue(Number(id),roots[0]);
      if(countIssue)return jsonError(countIssue,"A later physical count must be preserved.",409,
            countIssue === "purchase_correction_review_required" ? {blockReason:"physical_count_unverified"} : undefined);
    }
    if (correctionPurchaseLogId !== null || autoCorrectionRootId !== null) {
      // A correction reduces an existing receipt; its 실청구금액 is changed only in 입고 수정.
      if (billedRequest?.mode === "manual") return jsonError("invalid_billed_amount", "A billed amount belongs to a new receipt.", 400);
      const businessDate = autoCorrectionBusinessDate ?? (await resolveInventoryBusinessDate()).businessDate;
      writeStarted = true;
      const { data: correction, error } = await inventoryWrite("inventory_apply_purchase_correction_v3", {
        p_item_id: Number(id), p_purchase_log_id: correctionPurchaseLogId ?? autoCorrectionRootId,
        p_expected_quantity: autoCorrectionRootId !== null ? Number(prevItem.quantity) : Number(expectedQuantity),
        p_expected_item: prevItem, p_payload: serverPayload,
        p_business_date: businessDate, p_actor_user_id: actor.id,
      }, body.inventoryEvent, mode !== "quick-save");
      if (error && isBilledAmountEditRequired(error))
        return jsonError("purchase_billed_amount_edit_required", "This receipt has a manual billed amount. Use the receipt edit.", 409,
          { blockReason: "billed_amount_manual" });
      if (error) throw error;
      if (correction?.status !== "ok") {
        return jsonError(correction?.status ?? "purchase_correction_failed", "Purchase correction was not saved.",
          ["quantity_conflict", "inventory_conflict"].includes(correction?.status) ? 409 : correction?.status === "forbidden" ? 403 : correction?.status === "not_found" ? 404 : 400);
      }
      // v3 commits the inventory correction and its projection together. Never
      // retry via a second RPC if this operation or the local migration is missing.
      return NextResponse.json({ok:true,mode,ledgerSync:correction.ledgerSync});
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
    // A purchase save carries its 실청구금액; the RPC keeps it only for a new receipt and then
    // projects that receipt to the Ledger in the same transaction.
    const billedPayload = logReason === "purchase" && billedRequest ? billedAmountColumns(billedRequest) : {};
    writeStarted = true;
    const writeBegin = performance.now();
    const { data: saved, error: saveError } = await inventoryWrite("inventory_update_with_audit_v1", {
      p_item_id: Number(id), p_expected_item: prevItem, p_payload: { ...serverPayload, ...billedPayload },
      p_business_date: businessDate, p_actor_user_id: actor.id, p_reason: logReason, p_source: logSource,
      p_price_business_date: mode !== "quick-save" && typeof body.business_date === "string" ? body.business_date : businessDate,
    }, body.inventoryEvent, mode !== "quick-save");
    const writeDuration = performance.now() - writeBegin;
    if (saveError) throw saveError;
    if (saved?.status !== "ok") {
      const status = ["inventory_conflict", "purchase_correction_required"].includes(saved?.status) ? 409 : saved?.status === "forbidden" ? 403 : saved?.status === "not_found" ? 404 : 400;
      return jsonError(saved?.status === "inventory_conflict" ? "INVENTORY_CONFLICT" : saved?.status ?? "inventory_save_failed",
        "Item was not saved. Reload before retrying if it changed.", status);
    }
    const ledgerSync = saved.ledgerSync ?? (logReason === "purchase"
      ? await projectInventoryPurchaseLog(Number(saved.inventoryLogId), actor.id)
      : undefined);
    return NextResponse.json({ ok: true, mode, ledgerSync, inventoryLogId: saved.inventoryLogId }, {
      headers: { "Server-Timing": `inventory-write;dur=${writeDuration.toFixed(1)}, inventory-patch;dur=${(performance.now() - requestStarted).toFixed(1)}` },
    });
  } catch (error) {
    const contractResponse = writerContractResponse(error);
    if (contractResponse) return contractResponse;
    console.error("[INVENTORY_PATCH_ERROR]", error);
    const dbCode = getSupabaseErrorField(error, "code");
    const timedOut = dbCode === "57014";
    return NextResponse.json(
      { ok: false, error: timedOut ? "inventory_save_timeout" : "inventory_request_failed", message: INTERNAL_ERROR_MESSAGE,
        writeState: !writeStarted || timedOut ? "not_saved" : "unknown" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const { actor, response } = await authenticatedActorResponse();
  if (response) return response;
  const body = await req.json().catch(() => null);
  if (!body?.id) return jsonError("missing_item_id", "Missing id", 400);
  const itemId = Number(body.id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return jsonError("invalid_item_id", "Invalid id", 400);
  if (!canDeleteInventoryItem(actor.role)) return jsonError("inventory_item_delete_forbidden", "Inventory item deletion requires admin permission.", 403);
  // Pre-deploy safe: no DB/Storage call, irrespective of schema, history or flags.
  // This policy is permanent; retries cannot make a destructive request valid.
  return jsonError("inventory_history_preservation_required", "Deactivate the item to preserve its inventory and POS history.", 409,
    { retryable: false, requiresRefresh: false, nextAction: "deactivate_item" });
}
