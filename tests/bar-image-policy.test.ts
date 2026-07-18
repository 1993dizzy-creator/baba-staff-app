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
