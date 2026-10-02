import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ledgerSettingsText } from "../lib/ledger/settings-text.ts";
import { RESERVE_ENTRY_TYPE_KEYS, reserveEntryTypeLabel, reserveEntryTypeText } from "../lib/ledger/reserve-text.ts";
import { ledgerSettingsTabText, partnerSettingsText } from "../lib/partners/settings-view.ts";
import { shortLedgerAccountName } from "../lib/ledger/entry-display-account.ts";

const HANGUL = /[가-힣]/;
const page = readFileSync("app/(protected)/admin/ledger/settings/page.tsx", "utf8");
const entriesPage = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");

// Every string a value can render: plain strings, nested records and sample calls.
function renderedValues(copy: Record<string, unknown>) {
  return Object.entries(copy).flatMap(([key, value]) => {
    if (typeof value === "function") return [[key, String((value as (...args: unknown[]) => unknown)("3", "2026-09", "1.000 ₫"))]];
    if (value && typeof value === "object") return Object.entries(value).map(([inner, text]) => [`${key}.${inner}`, String(text)]);
    return [[key, String(value)]];
  });
}

test("KO and VI settings copy have the same keys and VI renders no Korean", () => {
  const ko = ledgerSettingsText.ko as unknown as Record<string, unknown>;
  const vi = ledgerSettingsText.vi as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(vi).sort(), Object.keys(ko).sort());
  for (const key of ["entryDescriptions", "scheduleStatus"]) {
    assert.deepEqual(Object.keys(vi[key] as object).sort(), Object.keys(ko[key] as object).sort(), key);
  }
  for (const [key, text] of renderedValues(vi)) {
    assert.ok(text.trim().length > 0, key);
    assert.doesNotMatch(text, HANGUL, key);
  }
  assert.equal(ledgerSettingsText.vi.dateLocale, "vi-VN");
  assert.equal(ledgerSettingsText.ko.dateLocale, "ko-KR");
});

test("settings page renders no hard-coded Korean outside the KO account-name overrides", () => {
  const code = page
    .replace(/\/\/.*$/gm, "")
    .replace(/const ACCOUNT_UI[\s\S]*?\n\};\n/, "");
  const leftovers = code.split("\n").filter(line => HANGUL.test(line));
  assert.deepEqual(leftovers, []);
  assert.match(page, /const copy = ledgerSettingsText\[lang\];/);
  assert.match(page, /<ReservePlanCard key=\{row\.id\} row=\{row\} month=\{month\} lang=\{lang\} copy=\{copy\}/);
  assert.match(page, /window\.prompt\(copy\.skipReasonPrompt\)/);
  assert.match(page, /formatReserveDateTime\(entry\.occurred_at, copy\.dateLocale\)/);
  // Account labels: Korean keeps the stored display_name; VI uses display labels and the ledger's short-name helper.
  assert.match(page, /\{accountUi\?\.name\[lang\] \?\? row\.display_name\}/);
  assert.match(page, /shortLedgerAccountName\(accountUi\?\.ledgerName \?\? row\.display_name, lang\)/);
  assert.equal(shortLedgerAccountName("매장 현금", "vi"), "Tiền mặt");
  assert.equal(shortLedgerAccountName("BABA 법인계좌", "vi"), "Công ty");
});

test("reserve entry-type labels are one shared mapping, reused by 장부작성 and 장부설정", () => {
  assert.deepEqual(RESERVE_ENTRY_TYPE_KEYS, ["allocate", "release", "consume", "adjustment"]);
  assert.deepEqual(RESERVE_ENTRY_TYPE_KEYS.map(key => reserveEntryTypeLabel(key, "ko")), ["적립", "해제", "사용", "조정"]);
  assert.deepEqual(RESERVE_ENTRY_TYPE_KEYS.map(key => reserveEntryTypeLabel(key, "vi")), ["Trích lập", "Giải phóng", "Sử dụng", "Điều chỉnh"]);
  assert.equal(reserveEntryTypeText("legacy_type", "vi"), "legacy_type");
  for (const source of [page, entriesPage]) assert.match(source, /from "@\/lib\/ledger\/reserve-text"/);
  for (const source of [page, entriesPage]) assert.doesNotMatch(source, /allocate: "Trích lập"|allocate: "적립"/);
});

test("API values and enums are untouched; only labels are translated", () => {
  // The entry type sent to the API is still the enum key.
  assert.match(page, /addEntry\(row\.id, \{ entryType, amount: Number\(entryAmount\)/);
  assert.match(page, /useState<ReserveEntryTypeKey>\("allocate"\)/);
  assert.match(page, /resolveSchedule\(pending\.id, \{ action: "confirm" \}\)/);
  assert.match(page, /resolveSchedule\(pending\.id, \{ action: "skip", reason: reason\.trim\(\) \}\)/);
  assert.match(page, /\{copy\.scheduleStatus\[schedule\.status\] \?\? schedule\.status\}/);
  assert.match(page, /note: "Owner settlement policy"/);
  assert.match(page, /mutate\("\/api\/admin\/ledger\/owners", \{ action: "participants"/);
});

test("tab, accordion and partner labels keep their existing KO/VI mappings", () => {
  assert.deepEqual([ledgerSettingsTabText.vi.fundAccounts, ledgerSettingsTabText.vi.ownerSettlement], ["Tài khoản quỹ", "Quyết toán chủ"]);
  for (const text of Object.values(partnerSettingsText.vi)) assert.doesNotMatch(String(text), HANGUL);
  assert.equal(partnerSettingsText.ko.pending, "등록대기");
});
