import "server-only";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";

export const DEFAULT_CUKCUK_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";
export const INVENTORY_ITEMS_PAGING_ENDPOINT = "/api/v1/inventoryitems/paging";
export const INVENTORY_ITEM_DETAIL_ENDPOINT = "/api/v1/inventoryitems/detail";

export type JsonObject = Record<string, unknown>;

export type CukcukProductRaw = JsonObject;

export type CukcukProductsResponse = {
  Code?: number;
  ErrorType?: number;
  ErrorMessage?: string;
  Success?: boolean;
  Environment?: string;
  Data?: CukcukProductRaw[];
  Total?: number;
  [key: string]: unknown;
};

export type NormalizedCukcukProduct = {
  source: "cukcuk";
  branchId: string;
  posItemId: string | null;
  itemCode: string | null;
  itemName: string;
  itemNameVi: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categoryNameVi: string | null;
  unitId: string | null;
  unitName: string | null;
  unitPrice: number;
  priceIncludesVat: boolean | null;
  taxRate: number | null;
  taxName: string | null;
  taxAmount: number | null;
  itemType: number | null;
  isActive: boolean;
  isSold: boolean | null;
  rawJson: CukcukProductRaw;
};

const PRODUCT_FIELD_CANDIDATES = {
  posItemId: ["Id", "ID", "InventoryItemId", "InventoryItemID", "ItemId", "ItemID"],
  itemCode: ["Code", "ItemCode", "InventoryItemCode"],
  itemName: ["Name", "ItemName", "InventoryItemName"],
  itemNameVi: ["NameVI", "NameVi", "NameVN", "NameVn"],
  categoryId: ["CategoryID", "CategoryId", "InventoryItemCategoryID"],
  categoryName: ["CategoryName", "InventoryItemCategoryName"],
  categoryNameVi: ["CategoryNameVI", "CategoryNameVi", "CategoryNameVN"],
  unitId: ["UnitID", "UnitId"],
  unitName: ["UnitName"],
  unitPrice: ["Price", "SalePrice", "SellingPrice", "UnitPrice"],
  priceIncludesVat: [
    "PriceIncludesVAT",
    "PriceIncludesVat",
    "IsPriceIncludeVAT",
    "IsPriceIncludeVat",
    "IsIncludeVAT",
    "IsIncludeVat",
  ],
  taxRate: ["TaxRate", "VATRate", "VatRate", "TaxPercent", "VATPercent"],
  taxName: ["TaxName", "VATName", "VatName", "TaxGroupName"],
  taxAmount: ["TaxAmount", "VATAmount", "VatAmount"],
  itemType: ["ItemType", "InventoryItemType"],
  inactive: ["Inactive", "IsInactive"],
  isActive: ["IsActive", "Active"],
  isSold: ["IsSold", "IsSale", "IsSaleItem", "IsForSale"],
} as const;

const TAX_CANDIDATE_KEYWORDS = [
  "tax",
  "vat",
  "thue",
  "thuế",
  "thue_suat",
  "thuesuat",
  "taxrate",
  "vatrate",
  "rate",
  "percent",
  "percentage",
];

export type TaxCandidateMatch = {
  path: string;
  key: string;
  value: unknown;
  matchedKeywords: string[];
};

export function getProductFieldCandidates() {
  return PRODUCT_FIELD_CANDIDATES;
}

function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getTaxKeywordMatches(key: string) {
  const normalizedKey = normalizeSearchText(key);

  return TAX_CANDIDATE_KEYWORDS.filter((keyword) =>
    normalizedKey.includes(normalizeSearchText(keyword))
  );
}

export function findTaxCandidateFields(value: unknown, basePath = "$") {
  const matches: TaxCandidateMatch[] = [];
  const seen = new WeakSet<object>();

  function walk(current: unknown, path: string) {
    if (!current || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    Object.entries(current as JsonObject).forEach(([key, item]) => {
      const nextPath = `${path}.${key}`;
      const matchedKeywords = getTaxKeywordMatches(key);

      if (matchedKeywords.length > 0) {
        matches.push({
          path: nextPath,
          key,
          value: item,
          matchedKeywords,
        });
      }

      walk(item, nextPath);
    });
  }

  walk(value, basePath);
  return matches;
}

export async function readJsonSafely(response: Response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function getValue(record: JsonObject, keys: readonly string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return null;
}

function getString(record: JsonObject, keys: readonly string[]) {
  const value = getValue(record, keys);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(record: JsonObject, keys: readonly string[]) {
  const value = getValue(record, keys);

  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function getBoolean(record: JsonObject, keys: readonly string[]) {
  const value = getValue(record, keys);

  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return null;
}

export function getPresentProductFields(items: CukcukProductRaw[]) {
  const keys = new Set<string>();
  items.forEach((item) => {
    Object.keys(item).forEach((key) => keys.add(key));
  });

  return Object.fromEntries(
    Object.entries(PRODUCT_FIELD_CANDIDATES).map(([field, candidates]) => [
      field,
      candidates.filter((candidate) => keys.has(candidate)),
    ])
  );
}

export function normalizeCukcukProduct(params: {
  branchId: string;
  item: CukcukProductRaw;
}): NormalizedCukcukProduct | null {
  const itemName = getString(params.item, PRODUCT_FIELD_CANDIDATES.itemName);
  if (!itemName) return null;

  const inactive = getBoolean(params.item, PRODUCT_FIELD_CANDIDATES.inactive);
  const isActive = getBoolean(params.item, PRODUCT_FIELD_CANDIDATES.isActive);

  return {
    source: "cukcuk",
    branchId: params.branchId,
    posItemId: getString(params.item, PRODUCT_FIELD_CANDIDATES.posItemId),
    itemCode: getString(params.item, PRODUCT_FIELD_CANDIDATES.itemCode),
    itemName,
    itemNameVi: getString(params.item, PRODUCT_FIELD_CANDIDATES.itemNameVi),
    categoryId: getString(params.item, PRODUCT_FIELD_CANDIDATES.categoryId),
    categoryName: getString(params.item, PRODUCT_FIELD_CANDIDATES.categoryName),
    categoryNameVi: getString(params.item, PRODUCT_FIELD_CANDIDATES.categoryNameVi),
    unitId: getString(params.item, PRODUCT_FIELD_CANDIDATES.unitId),
    unitName: getString(params.item, PRODUCT_FIELD_CANDIDATES.unitName),
    unitPrice: getNumber(params.item, PRODUCT_FIELD_CANDIDATES.unitPrice) ?? 0,
    priceIncludesVat: getBoolean(
      params.item,
      PRODUCT_FIELD_CANDIDATES.priceIncludesVat
    ),
    taxRate: getNumber(params.item, PRODUCT_FIELD_CANDIDATES.taxRate),
    taxName: getString(params.item, PRODUCT_FIELD_CANDIDATES.taxName),
    taxAmount: getNumber(params.item, PRODUCT_FIELD_CANDIDATES.taxAmount),
    itemType: getNumber(params.item, PRODUCT_FIELD_CANDIDATES.itemType),
    isActive: isActive ?? inactive !== true,
    isSold: getBoolean(params.item, PRODUCT_FIELD_CANDIDATES.isSold),
    rawJson: params.item,
  };
}

export async function fetchCukcukProductsPage(params: {
  branchId: string;
  page: number;
  limit: number;
  includeInactive: boolean;
  keySearch?: string;
}) {
  const auth = await loginCukcuk();
  const body: JsonObject = {
    Page: params.page,
    Limit: params.limit,
    BranchId: params.branchId,
    IncludeInactive: params.includeInactive,
  };

  if (params.keySearch?.trim()) {
    body.KeySearch = params.keySearch.trim();
  }

  const response = await fetch(
    `${auth.request.baseUrl}${INVENTORY_ITEMS_PAGING_ENDPOINT}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        CompanyCode: auth.companyCode,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    }
  );

  const raw = (await readJsonSafely(response)) as CukcukProductsResponse | null;

  if (!response.ok) {
    throw new Error(
      `CUKCUK inventoryitems HTTP error: ${response.status} ${JSON.stringify(raw)}`
    );
  }

  if (!raw?.Success) {
    throw new Error(`CUKCUK inventoryitems request failed: ${JSON.stringify(raw)}`);
  }

  const items = Array.isArray(raw.Data) ? raw.Data : [];

  return {
    endpoint: INVENTORY_ITEMS_PAGING_ENDPOINT,
    requestBody: body,
    raw,
    items,
    normalized: items
      .map((item) => normalizeCukcukProduct({ branchId: params.branchId, item }))
      .filter((item): item is NormalizedCukcukProduct => Boolean(item)),
    total: Number(raw.Total ?? items.length),
  };
}

export async function fetchCukcukProductDetail(params: { posItemId: string }) {
  const auth = await loginCukcuk();
  const endpoint = `${INVENTORY_ITEM_DETAIL_ENDPOINT}/${encodeURIComponent(
    params.posItemId
  )}`;

  const response = await fetch(`${auth.request.baseUrl}${endpoint}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      CompanyCode: auth.companyCode,
    },
    cache: "no-store",
  });

  const raw = (await readJsonSafely(response)) as
    | (JsonObject & { Data?: CukcukProductRaw; Success?: boolean })
    | null;

  if (!response.ok) {
    throw new Error(
      `CUKCUK inventoryitem detail HTTP error: ${response.status} ${JSON.stringify(raw)}`
    );
  }

  if (!raw?.Success) {
    throw new Error(`CUKCUK inventoryitem detail failed: ${JSON.stringify(raw)}`);
  }

  const data = raw.Data && typeof raw.Data === "object" ? raw.Data : raw;

  return {
    endpoint,
    raw,
    item: data as CukcukProductRaw,
    normalized: normalizeCukcukProduct({
      branchId: "",
      item: data as CukcukProductRaw,
    }),
  };
}
