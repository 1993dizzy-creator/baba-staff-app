import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const spinner = readFileSync("components/inventory/InventoryLoadingCard.tsx", "utf8");

test("ledger entries loading states use the shared spinner with their KO/VI text", () => {
  assert.match(page, /import InventoryLoadingCard from "@\/components\/inventory\/InventoryLoadingCard";/);
  for (const label of [
    `label={vi ? "Đang tải sổ..." : "장부를 불러오는 중입니다."}`,
    `label={vi ? "Đang tải công nợ…" : "미납금을 불러오는 중입니다…"}`,
    `label={vi?"Đang tải tình hình thẻ…":"카드 정산 현황을 불러오는 중입니다…"}`,
    `label={vi?"Đang tải tình hình vốn góp…":"투자금 현황을 불러오는 중입니다…"}`,
    `label={vi?"Đang tải…":"불러오는 중…"}`,
    `label={vi?"Đang tải chi tiết công nợ…":"미납 상세를 불러오는 중…"}`,
  ]) assert.ok(page.includes(label), label);
  // Text-only placeholders are gone (a <select> option keeps its text; it cannot hold a spinner).
  assert.doesNotMatch(page, /<p[^>]*>\{vi ?\? ?"Đang tải/);
  assert.doesNotMatch(page, /<main>장부 불러오는 중\.\.\.<\/main>/);
  assert.match(page, /<Suspense fallback=\{<LedgerEntriesFallback \/>\}>/);
  // The spinner keeps its status role; the label overrides the common text only when given.
  assert.match(spinner, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(spinner, /\{label \?\? commonText\[lang\]\.loading\}/);
  assert.match(spinner, /style=\{inline \? \{ minHeight, marginBottom \} : \{ \.\.\.ui\.card, minHeight, marginBottom \}\}/);
});

test("errors and empty results stay separate from loading", () => {
  // 미납금: error replaces the spinner rather than sharing its element.
  assert.match(page, /\{!payablesReady \? \(payablesFailed \? <p role="alert" className=\{styles\.error\}>/);
  // 미납금 상세: "no payables" only after the detail has loaded.
  assert.match(page, /\{!detail&&!error\?<InventoryLoadingCard /);
  assert.match(page, /\{detail&&mode!=="history"&&!groups\.length&&!error\?<p className=\{styles\.payableEmpty\}>/);
});

test("reopening the card settlement section does not refetch until the ledger reloads", () => {
  assert.match(page, /const key = `\$\{requestedMonth\}:\$\{investmentsVersion\}`;\n    if \(cardSettlementLoadedKeyRef\.current === key\) return;/);
  assert.match(page, /cardSettlementLoadedKeyRef\.current = key;\n        setCardSettlement\(/);
  assert.match(page, /\}, \[cardSettlementExpanded,month,vi,investmentsVersion\]\);/);
});
