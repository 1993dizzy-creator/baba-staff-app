import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Dict = Record<string, unknown>;
type DirectLineStatus = "pending" | "applied";

function getLimit(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 100;
}

function asRecord(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Dict;
}

function asArray(value: unknown): Dict[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (row): row is Dict =>
      !!row && typeof row === "object" && !Array.isArray(row)
  );
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toText(value: unknown, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function getPayload(json: unknown) {
  const root = asRecord(json);

  if (root.result && typeof root.result === "object") return asRecord(root.result);
  if (root.data && typeof root.data === "object") return asRecord(root.data);

  return root;
}

function firstArray(...values: unknown[]) {
  for (const value of values) {
    const arr = asArray(value);
    if (arr.length > 0) return arr;
  }

  return [];
}

function findArrayByCandidateKeys(
  value: unknown,
  candidateKeys: string[],
  depth = 0
): Dict[] {
  if (depth > 5) return [];

  if (Array.isArray(value)) {
    const rows = asArray(value);

    if (
      rows.length > 0 &&
      rows.some((row) =>
        candidateKeys.some((key) => Object.prototype.hasOwnProperty.call(row, key))
      )
    ) {
      return rows;
    }

    return [];
  }

  const record = asRecord(value);
  const entries = Object.values(record);

  for (const child of entries) {
    const found = findArrayByCandidateKeys(child, candidateKeys, depth + 1);
    if (found.length > 0) return found;
  }

  return [];
}

function getMappingType(row: Dict) {
  return String(
    row.mapping_type ??
    row.mappingType ??
    row.mapping_status ??
    row.mappingStatus ??
    row.status ??
    ""
  ).toLowerCase();
}

function getPosCode(row: Dict) {
  return toText(
    row.pos_item_code ??
    row.posItemCode ??
    row.itemCode ??
    row.item_code ??
    row.code ??
    row.inventory_code
  );
}

function getLineName(row: Dict) {
  return toText(
    row.pos_item_name ??
    row.posItemName ??
    row.itemName ??
    row.item_name ??
    row.name ??
    row.inventory_item_name
  );
}

function getLineUnit(row: Dict) {
  return toText(row.unitName ?? row.unit_name ?? row.unit ?? row.inventory_unit, "");
}

function getLineQuantity(row: Dict) {
  return toNumber(
    row.quantity ??
    row.qty ??
    row.deduct_quantity ??
    row.deductQuantity ??
    row.total_deduct_quantity ??
    row.totalDeductQuantity
  );
}

function getRefDetailId(row: Dict) {
  return toText(
    row.refDetailId ??
    row.refDetailID ??
    row.RefDetailID ??
    row.RefDetailId ??
    row.ref_detail_id ??
    row.pos_ref_detail_id ??
    row.posRefDetailId,
    ""
  );
}

function getProcessedRowStatus(row: Dict): DirectLineStatus {
  const status = String(
    row.status ??
    row.process_status ??
    row.processStatus ??
    row.deduction_status ??
    row.deductionStatus ??
    ""
  ).toLowerCase();

  if (
    status === "applied" ||
    status === "skipped" ||
    status === "already_applied"
  ) {
    return "applied";
  }

  return "pending";
}

async function getProcessedStatusByRefDetailIds(refDetailIds: string[]) {
  const cleanIds = Array.from(
    new Set(refDetailIds.filter((id) => id && id !== "-"))
  );

  const map = new Map<string, DirectLineStatus>();

  if (cleanIds.length === 0) {
    return map;
  }

  const { data, error } = await supabaseAdmin
    .from("pos_processed_invoice_lines")
    .select("*")
    .in("ref_detail_id", cleanIds);

  if (error) {
    throw new Error(`pos_processed_invoice_lines 조회 실패: ${error.message}`);
  }

  for (const row of data ?? []) {
    const record = asRecord(row);
    const refDetailId = getRefDetailId(record);

    if (!refDetailId) continue;

    const status = getProcessedRowStatus(record);
    const previous = map.get(refDetailId);

    if (previous === "applied") continue;

    map.set(refDetailId, status);
  }

  return map;
}

function getInventoryId(row: Dict) {
  return toText(row.inventory_item_id ?? row.inventoryItemId ?? row.item_id ?? row.id, "");
}

function getInventoryCode(row: Dict) {
  return toText(row.code ?? row.inventory_code ?? row.inventoryCode, "");
}

function getInventoryName(row: Dict) {
  return toText(
    row.item_name ??
    row.itemName ??
    row.name_ko ??
    row.inventory_item_name ??
    row.name_vi ??
    row.item_name_vi ??
    row.name,
    "-"
  );
}

function getInventoryUnit(row: Dict) {
  return toText(row.unit ?? row.inventory_unit ?? row.unit_name, "");
}

function getInventoryCurrentQuantity(row: Dict) {
  return toNumber(
    row.current_quantity ??
    row.currentQuantity ??
    row.quantity ??
    row.stock_quantity ??
    row.stockQuantity
  );
}

function normalizeReviewStatus(value: unknown) {
  const status = String(value || "").toLowerCase();

  if (status === "recipe") return "recipe";
  if (status === "ignore") return "ignore";
  if (status === "option") return "option";
  if (status === "manual" || status === "hold") return "manual";

  return "unmapped";
}

function getDefaultReason(status: string) {
  if (status === "manual") return "자동 차감 전 수동 확인이 필요한 항목입니다.";
  if (status === "recipe") return "레시피 차감 설정이 필요한 항목입니다.";
  if (status === "option") return "Parent 상품에 연결되는 옵션 라인입니다.";
  if (status === "ignore") return "재고 차감 대상에서 제외된 항목입니다.";

  return "POS 상품과 inventory 품목 매핑이 필요합니다.";
}

async function getAdminActor(actorUsername: string) {
  if (!actorUsername) return null;

  const { data } = await supabaseAdmin
    .from("users")
    .select("id, username, name, full_name, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (!data) return null;
  if (data.role !== "owner" && data.role !== "master") return null;

  return data;
}

async function buildDirectPreviewItems(payload: Dict) {
  const explicitLineRows = firstArray(
    payload.lines,
    payload.lineItems,
    payload.posLines,
    payload.items,
    payload.reviewItems
  );

  const foundLineRows =
    explicitLineRows.length > 0
      ? explicitLineRows
      : findArrayByCandidateKeys(payload, [
        "mapping_type",
        "mappingType",
        "mapping_status",
        "mappingStatus",
        "pos_item_code",
        "posItemCode",
        "itemCode",
        "itemName",
        "pos_item_name",
        "posItemName",
      ]);

  const directRows = foundLineRows.filter((row) => getMappingType(row) === "direct");

  const posCodes = Array.from(
    new Set(
      directRows
        .map((row) => getPosCode(row))
        .filter((code) => code && code !== "-")
    )
  );

  if (posCodes.length === 0) {
    return {
      items: [],
      pendingCount: 0,
      appliedCount: 0,
    };
  }

  const refDetailIds = directRows
    .map((row) => getRefDetailId(row))
    .filter((id) => id && id !== "-");

  const processedStatusByRefDetailId =
    await getProcessedStatusByRefDetailIds(refDetailIds);

  const { data: mappingRows, error: mappingError } = await supabaseAdmin
    .from("pos_item_mappings")
    .select("*")
    .in("pos_item_code", posCodes);

  if (mappingError) {
    throw new Error(`pos_item_mappings 조회 실패: ${mappingError.message}`);
  }

  const mappingByPosCode = new Map<string, Dict>();

  for (const row of mappingRows ?? []) {
    const record = asRecord(row);
    const posCode = toText(record.pos_item_code ?? record.posItemCode, "");
    if (posCode) mappingByPosCode.set(posCode, record);
  }

  const inventoryIds = Array.from(
    new Set(
      Array.from(mappingByPosCode.values())
        .map((row) => getInventoryId(row))
        .filter(Boolean)
    )
  );

  const inventoryById = new Map<string, Dict>();
  const inventoryByCode = new Map<string, Dict>();

  if (inventoryIds.length > 0) {
    const { data: inventoryRows, error: inventoryError } = await supabaseAdmin
      .from("inventory")
      .select("*")
      .in("id", inventoryIds);

    if (inventoryError) {
      throw new Error(`inventory 조회 실패: ${inventoryError.message}`);
    }

    for (const row of inventoryRows ?? []) {
      const record = asRecord(row);
      const id = getInventoryId(record);
      const code = getInventoryCode(record);

      if (id) inventoryById.set(id, record);
      if (code) inventoryByCode.set(code, record);
    }
  }

  const missingCodes = posCodes.filter((code) => {
    const mapping = mappingByPosCode.get(code);
    const inventoryId = mapping ? getInventoryId(mapping) : "";
    return !inventoryId && !inventoryByCode.has(code);
  });

  if (missingCodes.length > 0) {
    const { data: inventoryRowsByCode, error: inventoryByCodeError } =
      await supabaseAdmin.from("inventory").select("*").in("code", missingCodes);

    if (inventoryByCodeError) {
      throw new Error(`inventory code 조회 실패: ${inventoryByCodeError.message}`);
    }

    for (const row of inventoryRowsByCode ?? []) {
      const record = asRecord(row);
      const id = getInventoryId(record);
      const code = getInventoryCode(record);

      if (id) inventoryById.set(id, record);
      if (code) inventoryByCode.set(code, record);
    }
  }

  const grouped = new Map<
    string,
    {
      posCode: string;
      posName: string;
      unitName: string;
      inventory: Dict;
      quantity: number;
      status: DirectLineStatus;
    }
  >();

  let pendingCount = 0;
  let appliedCount = 0;

  for (const row of directRows) {
    const posCode = getPosCode(row);
    if (!posCode || posCode === "-") continue;

    const mapping = mappingByPosCode.get(posCode);
    const inventoryId = mapping ? getInventoryId(mapping) : "";

    const inventory = inventoryId
      ? inventoryById.get(inventoryId)
      : inventoryByCode.get(posCode);

    if (!inventory) continue;

    const refDetailId = getRefDetailId(row);

    const status: DirectLineStatus = refDetailId
      ? processedStatusByRefDetailId.get(refDetailId) ?? "pending"
      : "pending";

    if (status === "applied") {
      appliedCount += 1;
    } else {
      pendingCount += 1;
    }

    const inventoryCode = getInventoryCode(inventory) || posCode;
    const groupKey = `${inventoryCode}:${status}`;

    const previous = grouped.get(groupKey);
    const quantity = getLineQuantity(row);

    grouped.set(groupKey, {
      posCode,
      posName: previous?.posName || getLineName(row),
      unitName: previous?.unitName || getLineUnit(row),
      inventory,
      quantity: (previous?.quantity ?? 0) + quantity,
      status,
    });
  }

  const items = Array.from(grouped.entries())
    .map(([groupKey, item], index) => {
      const inventoryCode = groupKey.split(":")[0];
      const currentQuantity = getInventoryCurrentQuantity(item.inventory);
      const deductQuantity = item.quantity;

      const expectedAfterQuantity =
        item.status === "applied"
          ? currentQuantity
          : currentQuantity - deductQuantity;

      return {
        id: `${groupKey}-${index}`,
        code: inventoryCode,
        name: getInventoryName(item.inventory) || item.posName,
        unit: getInventoryUnit(item.inventory) || item.unitName,
        currentQuantity,
        deductQuantity,
        expectedAfterQuantity,
        status: item.status,
        posCode: item.posCode,
        posName: item.posName,
      };
    })
    .sort((a, b) => {
      if (a.status === b.status) return a.code.localeCompare(b.code);
      return a.status === "pending" ? -1 : 1;
    });

  return {
    items,
    pendingCount,
    appliedCount,
  };
}

function buildReviewItems(payload: Dict) {
  const explicitRows = firstArray(
    payload.reviewItems,
    payload.lines,
    payload.lineItems,
    payload.posLines,
    payload.items
  );

  const lineRows =
    explicitRows.length > 0
      ? explicitRows
      : findArrayByCandidateKeys(payload, [
        "mapping_type",
        "mappingType",
        "mapping_status",
        "mappingStatus",
        "pos_item_code",
        "posItemCode",
        "itemCode",
        "itemName",
        "pos_item_name",
        "posItemName",
      ]);

  return lineRows
    .map((row, index) => {
      const mappingType = getMappingType(row);

      if (
        mappingType === "direct" ||
        mappingType === "applied" ||
        mappingType === "pending"
      ) {
        return null;
      }

      const status = normalizeReviewStatus(mappingType);
      const code = getPosCode(row);
      const name = getLineName(row);

      return {
        id: toText(
          row.id ??
          row.refDetailId ??
          row.ref_detail_id ??
          row.lineId ??
          row.line_id ??
          `${code}-${index}`
        ),
        status,
        code,
        name,
        quantity: getLineQuantity(row),
        reason: toText(
          row.reason ??
          row.note ??
          row.mapping_reason ??
          row.mappingReason ??
          getDefaultReason(status)
        ),
      };
    })
    .filter(Boolean);
}

export async function POST(req: Request) {
  const secret = process.env.POS_ADMIN_SECRET;

  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "POS_ADMIN_SECRET is not configured." },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as Dict;

  const businessDate =
    typeof body.businessDate === "string" ? body.businessDate : "";

  const actorUsername =
    typeof body.actorUsername === "string" ? body.actorUsername : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return NextResponse.json(
      { ok: false, error: "businessDate 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const actor = await getAdminActor(actorUsername);

  if (!actor) {
    return NextResponse.json(
      { ok: false, error: "POS 관리자 권한이 없습니다." },
      { status: 403 }
    );
  }

  const origin = new URL(req.url).origin;

  const dryRunRes = await fetch(`${origin}/api/pos/cukcuk/sainvoices/dry-run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pos-admin-secret": secret,
    },
    body: JSON.stringify({
      businessDate,
      limit: getLimit(body.limit),
      saveDryRun: false,
      includeLines: true,
      includeDebug: false,
      actorName: actor.name || actor.full_name || actor.username,
      actorUsername: actor.username,
    }),
    cache: "no-store",
  });

  const dryRunJson = await dryRunRes.json().catch(() => null);
  const root = asRecord(dryRunJson);

  if (!dryRunRes.ok || root.ok === false) {
    return NextResponse.json(
      dryRunJson ?? {
        ok: false,
        error: `dry-run 실패: HTTP ${dryRunRes.status}`,
      },
      { status: dryRunRes.status }
    );
  }

  try {
    const payload = getPayload(dryRunJson);
    const directPreview = await buildDirectPreviewItems(payload);
    const reviewItems = buildReviewItems(payload);
    const originalSummary = asRecord(payload.summary);

    return NextResponse.json({
      ...root,
      ok: root.ok ?? true,
      result: {
        ...payload,
        summary: {
          ...originalSummary,
          pendingCount: directPreview.pendingCount,
          appliedCount: directPreview.appliedCount,
        },
        pendingCount: directPreview.pendingCount,
        appliedCount: directPreview.appliedCount,
        directPreviewItems: directPreview.items,
        reviewItems,
        enrichment: {
          directPreviewItemCount: directPreview.items.length,
          pendingDirectLineCount: directPreview.pendingCount,
          appliedDirectLineCount: directPreview.appliedCount,
          reviewItemCount: reviewItems.length,
          currentQuantitySource: "inventory",
          processedStatusSource: "pos_processed_invoice_lines",
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "dry-run 보강 처리 중 오류가 발생했습니다.",
        rawDryRunResult: dryRunJson,
      },
      { status: 500 }
    );
  }
}