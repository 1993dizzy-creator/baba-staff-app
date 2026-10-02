import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { effectivePartnerEmoji, partnerTypeEmoji } from "../lib/partners/emoji.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { parsePartnerSubtypeCreateInput, parsePartnerSubtypeUpdateInput } from "../lib/partners/policy.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { manualExpenseCategoryEmoji } from "../lib/ledger/manual-entry-policy.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { chooseLedgerEntryEmoji } from "../lib/ledger/entry-display-emoji.ts";

const read = (path: string) => readFileSync(path, "utf8");
const migration = read("supabase/migrations/20260928225900_add_partner_subtype_emoji.sql");
const info = read("components/partners/PartnerSettingsPanel.tsx");
const manager = read("components/PartnerSubtypeManager.tsx");
const ledger = read("app/(protected)/admin/ledger/entries/page.tsx");
const ledgerApi = read("app/api/admin/ledger/route.ts");
const partnerServer = read("lib/partners/server.ts");
const categoryPolicy = read("lib/ledger/manual-entry-policy.ts");

test("partner type and requested subtype emoji are exact Unicode characters", () => {
  assert.equal(partnerTypeEmoji.alcohol, String.fromCodePoint(0x1f37e));
  assert.equal(partnerTypeEmoji.food, String.fromCodePoint(0x1f6d2));
  const requested = [
    ["alcohol_other", 0x1f37a], ["meat", 0x1f969], ["vegetable_fruit", 0x1f96c],
    ["dry_food", 0x1f991],
  ] as const;
  for (const [code, point] of requested) {
    assert.ok(migration.includes("code = '" + code + "'"));
    assert.ok(migration.includes("emoji is distinct from '" + String.fromCodePoint(point) + "'"));
  }
  assert.doesNotMatch(migration, /name_ko = '일반 주류'/);
  assert.match(migration, /general_food remains NULL/);
  assert.doesNotMatch(migration, /where code = 'general_food'/);
  assert.equal("🍺", String.fromCodePoint(0x1f37a));
  assert.equal(effectivePartnerEmoji("food", { emoji: "🥩" }), "🥩");
  assert.equal(effectivePartnerEmoji("food", { emoji: null }), "🛒");
  assert.equal(effectivePartnerEmoji("alcohol", { emoji: "" }), "🍾");
  assert.equal(effectivePartnerEmoji("food", { emoji: "🦑" }), "🦑");
});

test("optional subtype emoji is validated without changing subtype names, codes, or status", () => {
  const created = parsePartnerSubtypeCreateInput({ partnerType: "food", nameKo: "육류", nameVi: null, sortOrder: 10, emoji: "🥩" });
  assert.equal(created?.emoji, "🥩");
  assert.equal(parsePartnerSubtypeCreateInput({ partnerType: "food", nameKo: "종합 식자재", nameVi: null, sortOrder: 75, emoji: "" })?.emoji, null);
  assert.equal(parsePartnerSubtypeUpdateInput({ nameKo: "육류", nameVi: null, sortOrder: 10, isActive: true, emoji: "🥩" })?.emoji, "🥩");
  assert.equal(parsePartnerSubtypeUpdateInput({ nameKo: "육류", nameVi: null, sortOrder: 10, isActive: false, emoji: null })?.isActive, false);
  assert.equal(parsePartnerSubtypeUpdateInput({ nameKo: "육류", nameVi: null, sortOrder: 10, isActive: false })?.emoji, undefined);
  assert.equal(parsePartnerSubtypeCreateInput({ partnerType: "food", nameKo: "육류", nameVi: null, sortOrder: 10, emoji: "not emoji" }), null);
  assert.match(manager, /emoji: emoji \|\| null/);
  assert.match(partnerServer, /name_ko,name_vi,emoji,sort_order,is_active/);
});

test("partner info and Ledger authoring use one effective partner emoji source", () => {
  assert.match(info, /partnerTypeEmoji\[group\.type\]/);
  assert.match(info, /effectivePartnerEmoji\(group\.type, sub\.subtype\)/);
  assert.match(info, /effectivePartnerEmoji\(partner\.partnerType, partner\.partnerSubtype\)/);
  assert.match(manager, /effectivePartnerEmoji\(subtype\.partnerType, subtype\)/);
  assert.match(ledgerApi, /emoji: effectivePartnerEmoji\(partner\.partner_type as PartnerType, partnerSubtype\)/);
  assert.match(ledger, /\{partner\.emoji\} \{partner\.name\}/);
  assert.match(ledger, /partnerByLedgerParty\.get\(entry\.partyId\)/);
  assert.match(ledger, /chooseLedgerEntryEmoji\(partner\.emoji, entryCategoryEmoji\(entry\)\)/);
});

test("Ledger partner identity overrides only the display emoji; unlinked rows retain category emoji", () => {
  assert.equal(chooseLedgerEntryEmoji("🥩", manualExpenseCategoryEmoji("직원 식대")!), "🥩");
  assert.equal(chooseLedgerEntryEmoji(null, manualExpenseCategoryEmoji("직원 식대")!), "🍱");
  for (const [category, emoji] of [
    ["전기료", "⚡"], ["수도료", "💧"], ["가스비", "🔥"],
    ["세금", "🧾"], ["기타 비용", "📦"],
  ]) assert.equal(manualExpenseCategoryEmoji(category), emoji);
  assert.match(ledger, /return entryCategoryEmoji\(entry\)/);
  assert.doesNotMatch(ledger, /if \(partner\) return "📂"/);
  assert.match(categoryPolicy, /"결제·은행 수수료": \{ emoji: "🏦"/);
  assert.match(ledger, /className=\{styles\.entryLeft\}/);
  assert.match(ledger, /className=\{styles\.entryRight\}/);
});