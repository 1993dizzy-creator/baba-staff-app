import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("closed keepings expose reactivation but not the information edit action", () => {
  const detail = source("components/bar/keeping/KeepingDetail.tsx");
  assert.match(detail, /item\.status === "closed" && \(capabilities\.reactivate \|\| capabilities\.delete\)/);
  assert.match(detail, /capabilities\.delete \? <button ref=\{deleteRef\}/);
  assert.doesNotMatch(detail, /capabilities\.editClosed \? <button onClick=\{\(\) => setAction\("update"\)\}/);
  assert.doesNotMatch(detail, /<span \/>\}\{capabilities\.editClosed/);
});

test("closed keeping mutations are limited to reactivation and photo replacement", () => {
  const route = source("app/api/bar/keepings/[id]/actions/route.ts");
  assert.match(route, /current\.status==="closed"&&!new Set\(\["replace_photo","reactivate"\]\)\.has\(action\)\)return conflict/);
  assert.match(route, /action==="replace_photo"&&!canEditClosedBarKeeping\(actor\)\)return forbidden/);
});

test("reactivation reuses the keeping form sections and the sheet keeps mobile-safe scrolling", () => {
  const modal = source("components/bar/keeping/KeepingActionModal.tsx");
  const ui = source("components/bar/keeping/KeepingUi.tsx");
  const image = source("components/bar/keeping/KeepingImageInput.tsx");

  assert.match(modal, /BarSection title=\{nt\.storageSection\} icon="📦" first/);
  assert.match(modal, /BarSection title=\{t\.photo\} icon="📷"/);
  assert.match(modal, /KeepingRegistrationPercentSelector label=\{t\.remaining\} directInputLabel=\{nt\.directPercent\}/);
  assert.doesNotMatch(modal, /KeepingPercentSelector label=\{t\.remaining\}/);
  assert.match(modal, /reactivateZonePercentStyle: React\.CSSProperties = \{ minWidth: 0, display: "grid", gap: 22 \}/);
  assert.match(modal, /zoneCode: item\.zoneCode/);
  assert.match(modal, /KeepingImageInput[^>]*currentUrl=\{item\.imageUrl\}[^>]*hideLabel/);
  assert.match(image, /hideLabel \? null/);
  assert.match(ui, /min\(92vh,92dvh,820px\)/);
  assert.match(ui, /\{number\}%<\/button>/);
  assert.match(ui, /gridTemplateColumns:"repeat\(5,minmax\(0,1fr\)\)"/);
  assert.match(ui, /style=\{\{\.\.\.keepingInputStyle,width:"100%",paddingRight:34/);
  assert.match(ui, /overscrollBehavior:"contain"/);
  assert.match(ui, /scrollPaddingBottom:88/);
  assert.match(ui, /env\(safe-area-inset-bottom\)/);
});

test("logs default to zone and tab changes discard detailed filters", () => {
  const page = source("app/(protected)/bar/logs/page.tsx");
  assert.match(page, /searchParams\.get\("entityType"\) === "keeping" \? "keeping" : "zone"/);
  assert.match(page, /const next = new URLSearchParams\(\)/);
  assert.match(page, /next\.set\("entityType", nextType\)/);
  assert.match(page, /<BarLogEntry key=\{log\.id\}/);
});

test("log notes are formatted separately and zone move reasons stay hidden", () => {
  const formatter = source("lib/bar/log-format.ts");
  const card = source("components/bar/BarLogEntry.tsx");
  assert.match(formatter, /export function getBarLogNote/);
  assert.match(formatter, /log\.actionType==="keeping_updated"/);
  assert.match(formatter, /keeping_remaining_corrected"\|\|log\.actionType==="keeping_reactivated"\?"reason":"close_note"/);
  assert.match(formatter, /if\(!\["keeping_used","keeping_remaining_corrected","keeping_closed","keeping_reactivated"\]/);
  assert.match(card, /const note = getBarLogNote\(log\)/);
  assert.match(card, /formatBarLogSummary\(log, lang, \{ includeTarget: false \}\)/);
  assert.match(card, /whiteSpace: "pre-wrap"/);
});

test("BAR log cards keep compact metadata in the header and reuse one layout", () => {
  const card = source("components/bar/BarLogEntry.tsx");
  const zoneRecent = source("components/bar/BarZoneRecentLogs.tsx");
  const keepingRecent = source("components/bar/keeping/KeepingRecentLogs.tsx");
  const formatter = source("lib/bar/log-format.ts");

  assert.match(card, /gridTemplateColumns: "minmax\(0, 1fr\) auto"/);
  assert.match(card, /whiteSpace: "nowrap"/);
  assert.match(card, /textOverflow: "ellipsis"/);
  assert.match(card, /formatBarDateTime\(log\.createdAt, lang, true\)/);
  assert.match(card, /<time dateTime=\{log\.createdAt\}/);
  assert.match(card, /<strong[^>]*>\{lang === "vi" \? "Ghi chú" : "비고"\}<\/strong> · \{note\}/);
  assert.match(formatter, /if\(compact\)return lang==="vi"\?`\$\{day\}\/\$\{month\} \$\{time\}`:`\$\{month\}\/\$\{day\} \$\{time\}`/);
  assert.match(zoneRecent, /<BarLogEntry key=\{log\.id\} log=\{log\} lang=\{lang\} compact \/>/);
  assert.match(keepingRecent, /<BarLogEntry key=\{log\.id\} log=\{log\} lang=\{lang\} compact \/>/);
});
