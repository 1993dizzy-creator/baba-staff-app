import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getMonthlySummaryBarMetrics } from "../lib/inventory/monthly-summary-bars.ts";

const page = readFileSync(
  join(process.cwd(), "app/(protected)/inventory/monthly/page.tsx"),
  "utf8"
);

const sumSegments = (segments: ReturnType<typeof getMonthlySummaryBarMetrics>["deductionSegmentWidths"]) =>
  Object.values(segments).reduce((sum, width) => sum + width, 0);

test("supplier purchase and deduction bars share one absolute amount scale", () => {
  const metrics = getMonthlySummaryBarMetrics({
    purchaseAmount: 38000000,
    totalPurchaseAmount: 38000000 / 0.179,
    scaleMax: 42000000,
    deductions: { sale: 12000000, check: 30000000, service: 0, other: 0 },
  });

  assert.equal(Number(metrics.purchaseBarWidth.toFixed(1)), 90.5);
  assert.equal(metrics.deductionVisualWidth, 100);
  assert.ok(metrics.deductionVisualWidth > metrics.purchaseBarWidth);
  assert.equal(Number(metrics.purchaseShare.toFixed(1)), 17.9);
  assert.equal(metrics.deductionSegmentWidths.sale, (12000000 / 42000000) * 100);
  assert.equal(metrics.deductionSegmentWidths.check, (30000000 / 42000000) * 100);
});

test("deduction segments use the same absolute amount scale as the purchase bar", () => {
  const metrics = getMonthlySummaryBarMetrics({
    purchaseAmount: 1000,
    totalPurchaseAmount: 5000,
    scaleMax: 1000,
    deductions: { sale: 100, check: 50, service: 27, other: 20 },
  });

  assert.equal(metrics.deductionRate, 19.7);
  assert.equal(metrics.deductionVisualWidth, 19.7);
  assert.ok(metrics.deductionVisualWidth < metrics.purchaseBarWidth);
  assert.deepEqual(metrics.deductionSegmentWidths, {
    sale: 10,
    check: 5,
    service: 2.7,
    other: 2,
  });
  assert.equal(Math.round(sumSegments(metrics.deductionSegmentWidths) * 10) / 10, 19.7);
});

test("deduction text can exceed 100% while the largest absolute amount fills the scale", () => {
  const metrics = getMonthlySummaryBarMetrics({
    purchaseAmount: 100,
    totalPurchaseAmount: 100,
    scaleMax: 128.4,
    deductions: { sale: 80, check: 30, service: 10, other: 8.4 },
  });

  assert.equal(metrics.deductionRate, 128.4);
  assert.equal(metrics.deductionVisualWidth, 100);
  assert.ok(metrics.deductionVisualWidth > metrics.purchaseBarWidth);
  assert.ok(Math.abs(sumSegments(metrics.deductionSegmentWidths) - 100) < 1e-9);
  assert.ok(
    Math.abs(
      metrics.deductionSegmentWidths.sale / metrics.deductionSegmentWidths.check -
      80 / 30
    ) < 1e-9
  );
});

test("part deduction rate uses that part purchase amount, never the monthly total", () => {
  const metrics = getMonthlySummaryBarMetrics({
    purchaseAmount: 458,
    totalPurchaseAmount: 1000,
    scaleMax: 458,
    deductions: { sale: 423, check: 0, service: 0, other: 0 },
  });

  assert.equal(metrics.purchaseBarWidth, 100);
  assert.equal(Number(metrics.purchaseShare.toFixed(1)), 45.8);
  assert.equal(Number(metrics.deductionRate.toFixed(1)), 92.4);
  assert.notEqual(Number(metrics.deductionRate.toFixed(1)), 42.3);
  assert.ok(Math.abs(metrics.deductionVisualWidth - (423 / 458) * 100) < 1e-9);
});

test("zero or invalid purchase amounts never produce NaN or Infinity", () => {
  const metrics = getMonthlySummaryBarMetrics({
    purchaseAmount: 0,
    totalPurchaseAmount: Number.NaN,
    scaleMax: Number.POSITIVE_INFINITY,
    deductions: { sale: 10, check: Number.POSITIVE_INFINITY, service: 0, other: 0 },
  });

  assert.equal(metrics.purchaseBarWidth, 0);
  assert.equal(metrics.purchaseShare, 0);
  assert.equal(metrics.deductionRate, 0);
  assert.equal(metrics.deductionVisualWidth, 0);
  assert.ok(Object.values(metrics.deductionSegmentWidths).every(Number.isFinite));
});

test("supplier UI uses the common amount scale, labeled shares and absolute deduction segments", () => {
  const supplierSection = page.slice(
    page.indexOf('{summaryView === "supplier"'),
    page.indexOf('{summaryView === "part"')
  );
  assert.match(page, /width: `\$\{supplierBarMetrics\.purchaseBarWidth\}%`/);
  assert.match(supplierSection, /scaleMax: supplierScaleMax/);
  assert.doesNotMatch(page, /supplierAmountStats\.max/);
  assert.match(page, /purchaseShare: "전체 비중"/);
  assert.match(page, /purchaseShare: "Tỷ trọng nhập"/);
  assert.match(page, /deductionRate: "입고대비 차감"/);
  assert.match(page, /deductionRate: "Khấu trừ \/ nhập"/);
  for (const segment of ["sale", "check", "service", "other"]) {
    assert.match(
      page,
      new RegExp(`supplierBarMetrics\\.deductionSegmentWidths\\.${segment}`)
    );
  }
  assert.doesNotMatch(supplierSection, /\(\{purchaseShareText\}\)/);
  assert.match(
    supplierSection,
    /gridTemplateColumns: "minmax\(0,1fr\) 38px"[\s\S]*?\{purchaseShareText\}/
  );
  assert.match(
    supplierSection,
    /\{deductionRateText\}[\s\S]*?gridTemplateColumns: "minmax\(0,1fr\) 38px"|gridTemplateColumns: "minmax\(0,1fr\) 38px"[\s\S]*?\{deductionRateText\}/
  );
  assert.doesNotMatch(supplierSection, /supplierSignals/);
});

test("part UI shares the same absolute amount scale and keeps its share beside the amount", () => {
  const partSection = page.slice(page.indexOf('{summaryView === "part"'));
  assert.match(partSection, /purchaseAmount: part\.totalAmount/);
  assert.match(partSection, /totalPurchaseAmount: partAmountStats\.total/);
  assert.match(partSection, /scaleMax: partScaleMax/);
  assert.match(partSection, /width: `\$\{partBarMetrics\.purchaseBarWidth\}%`/);
  assert.doesNotMatch(partSection, /partAmountStats\.max/);
  assert.doesNotMatch(partSection, /\(\{partShareText\}\)/);
  assert.match(
    partSection,
    /gridTemplateColumns: "minmax\(0,1fr\) 38px"[\s\S]*?\{partShareText\}/
  );
  assert.match(
    partSection,
    /gridTemplateColumns: "minmax\(0,1fr\) 38px"[\s\S]*?\{partDeductionRateText\}/
  );
  assert.doesNotMatch(partSection, /labels\.spendingShare/);
  for (const segment of ["sale", "check", "service", "other"]) {
    assert.match(
      partSection,
      new RegExp(`partBarMetrics\\.deductionSegmentWidths\\.${segment}`)
    );
  }
});

test("supplier ordering remains purchase amount descending", () => {
  assert.match(
    page,
    /const amountDiff =\s*\(b\.summary\?\.purchaseAmountKnown \?\? 0\) -\s*\(a\.summary\?\.purchaseAmountKnown \?\? 0\)/
  );
  assert.match(page, /if \(amountDiff !== 0\) return amountDiff/);
});
