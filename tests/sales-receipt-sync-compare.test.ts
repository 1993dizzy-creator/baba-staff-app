import assert from "node:assert/strict";
import test from "node:test";
import { stripVolatilePosSyncFields } from "../lib/pos/cukcuk/sales-receipt-sync-compare";

test("ModifiedDate-only POS changes compare as identical", () => {
  const before = {
    ID: "receipt-1",
    ModifiedDate: "2026-07-13T10:00:00Z",
    Details: [{ ID: "line-1", UpdatedDate: "2026-07-13T10:00:00Z" }],
  };
  const after = {
    ID: "receipt-1",
    ModifiedDate: "2026-07-13T11:00:00Z",
    Details: [{ ID: "line-1", UpdatedDate: "2026-07-13T11:00:00Z" }],
  };
  assert.deepEqual(
    stripVolatilePosSyncFields(before),
    stripVolatilePosSyncFields(after)
  );
});

test("non-volatile POS content changes remain visible", () => {
  assert.notDeepEqual(
    stripVolatilePosSyncFields({ ID: "receipt-1", Quantity: 1 }),
    stripVolatilePosSyncFields({ ID: "receipt-1", Quantity: 2 })
  );
});
