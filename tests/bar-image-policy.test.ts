import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inferredType } from "../lib/bar/image-file-type.js";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const file = (name: string, type = "") => ({ name, type });

test("BAR image MIME inference accepts supported empty and uppercase extensions", () => {
  assert.equal(inferredType(file("iphone.JPG")), "image/jpeg");
  assert.equal(inferredType(file("iphone.JPEG")), "image/jpeg");
  assert.equal(inferredType(file("iphone.HEIC")), "image/heic");
  assert.equal(inferredType(file("iphone.HEIF")), "image/heif");
  assert.equal(inferredType(file("photo.PNG")), "image/png");
  assert.equal(inferredType(file("photo.WEBP")), "image/webp");
  assert.equal(inferredType(file("photo.gif")), "");
  assert.equal(inferredType(file("photo.JPG", "IMAGE/JPEG")), "image/jpeg");
});

test("compression policies use orientation-aware fallback and matching output types", () => {
  const common = source("lib/bar/image-compression.ts");
  const keeping = source("lib/bar/keeping-image-compression.ts");
  assert.match(common, /typeof createImageBitmap === "function"/);
  assert.match(common, /imageOrientation: "from-image"/);
  assert.match(common, /URL\.revokeObjectURL/);
  assert.match(common, /\["image\/webp", "image\/jpeg"\]/);
  assert.match(common, /blob\?\.type === type/);
  assert.match(common, /Math\.min\(1, step\.side/);
  assert.match(keeping, /KEEPING_DETAIL_MAX_BYTES = 900 \* 1024/);
  assert.match(keeping, /KEEPING_THUMBNAIL_MAX_BYTES = 100 \* 1024/);
  assert.ok(keeping.indexOf("const detail = await") < keeping.indexOf("const thumbnail = await"));
});

test("client inputs, list images, server limits, and cleanup follow the BAR policy", () => {
  const input = source("components/bar/keeping/KeepingImageInput.tsx");
  const list = source("components/bar/keeping/KeepingBasics.tsx");
  const zoneList = source("components/bar/keeping/ZoneKeepingSummary.tsx");
  const server = source("lib/bar/keeping-server.ts");
  const zoneRoute = source("app/api/bar/zones/[code]/photo/route.ts");
  assert.match(input, /accept="image\/\*" capture="environment"/);
  assert.match(input, /accept="image\/\*,\.heic,\.heif"/);
  assert.doesNotMatch(input, /onChange\(null\)/);
  assert.match(list, /item\.thumbnailUrl/);
  assert.doesNotMatch(list, /item\.imageUrl/);
  assert.match(zoneList, /item\.thumbnailUrl/);
  assert.match(server, /\["image\/webp", "image\/jpeg"\]/);
  assert.match(server, /KEEPING_PARTIAL_UPLOAD_CLEANUP/);
  assert.match(server, /\(webp\|jpg\)/);
  assert.match(zoneRoute, /MAX_SIZE = 800 \* 1024/);
  assert.match(zoneRoute, /BAR_NEW_PHOTO_COMPENSATION_WARNING/);
  assert.match(zoneRoute, /BAR_OLD_PHOTO_CLEANUP_WARNING/);
});

test("image preview modal preserves accessibility and restores focus", () => {
  const modal = source("components/bar/ImagePreviewModal.tsx");
  const zone = source("components/bar/BarZoneDetail.tsx");
  const detail = source("components/bar/keeping/KeepingDetail.tsx");
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /event\.key === "Escape"/);
  assert.match(modal, /document\.body\.style\.overflow = "hidden"/);
  assert.match(modal, /focusTarget\?\.focus\(\)/);
  assert.match(zone, /<ImagePreviewModal/);
  assert.match(detail, /src=\{item\.imageUrl\}/);
});

test("keeping creation diagnostics separate devices, stages, safe fields, and RPC statuses", () => {
  const route = source("app/api/bar/keepings/route.ts");
  const form = source("components/bar/keeping/KeepingForm.tsx");
  const autocomplete = source("components/bar/keeping/KeepingProductAutocomplete.tsx");
  const migration = source("supabase/migrations/202607180001_allow_jpeg_bar_keeping_paths.sql");
  assert.match(route, /"iOS\/Safari"/);
  assert.match(route, /"Android\/Chrome"/);
  for (const stage of ["form_data_parse_failed", "input_validation_failed", "file_validation_failed", "detail_upload_failed", "thumbnail_upload_failed", "rpc_error", "rpc_non_ok", "success"]) assert.match(route + source("lib/bar/keeping-server.ts"), new RegExp(stage));
  for (const status of ["invalid_inventory_item", "invalid_zone", "invalid_actor", "invalid_input"]) assert.match(route, new RegExp(status));
  assert.match(route, /customerName:textDiagnostic\(customerRaw\)/);
  assert.match(route, /contact:textDiagnostic\(contactRaw\)/);
  assert.match(route, /identifier:textDiagnostic\(identifierRaw\)/);
  assert.match(route, /note:textDiagnostic\(noteRaw\)/);
  assert.doesNotMatch(route, /console\.(?:info|warn|error)\([^\n]*p_customer_/);
  assert.match(form, /form\.set\("lang",lang\)/);
  assert.match(form, /KEEPING_INVALID_INVENTORY/);
  assert.match(autocomplete, /onPointerDown/);
  assert.match(migration, /main\[\.\]\(webp\|jpg\)/);
  assert.match(migration, /thumb\[\.\]\(webp\|jpg\)/);
});
