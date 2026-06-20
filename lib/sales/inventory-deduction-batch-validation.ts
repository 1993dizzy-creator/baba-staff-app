import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";

type BatchReceiptRow = {
  id: number;
  receipt_id: number;
  receipt_ref_no: string | null;
  inventory_affecting_hash: string;
  amount_hash: string;
  previewed_receipt_updated_at: string | null;
};

type SavedDeductionRow = {
  receipt_id: number | null;
  receipt_line_id: number | null;
  mapping_id: number | null;
  recipe_id: number | null;
  mapping_type: string | null;
  mapping_snapshot: Record<string, unknown> | null;
  inventory_item_id: number | null;
  quantity_sold: number | string | null;
  deduct_quantity_per_unit: number | string | null;
  deduct_quantity_total: number | string | null;
};

export type BatchValidationReceiptStatus =
  | "valid"
  | "hash_changed"
  | "amount_changed"
  | "mapping_changed"
  | "recipe_changed"
  | "inventory_insufficient"
  | "already_applied"
  | "no_longer_ready"
  | "missing_receipt"
  | "missing_lines"
  | "invalid_mapping"
  | "manual_review"
  | "skipped";

function normalizeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function savedMappingSignature(row: SavedDeductionRow) {
  const snapshot = row.mapping_snapshot || {};
  return {
    receiptLineId: Number(row.receipt_line_id),
    mappingId: Number(row.mapping_id),
    mappingType: row.mapping_type,
    inventoryItemId: Number(row.inventory_item_id),
    mappingVersion: Number(snapshot.mappingVersion ?? 0),
    targetType: snapshot.targetType ?? null,
    posProductId: Number(snapshot.posProductId ?? 0),
    posOptionId: snapshot.posOptionId ?? null,
    quantityMultiplier: normalizeNumber(snapshot.quantityMultiplier),
  };
}

function currentMappingSignature(line: {
  receiptLineId: number;
  mappingId: number | null;
  mappingType: string | null;
  mappingSnapshot: Record<string, unknown> | null;
  deductions: Array<{ inventoryItemId: number }>;
}) {
  const snapshot = line.mappingSnapshot || {};
  return line.deductions.map((deduction) => ({
    receiptLineId: line.receiptLineId,
    mappingId: Number(line.mappingId),
    mappingType: line.mappingType,
    inventoryItemId: deduction.inventoryItemId,
    mappingVersion: Number(snapshot.mappingVersion ?? 0),
    targetType: snapshot.targetType ?? null,
    posProductId: Number(snapshot.posProductId ?? 0),
    posOptionId: snapshot.posOptionId ?? null,
    quantityMultiplier: normalizeNumber(snapshot.quantityMultiplier),
  }));
}

function savedRecipeSignature(row: SavedDeductionRow) {
  const snapshot = row.mapping_snapshot || {};
  return {
    receiptLineId: Number(row.receipt_line_id),
    inventoryItemId: Number(row.inventory_item_id),
    recipeId: Number(row.recipe_id ?? snapshot.recipeId ?? 0),
    recipeVersion: Number(snapshot.recipeVersion ?? 0),
    deductQuantityPerUnit: normalizeNumber(row.deduct_quantity_per_unit),
  };
}

function currentRecipeSignature(line: {
  receiptLineId: number;
  deductions: Array<{
    inventoryItemId: number;
    recipeId: number | null;
    recipeVersion: number | null;
    deductQuantityPerUnit: number;
  }>;
}) {
  return line.deductions
    .filter((deduction) => Number(deduction.recipeId) > 0)
    .map((deduction) => ({
      receiptLineId: line.receiptLineId,
      inventoryItemId: deduction.inventoryItemId,
      recipeId: Number(deduction.recipeId),
      recipeVersion: Number(deduction.recipeVersion ?? 0),
      deductQuantityPerUnit: normalizeNumber(
        deduction.deductQuantityPerUnit
      ),
    }));
}

function savedCandidateSignature(row: SavedDeductionRow) {
  return {
    receiptLineId: Number(row.receipt_line_id),
    mappingId: Number(row.mapping_id),
    recipeId: Number(row.recipe_id ?? 0),
    inventoryItemId: Number(row.inventory_item_id),
    quantitySold: normalizeNumber(row.quantity_sold),
    deductQuantityPerUnit: normalizeNumber(row.deduct_quantity_per_unit),
    deductQuantityTotal: normalizeNumber(row.deduct_quantity_total),
  };
}

function currentCandidateSignature(line: {
  receiptLineId: number;
  mappingId: number | null;
  quantitySold: number;
  deductions: Array<{
    inventoryItemId: number;
    recipeId: number | null;
    deductQuantityPerUnit: number;
    deductQuantity: number;
  }>;
}) {
  return line.deductions.map((deduction) => ({
    receiptLineId: line.receiptLineId,
    mappingId: Number(line.mappingId),
    recipeId: Number(deduction.recipeId ?? 0),
    inventoryItemId: deduction.inventoryItemId,
    quantitySold: normalizeNumber(line.quantitySold),
    deductQuantityPerUnit: normalizeNumber(
      deduction.deductQuantityPerUnit
    ),
    deductQuantityTotal: normalizeNumber(deduction.deductQuantity),
  }));
}

function sortSignature<T extends Record<string, unknown>>(rows: T[]) {
  return rows.sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right))
  );
}

function mappingCandidateKey(row: {
  receiptLineId: number;
  mappingId: number;
  inventoryItemId: number;
}) {
  return `${row.receiptLineId}:${row.mappingId}:${row.inventoryItemId}`;
}

function recipeCandidateKey(row: {
  receiptLineId: number;
  inventoryItemId: number;
  recipeId: number;
}) {
  return `${row.receiptLineId}:${row.inventoryItemId}:${row.recipeId}`;
}

function deductionCandidateKey(row: {
  receiptLineId: number;
  mappingId: number;
  recipeId: number;
  inventoryItemId: number;
}) {
  return `${row.receiptLineId}:${row.mappingId}:${row.recipeId}:${row.inventoryItemId}`;
}

export async function validateInventoryDeductionBatch(batchId: number) {
  const [batchResult, selectedResult] = await Promise.all([
    supabaseServer
      .from("pos_inventory_deduction_batches")
      .select("id, status, business_date_from, business_date_to")
      .eq("id", batchId)
      .maybeSingle(),
    supabaseServer
      .from("pos_inventory_deduction_receipts")
      .select(
        "id, receipt_id, receipt_ref_no, inventory_affecting_hash, amount_hash, previewed_receipt_updated_at"
      )
      .eq("batch_id", batchId)
      .eq("selected_for_apply", true)
      .order("id", { ascending: true }),
  ]);

  if (batchResult.error) throw batchResult.error;
  if (!batchResult.data) {
    return { found: false as const };
  }
  if (selectedResult.error) throw selectedResult.error;

  const savedReceipts = (selectedResult.data || []) as BatchReceiptRow[];
  const receiptIds = savedReceipts.map((receipt) => Number(receipt.receipt_id));
  const [currentReceiptsResult, savedDeductionsResult] = await Promise.all([
    receiptIds.length
      ? supabaseServer
          .from("pos_sales_receipts")
          .select("id, payment_status, is_canceled, updated_at")
          .in("id", receiptIds)
      : Promise.resolve({ data: [], error: null }),
    receiptIds.length
      ? supabaseServer
          .from("pos_inventory_deductions")
          .select(
            "receipt_id, receipt_line_id, mapping_id, recipe_id, mapping_type, mapping_snapshot, inventory_item_id, quantity_sold, deduct_quantity_per_unit, deduct_quantity_total"
          )
          .eq("batch_id", batchId)
          .in("receipt_id", receiptIds)
          .in("status", ["selected", "previewed"])
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (currentReceiptsResult.error) throw currentReceiptsResult.error;
  if (savedDeductionsResult.error) throw savedDeductionsResult.error;

  const currentReceiptRows = currentReceiptsResult.data || [];
  const currentReceiptById = new Map(
    currentReceiptRows.map((receipt) => [Number(receipt.id), receipt])
  );
  const eligibleReceiptIds = currentReceiptRows
    .filter(
      (receipt) =>
        Number(receipt.payment_status) === 3 &&
        receipt.is_canceled !== true
    )
    .map((receipt) => Number(receipt.id));
  const currentPreview =
    eligibleReceiptIds.length > 0
      ? await buildInventoryDeductionPreview({
          businessDateFrom:
            batchResult.data.business_date_from || "1970-01-01",
          businessDateTo: batchResult.data.business_date_to || "2999-12-31",
          receiptIds: eligibleReceiptIds,
        })
      : {
          receipts: [],
          inventoryTotals: [],
        };
  const currentPreviewByReceiptId = new Map(
    currentPreview.receipts.map((receipt) => [receipt.receiptId, receipt])
  );
  const currentInventoryTotalsMap = new Map<
    number,
    {
      inventoryItemId: number;
      inventoryItemName: string;
      currentQuantity: number;
      deductQuantity: number;
      receiptIds: Set<number>;
      lineIds: Set<number>;
    }
  >();

  for (const receipt of currentPreview.receipts.filter((candidate) =>
    ["ready", "review_required"].includes(candidate.status)
  )) {
    for (const line of receipt.lines) {
      for (const deduction of line.deductions) {
        const current = currentInventoryTotalsMap.get(
          deduction.inventoryItemId
        ) ?? {
          inventoryItemId: deduction.inventoryItemId,
          inventoryItemName: deduction.inventoryItemName,
          currentQuantity: normalizeNumber(deduction.currentQuantity),
          deductQuantity: 0,
          receiptIds: new Set<number>(),
          lineIds: new Set<number>(),
        };
        current.deductQuantity = normalizeNumber(
          current.deductQuantity + deduction.deductQuantity
        );
        current.receiptIds.add(receipt.receiptId);
        current.lineIds.add(line.receiptLineId);
        currentInventoryTotalsMap.set(deduction.inventoryItemId, current);
      }
    }
  }

  const inventoryTotals = Array.from(currentInventoryTotalsMap.values()).map(
    (total) => {
      const afterQuantity = normalizeNumber(
        total.currentQuantity - total.deductQuantity
      );
      return {
        inventoryItemId: total.inventoryItemId,
        inventoryItemName: total.inventoryItemName,
        currentQuantity: total.currentQuantity,
        deductQuantity: total.deductQuantity,
        afterQuantity,
        receiptCount: total.receiptIds.size,
        lineCount: total.lineIds.size,
        status: afterQuantity < 0 ? "insufficient_stock" : "ok",
      };
    }
  );
  const insufficientInventoryIds = new Set(
    inventoryTotals
      .filter((total) => total.afterQuantity < 0)
      .map((total) => total.inventoryItemId)
  );
  const savedDeductionsByReceiptId = new Map<number, SavedDeductionRow[]>();

  for (const row of (savedDeductionsResult.data || []) as SavedDeductionRow[]) {
    if (!row.receipt_id) continue;
    const rows = savedDeductionsByReceiptId.get(Number(row.receipt_id)) ?? [];
    rows.push(row);
    savedDeductionsByReceiptId.set(Number(row.receipt_id), rows);
  }

  const receiptResults = savedReceipts.map((savedReceipt) => {
    const receiptId = Number(savedReceipt.receipt_id);
    const currentReceipt = currentReceiptById.get(receiptId);
    const current = currentPreviewByReceiptId.get(receiptId);
    const savedCandidates =
      savedDeductionsByReceiptId.get(receiptId) ?? [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let status: BatchValidationReceiptStatus = "valid";
    let applyAllowed = true;

    if (!currentReceipt) {
      status = "missing_receipt";
      applyAllowed = false;
      errors.push("저장된 영수증을 현재 내부 DB에서 찾을 수 없습니다.");
    } else if (
      Number(currentReceipt.payment_status) !== 3 ||
      currentReceipt.is_canceled === true
    ) {
      status = "no_longer_ready";
      applyAllowed = false;
      errors.push("영수증이 더 이상 결제완료·비취소 상태가 아닙니다.");
    } else if (!current) {
      status = "no_longer_ready";
      applyAllowed = false;
      errors.push("현재 영수증 기준 preview를 생성할 수 없습니다.");
    } else if (current.status === "already_applied") {
      status = "already_applied";
      applyAllowed = false;
      errors.push("선택 이후 이미 적용된 차감 이력이 발견되었습니다.");
    } else if (current.lines.length === 0) {
      status = "missing_lines";
      applyAllowed = false;
      errors.push("현재 영수증에 판매 line이 없습니다.");
    } else if (
      current.status === "insufficient_stock" ||
      current.lines.some((line) =>
        line.deductions.some((deduction) =>
          insufficientInventoryIds.has(deduction.inventoryItemId)
        )
      )
    ) {
      status = "inventory_insufficient";
      applyAllowed = false;
      errors.push("현재 재고 기준 누적 예상 차감 후 수량이 부족합니다.");
    } else if (current.status === "manual_review") {
      status = "manual_review";
      applyAllowed = false;
      errors.push("현재 mapping이 manual 검토 대상으로 변경되었습니다.");
    } else if (
      current.status === "missing_mapping" ||
      current.status === "invalid_mapping" ||
      current.status === "incomplete_recipe"
    ) {
      status = "invalid_mapping";
      applyAllowed = false;
      errors.push(...current.blockedReasons);
    } else if (current.status === "skipped") {
      status = "skipped";
      applyAllowed = false;
      errors.push("현재 영수증은 차감 불필요 상태입니다.");
    } else if (
      current.status !== "ready" &&
      current.status !== "review_required"
    ) {
      status = "no_longer_ready";
      applyAllowed = false;
      errors.push(...current.blockedReasons);
    }

    if (
      current &&
      (current.status === "ready" || current.status === "review_required") &&
      applyAllowed
    ) {
      const savedMappingRows = savedCandidates.map(savedMappingSignature);
      const savedRecipeRows = savedCandidates
        .filter((candidate) => Number(candidate.recipe_id) > 0)
        .map(savedRecipeSignature);
      const savedCandidateRows = savedCandidates.map(
        savedCandidateSignature
      );
      const savedMappingKeys = new Set(
        savedMappingRows.map(mappingCandidateKey)
      );
      const savedRecipeKeys = new Set(
        savedRecipeRows.map(recipeCandidateKey)
      );
      const savedCandidateKeys = new Set(
        savedCandidateRows.map(deductionCandidateKey)
      );
      const currentMappingRows = current.lines
        .flatMap(currentMappingSignature)
        .filter((row) => savedMappingKeys.has(mappingCandidateKey(row)));
      const currentRecipeRows = current.lines
        .flatMap(currentRecipeSignature)
        .filter((row) => savedRecipeKeys.has(recipeCandidateKey(row)));
      const currentCandidateRows = current.lines
        .flatMap(currentCandidateSignature)
        .filter((row) => savedCandidateKeys.has(deductionCandidateKey(row)));

      if (
        stableStringify(sortSignature(savedMappingRows)) !==
        stableStringify(sortSignature(currentMappingRows))
      ) {
        status = "mapping_changed";
        applyAllowed = false;
        errors.push("Mapping ID, version 또는 direct 차감 규칙이 변경되었습니다.");
      } else if (
        stableStringify(sortSignature(savedRecipeRows)) !==
        stableStringify(sortSignature(currentRecipeRows))
      ) {
        status = "recipe_changed";
        applyAllowed = false;
        errors.push("Recipe 구성, version 또는 단위 차감량이 변경되었습니다.");
      } else if (
        savedReceipt.inventory_affecting_hash !==
        current.inventoryAffectingHash
      ) {
        status = "hash_changed";
        applyAllowed = false;
        errors.push(
          "영수증 상품, 수량, 옵션 또는 부모 관계가 preview 저장 이후 변경되었습니다."
        );
      } else if (
        stableStringify(sortSignature(savedCandidateRows)) !==
        stableStringify(sortSignature(currentCandidateRows))
      ) {
        status = "hash_changed";
        applyAllowed = false;
        errors.push("저장된 차감 candidate와 현재 계산 결과가 다릅니다.");
      }

      if (savedReceipt.amount_hash !== current.amountHash) {
        warnings.push(
          "금액, 세금, 할인 또는 결제 정보가 preview 저장 이후 변경되었습니다."
        );
        if (applyAllowed) status = "amount_changed";
      }
    }

    return {
      receiptId,
      receiptRefNo: savedReceipt.receipt_ref_no,
      status,
      applyAllowed,
      warnings,
      errors,
      savedInventoryHash: savedReceipt.inventory_affecting_hash,
      currentInventoryHash: current?.inventoryAffectingHash ?? null,
      savedAmountHash: savedReceipt.amount_hash,
      currentAmountHash: current?.amountHash ?? null,
      previewedReceiptUpdatedAt:
        savedReceipt.previewed_receipt_updated_at,
      currentReceiptUpdatedAt: currentReceipt?.updated_at ?? null,
    };
  });

  const validReceiptCount = receiptResults.filter(
    (receipt) => receipt.applyAllowed
  ).length;
  const blockedReceiptCount = receiptResults.length - validReceiptCount;

  return {
    found: true as const,
    batchId,
    batchStatus: batchResult.data.status,
    applyReady:
      batchResult.data.status === "previewed" &&
      receiptResults.length > 0 &&
      receiptResults.every((receipt) => receipt.applyAllowed),
    summary: {
      selectedReceiptCount: receiptResults.length,
      validReceiptCount,
      blockedReceiptCount,
      warningReceiptCount: receiptResults.filter(
        (receipt) => receipt.warnings.length > 0
      ).length,
      inventoryIssueCount: receiptResults.filter(
        (receipt) => receipt.status === "inventory_insufficient"
      ).length,
      hashChangedCount: receiptResults.filter(
        (receipt) => receipt.status === "hash_changed"
      ).length,
      mappingChangedCount: receiptResults.filter(
        (receipt) => receipt.status === "mapping_changed"
      ).length,
      recipeChangedCount: receiptResults.filter(
        (receipt) => receipt.status === "recipe_changed"
      ).length,
      alreadyAppliedCount: receiptResults.filter(
        (receipt) => receipt.status === "already_applied"
      ).length,
    },
    receipts: receiptResults,
    inventoryTotals,
    validatedAt: new Date().toISOString(),
  };
}
