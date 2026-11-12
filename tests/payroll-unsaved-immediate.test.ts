import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { payrollLeaveMessage } from "../components/payroll/payrollUnsaved.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const report = read("components/payroll/useReportDirty.ts");
const panel = read("components/payroll/EmployeePayrollSettingsPanel.tsx");
const unsaved = read("components/payroll/payrollUnsaved.ts");
const users = read("app/(protected)/admin/users/page.tsx");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");

test("unsaved state reaches the leave checks in the input's own commit, not after passive effects or extra renders", () => {
  // card → panel: layout effect (same commit as the input's render)
  assert.match(report, /useLayoutEffect\(\(\) => \{ reportRef\.current\?\.\(dirty\); \}, \[dirty\]\);/);
  // panel → page: the reporter writes a ref and calls the page right away (no setState hop in the panel)
  assert.doesNotMatch(panel, /setCardDirty|useState<Record<"insurance"/);
  assert.match(panel, /onUnsavedChangeRef\.current\?\.\(next\);/);
  // page: leave checks read the ref, not the rendered state
  assert.match(users, /unsaved: \(\) => payrollUnsavedRef\.current,\n\s+leaveMessage: latestPayrollLeave,/);
  assert.match(settings, /const message = latestLeaveMessage\(\);/);
  // 지연·디바운스로 가리지 않는다(레벨 설정 창 포커스 복원용 타이머는 미저장 판정과 무관하므로 대상 밖).
  assert.doesNotMatch(panel + report + unsaved, /setTimeout\(|debounce/);
});

test("the reload/menu guard stays installed with a latest-message getter and only blocks when something is unsaved", () => {
  assert.match(unsaved, /const active = message !== null \|\| latestMessage !== undefined;/);
  assert.match(unsaved, /if \(!currentMessage\(\)\) return;\n\s+event\.preventDefault\(\);/);
  assert.match(unsaved, /const current = currentMessage\(\);\n\s+if \(!current \|\|/);
});

test("pending verification keeps its own message, separate from unsaved input", () => {
  const input = payrollLeaveMessage({ input: true, pendingVerification: false }, false);
  const pending = payrollLeaveMessage({ input: false, pendingVerification: true }, false);
  assert.ok(input && pending && input !== pending);
  assert.equal(payrollLeaveMessage({ input: false, pendingVerification: false }, false), null);
});
