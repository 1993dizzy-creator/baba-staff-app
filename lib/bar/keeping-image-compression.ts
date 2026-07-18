import { BarImageCompressionError, loadBarImageSource, renderCompressedImage } from "@/lib/bar/image-compression";

export const KEEPING_DETAIL_TARGET_BYTES = 800 * 1024;
export const KEEPING_DETAIL_MAX_BYTES = 900 * 1024;
export const KEEPING_THUMBNAIL_TARGET_BYTES = 80 * 1024;
export const KEEPING_THUMBNAIL_MAX_BYTES = 100 * 1024;

const DETAIL_STEPS = [
  { side: 1800, quality: 0.9 }, { side: 1800, quality: 0.86 }, { side: 1700, quality: 0.84 },
  { side: 1600, quality: 0.81 }, { side: 1450, quality: 0.77 }, { side: 1300, quality: 0.73 }, { side: 1150, quality: 0.69 },
] as const;
const THUMB_STEPS = [
  { side: 480, quality: 0.82 }, { side: 480, quality: 0.76 }, { side: 440, quality: 0.72 },
  { side: 400, quality: 0.68 }, { side: 360, quality: 0.64 }, { side: 320, quality: 0.6 },
] as const;

export { BarImageCompressionError };

export async function compressKeepingImage(file: File) {
  const loaded = await loadBarImageSource(file);
  try {
    // Render sequentially so a large detail canvas and thumbnail canvas are never retained together.
    const detail = await renderCompressedImage(loaded.source, loaded.width, loaded.height, DETAIL_STEPS, KEEPING_DETAIL_TARGET_BYTES, KEEPING_DETAIL_MAX_BYTES, file.name, "-main");
    const thumbnail = await renderCompressedImage(loaded.source, loaded.width, loaded.height, THUMB_STEPS, KEEPING_THUMBNAIL_TARGET_BYTES, KEEPING_THUMBNAIL_MAX_BYTES, file.name, "-thumb");
    return { detail, thumbnail };
  } finally {
    loaded.close();
  }
}
