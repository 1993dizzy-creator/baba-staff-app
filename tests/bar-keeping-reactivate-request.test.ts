import assert from "node:assert/strict";
import test from "node:test";
// Node runs this TypeScript test directly; the explicit extension is required at runtime.
// @ts-expect-error allowImportingTsExtensions is intentionally not enabled for app builds.
import { parseReactivateActionForm } from "../lib/bar/keeping-reactivate-request.ts";

function requestForm(overrides: Record<string, unknown> = {}, note: unknown = "재활성화 확인") {
  const form = new FormData();
  form.set("action", "reactivate");
  form.set("version", "2");
  form.set("payload", JSON.stringify({
    storedAt: "2026-07-18",
    zoneCode: "A3",
    remainingPercent: "65",
    note,
    ...overrides,
  }));
  return form;
}

const validZone = async (code: string) => code === "A3";

test("browser-equivalent FormData with note reaches the v5 RPC contract", async () => {
  const parsed = await parseReactivateActionForm(requestForm(), validZone);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.rpc, "bar_mutate_keeping_v5");
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.payload, {
    stored_at: "2026-07-18",
    zone_code: "A3",
    remaining_percent: 65,
    note: "재활성화 확인",
  });
  assert.equal(parsed.detail, null);
  assert.equal(parsed.thumbnail, null);
});

test("empty note and no legacy reason or replacement photo are valid", async () => {
  const parsed = await parseReactivateActionForm(requestForm({}, "   "), validZone);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.payload.note, null);
  assert.equal("reason" in parsed.payload, false);
});

test("remainingPercent accepts the browser JSON string representation", async () => {
  const parsed = await parseReactivateActionForm(requestForm({ remainingPercent: "0" }), validZone);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.payload.remaining_percent, 0);
});

test("paired processed main and thumbnail files are accepted", async () => {
  const form = requestForm();
  form.set("image", new File([new Uint8Array([0xff, 0xd8, 0xff])], "main.jpg", { type: "image/jpeg" }));
  form.set("thumbnail", new File([new Uint8Array([0xff, 0xd8, 0xff])], "thumb.jpg", { type: "image/jpeg" }));
  const parsed = await parseReactivateActionForm(form, validZone);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.detail?.name, "main.jpg");
});

for (const [name, overrides, field] of [
  ["storedAt", { storedAt: "18/07/2026" }, "storedAt"],
  ["zoneCode", { zoneCode: "" }, "zoneCode"],
  ["remainingPercent", { remainingPercent: "101" }, "remainingPercent"],
] as const) {
  test(`only invalid ${name} reports ${field}`, async () => {
    const parsed = await parseReactivateActionForm(requestForm(overrides), validZone);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.field, field);
  });
}

test("missing version is reported separately", async () => {
  const form = requestForm();
  form.delete("version");
  const parsed = await parseReactivateActionForm(form, validZone);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.field, "version");
});

test("only one replacement image is rejected as a file-pair error", async () => {
  const form = requestForm();
  form.set("image", new File([new Uint8Array([1])], "main.webp", { type: "image/webp" }));
  const parsed = await parseReactivateActionForm(form, validZone);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.field, "files");
});
