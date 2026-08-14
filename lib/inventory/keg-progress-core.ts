export type KegProgressMapping = {
  pos_product_id: number | string | null;
  quantity_per_pos_unit: number | string | null;
};

export type KegProgressProduct = {
  id: number | string;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string | null;
  unit_name: string | null;
};

export type KegProgressLine = {
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

export type KegProgressReceipt = {
  id: number | string;
  ref_date: string | null;
  synced_at: string | null;
  updated_at: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
};

export type KegSalesBreakdown = {
  totalUnits: number;
  regularUnits: number;
  regularSoldMl: number;
  regularAverageMl: number | null;
  towerUnits: number;
  towerSoldMl: number;
  towerAverageMl: number | null;
  otherUnits: number;
  otherSoldMl: number;
};

const roundDecimal = (value: number) => Math.round(value * 1000) / 1000;

const asPositiveNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const asOptionalKey = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const normalizeClassifyText = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "d");

const classifyKegProduct = (
  product: KegProgressProduct | undefined
): "regular" | "tower" | "other" => {
  const unitName = normalizeClassifyText(product?.unit_name);
  if (unitName) {
    return unitName.includes("thap") ||
      unitName.includes("tower") ||
      unitName.includes("\ud0c0\uc6cc")
      ? "tower"
      : "regular";
  }

  const itemName = normalizeClassifyText(product?.item_name);
  if (itemName) {
    return itemName.includes("thap") ||
      itemName.includes("tower") ||
      itemName.includes("\ud0c0\uc6cc")
      ? "tower"
      : "regular";
  }

  return "other";
};

export const getKegLineReferenceTime = (
  line: KegProgressLine,
  receipt: KegProgressReceipt | undefined
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

export function calculateKegSalesForSession(params: {
  mappings: KegProgressMapping[];
  products: KegProgressProduct[];
  receipts: KegProgressReceipt[];
  lines: KegProgressLine[];
  startedAt: string;
}): { soldMl: number; salesBreakdown: KegSalesBreakdown } {
  const productById = new Map(
    params.products.map((product) => [Number(product.id), product])
  );
  const receiptById = new Map(
    params.receipts.map((receipt) => [Number(receipt.id), receipt])
  );
  const linesByKey = new Map<string, KegProgressLine[]>();

  for (const line of params.lines) {
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

  const sessionStartTime = Date.parse(params.startedAt);
  let soldMl = 0;
  let regularUnits = 0;
  let regularSoldMl = 0;
  let towerUnits = 0;
  let towerSoldMl = 0;
  let otherUnits = 0;
  let otherSoldMl = 0;

  for (const mapping of params.mappings) {
    const product = productById.get(Number(mapping.pos_product_id));
    const category = classifyKegProduct(product);
    const quantityPerPosUnit = asPositiveNumber(mapping.quantity_per_pos_unit);
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
        const referenceTime = getKegLineReferenceTime(line, receipt);
        if (referenceTime === null || referenceTime < sessionStartTime) continue;

        countedLineIds.add(lineId);
        const quantity = asPositiveNumber(line.quantity);
        const lineSoldMl = quantity * quantityPerPosUnit;
        soldMl += lineSoldMl;
        if (category === "tower") {
          towerUnits += quantity;
          towerSoldMl += lineSoldMl;
        } else if (category === "other") {
          otherUnits += quantity;
          otherSoldMl += lineSoldMl;
        } else {
          regularUnits += quantity;
          regularSoldMl += lineSoldMl;
        }
      }
    }
  }

  const roundedRegularUnits = roundDecimal(regularUnits);
  const roundedTowerUnits = roundDecimal(towerUnits);
  const roundedOtherUnits = roundDecimal(otherUnits);
  const roundedRegularSoldMl = roundDecimal(regularSoldMl);
  const roundedTowerSoldMl = roundDecimal(towerSoldMl);
  const roundedOtherSoldMl = roundDecimal(otherSoldMl);

  return {
    soldMl: roundDecimal(soldMl),
    salesBreakdown: {
      totalUnits: roundDecimal(
        roundedRegularUnits + roundedTowerUnits + roundedOtherUnits
      ),
      regularUnits: roundedRegularUnits,
      regularSoldMl: roundedRegularSoldMl,
      regularAverageMl:
        roundedRegularUnits > 0
          ? Math.round(roundedRegularSoldMl / roundedRegularUnits)
          : null,
      towerUnits: roundedTowerUnits,
      towerSoldMl: roundedTowerSoldMl,
      towerAverageMl:
        roundedTowerUnits > 0
          ? Math.round(roundedTowerSoldMl / roundedTowerUnits)
          : null,
      otherUnits: roundedOtherUnits,
      otherSoldMl: roundedOtherSoldMl,
    },
  };
}
