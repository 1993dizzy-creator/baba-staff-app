import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { groupPartnersByType, PARTNER_TYPE_GROUP_ORDER } from "../lib/partners/policy.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const infoPage = read("app/(protected)/admin/partners/info/page.tsx");
const styles = read("app/(protected)/admin/partners/partners.module.css");
const text = read("lib/partners/text.ts");

const partners = [
  { id: 1, name: "Thiên Vương", partnerType: "food" as const, isActive: true, dominantInventoryGroup: "other" },
  { id: 2, name: "Dabaco", partnerType: "food" as const, isActive: true, dominantInventoryGroup: "food" },
  { id: 3, name: "Phương", partnerType: "alcohol" as const, isActive: true, dominantInventoryGroup: "other" },
  { id: 4, name: "Old Vendor", partnerType: "food" as const, isActive: false, dominantInventoryGroup: "other" },
];

test("partner info groups only by partnerType and ignores dominant inventory group", () => {
  const groups = groupPartnersByType(partners, true, "vi");
  assert.deepEqual(groups.map(group => group.type), ["alcohol", "food"]);
  assert.deepEqual(groups.find(group => group.type === "food")?.partners.map(partner => partner.name), ["Dabaco", "Thiên Vương"]);
  assert.equal(groups.find(group => group.type === "other"), undefined);
});

test("active and inactive tabs produce separate non-empty groups", () => {
  assert.deepEqual(groupPartnersByType(partners, true, "ko").flatMap(group => group.partners.map(partner => partner.name)), ["Phương", "Dabaco", "Thiên Vương"]);
  assert.deepEqual(groupPartnersByType(partners, false, "ko").flatMap(group => group.partners.map(partner => partner.name)), ["Old Vendor"]);
});

test("partner groups follow the canonical partner type order", () => {
  assert.deepEqual(PARTNER_TYPE_GROUP_ORDER, [
    "alcohol",
    "beverage",
    "food",
    "consumable",
    "equipment",
    "service",
    "rent",
    "other",
  ]);
});

test("info page reuses localized partner type labels and removes row category badges", () => {
  assert.match(infoPage, /groupPartnersByType\(partners, filter === "active", lang\)/);
  assert.match(infoPage, /partnerTypeLabels\[group\.type\]\[lang\]/);
  assert.doesNotMatch(infoPage, /dominantInventoryGroup|styles\.groupBadge/);
  assert.match(infoPage, /formatPartnerPaymentPolicy\(partner, lang\)/);
  assert.match(infoPage, /formatInventoryItemCount\(partner\.inventoryCount, partner\.activeInventoryCount, lang\)/);
  assert.match(text, /food: \{ ko: "식자재", vi: "Thực phẩm" \}/);
});

test("group headers and compact info rows have dedicated responsive styles", () => {
  assert.match(styles, /\.partnerGroupHeader\{[\s\S]*border-left:4px solid[\s\S]*border-radius:9px/);
  assert.match(styles, /\.partnerGroupCount\{/);
  assert.match(styles, /\.partnerInfoRow\{grid-template-columns:minmax\(0,1fr\) auto auto\}/);
});
