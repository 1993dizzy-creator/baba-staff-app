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
