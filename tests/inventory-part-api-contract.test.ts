import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { validateInventoryPartPayload } from "../lib/inventory/parts.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const itemsRoute = read("app/api/inventory/items/route.ts");

// ---------------------------------------------------------------------------
// 실제 동작 검증: 정규식으로 소스를 읽는 대신, 두 API가 공유하는 순수 함수
// validateInventoryPartPayload를 실제 payload 객체로 직접 호출해 반환값을 확인한다.
// ---------------------------------------------------------------------------

test("POST (required: true) rejects a missing part", () => {
  const result = validateInventoryPartPayload({}, { required: true });
  assert.equal(result.ok, false);
});

test("POST (required: true) rejects part: null", () => {
  const result = validateInventoryPartPayload({ part: null }, { required: true });
  assert.equal(result.ok, false);
});

test("POST (required: true) rejects an empty string", () => {
  const result = validateInventoryPartPayload({ part: "" }, { required: true });
  assert.equal(result.ok, false);
});

test("POST (required: true) rejects a whitespace-only string", () => {
  const result = validateInventoryPartPayload({ part: "   " }, { required: true });
  assert.equal(result.ok, false);
});

test("POST (required: true) rejects owner", () => {
  const result = validateInventoryPartPayload({ part: "owner" }, { required: true });
  assert.equal(result.ok, false);
});

test("POST (required: true) rejects cleaning", () => {
  const result = validateInventoryPartPayload({ part: "cleaning" }, { required: true });
  assert.equal(result.ok, false);
});

test("POST (required: true) rejects an unknown string", () => {
  const result = validateInventoryPartPayload(
    { part: "some-future-part" },
    { required: true }
  );
  assert.equal(result.ok, false);
});

test("POST (required: true) accepts kitchen/hall/bar/etc and returns the trimmed value", () => {
  for (const value of ["kitchen", "hall", "bar", "etc"]) {
    const result = validateInventoryPartPayload({ part: value }, { required: true });
    assert.equal(result.ok, true);
    assert.equal((result as { ok: true; normalizedPart?: string }).normalizedPart, value);
  }
});

test("POST (required: true) trims surrounding whitespace on an otherwise-valid value", () => {
  const result = validateInventoryPartPayload({ part: " kitchen " }, { required: true });
  assert.equal(result.ok, true);
  assert.equal((result as { ok: true; normalizedPart?: string }).normalizedPart, "kitchen");
});

test("PATCH (required: false) allows a payload with no part property at all (quick-save/active-status)", () => {
  const quickSavePayload = { quantity: 5 };
  const activeStatusPayload = { is_active: false };

  assert.equal(validateInventoryPartPayload(quickSavePayload, { required: false }).ok, true);
  assert.equal(validateInventoryPartPayload(activeStatusPayload, { required: false }).ok, true);
});

test("PATCH (required: false) still allows only the 4 inventory parts when part is included", () => {
  for (const value of ["kitchen", "hall", "bar", "etc"]) {
    const result = validateInventoryPartPayload({ part: value }, { required: false });
    assert.equal(result.ok, true);
  }
});

test("PATCH (required: false) rejects owner, cleaning, and an empty string when part is included", () => {
  assert.equal(
    validateInventoryPartPayload({ part: "owner" }, { required: false }).ok,
    false
  );
  assert.equal(
    validateInventoryPartPayload({ part: "cleaning" }, { required: false }).ok,
    false
  );
  assert.equal(
    validateInventoryPartPayload({ part: "" }, { required: false }).ok,
    false
  );
});

test("part: undefined explicitly present is treated as an invalid part, not as 'absent'", () => {
  // hasOwnProperty is true even though the value is undefined — this must NOT be
  // silently treated the same as "the key was never sent".
  const payloadWithExplicitUndefined = { part: undefined };
  assert.equal(Object.prototype.hasOwnProperty.call(payloadWithExplicitUndefined, "part"), true);

  const requiredResult = validateInventoryPartPayload(payloadWithExplicitUndefined, {
    required: true,
  });
  assert.equal(requiredResult.ok, false);

  const optionalResult = validateInventoryPartPayload(payloadWithExplicitUndefined, {
    required: false,
  });
  assert.equal(optionalResult.ok, false);
});

// ---------------------------------------------------------------------------
// 배선(wiring) 확인: route.ts가 이 순수 함수를 실제로 쓰고 있는지, POST/PATCH가
// required 값을 다르게 넘기는지, 검증이 mode 분기보다 먼저 실행되는지는 함수 호출만으로는
// 확인할 수 없으므로 소스에서 최소한으로만 확인한다.
// ---------------------------------------------------------------------------

test("route imports the shared pure validator instead of re-implementing it", () => {
  assert.match(itemsRoute, /from "@\/lib\/inventory\/parts";/);
  assert.match(itemsRoute, /validateInventoryPartPayload/);
});

test("POST and PATCH both funnel through the same HTTP wrapper around the shared validator", () => {
  const occurrences = itemsRoute.match(/enforceInventoryPartPayload\(payload, \{/g) ?? [];
  assert.equal(occurrences.length, 2, "expected POST and PATCH to both call enforceInventoryPartPayload");
});

test("validation returns a stable invalid_inventory_part error code with HTTP 400", () => {
  assert.match(itemsRoute, /"invalid_inventory_part"/);
  assert.match(
    itemsRoute,
    /const invalidInventoryPartResponse = \(\) =>\s*\n\s*jsonError\(\s*\n\s*"invalid_inventory_part",[\s\S]{0,200}?400/
  );
});

test("POST passes required: true, PATCH passes required: false", () => {
  const postStart = itemsRoute.indexOf("export async function POST");
  const postEnd = itemsRoute.indexOf("export async function PATCH");
  const postSection = itemsRoute.slice(postStart, postEnd);

  assert.match(postSection, /enforceInventoryPartPayload\(payload, \{\s*required: true,?\s*\}\)/);
  assert.match(postSection, /if \(partValidationError\) return partValidationError;/);

  const patchStart = itemsRoute.indexOf("export async function PATCH");
  const patchEnd = itemsRoute.indexOf("export async function DELETE");
  const patchSection = itemsRoute.slice(patchStart, patchEnd);

  assert.match(patchSection, /enforceInventoryPartPayload\(payload, \{\s*required: false,?\s*\}\)/);
  assert.match(patchSection, /if \(partValidationError\) return partValidationError;/);

  // part 검증은 mode 분기(active-status 등)보다 앞서 한 번만 실행되어, 클라이언트가
  // 어떤 mode를 보내도 payload.part가 있으면 우회할 수 없다.
  const validationIndex = patchSection.indexOf("enforceInventoryPartPayload");
  const modeCheckIndex = patchSection.indexOf('mode === "active-status"');
  assert.ok(validationIndex !== -1 && modeCheckIndex !== -1 && validationIndex < modeCheckIndex);
});
