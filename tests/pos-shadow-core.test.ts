import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript runner requires an explicit extension.
import { createFallbackBusinessTimeSnapshot } from "../lib/store-settings/business-time-adapter-core.ts";
// @ts-expect-error Node's direct TypeScript runner requires an explicit extension.
import { buildPosShadowResult, formatPosShadowStoreDateTime, type PosShadowObservation } from "../lib/store-settings/pos-shadow-core.ts";

const snapshot = createFallbackBusinessTimeSnapshot("2026-07-20");
const matching: PosShadowObservation = {
  timestamp: "2026-07-20T16:00:00+07:00",
  configuredPureBusinessDate: "2026-07-20",
  configuredDbBusinessDate: "2026-07-20",
  inLegacyRange: true,
  inConfiguredRange: true,
  status: "completed",
  optionLineCount: 1,
  parentLineCount: 1,
};

function result(overrides: Partial<Parameters<typeof buildPosShadowResult>[0]> = {}) {
  return buildPosShadowResult({
    checkedAt: "2026-07-21T03:00:00+07:00",
    businessDate: "2026-07-20", snapshot,
    legacyWindow: { from: "2026-07-20T09:00:00.000Z", to: "2026-07-20T20:00:00.000Z" },
    configuredWindow: { from: "2026-07-20T16:00:00+07:00", to: "2026-07-21T03:00:00+07:00" },
    listCount: 1, detailCount: 1, detailFailureCount: 0, queryPerformed: true, limit: 100,
    observations: [matching], ...overrides,
  });
}

test("complete matching comparisons are ready", () => {
  const value = result();
  assert.equal(value.status, "ready");
  assert.equal(value.window.matches, true);
  assert.equal(value.businessDateComparison.legacyConfiguredMatchCount, 1);
  assert.equal(value.businessDateComparison.pureDbMatchCount, 1);
  assert.equal(value.rangeSetComparison.idSetsMatch, true);
  assert.equal(value.windowState, "completed");
  assert.equal(value.isFinalResult, true);
});

test("future business days never become ready and perform no invoice classification", () => {
  const value = result({
    checkedAt: "2026-07-20T15:59:59+07:00",
    listCount: 0, detailCount: 0, queryPerformed: false, observations: [],
  });
  assert.equal(value.windowState, "future");
  assert.equal(value.status, "incomplete");
  assert.equal(value.isFinalResult, false);
  assert.equal(value.window.matches, true);
  assert.equal(value.cukcuk.queryPerformed, false);
});

test("in-progress matching results remain provisional", () => {
  const value = result({ checkedAt: "2026-07-20T18:00:00+07:00" });
  assert.equal(value.windowState, "in_progress");
  assert.equal(value.status, "incomplete");
  assert.equal(value.isFinalResult, false);
});

test("completed zero-invoice days have a separate final state", () => {
  const value = result({ listCount: 0, detailCount: 0, observations: [] });
  assert.equal(value.windowState, "completed");
  assert.equal(value.status, "no_invoices");
  assert.equal(value.isFinalResult, true);
});

test("fallback revision zero and configured revision three remain valid selections", () => {
  const fallback = result({ listCount: 0, detailCount: 0, observations: [] });
  assert.equal(fallback.setting.revision, 0);
  assert.equal(fallback.setting.isFallback, true);
  const configured = result({
    snapshot: { ...snapshot, revision: 3, source: "configured", isFallback: false },
    listCount: 0, detailCount: 0, observations: [],
  });
  assert.equal(configured.setting.revision, 3);
  assert.equal(configured.setting.isFallback, false);
  assert.equal(configured.status, "no_invoices");
});

test("business date and range differences are mismatches", () => {
  const value = result({ observations: [{ ...matching, configuredPureBusinessDate: "2026-07-19", configuredDbBusinessDate: "2026-07-19", inConfiguredRange: false }] });
  assert.equal(value.status, "mismatch");
  assert.deepEqual(value.mismatchKinds, ["legacyConfiguredBusinessDate", "invoiceRangeSet"]);
});

test("pure and DB disagreement is a mismatch", () => {
  const value = result({ observations: [{ ...matching, configuredDbBusinessDate: "2026-07-19" }] });
  assert.equal(value.status, "mismatch");
  assert.equal(value.businessDateComparison.pureDbMismatchCount, 1);
});

test("missing timestamps, detail failures, and a reached limit are incomplete", () => {
  const missing = { ...matching, timestamp: null, configuredPureBusinessDate: null, configuredDbBusinessDate: null };
  assert.equal(result({ observations: [missing] }).status, "incomplete");
  assert.equal(result({ detailFailureCount: 1 }).status, "incomplete");
  assert.equal(result({ listCount: 100 }).status, "incomplete");
});

test("window endpoint differences are mismatches", () => {
  const value = result({ configuredWindow: { from: "2026-07-20T17:00:00+07:00", to: "2026-07-21T03:00:00+07:00" } });
  assert.equal(value.status, "mismatch");
  assert.equal(value.window.fromMatches, false);
});

test("legacy UTC and configured offsets display as the same Vietnam local time", () => {
  assert.equal(formatPosShadowStoreDateTime("2026-07-20T09:00:00.000Z"), "2026-07-20 16:00");
  assert.equal(formatPosShadowStoreDateTime("2026-07-20T16:00:00+07:00"), "2026-07-20 16:00");
  assert.equal(formatPosShadowStoreDateTime("2026-07-20T20:00:00.000Z"), "2026-07-21 03:00");
});
