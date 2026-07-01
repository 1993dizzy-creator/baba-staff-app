import "server-only";

import { createHash } from "node:crypto";
import { supabaseServer } from "@/lib/supabase/server";
import {
  asObject,
  extractProductChildren,
  findProductForChild,
  getCatalogCode,
  type PosItemMappingRecipeRow,
  type PosItemMappingRow,
  type PosProductRow,
} from "@/lib/pos/mapping-catalog";
import { validatePosMappings } from "@/lib/pos/mapping-validation";

const HASH_VERSION = 1;
const PAGE_SIZE = 1000;
const RECEIPT_SELECT =
  "id, ref_id, ref_no, business_date, ref_date, payment_status, is_canceled, total_amount, discount_amount, vat_amount, final_amount, receive_amount, return_amount, is_modified, review_status, updated_at";
const LINE_SELECT =
  "id, receipt_id, receipt_ref_id, ref_detail_id, parent_ref_detail_id, sort_order, item_id, item_code, item_name, unit_name, quantity, unit_price, amount, discount_amount, final_amount, tax_rate, tax_amount, ref_detail_type, inventory_item_type, is_option, is_excluded, mapping_status, raw_json";
const PRODUCT_SELECT =
  "id, source, branch_id, pos_item_id, item_id, item_code, item_name, item_name_vi, category_name, unit_name, is_active, is_sold, raw_json";
const MAPPING_SELECT =
  "id, pos_item_code, pos_item_name, pos_unit_name, mapping_type, inventory_item_id, quantity_multiplier, is_active, pos_product_id, target_type, pos_option_id, pos_product_code_snapshot, pos_product_name_snapshot, pos_option_name_snapshot, mapping_version, last_reconciled_at, updated_at, updated_by, archived_at, archived_by, archive_reason";
const RECIPE_SELECT =
  "id, mapping_id, inventory_item_id, quantity_per_pos_unit, is_active, is_required, version";

type ReceiptRow = {
  id: number;
  ref_id: string;
  ref_no: string | null;
  business_date: string;
  ref_date: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
  total_amount: number | string | null;
  discount_amount: number | string | null;
  vat_amount: number | string | null;
  final_amount: number | string | null;
  receive_amount: number | string | null;
  return_amount: number | string | null;
  is_modified: boolean | null;
  review_status: string | null;
  updated_at: string | null;
};

type LineRow = {
  id: number;
  receipt_id: number | null;
  receipt_ref_id: string;
  ref_detail_id: string | null;
  parent_ref_detail_id: string | null;
  sort_order: number | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string | null;
  unit_name: string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
  amount: number | string | null;
  discount_amount: number | string | null;
  final_amount: number | string | null;
  tax_rate: number | string | null;
  tax_amount: number | string | null;
  ref_detail_type: number | null;
  inventory_item_type: number | null;
  is_option: boolean | null;
  is_excluded: boolean | null;
  mapping_status: string | null;
  raw_json: unknown;
};

type ProductRow = PosProductRow & {
  item_id: string | null;
};

type InventoryRow = {
  id: number;
  item_name: string | null;
  item_name_vi: string | null;
  code: string | null;
  unit: string | null;
  quantity: number | string | null;
};

type PaymentRow = {
  receipt_id: number;
  payment_type: number | null;
  payment_name: string | null;
  card_name: string | null;
  amount: number | string | null;
};

type AppliedDeductionRow = {
  invoice_ref_id: string | null;
  receipt_line_id: number | string | null;
  inventory_item_id: number | string | null;
  mapping_id: number | string | null;
  recipe_id: number | string | null;
  applied_at: string | null;
  updated_at: string | null;
};

export type PreviewReceiptStatus =
  | "ready"
  | "skipped"
  | "missing_mapping"
  | "manual_review"
  | "invalid_mapping"
  | "incomplete_recipe"
  | "insufficient_stock"
  | "already_applied"
  | "applied_after_modified"
  | "review_required";

export type PreviewLineType =
  | "direct"
  | "recipe"
  | "option_direct"
  | "option_recipe"
  | "combo_direct"
  | "combo_recipe"
  | "combo_ignore"
  | "combo_incomplete_recipe"
  | "combo_missing_mapping"
  | "combo_invalid_mapping"
  | "manual"
  | "ignore"
  | "incomplete_recipe"
  | "missing_mapping"
  | "invalid_mapping";

type DeductionComponent = {
  inventoryItemId: number;
  inventoryItemName: string;
  inventoryCode: string | null;
  inventoryUnit: string | null;
  deductQuantity: number;
  currentQuantity: number;
  afterQuantity: number;
  status: "ok" | "insufficient_stock";
  recipeId: number | null;
  recipeVersion: number | null;
  deductQuantityPerUnit: number;
};

type PreviewLine = {
  receiptId: number;
  receiptLineId: number;
  refDetailId: string | null;
  parentRefDetailId: string | null;
  isOption: boolean;
  lineType: PreviewLineType;
  posProductId: number | null;
  posItemCode: string | null;
  itemName: string | null;
  quantitySold: number;
  mappingId: number | null;
  mappingType: string | null;
  mappingVersion: number | null;
  mappingSnapshot: Record<string, unknown> | null;
  status: string;
  blockedReason: string | null;
  deductions: DeductionComponent[];
};

type WorkingReceipt = {
  receipt: ReceiptRow;
  status: PreviewReceiptStatus;
  blockedReasons: string[];
  lines: PreviewLine[];
  inventoryAffectingHash: string;
  amountHash: string;
  canContributeStock: boolean;
};

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNumber(value: unknown) {
  return Number(toNumber(value).toFixed(6));
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getOptionId(line: LineRow) {
  const raw = asObject(line.raw_json);
  return (
    getString(raw?.InventoryItemAdditionID) ||
    getString(raw?.InventoryItemAdditionId) ||
    getString(raw?.AdditionID) ||
    getString(raw?.AdditionId) ||
    getString(raw?.OptionID) ||
    getString(raw?.OptionId)
  );
}

function isOptionLine(line: LineRow) {
  const raw = asObject(line.raw_json);
  return (
    line.is_option === true ||
    Boolean(line.parent_ref_detail_id) ||
    line.ref_detail_type !== 1 ||
    line.mapping_status === "option" ||
    Boolean(raw?.ParentID) ||
    Boolean(raw?.InventoryItemAdditionID)
  );
}

function inventoryName(item: InventoryRow | undefined, id: number) {
  return item?.item_name_vi || item?.item_name || `Inventory #${id}`;
}

function isAfter(left: string | null, right: string | null) {
  if (!left || !right) return false;
  return new Date(left).getTime() > new Date(right).getTime();
}

async function fetchAll<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>
) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function addBlockedReason(receipt: WorkingReceipt, reason: string) {
  if (!receipt.blockedReasons.includes(reason)) {
    receipt.blockedReasons.push(reason);
  }
}

function resolveBlockedStatus(lines: PreviewLine[]) {
  const hasDeductionLines = lines.some((line) => line.deductions.length > 0);
  if (hasDeductionLines) return null;
  const statuses = new Set(lines.map((line) => line.status));
  if (statuses.has("missing_mapping")) return "missing_mapping" as const;
  if (statuses.has("manual_review")) return "manual_review" as const;
  if (statuses.has("invalid_mapping")) return "invalid_mapping" as const;
  return null;
}

function hasDeductionCandidates(lines: PreviewLine[]) {
  return lines.some((line) => line.deductions.length > 0);
}

function hasIncompleteRecipeLines(lines: PreviewLine[]) {
  return lines.some((line) => line.status === "incomplete_recipe");
}

function getAppliedDeductionKey(row: {
  receiptLineId: number;
  inventoryItemId: number;
  mappingId: number | null;
  recipeId: number | null;
}) {
  return [
    row.receiptLineId,
    row.inventoryItemId,
    row.mappingId ?? "",
    row.recipeId ?? "",
  ].join(":");
}

export async function buildInventoryDeductionPreview(input: {
  businessDateFrom: string;
  businessDateTo: string;
  receiptIds?: number[];
}) {
  const validation = await validatePosMappings();
  let receiptQuery = supabaseServer
    .from("pos_sales_receipts")
    .select(RECEIPT_SELECT)
    .eq("payment_status", 3)
    .or("is_canceled.is.null,is_canceled.eq.false")
    .order("business_date", { ascending: true })
    .order("id", { ascending: true });

  if (input.receiptIds?.length) {
    receiptQuery = receiptQuery.in("id", input.receiptIds);
  } else {
    receiptQuery = receiptQuery
      .gte("business_date", input.businessDateFrom)
      .lte("business_date", input.businessDateTo);
  }

  const { data: receiptData, error: receiptError } = await receiptQuery;
  if (receiptError) throw new Error(receiptError.message);
  const receipts = (receiptData || []) as ReceiptRow[];
  const receiptIds = receipts.map((receipt) => Number(receipt.id));
  const receiptRefIds = receipts.map((receipt) => receipt.ref_id);

  const [lines, products, mappings] = await Promise.all([
    receiptIds.length
      ? fetchAll<LineRow>((from, to) =>
          supabaseServer
            .from("pos_sales_receipt_lines")
            .select(LINE_SELECT)
            .in("receipt_id", receiptIds)
            .order("receipt_id", { ascending: true })
            .order("sort_order", { ascending: true })
            .range(from, to)
        )
      : Promise.resolve([]),
    fetchAll<ProductRow>((from, to) =>
      supabaseServer
        .from("pos_products")
        .select(PRODUCT_SELECT)
        .eq("source", "cukcuk")
        .range(from, to)
    ),
    fetchAll<PosItemMappingRow>((from, to) =>
      supabaseServer
        .from("pos_item_mappings")
        .select(MAPPING_SELECT)
        .eq("is_active", true)
        .is("archived_at", null)
        .range(from, to)
    ),
  ]);

  const mappingIds = mappings.map((mapping) => Number(mapping.id));
  const [recipes, payments, appliedDeductions] = await Promise.all([
    mappingIds.length
      ? fetchAll<PosItemMappingRecipeRow>((from, to) =>
          supabaseServer
            .from("pos_item_mapping_recipes")
            .select(RECIPE_SELECT)
            .in("mapping_id", mappingIds)
            .range(from, to)
        )
      : Promise.resolve([]),
    receiptIds.length
      ? fetchAll<PaymentRow>((from, to) =>
          supabaseServer
            .from("pos_sales_receipt_payments")
            .select(
              "receipt_id, payment_type, payment_name, card_name, amount"
            )
            .in("receipt_id", receiptIds)
            .order("id", { ascending: true })
            .range(from, to)
        )
      : Promise.resolve([]),
    receiptRefIds.length
      ? supabaseServer
          .from("pos_inventory_deductions")
          .select(
            "invoice_ref_id, receipt_line_id, inventory_item_id, mapping_id, recipe_id, applied_at, updated_at"
          )
          .in("invoice_ref_id", receiptRefIds)
          .or(
            "status.eq.applied,status.eq.success,applied_at.not.is.null,inventory_log_id.not.is.null"
          )
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (appliedDeductions.error) {
    throw new Error(appliedDeductions.error.message);
  }

  const inventoryIds = Array.from(
    new Set(
      [
        ...mappings.map((mapping) => Number(mapping.inventory_item_id)),
        ...recipes.map((recipe) => Number(recipe.inventory_item_id)),
      ].filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  const inventoryRows = inventoryIds.length
    ? await fetchAll<InventoryRow>((from, to) =>
        supabaseServer
          .from("inventory")
          .select("id, item_name, item_name_vi, code, unit, quantity")
          .in("id", inventoryIds)
          .range(from, to)
      )
    : [];

  const inventoryById = new Map(
    inventoryRows.map((item) => [Number(item.id), item])
  );
  const productsByPosItemId = new Map<string, ProductRow[]>();
  const productsByItemId = new Map<string, ProductRow[]>();
  const productsByCode = new Map<string, ProductRow[]>();
  for (const product of products) {
    for (const [key, target] of [
      [product.pos_item_id, productsByPosItemId],
      [product.item_id, productsByItemId],
      [getCatalogCode(product.item_code), productsByCode],
    ] as const) {
      if (!key) continue;
      const rows = target.get(key) ?? [];
      rows.push(product);
      target.set(key, rows);
    }
  }

  const mappingsByProduct = new Map<string, PosItemMappingRow[]>();
  for (const mapping of mappings) {
    if (!mapping.pos_product_id) continue;
    const key =
      mapping.target_type === "option"
        ? `${mapping.pos_product_id}:option:${mapping.pos_option_id || ""}`
        : `${mapping.pos_product_id}:product`;
    const rows = mappingsByProduct.get(key) ?? [];
    rows.push(mapping);
    mappingsByProduct.set(key, rows);
  }
  const recipesByMappingId = new Map<number, PosItemMappingRecipeRow[]>();
  for (const recipe of recipes) {
    const rows = recipesByMappingId.get(Number(recipe.mapping_id)) ?? [];
    rows.push(recipe);
    recipesByMappingId.set(Number(recipe.mapping_id), rows);
  }
  const linesByReceiptId = new Map<number, LineRow[]>();
  for (const line of lines) {
    if (!line.receipt_id) continue;
    const rows = linesByReceiptId.get(Number(line.receipt_id)) ?? [];
    rows.push(line);
    linesByReceiptId.set(Number(line.receipt_id), rows);
  }
  const paymentsByReceiptId = new Map<number, PaymentRow[]>();
  for (const payment of payments) {
    const rows = paymentsByReceiptId.get(Number(payment.receipt_id)) ?? [];
    rows.push(payment);
    paymentsByReceiptId.set(Number(payment.receipt_id), rows);
  }
  const appliedReceiptByRefId = new Map<
    string,
    { appliedAt: string | null }
  >();
  const appliedDeductionKeys = new Set<string>();
  for (const row of ((appliedDeductions.data || []) as AppliedDeductionRow[])) {
    const refId = String(row.invoice_ref_id);
    const appliedAt = row.applied_at || row.updated_at || null;
    const current = appliedReceiptByRefId.get(refId);
    if (!current || isAfter(appliedAt, current.appliedAt)) {
      appliedReceiptByRefId.set(refId, { appliedAt });
    }

    const receiptLineId = Number(row.receipt_line_id);
    const inventoryItemId = Number(row.inventory_item_id);
    if (Number.isInteger(receiptLineId) && Number.isInteger(inventoryItemId)) {
      appliedDeductionKeys.add(
        getAppliedDeductionKey({
          receiptLineId,
          inventoryItemId,
          mappingId: row.mapping_id === null ? null : Number(row.mapping_id),
          recipeId: row.recipe_id === null ? null : Number(row.recipe_id),
        })
      );
    }
  }

  const workingReceipts: WorkingReceipt[] = receipts.map((receipt) => {
    const receiptLines = linesByReceiptId.get(Number(receipt.id)) ?? [];
    const previewLines: PreviewLine[] = receiptLines.flatMap((line) => {
      const result: PreviewLine | PreviewLine[] = (() => {
      const option = isOptionLine(line);
      const productCandidates =
        (line.item_id &&
          (productsByPosItemId.get(line.item_id) ||
            productsByItemId.get(line.item_id))) ||
        productsByCode.get(getCatalogCode(line.item_code)) ||
        [];
      const product =
        productCandidates.length === 1 ? productCandidates[0] : null;
      const optionId = option ? getOptionId(line) : null;
      const mappingKey = product
        ? option
          ? `${product.id}:option:${optionId || ""}`
          : `${product.id}:product`
        : "";
      const mappingCandidates = mappingKey
        ? mappingsByProduct.get(mappingKey) ?? []
        : [];
      const mapping =
        mappingCandidates.length === 1 ? mappingCandidates[0] : null;
      const quantitySold = normalizeNumber(line.quantity);
      const base = {
        receiptId: Number(receipt.id),
        receiptLineId: Number(line.id),
        refDetailId: line.ref_detail_id,
        parentRefDetailId: line.parent_ref_detail_id,
        isOption: option,
        posProductId: product ? Number(product.id) : null,
        posItemCode: line.item_code,
        itemName: line.item_name,
        quantitySold,
        mappingId: mapping ? Number(mapping.id) : null,
        mappingType: mapping?.mapping_type ?? null,
        mappingVersion: mapping
          ? Number(mapping.mapping_version ?? 1)
          : null,
        mappingSnapshot: mapping
          ? {
              id: Number(mapping.id),
              mappingType: mapping.mapping_type,
              mappingVersion: Number(mapping.mapping_version ?? 1),
              targetType: mapping.target_type,
              posProductId: mapping.pos_product_id,
              posOptionId: mapping.pos_option_id,
              inventoryItemId: mapping.inventory_item_id,
              quantityMultiplier: normalizeNumber(
                mapping.quantity_multiplier
              ),
            }
          : null,
      };

      if (line.is_excluded === true) {
        return {
          ...base,
          lineType: "ignore" as const,
          status: "ignored",
          blockedReason: null,
          deductions: [],
        };
      }
      if (
        productCandidates.length !== 1 ||
        product?.is_active !== true ||
        (option && !optionId) ||
        mappingCandidates.length > 1
      ) {
        return {
          ...base,
          lineType: "invalid_mapping" as const,
          status: "invalid_mapping",
          blockedReason:
            productCandidates.length > 1 || mappingCandidates.length > 1
              ? "POS 상품 또는 mapping 후보가 여러 개입니다."
              : product && product.is_active !== true
                ? "연결된 POS 상품이 비활성 상태입니다."
              : option && !optionId
                ? "옵션 line에서 POS 옵션 ID를 확인할 수 없습니다."
                : "POS 상품을 내부 카탈로그와 연결할 수 없습니다.",
          deductions: [],
        };
      }
      if (!mapping) {
        return {
          ...base,
          lineType: "missing_mapping" as const,
          status: "missing_mapping",
          blockedReason: option
            ? "옵션 mapping이 없습니다."
            : "상품 mapping이 없습니다.",
          deductions: [],
        };
      }
      if (mapping.mapping_type === "ignore") {
        return {
          ...base,
          lineType: "ignore" as const,
          status: "ignored",
          blockedReason: null,
          deductions: [],
        };
      }
      if (mapping.mapping_type === "manual") {
        return {
          ...base,
          lineType: "manual" as const,
          status: "manual_review",
          blockedReason: "Manual mapping은 관리자 검토가 필요합니다.",
          deductions: [],
        };
      }
      if (mapping.mapping_type === "combo") {
        if (option) {
          return {
            ...base,
            lineType: "combo_invalid_mapping" as const,
            status: "invalid_mapping",
            blockedReason: "Combo mapping은 POS 옵션에는 사용할 수 없습니다.",
            deductions: [],
          };
        }

        const comboChildren = product
          ? extractProductChildren(product).filter((child) => child.isActive)
          : [];
        if (comboChildren.length === 0) {
          return {
            ...base,
            lineType: "combo_invalid_mapping" as const,
            status: "invalid_mapping",
            blockedReason: "Combo 구성 상품을 POS catalog에서 확인할 수 없습니다.",
            deductions: [],
          };
        }

        return comboChildren.map((child) => {
          const childProducts = findProductForChild(child, products);
          const childProduct =
            childProducts.length === 1 ? childProducts[0] : null;
          const childMappingCandidates = childProduct
            ? mappingsByProduct.get(`${Number(childProduct.id)}:product`) ?? []
            : [];
          const childMapping =
            childMappingCandidates.length === 1
              ? childMappingCandidates[0]
              : null;
          const childQuantitySold = normalizeNumber(
            quantitySold * child.quantity
          );
          const comboSnapshot = {
            comboParentMappingId: Number(mapping.id),
            comboParentProductId: product ? Number(product.id) : null,
            comboParentCode: product?.item_code ?? line.item_code,
            comboParentName: product?.item_name ?? line.item_name,
            comboChildProductId: childProduct ? Number(childProduct.id) : null,
            comboChildCode: child.code,
            comboChildName: child.name,
            comboChildQuantity: child.quantity,
            comboChildIndex: child.index,
          };
          const childBase = {
            ...base,
            posProductId: childProduct ? Number(childProduct.id) : null,
            posItemCode: child.code ?? childProduct?.item_code ?? line.item_code,
            itemName: child.name || childProduct?.item_name || line.item_name,
            quantitySold: childQuantitySold,
            mappingId: childMapping ? Number(childMapping.id) : null,
            mappingType: childMapping?.mapping_type ?? null,
            mappingVersion: childMapping
              ? Number(childMapping.mapping_version ?? 1)
              : null,
            mappingSnapshot: childMapping
              ? {
                  id: Number(childMapping.id),
                  mappingType: childMapping.mapping_type,
                  mappingVersion: Number(childMapping.mapping_version ?? 1),
                  targetType: childMapping.target_type,
                  posProductId: childMapping.pos_product_id,
                  posOptionId: childMapping.pos_option_id,
                  inventoryItemId: childMapping.inventory_item_id,
                  quantityMultiplier: normalizeNumber(
                    childMapping.quantity_multiplier
                  ),
                  ...comboSnapshot,
                }
              : comboSnapshot,
          };

          if (
            childProducts.length !== 1 ||
            childMappingCandidates.length > 1
          ) {
            return {
              ...childBase,
              lineType: "combo_invalid_mapping" as const,
              status: "invalid_mapping",
              blockedReason:
                childProducts.length > 1 || childMappingCandidates.length > 1
                  ? "Combo 구성 상품 후보가 여러 개입니다."
                  : "Combo 구성 상품 매핑 확인이 필요합니다.",
              deductions: [],
            };
          }

          if (!childMapping) {
            return {
              ...childBase,
              lineType: "combo_missing_mapping" as const,
              status: "missing_mapping",
              blockedReason: "Combo 구성 상품 매핑 확인이 필요합니다.",
              deductions: [],
            };
          }

          if (childMapping.mapping_type === "combo") {
            return {
              ...childBase,
              lineType: "combo_invalid_mapping" as const,
              status: "invalid_mapping",
              blockedReason: "Combo 안에 Combo는 지원하지 않습니다.",
              deductions: [],
            };
          }

          if (childMapping.mapping_type === "ignore") {
            return {
              ...childBase,
              lineType: "combo_ignore" as const,
              status: "ignored",
              blockedReason: null,
              deductions: [],
            };
          }

          if (childMapping.mapping_type === "manual") {
            return {
              ...childBase,
              lineType: "manual" as const,
              status: "manual_review",
              blockedReason: "Combo 구성 상품은 수동 확인이 필요합니다.",
              deductions: [],
            };
          }

          if (childMapping.mapping_type === "direct") {
            const inventoryItemId = Number(childMapping.inventory_item_id);
            const multiplier = normalizeNumber(childMapping.quantity_multiplier);
            const inventory = inventoryById.get(inventoryItemId);
            if (!inventory || inventoryItemId <= 0 || multiplier <= 0) {
              return {
                ...childBase,
                lineType: "combo_invalid_mapping" as const,
                status: "invalid_mapping",
                blockedReason:
                  "Combo 구성 상품 Direct mapping 설정이 올바르지 않습니다.",
                deductions: [],
              };
            }

            return {
              ...childBase,
              lineType: "combo_direct" as const,
              status: "ready",
              blockedReason: null,
              deductions: [
                {
                  inventoryItemId,
                  inventoryItemName: inventoryName(inventory, inventoryItemId),
                  inventoryCode: inventory.code,
                  inventoryUnit: inventory.unit,
                  deductQuantity: normalizeNumber(
                    childQuantitySold * multiplier
                  ),
                  currentQuantity: normalizeNumber(inventory.quantity),
                  afterQuantity: 0,
                  status: "ok" as const,
                  recipeId: null,
                  recipeVersion: null,
                  deductQuantityPerUnit: multiplier,
                },
              ],
            };
          }

          if (childMapping.mapping_type === "recipe") {
            const mappingRecipes =
              recipesByMappingId.get(Number(childMapping.id)) ?? [];
            const activeRecipes = mappingRecipes.filter(
              (recipe) => recipe.is_active === true
            );
            const activeRecipeInventoryIds = activeRecipes.map((recipe) =>
              Number(recipe.inventory_item_id)
            );
            const invalidRecipes =
              activeRecipes.length === 0 ||
              activeRecipes.some((recipe) => {
                const quantityPerPosUnit = Number(
                  recipe.quantity_per_pos_unit
                );
                return (
                  !inventoryById.has(Number(recipe.inventory_item_id)) ||
                  !Number.isFinite(quantityPerPosUnit) ||
                  quantityPerPosUnit <= 0
                );
              }) ||
              new Set(activeRecipeInventoryIds).size !==
                activeRecipeInventoryIds.length;

            if (invalidRecipes) {
              return {
                ...childBase,
                lineType: "combo_incomplete_recipe" as const,
                status: "incomplete_recipe",
                blockedReason:
                  "Combo 구성 상품 Recipe 미완성으로 차감 대상에서 제외했습니다.",
                deductions: [],
              };
            }

            return {
              ...childBase,
              lineType: "combo_recipe" as const,
              status: "ready",
              blockedReason: null,
              deductions: activeRecipes.map((recipe) => {
                const inventoryItemId = Number(recipe.inventory_item_id);
                const inventory = inventoryById.get(inventoryItemId);
                return {
                  inventoryItemId,
                  inventoryItemName: inventoryName(inventory, inventoryItemId),
                  inventoryCode: inventory?.code ?? null,
                  inventoryUnit: inventory?.unit ?? null,
                  deductQuantity: normalizeNumber(
                    childQuantitySold * Number(recipe.quantity_per_pos_unit)
                  ),
                  currentQuantity: normalizeNumber(inventory?.quantity),
                  afterQuantity: 0,
                  status: "ok" as const,
                  recipeId: Number(recipe.id),
                  recipeVersion: Number(recipe.version ?? 1),
                  deductQuantityPerUnit: normalizeNumber(
                    recipe.quantity_per_pos_unit
                  ),
                };
              }),
            };
          }

          return {
            ...childBase,
            lineType: "combo_invalid_mapping" as const,
            status: "invalid_mapping",
            blockedReason: "Combo 구성 상품 mapping type을 지원하지 않습니다.",
            deductions: [],
          };
        });
      }
      if (mapping.mapping_type === "direct") {
        const inventoryItemId = Number(mapping.inventory_item_id);
        const multiplier = normalizeNumber(mapping.quantity_multiplier);
        const inventory = inventoryById.get(inventoryItemId);
        if (!inventory || inventoryItemId <= 0 || multiplier <= 0) {
          return {
            ...base,
            lineType: "invalid_mapping" as const,
            status: "invalid_mapping",
            blockedReason:
              "Direct mapping의 inventory 품목 또는 차감 배수가 유효하지 않습니다.",
            deductions: [],
          };
        }
        return {
          ...base,
          lineType: option ? ("option_direct" as const) : ("direct" as const),
          status: "ready",
          blockedReason: null,
          deductions: [
            {
              inventoryItemId,
              inventoryItemName: inventoryName(inventory, inventoryItemId),
              inventoryCode: inventory.code,
              inventoryUnit: inventory.unit,
              deductQuantity: normalizeNumber(quantitySold * multiplier),
              currentQuantity: normalizeNumber(inventory.quantity),
              afterQuantity: 0,
              status: "ok" as const,
              recipeId: null,
              recipeVersion: null,
              deductQuantityPerUnit: multiplier,
            },
          ],
        };
      }
      if (mapping.mapping_type === "recipe") {
        const mappingRecipes =
          recipesByMappingId.get(Number(mapping.id)) ?? [];
        const activeRecipes = mappingRecipes.filter(
          (recipe) => recipe.is_active === true
        );
        const activeRecipeInventoryIds = activeRecipes.map((recipe) =>
          Number(recipe.inventory_item_id)
        );
        const hasDuplicateInventory =
          new Set(activeRecipeInventoryIds).size !==
          activeRecipeInventoryIds.length;
        const invalidRecipeRows = activeRecipes.some((recipe) => {
          const quantityPerPosUnit = Number(recipe.quantity_per_pos_unit);
          return (
            !inventoryById.has(Number(recipe.inventory_item_id)) ||
            !Number.isFinite(quantityPerPosUnit) ||
            quantityPerPosUnit <= 0
          );
        });
        if (
          activeRecipes.length === 0 ||
          invalidRecipeRows ||
          hasDuplicateInventory
        ) {
          return {
            ...base,
            lineType: "incomplete_recipe" as const,
            status: "incomplete_recipe",
            blockedReason:
              "Recipe 미완성으로 차감 대상에서 제외되었습니다.",
            deductions: [],
          };
        }
        return {
          ...base,
          lineType: option ? ("option_recipe" as const) : ("recipe" as const),
          status: "ready",
          blockedReason: null,
          deductions: activeRecipes.map((recipe) => {
            const inventoryItemId = Number(recipe.inventory_item_id);
            const inventory = inventoryById.get(inventoryItemId);
            return {
              inventoryItemId,
              inventoryItemName: inventoryName(inventory, inventoryItemId),
              inventoryCode: inventory?.code ?? null,
              inventoryUnit: inventory?.unit ?? null,
              deductQuantity: normalizeNumber(
                quantitySold * Number(recipe.quantity_per_pos_unit)
              ),
              currentQuantity: normalizeNumber(inventory?.quantity),
              afterQuantity: 0,
              status: "ok" as const,
              recipeId: Number(recipe.id),
              recipeVersion: Number(recipe.version ?? 1),
              deductQuantityPerUnit: normalizeNumber(
                recipe.quantity_per_pos_unit
              ),
            };
          }),
        };
      }
      return {
        ...base,
        lineType: "invalid_mapping" as const,
        status: "invalid_mapping",
        blockedReason: "지원하지 않는 mapping type입니다.",
        deductions: [],
      };
      })();
      return Array.isArray(result) ? result : [result];
    });

    const inventoryHashPayload = {
      hashVersion: HASH_VERSION,
      receiptId: Number(receipt.id),
      lines: previewLines
        .map((preview) => {
          const mapping = preview.mappingId
            ? mappings.find(
                (candidate) => Number(candidate.id) === preview.mappingId
              )
            : null;
          const mappingRecipes = mapping
            ? recipesByMappingId.get(Number(mapping.id)) ?? []
            : [];
          const includeRecipeRows =
            preview?.deductions.some(
              (deduction) => Number(deduction.recipeId) > 0
            ) ?? false;
          return {
            lineId: preview.receiptLineId,
            refDetailId: preview.refDetailId,
            itemCode: preview.posItemCode,
            quantity: preview.quantitySold,
            isOption: preview.isOption,
            parentRefDetailId: preview.parentRefDetailId,
            mappingId: preview?.mappingId ?? null,
            mappingType: preview?.mappingType ?? null,
            mappingVersion: preview?.mappingVersion ?? null,
            mappingSnapshot: preview.mappingSnapshot,
            recipeRows: includeRecipeRows
              ? mappingRecipes
                  .map((recipe) => ({
                    id: Number(recipe.id),
                    inventoryItemId: Number(recipe.inventory_item_id),
                    quantityPerPosUnit: normalizeNumber(
                      recipe.quantity_per_pos_unit
                    ),
                    isActive: recipe.is_active === true,
                    isRequired: recipe.is_required !== false,
                    version: Number(recipe.version ?? 1),
                  }))
                  .sort((left, right) => left.id - right.id)
              : [],
          };
        })
        .sort((left, right) => left.lineId - right.lineId),
    };
    const amountHashPayload = {
      hashVersion: HASH_VERSION,
      receiptId: Number(receipt.id),
      totalAmount: normalizeNumber(receipt.total_amount),
      discountAmount: normalizeNumber(receipt.discount_amount),
      vatAmount: normalizeNumber(receipt.vat_amount),
      finalAmount: normalizeNumber(receipt.final_amount),
      receiveAmount: normalizeNumber(receipt.receive_amount),
      returnAmount: normalizeNumber(receipt.return_amount),
      paymentStatus: receipt.payment_status,
      lines: receiptLines
        .map((line) => ({
          lineId: Number(line.id),
          unitPrice: normalizeNumber(line.unit_price),
          amount: normalizeNumber(line.amount),
          discountAmount: normalizeNumber(line.discount_amount),
          taxRate: normalizeNumber(line.tax_rate),
          taxAmount: normalizeNumber(line.tax_amount),
          finalAmount: normalizeNumber(line.final_amount),
        }))
        .sort((left, right) => left.lineId - right.lineId),
      payments: (paymentsByReceiptId.get(Number(receipt.id)) ?? [])
        .map((payment) => ({
          paymentType: payment.payment_type,
          paymentName: payment.payment_name,
          cardName: payment.card_name,
          amount: normalizeNumber(payment.amount),
        }))
        .sort((left, right) =>
          `${left.paymentType}:${left.paymentName}:${left.cardName}`.localeCompare(
            `${right.paymentType}:${right.paymentName}:${right.cardName}`
          )
        ),
    };
    const blockedStatus = resolveBlockedStatus(previewLines);
    const hasCandidates = hasDeductionCandidates(previewLines);
    const hasIncompleteRecipes = hasIncompleteRecipeLines(previewLines);
    let status: PreviewReceiptStatus =
      blockedStatus || (hasCandidates ? "ready" : "skipped");
    const blockedReasons = previewLines
      .map((line) => line.blockedReason)
      .filter((reason): reason is string => Boolean(reason));

    const appliedReceipt = appliedReceiptByRefId.get(receipt.ref_id);
    if (appliedReceipt) {
      status =
        receipt.is_modified === true &&
        isAfter(receipt.updated_at, appliedReceipt.appliedAt)
          ? "applied_after_modified"
          : "already_applied";
      blockedReasons.unshift(
        status === "applied_after_modified"
          ? "재고 차감 후 영수증이 수정되어 별도 보정 검토가 필요합니다."
          : "이미 재고 차감이 적용된 영수증입니다."
      );
      // TODO(sales-inventory-adjustment):
      // applied_after_modified receipts are intentionally blocked from standard apply.
      // Future delta apply must compare per-line applied deductions (pos_inventory_deductions
      // WHERE receipt_id = ? AND status = 'applied') with current preview lines, keyed by
      // (receipt_line_id, inventory_item_id, mapping_id, recipe_id), and allow only
      // new/increased-quantity lines through a separate adjustment flow.
      // See docs/sales-inventory-deduction-adjustment.md.
    } else if (
      previewLines.length === 0 ||
      previewLines.every((line) => line.lineType === "ignore")
    ) {
      status = "skipped";
    } else if (!hasCandidates && hasIncompleteRecipes) {
      status = "incomplete_recipe";
    }

    return {
      receipt,
      status,
      blockedReasons: Array.from(new Set(blockedReasons)),
      lines: previewLines,
      inventoryAffectingHash: hash(inventoryHashPayload),
      amountHash: hash(amountHashPayload),
      canContributeStock: status === "ready",
    };
  });

  const inventoryTotalsMap = new Map<
    number,
    {
      inventoryItemId: number;
      inventoryItemName: string;
      inventoryCode: string | null;
      inventoryUnit: string | null;
      currentQuantity: number;
      deductQuantity: number;
      receiptIds: Set<number>;
      lineIds: Set<number>;
    }
  >();
  for (const receipt of workingReceipts.filter(
    (candidate) => candidate.canContributeStock
  )) {
    for (const line of receipt.lines) {
      for (const deduction of line.deductions) {
        const current = inventoryTotalsMap.get(deduction.inventoryItemId) ?? {
          inventoryItemId: deduction.inventoryItemId,
          inventoryItemName: deduction.inventoryItemName,
          inventoryCode: deduction.inventoryCode,
          inventoryUnit: deduction.inventoryUnit,
          currentQuantity: deduction.currentQuantity,
          deductQuantity: 0,
          receiptIds: new Set<number>(),
          lineIds: new Set<number>(),
        };
        current.deductQuantity = normalizeNumber(
          current.deductQuantity + deduction.deductQuantity
        );
        current.receiptIds.add(receipt.receipt.id);
        current.lineIds.add(line.receiptLineId);
        inventoryTotalsMap.set(deduction.inventoryItemId, current);
      }
    }
  }

  const insufficientInventoryIds = new Set<number>();
  const inventoryTotals = Array.from(inventoryTotalsMap.values())
    .map((total) => {
      const afterQuantity = normalizeNumber(
        total.currentQuantity - total.deductQuantity
      );
      if (afterQuantity < 0) {
        insufficientInventoryIds.add(total.inventoryItemId);
      }
      return {
        inventoryItemId: total.inventoryItemId,
        inventoryItemName: total.inventoryItemName,
        inventoryCode: total.inventoryCode,
        inventoryUnit: total.inventoryUnit,
        currentQuantity: total.currentQuantity,
        deductQuantity: total.deductQuantity,
        afterQuantity,
        receiptCount: total.receiptIds.size,
        lineCount: total.lineIds.size,
        status: afterQuantity < 0 ? "insufficient_stock" : "ok",
      };
    })
    .sort((left, right) =>
      left.inventoryItemName.localeCompare(right.inventoryItemName, "ko")
    );

  for (const receipt of workingReceipts.filter(
    (candidate) => candidate.status === "ready"
  )) {
    let insufficient = false;
    for (const line of receipt.lines) {
      line.deductions = line.deductions.map((deduction) => {
        const total = inventoryTotalsMap.get(deduction.inventoryItemId);
        const afterQuantity = total
          ? normalizeNumber(total.currentQuantity - total.deductQuantity)
          : deduction.currentQuantity;
        const isInsufficient = insufficientInventoryIds.has(
          deduction.inventoryItemId
        );
        if (isInsufficient) insufficient = true;
        return {
          ...deduction,
          afterQuantity,
          status: isInsufficient ? "insufficient_stock" : "ok",
        };
      });
    }
    if (insufficient) {
      receipt.status = "insufficient_stock";
      addBlockedReason(
        receipt,
        "전체 미리보기 누적 차감량 기준으로 재고가 부족합니다."
      );
    }
  }

  const resultReceipts = workingReceipts.map((working) => ({
    receiptId: Number(working.receipt.id),
    refId: working.receipt.ref_id,
    refNo: working.receipt.ref_no,
    businessDate: working.receipt.business_date,
    refDate: working.receipt.ref_date,
    previewedReceiptUpdatedAt: working.receipt.updated_at,
    status: working.status,
    blocked: !["ready", "skipped"].includes(working.status),
    blockedReasons: working.blockedReasons,
    inventoryAffectingHash: working.inventoryAffectingHash,
    amountHash: working.amountHash,
    hashVersion: HASH_VERSION,
    lines: working.lines.map((line) => {
      const directDeduction =
        line.lineType === "direct" || line.lineType === "option_direct"
          ? line.deductions[0] ?? null
          : null;
      return {
        ...line,
        isApplied: line.deductions.some((deduction) =>
          appliedDeductionKeys.has(
            getAppliedDeductionKey({
              receiptLineId: line.receiptLineId,
              inventoryItemId: deduction.inventoryItemId,
              mappingId: line.mappingId,
              recipeId: deduction.recipeId,
            })
          )
        ),
        inventoryItemId: directDeduction?.inventoryItemId ?? null,
        inventoryItemName: directDeduction?.inventoryItemName ?? null,
        deductQuantity: directDeduction?.deductQuantity ?? null,
        currentQuantity: directDeduction?.currentQuantity ?? null,
        afterQuantity: directDeduction?.afterQuantity ?? null,
      };
    }),
  }));
  const statusCounts = resultReceipts.reduce<Record<string, number>>(
    (counts, receipt) => {
      counts[receipt.status] = (counts[receipt.status] ?? 0) + 1;
      return counts;
    },
    {}
  );
  const partialReadyCount = resultReceipts.filter(
    (receipt) =>
      receipt.status === "ready" &&
      receipt.lines.some((line) => line.status === "incomplete_recipe")
  ).length;
  const incompleteRecipeCount = resultReceipts.filter((receipt) =>
    receipt.lines.some((line) => line.status === "incomplete_recipe")
  ).length;
  const incompleteRecipeLineCount = resultReceipts.reduce(
    (count, receipt) =>
      count +
      receipt.lines.filter((line) => line.status === "incomplete_recipe")
        .length,
    0
  );

  return {
    generatedAt: new Date().toISOString(),
    businessDateFrom: input.businessDateFrom,
    businessDateTo: input.businessDateTo,
    validationSummary: validation.summary,
    summary: {
      totalReceiptCount: resultReceipts.length,
      readyCount: statusCounts.ready ?? 0,
      partialReadyCount,
      blockedCount: resultReceipts.filter((receipt) => receipt.blocked).length,
      skippedCount: statusCounts.skipped ?? 0,
      missingMappingCount: statusCounts.missing_mapping ?? 0,
      manualReviewCount: statusCounts.manual_review ?? 0,
      invalidMappingCount: statusCounts.invalid_mapping ?? 0,
      incompleteRecipeCount,
      incompleteRecipeLineCount,
      insufficientStockCount: statusCounts.insufficient_stock ?? 0,
      alreadyAppliedCount: statusCounts.already_applied ?? 0,
      appliedAfterModifiedCount: statusCounts.applied_after_modified ?? 0,
      reviewRequiredCount: statusCounts.review_required ?? 0,
      canApply: false,
    },
    inventoryTotals,
    receipts: resultReceipts,
  };
}
