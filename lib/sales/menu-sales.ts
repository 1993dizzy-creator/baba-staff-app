export type MenuSalesReceiptRow = {
  id: number;
  ref_no: string | null;
  business_date: string;
  ref_date: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
};

export type MenuSalesLineRow = {
  id: number;
  receipt_id: number | null;
  ref_detail_id: string | null;
  parent_ref_detail_id: string | null;
  business_date: string;
  payment_status: number | null;
  is_canceled: boolean | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string | null;
  quantity: number | string | null;
  final_amount: number | string | null;
  is_option: boolean | null;
  ref_detail_type: number | null;
  mapping_status: string | null;
  is_excluded: boolean | null;
  raw_json: unknown;
};

export type MenuSalesProductCategoryRow = {
  source: string;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
  category_name: string | null;
};

export type MenuSalesCategoryGroupMappingRow = {
  category_name: string;
  group_type: "food" | "drink" | "uncategorized";
};

export type MenuSalesOption = {
  key: string;
  optionName: string;
  quantity: number;
  amount: number;
};

export type MenuSalesItem = {
  key: string;
  itemId: string | null;
  itemCode: string | null;
  itemName: string;
  categoryName: string | null;
  groupType: "food" | "drink" | "uncategorized";
  quantity: number;
  amount: number;
  receiptCount: number;
  optionAmount: number;
  options: MenuSalesOption[];
};

type CategoryGroupType = MenuSalesItem["groupType"];
type UnlinkedOptionFailureReason =
  | "missing_parent_id"
  | "parent_not_found"
  | "parent_not_sales_line"
  | "parent_excluded_or_not_eligible"
  | "parent_missing_ref_detail_id"
  | "unknown";
type UnlinkedOptionReceipt = {
  lineId: number;
  receiptId: number;
  receiptRefNo: string | null;
  businessDate: string;
  refDate: string | null;
  optionName: string;
  quantity: number;
  amount: number;
  parentRefDetailId: string | null;
  rawParentId: string | null;
  failureReason: UnlinkedOptionFailureReason;
};
type UnlinkedOptionGroup = {
  key: string;
  optionName: string;
  lineCount: number;
  quantity: number;
  amount: number;
  receipts: UnlinkedOptionReceipt[];
};
type MenuSalesCategory = {
  key: string;
  name: string | null;
  groupType: CategoryGroupType;
  quantity: number;
  amount: number;
  itemCount: number;
};
type MenuSalesGroup = {
  key: "all" | CategoryGroupType;
  name: string;
  quantity: number;
  amount: number;
  itemCount: number;
};

const PAID_PAYMENT_STATUS = 3;
const CANCELED_PAYMENT_STATUSES = new Set([4, 5]);
const UNCATEGORIZED_KEY = "__uncategorized__";

function toNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isPaid(paymentStatus: number | null) {
  return paymentStatus === PAID_PAYMENT_STATUS;
}

function isCanceled(row: Pick<MenuSalesReceiptRow | MenuSalesLineRow, "payment_status" | "is_canceled">) {
  return row.is_canceled === true || CANCELED_PAYMENT_STATUSES.has(Number(row.payment_status));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getRawString(value: unknown, key: string) {
  const rawValue = asObject(value)?.[key];
  if (typeof rawValue === "string" && rawValue.trim()) return rawValue.trim();
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) return String(rawValue);
  return null;
}

function getParentRefDetailId(line: MenuSalesLineRow) {
  return line.parent_ref_detail_id || getRawString(line.raw_json, "ParentID");
}

function isOptionLine(line: MenuSalesLineRow) {
  const raw = asObject(line.raw_json);
  return line.is_option === true || Boolean(line.parent_ref_detail_id) || line.ref_detail_type !== 1 || line.mapping_status === "option" || Boolean(raw?.ParentID) || Boolean(raw?.InventoryItemAdditionID);
}

function getReceiptLineKey(receiptId: number, refDetailId: string) {
  return `${receiptId}::${refDetailId}`;
}

function getMenuItemKey(line: MenuSalesLineRow) {
  if (line.item_id) return `item:${line.item_id}`;
  if (line.item_code) return `code:${line.item_code}::${line.item_name || ""}`;
  if (line.item_name) return `name:${line.item_name}`;
  return `line:${line.id}`;
}

function getOptionKey(line: MenuSalesLineRow) {
  return getRawString(line.raw_json, "InventoryItemAdditionID") || line.item_id || line.item_code || line.item_name || `line:${line.id}`;
}

function getUnlinkedOptionFailureReason(line: MenuSalesLineRow, parentLine: MenuSalesLineRow | null, paidReceiptIds: Set<number>): UnlinkedOptionFailureReason {
  const parentRefDetailId = getParentRefDetailId(line);
  if (!parentRefDetailId) return "missing_parent_id";
  if (!parentLine) return "parent_not_found";
  if (!parentLine.ref_detail_id) return "parent_missing_ref_detail_id";
  if (isOptionLine(parentLine)) return "parent_not_sales_line";
  if (parentLine.receipt_id === null || !paidReceiptIds.has(parentLine.receipt_id) || !isPaid(parentLine.payment_status) || isCanceled(parentLine) || parentLine.is_excluded === true) return "parent_excluded_or_not_eligible";
  return "unknown";
}

function getCategoryGroupType(categoryName: string | null, categoryGroupByName: Map<string, CategoryGroupType>): CategoryGroupType {
  return categoryName ? categoryGroupByName.get(categoryName) || "uncategorized" : "uncategorized";
}

function getLineCategoryName(line: MenuSalesLineRow, productCategoryByItemId: Map<string, string>, productCategoryByItemCode: Map<string, string>) {
  const rawCategoryName = getRawString(line.raw_json, "CategoryName");
  if (rawCategoryName) return rawCategoryName;
  if (line.item_id && productCategoryByItemId.has(line.item_id)) return productCategoryByItemId.get(line.item_id) || null;
  if (line.item_code && productCategoryByItemCode.has(line.item_code)) return productCategoryByItemCode.get(line.item_code) || null;
  return null;
}

// This is the single menu-sales projection shared by /admin/sales/monthly and
// payroll-derived menu incentives. Keep payment/cancellation/exclusion rules
// and option-to-parent attribution here so the amount shown to managers can
// never drift from the amount used by payroll.
export function buildMenuSales(
  receipts: MenuSalesReceiptRow[],
  lines: MenuSalesLineRow[],
  productCategories: MenuSalesProductCategoryRow[],
  categoryGroupMappings: MenuSalesCategoryGroupMappingRow[]
) {
  type MenuSalesBucket = Omit<MenuSalesItem, "receiptCount" | "options"> & {
    categoryFromReceipt: boolean;
    receiptIds: Set<number>;
    options: Map<string, MenuSalesOption>;
  };
  const paidReceiptIds = new Set(receipts.filter((receipt) => isPaid(receipt.payment_status) && !isCanceled(receipt)).map((receipt) => receipt.id));
  const eligibleLines = lines.filter((line) => line.receipt_id !== null && paidReceiptIds.has(line.receipt_id) && isPaid(line.payment_status) && !isCanceled(line) && line.is_excluded !== true);
  const itemBuckets = new Map<string, MenuSalesBucket>();
  const parentBucketByLineKey = new Map<string, MenuSalesBucket>();
  const lineByReceiptRefDetailKey = new Map<string, MenuSalesLineRow>();
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const unlinkedOptionGroups = new Map<string, UnlinkedOptionGroup>();
  const productCategoryByItemId = new Map<string, string>();
  const productCategoryByItemCode = new Map<string, string>();
  const categoryGroupByName = new Map(categoryGroupMappings.map((mapping) => [mapping.category_name.trim(), mapping.group_type]));

  lines.forEach((line) => {
    if (line.receipt_id !== null && line.ref_detail_id) lineByReceiptRefDetailKey.set(getReceiptLineKey(line.receipt_id, line.ref_detail_id), line);
  });
  productCategories.toSorted((a, b) => Number(b.source === "cukcuk") - Number(a.source === "cukcuk")).forEach((product) => {
    const categoryName = product.category_name?.trim();
    if (!categoryName) return;
    if (product.pos_item_id && !productCategoryByItemId.has(product.pos_item_id)) productCategoryByItemId.set(product.pos_item_id, categoryName);
    if (product.item_id && !productCategoryByItemId.has(product.item_id)) productCategoryByItemId.set(product.item_id, categoryName);
    if (product.item_code && !productCategoryByItemCode.has(product.item_code)) productCategoryByItemCode.set(product.item_code, categoryName);
  });

  eligibleLines.filter((line) => !isOptionLine(line)).forEach((line) => {
    const receiptId = line.receipt_id as number;
    const key = getMenuItemKey(line);
    const receiptCategoryName = getRawString(line.raw_json, "CategoryName");
    const categoryName = receiptCategoryName || getLineCategoryName(line, productCategoryByItemId, productCategoryByItemCode);
    const current = itemBuckets.get(key) || ({key,itemId:line.item_id,itemCode:line.item_code,itemName:line.item_name || line.item_code || "-",categoryName,groupType:getCategoryGroupType(categoryName,categoryGroupByName),categoryFromReceipt:Boolean(receiptCategoryName),quantity:0,amount:0,optionAmount:0,receiptIds:new Set<number>(),options:new Map<string,MenuSalesOption>()} satisfies MenuSalesBucket);
    if (receiptCategoryName && !current.categoryFromReceipt) {
      current.categoryName = receiptCategoryName;
      current.groupType = getCategoryGroupType(receiptCategoryName, categoryGroupByName);
      current.categoryFromReceipt = true;
    } else if (!current.categoryName && categoryName) {
      current.categoryName = categoryName;
      current.groupType = getCategoryGroupType(categoryName, categoryGroupByName);
    }
    current.quantity += toNumber(line.quantity);
    current.amount += toNumber(line.final_amount);
    current.receiptIds.add(receiptId);
    itemBuckets.set(key, current);
    if (line.ref_detail_id) parentBucketByLineKey.set(getReceiptLineKey(receiptId, line.ref_detail_id), current);
  });

  let unlinkedOptionAmount = 0;
  let unlinkedOptionCount = 0;
  eligibleLines.filter(isOptionLine).forEach((line) => {
    const receiptId = line.receipt_id as number;
    const parentRefDetailId = getParentRefDetailId(line);
    const parentBucket = parentRefDetailId ? parentBucketByLineKey.get(getReceiptLineKey(receiptId, parentRefDetailId)) : null;
    const amount = toNumber(line.final_amount);
    if (!parentBucket) {
      const optionKey = getOptionKey(line);
      const optionName = line.item_name || line.item_code || "-";
      const rawParentId = getRawString(line.raw_json, "ParentID");
      const parentLine = parentRefDetailId ? lineByReceiptRefDetailKey.get(getReceiptLineKey(receiptId, parentRefDetailId)) || null : null;
      const receipt = receiptById.get(receiptId);
      const group = unlinkedOptionGroups.get(optionKey) || ({key:optionKey,optionName,lineCount:0,quantity:0,amount:0,receipts:[]} satisfies UnlinkedOptionGroup);
      unlinkedOptionAmount += amount;
      unlinkedOptionCount += 1;
      group.lineCount += 1;
      group.quantity += toNumber(line.quantity);
      group.amount += amount;
      group.receipts.push({lineId:line.id,receiptId,receiptRefNo:receipt?.ref_no ?? null,businessDate:line.business_date,refDate:receipt?.ref_date ?? null,optionName,quantity:toNumber(line.quantity),amount,parentRefDetailId,rawParentId,failureReason:getUnlinkedOptionFailureReason(line,parentLine,paidReceiptIds)});
      unlinkedOptionGroups.set(optionKey, group);
      return;
    }
    const optionKey = getOptionKey(line);
    const option = parentBucket.options.get(optionKey) || ({key:optionKey,optionName:line.item_name || line.item_code || "-",quantity:0,amount:0} satisfies MenuSalesOption);
    option.quantity += toNumber(line.quantity);
    option.amount += amount;
    parentBucket.options.set(optionKey, option);
    parentBucket.optionAmount += amount;
    parentBucket.amount += amount;
  });

  const items = Array.from(itemBuckets.values()).map((item): MenuSalesItem => ({key:item.key,itemId:item.itemId,itemCode:item.itemCode,itemName:item.itemName,categoryName:item.categoryName,groupType:item.groupType,quantity:item.quantity,amount:item.amount,receiptCount:item.receiptIds.size,optionAmount:item.optionAmount,options:Array.from(item.options.values()).sort((a,b)=>b.quantity-a.quantity || b.amount-a.amount || a.optionName.localeCompare(b.optionName))}));
  const categoryMap = new Map<string, MenuSalesCategory>();
  items.forEach((item) => {
    const key = item.categoryName ? `category:${item.categoryName}` : UNCATEGORIZED_KEY;
    const category = categoryMap.get(key) || ({key,name:item.categoryName,groupType:item.groupType,quantity:0,amount:0,itemCount:0} satisfies MenuSalesCategory);
    category.quantity += item.quantity;
    category.amount += item.amount;
    category.itemCount += 1;
    categoryMap.set(key, category);
  });
  const groupLabels: Record<MenuSalesGroup["key"], string> = {all:"전체",food:"음식",drink:"주류·음료",uncategorized:"미분류"};
  const groups: MenuSalesGroup[] = (["all","food","drink","uncategorized"] as const).map((key) => {
    const groupItems = key === "all" ? items : items.filter((item) => item.groupType === key);
    return {key,name:groupLabels[key],quantity:groupItems.reduce((sum,item)=>sum+item.quantity,0),amount:groupItems.reduce((sum,item)=>sum+item.amount,0),itemCount:groupItems.length};
  });
  return {sortDefault:"quantity" as const,totalItemAmount:items.reduce((sum,item)=>sum+item.amount,0),unlinkedOptionAmount,unlinkedOptionCount,unlinkedOptions:Array.from(unlinkedOptionGroups.values()).sort((a,b)=>b.amount-a.amount || b.lineCount-a.lineCount || a.optionName.localeCompare(b.optionName)),groups,categories:Array.from(categoryMap.values()).sort((a,b)=>b.amount-a.amount || (a.name || "").localeCompare(b.name || "")),items};
}
