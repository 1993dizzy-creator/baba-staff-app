import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { selectedLedgerMonth, ledgerMonthHref } = createRequire(import.meta.url)("../lib/ledger/month-query.ts") as typeof import("../lib/ledger/month-query");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");

test("valid month query wins; absent or malformed query uses current month", () => {
  assert.equal(selectedLedgerMonth("2026-08", "2026-09"), "2026-08");
  for (const value of [null, "2026-13", "2026-8", "invalid"]) {
    assert.equal(selectedLedgerMonth(value, "2026-09"), "2026-09");
  }
});

test("month navigation preserves other query parameters", () => {
  assert.equal(ledgerMonthHref("/admin/ledger/entries", "tab=book&month=2026-09", "2026-08"), "/admin/ledger/entries?tab=book&month=2026-08");
  assert.throws(() => ledgerMonthHref("/admin/ledger/entries", "tab=book", "2026-13"), /INVALID_MONTH/);
});

test("URL is the month source for refresh and browser history with a Suspense boundary", () => {
  assert.match(page, /useSearchParams\(\)/);
  assert.match(page, /const businessMonth = currentMonth\(\)/);
  assert.match(page, /selectedLedgerMonth\(requestedMonth, businessMonth\)/);
  assert.match(page, /router\.push\(ledgerMonthHref\(pathname, searchParams\.toString\(\), nextMonth\)/);
  assert.match(page, /<Suspense fallback=/);
  assert.doesNotMatch(page, /useState\(currentMonth\)/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
});

const { getLedgerTabs } = createRequire(import.meta.url)("../lib/navigation/ledger-tabs.ts") as typeof import("../lib/navigation/ledger-tabs");
const hrefs = (pathname: string, month?: string | null, lang: "ko" | "vi" = "ko") => getLedgerTabs(pathname, lang, month).map(tab => tab.href);

test("대시보드 ↔ 장부작성 tabs carry the selected month both ways, in Korean and Vietnamese", () => {
  for (const lang of ["ko", "vi"] as const) {
    // 대시보드 in August → 장부작성 August; 장부작성 in September → 대시보드 September.
    assert.deepEqual(hrefs("/admin/ledger", "2026-08", lang), ["/admin/ledger?month=2026-08", "/admin/ledger/entries?month=2026-08", "/admin/ledger/settings"]);
    assert.deepEqual(hrefs("/admin/ledger/entries", "2026-09", lang), ["/admin/ledger?month=2026-09", "/admin/ledger/entries?month=2026-09", "/admin/ledger/settings"]);
  }
  // A round trip keeps the last month chosen on either page (the URL is the only source).
  let month = "2026-08";
  for (const [pathname, next] of [["/admin/ledger", "2026-07"], ["/admin/ledger/entries", "2026-09"], ["/admin/ledger", "2026-10"]] as const) {
    const href = ledgerMonthHref(pathname, `month=${month}`, next);
    month = new URL(href, "http://x").searchParams.get("month")!;
    const other = hrefs(pathname, month).find(item => !item.startsWith(pathname + "?") && item !== "/admin/ledger/settings")!;
    assert.equal(new URL(other, "http://x").searchParams.get("month"), next);
  }
});

test("absent or malformed month keeps each page's default; detail deep-link parameters never follow a tab", () => {
  for (const month of [undefined, null, "", "2026-13", "2026-8", "2026-08&transactionId=1"]) {
    assert.deepEqual(hrefs("/admin/ledger/entries", month), ["/admin/ledger", "/admin/ledger/entries", "/admin/ledger/settings"], String(month));
  }
  // The sub-nav reads only `month` from the URL; transactionId/inventoryLogId/sourceKey are not passed on.
  const href = hrefs("/admin/ledger/entries", new URLSearchParams("month=2026-08&transactionId=2415&inventoryLogId=13849&sourceKey=inventory-log%3A13849").get("month"));
  assert.deepEqual(href.slice(0, 2), ["/admin/ledger?month=2026-08", "/admin/ledger/entries?month=2026-08"]);
  // Active tabs are unchanged by the month.
  assert.deepEqual(getLedgerTabs("/admin/ledger/entries", "ko", "2026-08").map(tab => tab.active), [false, true, false]);
  assert.deepEqual(getLedgerTabs("/admin/ledger", "vi", "2026-08").map(tab => [tab.label, tab.active]), [["Tổng quan", true], ["Ghi sổ", false], ["Cài đặt", false]]);
});

test("sub-nav reads the URL month inside a Suspense boundary; no extra state or storage", () => {
  const nav = readFileSync("components/LedgerSubNav.tsx", "utf8");
  assert.match(nav, /<Suspense fallback=\{<LedgerTabs \/>\}><LedgerTabsWithMonth \/><\/Suspense>/);
  assert.match(nav, /<LedgerTabs month=\{useSearchParams\(\)\.get\("month"\)\} \/>/);
  assert.doesNotMatch(nav, /localStorage|sessionStorage|useState/);
  const dashboard = readFileSync("app/(protected)/admin/ledger/page.tsx", "utf8");
  assert.match(dashboard, /selectedLedgerMonth\(searchParams\.get\("month"\), getBusinessDate\(\)\.slice\(0, 7\)\)/);
  assert.match(dashboard, /router\.push\(ledgerMonthHref\(pathname, searchParams\.toString\(\), nextMonth\), \{ scroll: false \}\)/);
});
