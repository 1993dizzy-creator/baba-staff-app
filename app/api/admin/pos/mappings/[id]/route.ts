import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  extractProductOptions,
  findLegacyProductCandidates,
  getCatalogCode,
  isMissingMappingSchemaError,
  type PosItemMappingRow,
  type PosProductRow,
} from "@/lib/pos/mapping-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRODUCT_SELECT =
  "id, source, branch_id, pos_item_id, item_code, item_name, item_name_vi, category_name, unit_name, is_active, is_sold, raw_json";
const MAPPING_SELECT =
  "id, pos_item_code, pos_item_name, pos_unit_name, mapping_type, inventory_item_id, quantity_multiplier, source_quantity, source_unit, source_package_content_quantity, source_package_content_unit, is_active, pos_product_id, target_type, pos_option_id, pos_product_code_snapshot, pos_product_name_snapshot, pos_option_name_snapshot, mapping_version, last_reconciled_at, updated_at, updated_by, archived_at, archived_by, archive_reason";

type JsonObject = Record<string, unknown>;
type MappingType = "direct" | "recipe" | "combo" | "manual" | "ignore";
type TargetType = "product" | "option";

const MAPPING_TYPES = new Set<MappingType>([
  "direct",
  "recipe",
  "combo",
  "manual",
  "ignore",
]);
const TARGET_TYPES = new Set<TargetType>(["product", "option"]);

async function getAdminActor(actorUsername: string) {
  if (!actorUsername) return null;

  const { data } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (
    !data ||
    (data.role !== "owner" &&
      data.role !== "master" &&
      data.role !== "manager" &&
      data.role !== "leader")
  ) {
    return null;
  }

  return data;
}

function getPositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getPositiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasOwn(body: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function getSupabaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function getText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSourceUnit(value: unknown) {
  if (typeof value !== "string") return null;
  const unit = value.trim().toLowerCase();
  return unit === "ml" || unit === "g" ? unit : null;
}

function getDirectSourceFields(body: JsonObject) {
  const keys = [
    "sourceQuantity",
    "sourceUnit",
    "sourcePackageContentQuantity",
    "sourcePackageContentUnit",
  ];
  const presentKeys = keys.filter((key) => hasOwn(body, key));
  const hasAnySourceField = presentKeys.length > 0;
  const sourceFieldsAreEmpty = keys.every(
    (key) => body[key] === undefined || body[key] === null || body[key] === ""
  );

  if (!hasAnySourceField || sourceFieldsAreEmpty) {
    return {
      ok: true as const,
      hasSource: false,
      values: {
        source_quantity: null,
        source_unit: null,
        source_package_content_quantity: null,
        source_package_content_unit: null,
      },
    };
  }

  const sourceQuantity = getPositiveNumber(body.sourceQuantity);
  const sourceUnit = normalizeSourceUnit(body.sourceUnit);
  const sourcePackageContentQuantity = getPositiveNumber(
    body.sourcePackageContentQuantity
  );
  const sourcePackageContentUnit = normalizeSourceUnit(
    body.sourcePackageContentUnit
  );

  if (
    presentKeys.length !== keys.length ||
    !sourceQuantity ||
    !sourcePackageContentQuantity ||
    !sourceUnit ||
    !sourcePackageContentUnit ||
    sourceUnit !== sourcePackageContentUnit
  ) {
    return {
      ok: false as const,
      error:
        "Direct source fields require positive source quantity, matching ml/g unit, and positive package content quantity.",
    };
  }

  return {
    ok: true as const,
    hasSource: true,
    values: {
      source_quantity: sourceQuantity,
      source_unit: sourceUnit,
      source_package_content_quantity: sourcePackageContentQuantity,
      source_package_content_unit: sourcePackageContentUnit,
    },
  };
}

function normalizeDirectSourceMultiplier(sourceFields: {
  source_quantity: number | null;
  source_package_content_quantity: number | null;
}) {
  if (
    !sourceFields.source_quantity ||
    !sourceFields.source_package_content_quantity
  ) {
    return null;
  }
  const multiplier =
    sourceFields.source_quantity /
    sourceFields.source_package_content_quantity;
  return Number.isFinite(multiplier) && multiplier > 0
    ? Number(multiplier.toFixed(6))
    : null;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const mappingId = getPositiveInteger(id);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername = getText(body.actorUsername);
    const action = getText(body.action);
    const actor = await getAdminActor(actorUsername);

    if (
      !actor ||
      (actor.role !== "owner" &&
        actor.role !== "master" &&
        actor.role !== "leader")
    ) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }
    if (!mappingId) {
      return NextResponse.json(
        { ok: false, error: "Invalid mapping id." },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseServer
      .from("pos_item_mappings")
      .select(MAPPING_SELECT)
      .eq("id", mappingId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "POS mapping was not found." },
        { status: 404 }
      );
    }

    const current = data as PosItemMappingRow;
    const now = new Date().toISOString();

    if (action === "relink") {
      const targetPosProductId = getPositiveInteger(body.targetPosProductId);
      if (body.approved !== true || !targetPosProductId) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Explicit approval and targetPosProductId are required for relinking.",
          },
          { status: 400 }
        );
      }
      if (
        current.archived_at ||
        current.target_type !== "product" ||
        current.pos_option_id
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: "Only non-archived product mappings can be relinked.",
          },
          { status: 409 }
        );
      }

      const [
        { data: product, error: productError },
        conflictResult,
        currentProductResult,
        exactCodeResult,
      ] =
        await Promise.all([
          supabaseServer
            .from("pos_products")
            .select(PRODUCT_SELECT)
            .eq("id", targetPosProductId)
            .eq("source", "cukcuk")
            .maybeSingle(),
          supabaseServer
            .from("pos_item_mappings")
            .select("id")
            .eq("pos_product_id", targetPosProductId)
            .neq("id", mappingId)
            .is("archived_at", null)
            .limit(1),
          current.pos_product_id
            ? supabaseServer
                .from("pos_products")
                .select("id")
                .eq("id", current.pos_product_id)
                .eq("source", "cukcuk")
                .limit(1)
            : Promise.resolve({ data: [], error: null }),
          getCatalogCode(current.pos_item_code)
            ? supabaseServer
                .from("pos_products")
                .select("id")
                .eq("source", "cukcuk")
                .eq("item_code", getCatalogCode(current.pos_item_code))
                .limit(1)
            : Promise.resolve({ data: [], error: null }),
        ]);

      if (productError) throw productError;
      if (conflictResult.error) throw conflictResult.error;
      if (currentProductResult.error) throw currentProductResult.error;
      if (exactCodeResult.error) throw exactCodeResult.error;
      if (!product) {
        return NextResponse.json(
          { ok: false, error: "Target CUKCUK POS product was not found." },
          { status: 404 }
        );
      }
      if ((conflictResult.data || []).length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: "Another mapping already uses the target POS product.",
          },
          { status: 409 }
        );
      }
      if (
        (currentProductResult.data || []).length > 0 ||
        (exactCodeResult.data || []).length > 0
      ) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "This mapping is not Orphaned. Use the normal mapping workflow instead.",
          },
          { status: 409 }
        );
      }

      let updateQuery = supabaseServer
        .from("pos_item_mappings")
        .update({
          pos_product_id: product.id,
          pos_product_code_snapshot: product.item_code,
          pos_product_name_snapshot: product.item_name,
          mapping_version: Number(current.mapping_version ?? 1) + 1,
          last_reconciled_at: now,
          updated_at: now,
          updated_by: actor.username,
        })
        .eq("id", mappingId)
        .is("archived_at", null);

      updateQuery =
        current.mapping_version === null
          ? updateQuery.is("mapping_version", null)
          : updateQuery.eq(
              "mapping_version",
              Number(current.mapping_version)
            );

      const { data: updated, error: updateError } = await updateQuery
        .select(MAPPING_SELECT)
        .maybeSingle();

      if (updateError) {
        if (getSupabaseErrorCode(updateError) === "23505") {
          return NextResponse.json(
            {
              ok: false,
              error: "Another mapping already uses the target POS product.",
            },
            { status: 409 }
          );
        }
        throw updateError;
      }
      if (!updated) {
        return NextResponse.json(
          {
            ok: false,
            error: "Mapping changed while relinking. Reload and retry.",
          },
          { status: 409 }
        );
      }

      return NextResponse.json({ ok: true, mapping: updated });
    }

    if (action === "archive") {
      const archiveReason = getText(body.archiveReason);
      if (!archiveReason) {
        return NextResponse.json(
          { ok: false, error: "archiveReason is required." },
          { status: 400 }
        );
      }
      if (current.archived_at) {
        return NextResponse.json(
          { ok: false, error: "Mapping is already archived." },
          { status: 409 }
        );
      }
      if (
        current.target_type !== "product" ||
        current.pos_option_id
      ) {
        return NextResponse.json(
          { ok: false, error: "Only Orphaned product mappings can be archived." },
          { status: 409 }
        );
      }

      if (current.pos_product_id) {
        const { data: linkedProduct, error: linkedProductError } =
          await supabaseServer
            .from("pos_products")
            .select("id")
            .eq("id", current.pos_product_id)
            .eq("source", "cukcuk")
            .maybeSingle();

        if (linkedProductError) throw linkedProductError;
        if (linkedProduct) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "The mapping still points to a current POS product and is not Orphaned.",
            },
            { status: 409 }
          );
        }
      }

      const itemCode = getCatalogCode(current.pos_item_code);
      if (itemCode) {
        const { count, error: productError } = await supabaseServer
          .from("pos_products")
          .select("id", { count: "exact", head: true })
          .eq("source", "cukcuk")
          .eq("item_code", itemCode);

        if (productError) throw productError;
        if ((count || 0) > 0) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "A current POS product has the same item code. Reconcile or review the mapping instead.",
            },
            { status: 409 }
          );
        }
      }

      const { data: updated, error: updateError } = await supabaseServer
        .from("pos_item_mappings")
        .update({
          archived_at: now,
          archived_by: actor.username,
          archive_reason: archiveReason,
        })
        .eq("id", mappingId)
        .is("archived_at", null)
        .select(MAPPING_SELECT)
        .maybeSingle();

      if (updateError) throw updateError;
      if (!updated) {
        return NextResponse.json(
          {
            ok: false,
            error: "Mapping changed while archiving. Reload and retry.",
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true, mapping: updated });
    }

    if (action === "restore") {
      if (!current.archived_at) {
        return NextResponse.json(
          { ok: false, error: "Mapping is not archived." },
          { status: 409 }
        );
      }

      const { data: updated, error: updateError } = await supabaseServer
        .from("pos_item_mappings")
        .update({
          archived_at: null,
          archived_by: null,
          archive_reason: null,
        })
        .eq("id", mappingId)
        .eq("archived_at", current.archived_at)
        .select(MAPPING_SELECT)
        .maybeSingle();

      if (updateError) {
        if (getSupabaseErrorCode(updateError) === "23505") {
          return NextResponse.json(
            {
              ok: false,
              error:
                "Another active mapping currently uses the restored POS target.",
            },
            { status: 409 }
          );
        }
        throw updateError;
      }
      if (!updated) {
        return NextResponse.json(
          {
            ok: false,
            error: "Mapping changed while restoring. Reload and retry.",
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true, mapping: updated });
    }

    return NextResponse.json(
      { ok: false, error: "Unsupported mapping action." },
      { status: 400 }
    );
  } catch (error) {
    if (isMissingMappingSchemaError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "POS mapping archive migration has not been applied.",
        },
        { status: 503 }
      );
    }

    console.error("[ADMIN_POS_MAPPING_ACTION_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to perform POS mapping action.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const mappingId = getPositiveInteger(id);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const actor = await getAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    if (!mappingId) {
      return NextResponse.json(
        { ok: false, error: "Invalid mapping id." },
        { status: 400 }
      );
    }

    const { data: currentData, error: currentError } = await supabaseServer
      .from("pos_item_mappings")
      .select(MAPPING_SELECT)
      .eq("id", mappingId)
      .maybeSingle();

    if (currentError) throw currentError;
    if (!currentData) {
      return NextResponse.json(
        { ok: false, error: "POS mapping was not found." },
        { status: 404 }
      );
    }

    const current = currentData as PosItemMappingRow;
    if (current.archived_at) {
      return NextResponse.json(
        { ok: false, error: "Archived mappings cannot be edited." },
        { status: 409 }
      );
    }
    const mappingType =
      hasOwn(body, "mappingType") && typeof body.mappingType === "string"
        ? MAPPING_TYPES.has(body.mappingType as MappingType)
          ? (body.mappingType as MappingType)
          : null
        : (current.mapping_type as MappingType);
    const targetType =
      hasOwn(body, "targetType") && typeof body.targetType === "string"
        ? TARGET_TYPES.has(body.targetType as TargetType)
          ? (body.targetType as TargetType)
          : null
        : current.target_type;
    const posProductId = hasOwn(body, "posProductId")
      ? body.posProductId === null || body.posProductId === ""
        ? null
        : getPositiveInteger(body.posProductId)
      : current.pos_product_id;
    const posOptionId = hasOwn(body, "posOptionId")
      ? typeof body.posOptionId === "string" && body.posOptionId.trim()
        ? body.posOptionId.trim()
        : null
      : current.pos_option_id;
    const inventoryItemId = hasOwn(body, "inventoryItemId")
      ? body.inventoryItemId === null || body.inventoryItemId === ""
        ? null
        : getPositiveInteger(body.inventoryItemId)
      : current.inventory_item_id;
    const quantityMultiplier = hasOwn(body, "quantityMultiplier")
      ? getPositiveNumber(body.quantityMultiplier)
      : getPositiveNumber(current.quantity_multiplier);
    const directSourceFields = getDirectSourceFields(body);
    const isActive = hasOwn(body, "isActive")
      ? body.isActive === true
      : current.is_active === true;

    if (!mappingType || !targetType) {
      return NextResponse.json(
        { ok: false, error: "Unsupported mappingType or targetType." },
        { status: 400 }
      );
    }

    if (targetType !== current.target_type) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "targetType cannot be changed after creation. Create a separate mapping.",
        },
        { status: 400 }
      );
    }

    if (
      targetType === "option" &&
      (Number(posProductId) !== Number(current.pos_product_id) ||
        posOptionId !== current.pos_option_id)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "An option mapping cannot be moved to another product or option.",
        },
        { status: 400 }
      );
    }

    if (!quantityMultiplier) {
      return NextResponse.json(
        { ok: false, error: "quantityMultiplier must be greater than zero." },
        { status: 400 }
      );
    }

    if (!directSourceFields.ok) {
      return NextResponse.json(
        { ok: false, error: directSourceFields.error },
        { status: 400 }
      );
    }

    if (mappingType === "direct" && !inventoryItemId) {
      return NextResponse.json(
        { ok: false, error: "Direct mappings require an inventory item." },
        { status: 400 }
      );
    }

    if (mappingType === "combo" && targetType !== "product") {
      return NextResponse.json(
        { ok: false, error: "Combo mappings are only supported for products." },
        { status: 400 }
      );
    }

    if (targetType === "option" && (!posProductId || !posOptionId)) {
      return NextResponse.json(
        {
          ok: false,
          error: "Option mappings require posProductId and posOptionId.",
        },
        { status: 400 }
      );
    }

    if (inventoryItemId) {
      const { data: inventoryItem, error: inventoryError } =
        await supabaseServer
          .from("inventory")
          .select("id")
          .eq("id", inventoryItemId)
          .maybeSingle();

      if (inventoryError) throw inventoryError;
      if (!inventoryItem) {
        return NextResponse.json(
          { ok: false, error: "Inventory item was not found." },
          { status: 400 }
        );
      }
    }

    let product: PosProductRow | null = null;
    if (posProductId) {
      const { data, error } = await supabaseServer
        .from("pos_products")
        .select(PRODUCT_SELECT)
        .eq("id", posProductId)
        .eq("source", "cukcuk")
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        return NextResponse.json(
          { ok: false, error: "CUKCUK POS product was not found." },
          { status: 400 }
        );
      }
      product = data as PosProductRow;
    }

    const option =
      targetType === "option" && product
        ? extractProductOptions(product).find((item) => item.id === posOptionId)
        : null;

    if (targetType === "option" && !option) {
      return NextResponse.json(
        { ok: false, error: "POS option was not found in the product catalog." },
        { status: 400 }
      );
    }

    const nextVersion = Number(current.mapping_version ?? 1) + 1;
    const now = new Date().toISOString();
    const storedInventoryItemId =
      mappingType === "direct" ? inventoryItemId : null;
    const storedSourceFields =
      mappingType === "direct"
        ? directSourceFields.values
        : {
            source_quantity: null,
            source_unit: null,
            source_package_content_quantity: null,
            source_package_content_unit: null,
          };
    const storedQuantityMultiplier =
      mappingType === "direct" && directSourceFields.hasSource
        ? normalizeDirectSourceMultiplier(storedSourceFields)
        : quantityMultiplier;

    if (!storedQuantityMultiplier) {
      return NextResponse.json(
        { ok: false, error: "quantityMultiplier must be greater than zero." },
        { status: 400 }
      );
    }
    let updateQuery = supabaseServer
      .from("pos_item_mappings")
      .update({
        mapping_type: mappingType,
        inventory_item_id: storedInventoryItemId,
        quantity_multiplier: storedQuantityMultiplier,
        ...storedSourceFields,
        is_active: isActive,
        pos_product_id: posProductId,
        target_type: targetType,
        pos_option_id: targetType === "option" ? posOptionId : null,
        pos_product_code_snapshot:
          product?.item_code ?? current.pos_product_code_snapshot,
        pos_product_name_snapshot:
          product?.item_name ?? current.pos_product_name_snapshot,
        pos_option_name_snapshot:
          targetType === "option"
            ? option?.name ?? current.pos_option_name_snapshot
            : null,
        mapping_version: nextVersion,
        last_reconciled_at: product ? now : current.last_reconciled_at,
        updated_at: now,
        updated_by: actor.username,
      })
      .eq("id", mappingId);

    if (current.mapping_version === null) {
      updateQuery = updateQuery.is("mapping_version", null);
    } else {
      updateQuery = updateQuery.eq(
        "mapping_version",
        Number(current.mapping_version)
      );
    }

    const { data, error } = await updateQuery
      .select(MAPPING_SELECT)
      .maybeSingle();

    if (error) {
      const code = getSupabaseErrorCode(error);
      if (code === "23505") {
        return NextResponse.json(
          {
            ok: false,
            error:
              "An active mapping already exists for this POS product or option.",
          },
          { status: 409 }
        );
      }
      if (code === "23503") {
        return NextResponse.json(
          {
            ok: false,
            error: "The selected POS product or inventory item does not exist.",
          },
          { status: 400 }
        );
      }
      throw error;
    }

    if (!data) {
      return NextResponse.json(
        {
          ok: false,
          error: "Mapping changed while it was being edited. Reload and retry.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, mapping: data });
  } catch (error) {
    if (isMissingMappingSchemaError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "POS mapping catalog migration has not been applied.",
        },
        { status: 503 }
      );
    }

    console.error("[ADMIN_POS_MAPPING_PATCH_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update POS mapping.",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const mappingId = getPositiveInteger(id);
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const actor = await getAdminActor(actorUsername);

    if (
      !actor ||
      (actor.role !== "owner" &&
        actor.role !== "master" &&
        actor.role !== "leader")
    ) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    if (!mappingId) {
      return NextResponse.json(
        { ok: false, error: "Invalid mapping id." },
        { status: 400 }
      );
    }

    const { data: currentData, error: currentError } = await supabaseServer
      .from("pos_item_mappings")
      .select(MAPPING_SELECT)
      .eq("id", mappingId)
      .maybeSingle();

    if (currentError) throw currentError;
    if (!currentData) {
      return NextResponse.json(
        { ok: false, error: "POS mapping was not found." },
        { status: 404 }
      );
    }

    const current = currentData as PosItemMappingRow;
    if (current.archived_at) {
      return NextResponse.json(
        { ok: false, error: "Archived mappings cannot be hard deleted." },
        { status: 409 }
      );
    }
    if (current.target_type !== "product" || current.pos_option_id) {
      return NextResponse.json(
        { ok: false, error: "옵션 매핑은 Orphaned 삭제 대상이 아닙니다." },
        { status: 409 }
      );
    }

    const { data: products, error: productsError } = await supabaseServer
      .from("pos_products")
      .select(PRODUCT_SELECT)
      .eq("source", "cukcuk");

    if (productsError) throw productsError;
    const catalogProducts = (products || []) as PosProductRow[];
    const exactCode = getCatalogCode(current.pos_item_code);
    const linkedProduct = current.pos_product_id
      ? catalogProducts.find(
          (product) => Number(product.id) === Number(current.pos_product_id)
        )
      : null;
    const exactProducts = exactCode
      ? catalogProducts.filter(
          (product) => getCatalogCode(product.item_code) === exactCode
        )
      : [];

    if (linkedProduct || exactProducts.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "현재 POS 상품 목록에서 연결 대상을 찾을 수 있어 Orphaned 매핑으로 삭제할 수 없습니다.",
        },
        { status: 409 }
      );
    }

    const legacyCandidates = findLegacyProductCandidates(
      current.pos_item_code,
      catalogProducts
    );
    const [recipeResult, deductionResult, processedLineResult] =
      await Promise.all([
        supabaseServer
          .from("pos_item_mapping_recipes")
          .select("id", { count: "exact", head: true })
          .eq("mapping_id", mappingId),
        supabaseServer
          .from("pos_inventory_deductions")
          .select("id", { count: "exact", head: true })
          .eq("mapping_id", mappingId),
        supabaseServer
          .from("pos_processed_invoice_lines")
          .select("id", { count: "exact", head: true })
          .eq("mapping_id", mappingId),
      ]);

    if (recipeResult.error) throw recipeResult.error;
    if (deductionResult.error) throw deductionResult.error;
    if (processedLineResult.error) throw processedLineResult.error;

    const blockers: string[] = [];
    if (legacyCandidates.length > 0) {
      blockers.push(
        `재연결 후보 POS 상품: ${legacyCandidates
          .map((product) => product.item_code || product.item_name)
          .join(", ")}`
      );
    }
    if ((deductionResult.count || 0) > 0) {
      blockers.push(
        `판매 재고차감 이력 ${deductionResult.count || 0}건이 이 매핑을 참조합니다.`
      );
    }
    if ((processedLineResult.count || 0) > 0) {
      blockers.push(
        `구형 POS 처리 이력 ${processedLineResult.count || 0}건이 이 매핑을 참조합니다.`
      );
    }
    if ((recipeResult.count || 0) > 0) {
      blockers.push(
        `Recipe 하위 행 ${recipeResult.count || 0}건이 있어 자동 hard delete하지 않습니다.`
      );
    }

    if (blockers.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: blockers.join(" "),
          blockers,
          legacyCandidates: legacyCandidates.map((product) => ({
            id: product.id,
            itemCode: product.item_code,
            itemName: product.item_name,
            isActive: product.is_active === true,
          })),
        },
        { status: 409 }
      );
    }

    const { data: deleted, error: deleteError } = await supabaseServer
      .from("pos_item_mappings")
      .delete()
      .eq("id", mappingId)
      .select("id")
      .maybeSingle();

    if (deleteError) {
      if (getSupabaseErrorCode(deleteError) === "23503") {
        return NextResponse.json(
          {
            ok: false,
            error:
              "다른 데이터가 이 매핑을 참조하고 있어 삭제할 수 없습니다.",
          },
          { status: 409 }
        );
      }
      throw deleteError;
    }

    if (!deleted) {
      return NextResponse.json(
        {
          ok: false,
          error: "매핑이 이미 변경되었거나 삭제되었습니다. 목록을 새로고침하세요.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, deletedMappingId: mappingId });
  } catch (error) {
    if (isMissingMappingSchemaError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "POS mapping catalog migration has not been applied.",
        },
        { status: 503 }
      );
    }

    console.error("[ADMIN_POS_MAPPING_DELETE_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete POS mapping.",
      },
      { status: 500 }
    );
  }
}
