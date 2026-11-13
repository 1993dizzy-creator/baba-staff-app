import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const trap = read("components/payroll/useModalFocusTrap.ts");
const modal = read("components/payroll/PayrollModal.tsx");
const page = read("app/(protected)/admin/users/page.tsx");

test("focus trap: only the top modal cycles Tab; a native modal <dialog> is the top while open; no body-wide inert", () => {
  assert.match(trap, /const native = openNativeDialog\(\);\n\s+if \(native\) return native;/);
  assert.match(trap, /if \(!stack\.some\(\(other\) => other !== candidate && candidate\.contains\(other\)\)\) return candidate;/);
  assert.match(trap, /else if \(event\.shiftKey && current === first\) \{\n\s+event\.preventDefault\(\);\n\s+last\.focus\(\);/);
  assert.match(trap, /else if \(!event\.shiftKey && current === last\) \{\n\s+event\.preventDefault\(\);\n\s+first\.focus\(\);/);
  // focus that escapes to the background is pulled back into the top modal
  assert.match(trap, /if \(!top \|\| !\(target instanceof Node\) \|\| top\.contains\(target\)\) return;\n\s+focusInto\(top\);/);
  assert.doesNotMatch(trap, /\.inert\s*=|setAttribute\("inert"/);
});

test("focus trap: restores the opener on close and releases document listeners with the last modal", () => {
  assert.match(trap, /const opener = document\.activeElement instanceof HTMLElement \? document\.activeElement : null;/);
  assert.match(trap, /if \(opener\?\.isConnected && \(!next \|\| next\.contains\(opener\)\)\) opener\.focus\(\);\n\s+else if \(next\) focusInto\(next\);/);
  assert.match(trap, /if \(!stack\.length\) \{\n\s+document\.removeEventListener\("keydown", onKeyDown, true\);\n\s+document\.removeEventListener\("focusin", onFocusIn, true\);/);
});

test("PayrollModal and the payroll sheet use the trap; Escape only closes the top modal", () => {
  assert.match(modal, /const sectionRef=useRef<HTMLElement>\(null\);useModalFocusTrap\(sectionRef\);const closeRef/);
  assert.match(modal, /if\(e\.key==="Escape"&&isTopModal\(sectionRef\.current\)\)onCloseRef\.current\(\)/);
  assert.match(modal, /<section ref=\{sectionRef\} role="dialog" aria-modal="true"/);
  const sheet = page.slice(page.indexOf("function PayrollSheet("), page.indexOf("const SHEET_TITLES"));
  // registered before the close button takes focus so the opener (관리) is remembered
  assert.ok(sheet.indexOf("useModalFocusTrap(sheetRef);") < sheet.indexOf("closeRef.current?.focus();"));
  assert.match(sheet, /if \(!isTopModal\(sheetRef\.current\)\) return;\n\s+onCloseRef\.current\(\);/);
});

test("level settings dialog returns focus to the button that opened it (detail card or payroll sheet) after it closes", () => {
  assert.match(page, /const openLevelModal = \(event: \{ currentTarget: HTMLElement \}\) => \{ levelOpenerRef\.current = event\.currentTarget; setLevelModalOpen\(true\); \};/);
  assert.match(page, /window\.setTimeout\(\(\) => \{ const opener = levelOpenerRef\.current; \(opener\?\.isConnected \? opener : levelButtonRef\.current\)\?\.focus\(\); \}, 0\);/);
  // 2026-11 switch restore: the level dialog opens from the 📈 tile's name or its switch; either one is the opener.
  assert.match(page, /infoButtonRef=\{levelButtonRef\}\n[^\n]*\n\s+onSwitch=\{openLevelModal\}\n\s+onDetail=\{openLevelModal\}/);
  // the level <dialog> also traps Tab when opened directly from the detail (no payroll sheet)
  assert.match(page, /const dialogRef = useRef<HTMLDialogElement>\(null\);\n[^\n]*\n\s+useModalFocusTrap\(dialogRef\);/);
  assert.match(page, /onCancel=\{\(\) => \{ setLevelModalOpen\(false\); focusLevelOpener\(\); \}\}/);
});
