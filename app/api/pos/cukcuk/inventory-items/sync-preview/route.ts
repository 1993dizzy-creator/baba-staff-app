import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  CukcukAuthError,
  loginCukcuk,
} from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";

export const runtime = "nodejs";

const BABA_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type CukcukInventoryItem = {
  Id?: string;
  Code?: string;
  ItemType?: number;
  Name?: string;
  CategoryID?: string;
  CategoryId?: string;
  CategoryName?: string;
  Price?: number;
  Inactive?: boolean;
  UnitID?: string;
  UnitId?: string;
  UnitName?: string;
  [key: string]: unknown;
};

type CukcukInventoryItemsResponse = {
  Code?: number;
  ErrorType?: number;
  ErrorMessage?: string;
  Success?: boolean;
  Environment?: string;
  Data?: CukcukInventoryItem[];
  Total?: number;
  [key: string]: unknown;
};

type BabaInventoryItem = {
  id: number;
  code: string | null;
};

type NormalizedPosItem = ReturnType<typeof normalizePosItem>;

async function readJsonSafely(response: Response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return {
      rawText: text,
    };
  }
}

function normalizeCode(code?: string | null) {
  return String(code || "")
    .trim()
    .toUpperCase();
}

function normalizePosItem(item: CukcukInventoryItem) {
  return {
    id: item.Id ?? null,
    code: item.Code ?? null,
    normalizedCode: normalizeCode(item.Code),
    itemType: item.ItemType ?? null,
    name: item.Name ?? null,
    categoryId: item.CategoryID ?? item.CategoryId ?? null,
    categoryName: item.CategoryName ?? null,
    price: item.Price ?? null,
    inactive: item.Inactive ?? false,
    unitId: item.UnitID ?? item.UnitId ?? null,
    unitName: item.UnitName ?? null,
  };
}

function getSuggestedMode(item: NormalizedPosItem) {
  const code = normalizeCode(item.code);
  const name = String(item.name || "").toLowerCase();
  const category = String(item.categoryName || "").toLowerCase();

  if (!code) return "manual";

  if (
    code.startsWith("EVENT") ||
    category.includes("event") ||
    code === "CORKAGE"
  ) {
    return "ignore";
  }

  if (item.itemType === 4 || code.startsWith("CB")) {
    return "recipe";
  }

  if (
    item.itemType === 6 ||
    code.includes("-") ||
    category.includes("cocktail") ||
    category.includes("shot") ||
    category.includes("mix drink") ||
    category.includes("mocktail") ||
    category.includes("bia tươi") ||
    name.includes("(cốc)") ||
    name.includes("tháp")
  ) {
    return "recipe";
  }

  return "manual";
}

function countBy<T>(items: T[], getKey: (item: T) => string | null | undefined) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = getKey(item) || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function fetchCukcukInventoryItems(params: {
  branchId: string;
  includeInactive: boolean;
}) {
  const auth = await loginCukcuk();

  const endpoint = "/api/v1/inventoryitems/paging";
  const limit = 100;
  let page = 1;
  let total = 0;
  const items: NormalizedPosItem[] = [];

  while (true) {
    const body = {
      Page: page,
      Limit: limit,
      BranchId: params.branchId,
      IncludeInactive: params.includeInactive,
    };

    const response = await fetch(`${auth.request.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        CompanyCode: auth.companyCode,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const raw = (await readJsonSafely(
      response
    )) as CukcukInventoryItemsResponse | null;

    if (!response.ok) {
      throw new Error(
        `CUKCUK inventoryitems HTTP error: ${response.status} ${JSON.stringify(
          raw
        )}`
      );
    }

    if (!raw?.Success) {
      throw new Error(
        `CUKCUK inventoryitems request failed: ${JSON.stringify(raw)}`
      );
    }

    const pageItems = Array.isArray(raw.Data)
      ? raw.Data.map(normalizePosItem)
      : [];

    items.push(...pageItems);

    total = Number(raw.Total ?? items.length);

    if (pageItems.length < limit) break;
    if (items.length >= total) break;

    page += 1;
  }

  return {
    endpoint,
    total,
    items,
  };
}

async function fetchBabaInventoryItems() {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select("id, code")
    .order("code", { ascending: true });

  if (error) {
    throw new Error(`BABA inventory fetch failed: ${error.message}`);
  }

  return (data || []) as BabaInventoryItem[];
}

export async function GET(req: Request) {
  const guardResponse = requirePosAdminSecret(req);
  if (guardResponse) return guardResponse;

  const { searchParams } = new URL(req.url);

  const branchId = searchParams.get("branchId") || BABA_BRANCH_ID;
  const includeInactive = searchParams.get("includeInactive") === "true";
  const listLimit = Number(searchParams.get("listLimit") || 80);

  try {
    const [posResult, babaItems] = await Promise.all([
      fetchCukcukInventoryItems({
        branchId,
        includeInactive,
      }),
      fetchBabaInventoryItems(),
    ]);

    const babaWithoutCode = babaItems.filter(
      (item) => !normalizeCode(item.code)
    );

    const babaCodeMap = new Map<string, BabaInventoryItem[]>();

    babaItems.forEach((item) => {
      const code = normalizeCode(item.code);
      if (!code) return;

      const group = babaCodeMap.get(code) || [];
      group.push(item);
      babaCodeMap.set(code, group);
    });

    const babaDuplicateCodes = Array.from(babaCodeMap.entries())
      .filter(([, items]) => items.length > 1)
      .map(([code, items]) => ({
        code,
        count: items.length,
        items,
      }));

    const directMatched: {
      code: string;
      pos: NormalizedPosItem;
      baba: BabaInventoryItem;
      deductionMode: "direct";
    }[] = [];

    const duplicateCodeConflicts: {
      code: string;
      pos: NormalizedPosItem;
      babaCandidates: BabaInventoryItem[];
      reason: string;
    }[] = [];

    const needsMapping: {
      code: string | null;
      pos: NormalizedPosItem;
      suggestedMode: string;
      reason: string;
    }[] = [];

    const posWithoutCode: NormalizedPosItem[] = [];

    posResult.items.forEach((posItem) => {
      const code = normalizeCode(posItem.code);

      if (!code) {
        posWithoutCode.push(posItem);
        needsMapping.push({
          code: null,
          pos: posItem,
          suggestedMode: "manual",
          reason: "POS 상품 code가 비어 있음",
        });
        return;
      }

      const babaMatches = babaCodeMap.get(code) || [];

      if (babaMatches.length === 1) {
        directMatched.push({
          code,
          pos: posItem,
          baba: babaMatches[0],
          deductionMode: "direct",
        });
        return;
      }

      if (babaMatches.length > 1) {
        duplicateCodeConflicts.push({
          code,
          pos: posItem,
          babaCandidates: babaMatches,
          reason: "BABA inventory에 같은 code가 여러 개 있음",
        });
        return;
      }

      needsMapping.push({
        code,
        pos: posItem,
        suggestedMode: getSuggestedMode(posItem),
        reason: "POS에는 있지만 BABA inventory.code와 직접 매칭되지 않음",
      });
    });

    const posCodeSet = new Set(
      posResult.items.map((item) => normalizeCode(item.code)).filter(Boolean)
    );

    const babaOnly = babaItems.filter((item) => {
      const code = normalizeCode(item.code);
      if (!code) return false;
      return !posCodeSet.has(code);
    });

    const needsMappingByMode = countBy(
      needsMapping,
      (item) => item.suggestedMode
    );

    const posItemTypeCounts = countBy(posResult.items, (item) =>
      item.itemType === null ? "unknown" : String(item.itemType)
    );

    const posCategoryCounts = countBy(
      posResult.items,
      (item) => item.categoryName
    );

    return NextResponse.json({
      ok: true,
      request: {
        branchId,
        includeInactive,
        endpoint: posResult.endpoint,
        listLimit,
      },
      summary: {
        posTotal: posResult.total,
        posFetched: posResult.items.length,
        babaTotal: babaItems.length,

        directMatched: directMatched.length,
        needsMapping: needsMapping.length,
        duplicateCodeConflicts: duplicateCodeConflicts.length,

        posWithoutCode: posWithoutCode.length,
        babaWithoutCode: babaWithoutCode.length,
        babaOnly: babaOnly.length,
        babaDuplicateCodeGroups: babaDuplicateCodes.length,

        needsMappingByMode,
        posItemTypeCounts,
        posCategoryCounts,
      },
      directMatched: directMatched.slice(0, listLimit),
      needsMapping: needsMapping.slice(0, listLimit),
      duplicateCodeConflicts: duplicateCodeConflicts.slice(0, listLimit),
      posWithoutCode: posWithoutCode.slice(0, listLimit),
      babaWithoutCode: babaWithoutCode.slice(0, listLimit),
      babaDuplicateCodes: babaDuplicateCodes.slice(0, listLimit),
      babaOnly: babaOnly.slice(0, listLimit),
      notes: [
        "directMatched는 POS code와 BABA inventory.code가 1:1로 맞아 바로 차감 가능한 후보입니다.",
        "needsMapping은 POS에는 있지만 BABA inventory.code와 직접 매칭되지 않아 recipe/ignore/manual 매핑이 필요한 후보입니다.",
        "duplicateCodeConflicts는 BABA inventory에 같은 code가 여러 개 있어 자동 차감하면 위험한 후보입니다.",
        "babaWithoutCode는 재고 품목이지만 code가 비어 있어 POS 자동 차감 대상이 될 수 없습니다.",
      ],
    });
  } catch (error) {
    if (error instanceof CukcukAuthError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          status: error.status ?? 500,
          data: error.raw,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
