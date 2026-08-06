import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { INVENTORY_PART_VALUES, INVENTORY_PART_FALLBACK, isInventoryPart, resolveInventoryDefaultPart } from "../lib/inventory/parts.ts";

test("INVENTORY_PART_VALUES is exactly kitchen/hall/bar/etc, no owner or cleaning", () => {
  assert.deepEqual(INVENTORY_PART_VALUES, ["kitchen", "hall", "bar", "etc"]);
  assert.equal(INVENTORY_PART_FALLBACK, "kitchen");
});

test("isInventoryPart accepts only the 4 inventory parts", () => {
  assert.equal(isInventoryPart("kitchen"), true);
  assert.equal(isInventoryPart("hall"), true);
  assert.equal(isInventoryPart("bar"), true);
  assert.equal(isInventoryPart("etc"), true);

  assert.equal(isInventoryPart("owner"), false);
  assert.equal(isInventoryPart("cleaning"), false);
  assert.equal(isInventoryPart(""), false);
  assert.equal(isInventoryPart("   "), false);
  assert.equal(isInventoryPart(null), false);
  assert.equal(isInventoryPart(undefined), false);
  assert.equal(isInventoryPart("some-future-part"), false);
});

test("resolveInventoryDefaultPart prefers a valid saved part over the user's part", () => {
  assert.equal(resolveInventoryDefaultPart("hall", "kitchen"), "hall");
  assert.equal(resolveInventoryDefaultPart("bar", "owner"), "bar");
  assert.equal(resolveInventoryDefaultPart("etc", "cleaning"), "etc");
});

test("resolveInventoryDefaultPart falls back to a valid user part when the saved part is owner", () => {
  assert.equal(resolveInventoryDefaultPart("owner", "hall"), "hall");
});

test("resolveInventoryDefaultPart falls back to a valid user part when the saved part is cleaning", () => {
  assert.equal(resolveInventoryDefaultPart("cleaning", "bar"), "bar");
});

test("resolveInventoryDefaultPart falls back to a valid user part when the saved part is blank or unknown", () => {
  assert.equal(resolveInventoryDefaultPart("", "etc"), "etc");
  assert.equal(resolveInventoryDefaultPart(null, "kitchen"), "kitchen");
  assert.equal(resolveInventoryDefaultPart("garbage", "bar"), "bar");
});

test("resolveInventoryDefaultPart falls back to kitchen when the user is owner/cleaning/unknown and there is no saved part", () => {
  assert.equal(resolveInventoryDefaultPart(null, "owner"), "kitchen");
  assert.equal(resolveInventoryDefaultPart(null, "cleaning"), "kitchen");
  assert.equal(resolveInventoryDefaultPart(null, "some-future-part"), "kitchen");
  assert.equal(resolveInventoryDefaultPart(undefined, undefined), "kitchen");
});

test("resolveInventoryDefaultPart falls back to kitchen when both saved and user parts are invalid", () => {
  assert.equal(resolveInventoryDefaultPart("owner", "cleaning"), "kitchen");
  assert.equal(resolveInventoryDefaultPart("", ""), "kitchen");
});

test("kitchen/hall/bar/etc users resolve to their own part with no saved value", () => {
  for (const value of INVENTORY_PART_VALUES) {
    assert.equal(resolveInventoryDefaultPart(null, value), value);
  }
});
