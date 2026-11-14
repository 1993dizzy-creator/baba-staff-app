import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/users/page.tsx");
const text = read("lib/text/admin-users.ts");

test("part groups collapse: owner/inactive closed by default, user choice kept apart from the list data, returning employee's group opened", () => {
  assert.match(page, /const isGroupOpen = \(key: UserGroupKey\) => groupOpenOverrides\[key\] \?\? \(key === focusGroupKey \|\| \(key !== "owner" && key !== "inactive"\)\);/);
  // overrides live in their own state, so a list refetch or a save does not reset them
  assert.match(page, /const \[groupOpenOverrides, setGroupOpenOverrides\] = useState<Partial<Record<UserGroupKey, boolean>>>\(\{\}\);/);
  assert.match(page, /const focused = users\.find\(\(user\) => String\(user\.id\) === initialFocus\.userId\);\n\s+return focused \? getActiveUserGroup\(focused\) : null;/);
  // the whole header is a button with aria-expanded / aria-controls; count and chevron kept
  assert.match(page, /<button\n\s+type="button"\n\s+aria-expanded=\{open\}\n\s+aria-controls=\{listId\}\n\s+onClick=\{onToggle\}/);
  assert.match(page, /<span style=\{styles\.groupCount\}>\{users\.length\}<\/span>\n\s+<span aria-hidden="true" style=\{\{ \.\.\.styles\.groupChevron/);
  // collapsed cards stay mounted (hidden), so an open detail keeps its draft
  assert.match(page, /<div id=\{listId\} hidden=\{!open\} style=\{open \? styles\.groupList : \{ \.\.\.styles\.groupList, display: "none" \}\}>/);
  // grouping and sorting are unchanged
  assert.match(page, /const groupOrder = \["owner", "kitchen", "hall", "bar", "cleaning", "etc", "inactive"\] as const;/);
  assert.match(page, /users\.filter\(\(user\) => getActiveUserGroup\(user\) === groupKey\)/);
});

test("detail: work·pay holds work times, 💰 contract, 🎁 benefits (level first) and the payroll exception in that order", () => {
  const start = page.indexOf('<CollapsibleSection tone="workPay" emoji="⏰" title={text.workPayInfo} open={workOpen} onToggle={toggleWork}>');
  const end = page.indexOf('<SectionTitle emoji="🔐">{text.appAccess}</SectionTitle>');
  const work = page.slice(start, end);
  const order = ["<PayrollContractStatus", '<SubsectionTitle emoji="🎁">{text.benefits}</SubsectionTitle>', 'emoji="📈"', "BENEFIT_ROWS.map", "{text.payrollException}</SubsectionTitle>"].map((needle) => work.indexOf(needle));
  assert.ok(start > 0 && order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1])), String(order));
  // the contract is a subsection with its own 계약 관리 entry (no switch)
  assert.match(page, /return <div style=\{styles\.subsection\}>\n\s+<div style=\{styles\.sectionHead\}>\n\s+<SubsectionTitle emoji="💰">\{text\.payrollContract\}<\/SubsectionTitle>/);
});

test("app access explains when login is blocked by the employment status (server needs is_active and app_login_enabled)", () => {
  assert.match(read("lib/auth/server-auth.ts"), /data\.is_active !== true \|\| data\.app_login_enabled !== true/);
  assert.match(page, /\{user\.termination_date \|\| user\.is_active === false \? <span style=\{styles\.fieldNotice\}>\{user\.termination_date \? text\.appLoginBlockedTerminated : text\.appLoginBlockedInactive\}<\/span> : null\}/);
  for (const key of ["appLoginBlockedInactive", "appLoginBlockedTerminated", "cancelTerminationConfirm", "reactivate", "reactivatePending"]) {
    assert.equal((text.match(new RegExp(`\\b${key}:`, "g")) ?? []).length, 2, key);
  }
  assert.doesNotMatch(text, /employeeActiveToggle|employeeActiveHelp|advancedSettings/);
});

test("rehire stays available for terminated, inactive employees inside the basic card", () => {
  const basic = page.slice(page.indexOf('<CollapsibleSection tone="basic" emoji="🪪" title={text.basicInfo} open={basicOpen} onToggle={() => setBasicOpen((current) => !current)}>'), page.indexOf('<CollapsibleSection tone="workPay" emoji="⏰" title={text.workPayInfo} open={workOpen} onToggle={toggleWork}>'));
  assert.ok(basic.length > 0);
  assert.match(basic, /\{user\.is_active === false && user\.termination_date \? \(\n\s+<div style=\{styles\.rehireBox\}>/);
  assert.match(basic, /onClick=\{\(\)=>onRehire\(user,rehireDate,rehireLevelEnabled,rehireLevelEnabled\?true:null\)\}/);
});
