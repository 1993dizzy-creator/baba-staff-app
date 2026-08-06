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
