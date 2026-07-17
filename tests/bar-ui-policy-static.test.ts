import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("closed keepings expose reactivation but not the information edit action", () => {
  const detail = source("components/bar/keeping/KeepingDetail.tsx");
  assert.match(detail, /item\.status === "closed" && capabilities\.reactivate/);
  assert.doesNotMatch(detail, /capabilities\.editClosed \? <button onClick=\{\(\) => setAction\("update"\)\}/);
  assert.doesNotMatch(detail, /<span \/>\}\{capabilities\.editClosed/);
});

test("closed keeping mutations are limited to reactivation and photo replacement", () => {
  const route = source("app/api/bar/keepings/[id]/actions/route.ts");
  assert.match(route, /current\.status==="closed"&&!new Set\(\["replace_photo","reactivate"\]\)\.has\(action\)\)return conflict/);
  assert.match(route, /action==="replace_photo"&&!canEditClosedBarKeeping\(actor\)\)return forbidden/);
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
  assert.match(formatter, /keeping_remaining_corrected"\?"reason":"close_note"/);
  assert.match(formatter, /if\(!\["keeping_used","keeping_remaining_corrected","keeping_closed"\]/);
  assert.match(card, /const note = getBarLogNote\(log\)/);
  assert.match(card, /formatBarLogSummary\(log, lang, \{ includeTarget: false \}\)/);
  assert.match(card, /whiteSpace: "pre-wrap"/);
});
