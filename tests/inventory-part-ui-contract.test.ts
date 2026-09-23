import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const inventoryPage = read("app/(protected)/inventory/page.tsx");

test("/inventory imports the inventory-only part policy, not the common employee PART_VALUES", () => {
  assert.match(
    inventoryPage,
    /from "@\/lib\/inventory\/parts";/
  );
  assert.match(inventoryPage, /INVENTORY_PART_VALUES/);
  assert.match(inventoryPage, /type InventoryPartValue/);
  assert.match(inventoryPage, /isInventoryPart/);
  assert.match(inventoryPage, /resolveInventoryDefaultPart/);

  // 공통 PART_VALUES/PartValue(owner/cleaning 포함)를 재고 필터 허용값으로 다시 쓰지 않는다.
  assert.doesNotMatch(inventoryPage, /import\s*\{[^}]*\bPART_VALUES\b[^}]*\}\s*from\s*"@\/lib\/common\/parts"/);
  assert.doesNotMatch(inventoryPage, /\bPART_VALUES\.includes\(/);
  assert.doesNotMatch(inventoryPage, /:\s*PartValue\b/);
});

test("defaultPart/part/partFilter state are all typed as the inventory-only part", () => {
  assert.match(
    inventoryPage,
    /const defaultPart: InventoryPartValue = resolveInventoryDefaultPart\(\s*null,\s*currentUser\?\.part\s*\)/
  );
  assert.match(inventoryPage, /const \[part, setPart\] = useState<InventoryPartValue>\(defaultPart\)/);
  assert.match(
    inventoryPage,
    /const \[partFilter, setPartFilter\] = useState<InventoryPartValue>\(defaultPart\)/
  );
});

test("part filter buttons and item-registration part buttons are generated from the same INVENTORY_PART_VALUES-derived list", () => {
  assert.match(
    inventoryPage,
    /const inventoryPartOptions = INVENTORY_PART_VALUES\.map\(/
  );

  const occurrences = inventoryPage.match(/inventoryPartOptions\.map\(/g) ?? [];
  assert.equal(
    occurrences.length,
    2,
    "expected exactly 2 renders (filter buttons + registration form buttons) to map over inventoryPartOptions"
  );

  // 예전처럼 화면에는 없는데 내부 상태에는 남는 owner 버튼 배열이 다시 하드코딩되지 않는다.
  assert.doesNotMatch(
    inventoryPage,
    /\{\s*value:\s*"owner"/
  );
  assert.doesNotMatch(
    inventoryPage,
    /\{\s*value:\s*"cleaning"/
  );
});

test("localStorage saved part filter is validated and auto-healed against the inventory-only policy", () => {
  const effectStart = inventoryPage.indexOf(
    'localStorage.getItem("inventory_part_filter")'
  );
  assert.notEqual(effectStart, -1);

  const effectSection = inventoryPage.slice(effectStart, effectStart + 400);
  assert.match(effectSection, /resolveInventoryDefaultPart\(savedPartFilter, defaultPart\)/);

  // 저장값을 검증 없이 그대로 신뢰하던 예전 패턴(PART_VALUES.includes)이 남아있지 않다.
  assert.doesNotMatch(effectSection, /PART_VALUES\.includes/);

  // partFilter가 바뀔 때마다 localStorage에 다시 쓰는 write-back effect는 유지되어야
  // 자동 복구된 값이 저장소에도 반영된다.
  assert.match(
    inventoryPage,
    /localStorage\.setItem\("inventory_part_filter", partFilter\)/
  );
});

test("deep-link target item part and edit-entry part fall back through isInventoryPart, never a raw string cast", () => {
  assert.match(
    inventoryPage,
    /setPartFilter\(\s*isInventoryPart\(targetItem\.part\) \? targetItem\.part : defaultPart\s*\)/
  );
  assert.match(
    inventoryPage,
    /const nextPart: InventoryPartValue = isInventoryPart\(item\.part\)\s*\?\s*item\.part\s*:\s*defaultPart;/
  );
});

test("item registration requires part to actually be a valid InventoryPartValue, not just truthy", () => {
  assert.match(
    inventoryPage,
    /if \(!isInventoryPart\(part\) \|\| !normalizedItemName \|\| !quantity \|\| !normalizedUnit\) \{/
  );
});

test("low-stock counts per part are keyed off the inventory-only part list", () => {
  assert.match(inventoryPage, /INVENTORY_PART_VALUES\.reduce\(/);
  assert.match(inventoryPage, /Record<InventoryPartValue, number>/);
});

test("ordinary item editing no longer exposes or loads historical purchase corrections", () => {
  assert.doesNotMatch(inventoryPage, /기존 구매입고 수정 \(선택\)/);
  assert.doesNotMatch(inventoryPage, /purchaseCorrectionSources/);
  assert.doesNotMatch(inventoryPage, /correctionPurchaseLogId/);
  assert.doesNotMatch(inventoryPage, /purchaseCorrectionLoadError/);
  assert.doesNotMatch(inventoryPage, /correctionItemId/);
  assert.doesNotMatch(inventoryPage, /correction_of_inventory_log_id/);
});

test("ordinary edit-form reason modal keeps four reasons and gates purchase on a quantity increase", () => {
  assert.match(
    inventoryPage,
    /\["stock_check", "purchase", "service", "other"\] as const/
  );
  assert.match(
    inventoryPage,
    /reason === "purchase" &&[\s\S]*?Number\(editFormPendingSave\.payload\.quantity\) <=[\s\S]*?editFormPendingSave\.expectedQuantity/
  );
  assert.match(
    inventoryPage,
    /구매입고는 재고 수량이 증가할 때만 선택할 수 있습니다\./
  );
  assert.match(
    inventoryPage,
    /Chỉ có thể chọn Nhập mua khi số lượng tồn kho tăng\./
  );
});

test("new-item forms render local top-five similarity candidates directly below the name input", () => {
  assert.match(inventoryPage, /findSimilarInventoryItems\(itemName, inventoryList, 5\)/);
  assert.match(inventoryPage, /유사한 기존 품목/);
  assert.match(inventoryPage, /formatDecimalDisplay\(item\.quantity\)/);
  assert.match(inventoryPage, /item\.is_active === false/);
});

test("similar-item rows are compact single-line buttons with optional code text", () => {
  const candidateSection = inventoryPage.slice(
    inventoryPage.indexOf("similarInventoryCandidates.map"),
    inventoryPage.indexOf("similarInventoryCandidates.map") + 12000
  );

  assert.match(candidateSection, /<button\s+type="button"/);
  assert.match(candidateSection, /whiteSpace:\s*"nowrap"/);
  assert.match(candidateSection, /overflow:\s*"hidden"/);
  assert.match(candidateSection, /textOverflow:\s*"ellipsis"/);
  assert.match(candidateSection, /item\.code\?\.trim\(\) && \(/);
  assert.doesNotMatch(candidateSection, /\{c\.code\}:/);
  assert.doesNotMatch(candidateSection, /현재 재고|Tồn kho hiện tại/);
});

test("similar-item rows show part emoji, localized category and one localized name before optional code and stock", () => {
  const candidateSection = inventoryPage.slice(
    inventoryPage.indexOf("similarInventoryCandidates.map"),
    inventoryPage.indexOf("similarInventoryCandidates.map") + 12000
  );

  assert.match(
    candidateSection,
    /PART_META\[\s*isInventoryPart\(item\.part\) \? item\.part : "etc"\s*\]\.emoji/
  );
  assert.match(
    candidateSection,
    /lang === "ko"\s*\? item\.item_name \|\| item\.item_name_vi \|\| "-"\s*:\s*item\.item_name_vi \|\| item\.item_name \|\| "-"/
  );
  assert.match(candidateSection, /\{categoryLabel\}/);
  assert.match(candidateSection, /\{displayName\}/);
  assert.match(candidateSection, /item\.code\?\.trim\(\) && \(/);
  assert.match(candidateSection, /\{formatDecimalDisplay\(item\.quantity\)\} \{item\.unit \|\| "-"\}/);
  assert.doesNotMatch(candidateSection, /partLabel/);
  assert.doesNotMatch(candidateSection, /item\.item_name \|\| "-"\}\s*\/\s*\{item\.item_name_vi/);
});

test("similar-item category has its own 84px ellipsis while name, code and stock keep their flex priorities", () => {
  const candidateSection = inventoryPage.slice(
    inventoryPage.indexOf("similarInventoryCandidates.map"),
    inventoryPage.indexOf("similarInventoryCandidates.map") + 12000
  );

  assert.match(candidateSection, /flex:\s*"0 0 18px"/);
  assert.match(
    candidateSection,
    /title=\{categoryLabel\}[\s\S]*?maxWidth:\s*84[\s\S]*?overflow:\s*"hidden"[\s\S]*?textOverflow:\s*"ellipsis"[\s\S]*?whiteSpace:\s*"nowrap"/
  );
  assert.match(
    candidateSection,
    /flex:\s*1,[\s\S]*?minWidth:\s*0,[\s\S]*?\{displayName\}/
  );
  assert.match(candidateSection, /item\.code\?\.trim\(\) && \([\s\S]*?flexShrink:\s*0/);
  assert.match(
    candidateSection,
    /<span style=\{\{ flexShrink: 0 \}\}>\s*\{formatDecimalDisplay\(item\.quantity\)\}/
  );
});

test("clicking a similar-item row reuses handleEdit and enters edit state for that item id", () => {
  assert.match(inventoryPage, /onClick=\{\(\) => handleEdit\(item\)\}/);

  const handleEditSection = inventoryPage.slice(
    inventoryPage.indexOf("const handleEdit = (item: InventoryItem)"),
    inventoryPage.indexOf("const handleSubmit = async")
  );
  assert.match(handleEditSection, /setEditingId\(item\.id\)/);
  assert.match(handleEditSection, /formRef\.current\?\.scrollIntoView/);
});

test("similarity candidates are hidden while editing an existing item", () => {
  assert.match(
    inventoryPage,
    /editingId === null\s*\? findSimilarInventoryItems\(itemName, inventoryList, 5\)\s*:\s*\[\]/
  );
});

test("duplicate UI accepts legacy and current error codes and explains inactive duplicates", () => {
  assert.match(inventoryPage, /inventory_item_duplicate_name_vi/);
  assert.match(inventoryPage, /inventory_item_duplicate_name_code/);
  assert.match(
    inventoryPage,
    /동일한 품목이 비활성 상태로 등록되어 있습니다\. 기존 품목을 확인해주세요\./
  );
});
