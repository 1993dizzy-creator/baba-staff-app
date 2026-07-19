import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const route = fs.readFileSync(path.join(root, "app/api/admin/store-settings/pos-shadow/route.ts"), "utf8");
const server = fs.readFileSync(path.join(root, "lib/store-settings/pos-shadow-server.ts"), "utf8");
const auth = fs.readFileSync(path.join(root, "lib/store-settings/server.ts"), "utf8");
const ui = fs.readFileSync(path.join(root, "components/StorePosShadowPanel.tsx"), "utf8");

test("shadow route revalidates the signed actor and permits only owner/master capability", () => {
  assert.match(route, /getStoreSettingsActor\(\)/);
  assert.match(route, /canMutateStoreSettings\(auth\.actor\)/);
  assert.match(auth, /readServerSession\(\)/);
  assert.match(auth, /\.eq\("id", session\.uid\)/);
  assert.match(auth, /data\.is_active !== true/);
  assert.match(auth, /\["owner", "master"\]\.includes\(actor\.role\)/);
});

test("shadow implementation is read-only and does not resurrect legacy staging", () => {
  const implementation = `${route}\n${server}`;
  for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete(", "sync-to-sales", "pos_processed_invoice_lines", "inventory_deductions", "inventory_logs"]) {
    assert.equal(implementation.includes(forbidden), false, forbidden);
  }
  assert.match(server, /loginCukcuk\(\)/);
  assert.match(server, /store_business_date_for_timestamp_v1/);
  assert.match(server, /representativeByPureDate/);
});

test("request cannot override timezone, cutoff, or operating hours", () => {
  assert.match(route, /\["businessDate", "limit"\]/);
  assert.doesNotMatch(route, /body\.(timezone|cutoff|openTime|closeTime)/);
  assert.match(route, /MAX_LIMIT = 100/);
});

test("UI includes owner capability gate, bilingual copy, and loading/error states", () => {
  assert.match(ui, /capabilities\.posShadow/);
  assert.match(ui, /POS 연동 비교/);
  assert.match(ui, /So sánh kết nối POS/);
  assert.match(ui, /Đang kiểm tra/);
  assert.match(ui, /CUKCUK 조회 실패/);
  assert.match(ui, /aria-live="polite"/);
  assert.match(ui, /설정 기준 확인 완료/);
  assert.match(ui, /영업 진행 중 · 임시 결과/);
  assert.match(ui, /조회된 영수증 없음/);
  assert.match(ui, /Đang trong ca kinh doanh · Kết quả tạm thời/);
  assert.match(ui, /Sử dụng cài đặt mặc định/);
  assert.match(ui, /사용함/);
  assert.match(ui, /사용 안 함/);
  assert.match(ui, /formatPosShadowStoreDateTime\(result\.window\.legacy\.from/);
  assert.match(ui, /formatPosShadowStoreDateTime\(result\.window\.configured\.from/);
});
