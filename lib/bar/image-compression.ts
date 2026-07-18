export const BAR_IMAGE_TARGET_BYTES = 700 * 1024;
export const BAR_IMAGE_MAX_BYTES = 800 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const STEPS = [
  { side: 1800, quality: 0.9 },
  { side: 1800, quality: 0.86 },
  { side: 1700, quality: 0.84 },
  { side: 1600, quality: 0.82 },
  { side: 1500, quality: 0.78 },
  { side: 1350, quality: 0.74 },
  { side: 1200, quality: 0.7 },
] as const;

export class BarImageCompressionError extends Error {
  constructor(public code: "unsupported_format" | "compression_failed" | "too_large") {
    super(code);
    this.name = "BarImageCompressionError";
  }
}

export async function loadBarImageSource(file: File) {
  if (!ALLOWED.has(inferredType(file))) throw new BarImageCompressionError("unsupported_format");
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      if (bitmap.width > 0 && bitmap.height > 0) return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      bitmap.close();
    } catch { /* Safari/iPhone formats continue through the HTML image decoder. */ }
  }
  return new Promise<{ source: HTMLImageElement; width: number; height: number; close: () => void }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    image.onload = () => {
      cleanup();
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) reject(new BarImageCompressionError("compression_failed"));
      else resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined });
    };
    image.onerror = () => { cleanup(); reject(new BarImageCompressionError("compression_failed")); };
    image.src = url;
  });
}

export const toImageBlob = (canvas: HTMLCanvasElement, type: "image/webp" | "image/jpeg", quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob?.type === type ? blob : null), type, quality));

export function imageFile(blob: Blob, originalName: string, suffix: string, type: "image/webp" | "image/jpeg") {
  const base = originalName.replace(/\.[^.]+$/, "").trim() || "bar-image";
  return new File([blob], `${base}${suffix}.${type === "image/webp" ? "webp" : "jpg"}`, { type });
}

export async function renderCompressedImage(source: CanvasImageSource, width: number, height: number, steps: readonly { side: number; quality: number }[], target: number, max: number, originalName: string, suffix = "") {
  for (const type of ["image/webp", "image/jpeg"] as const) {
    let sharpestWithinMax: Blob | null = null;
    const canvas = document.createElement("canvas");
    for (const step of steps) {
      const ratio = Math.min(1, step.side / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext("2d");
      if (!context) throw new BarImageCompressionError("compression_failed");
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await toImageBlob(canvas, type, step.quality);
      if (!blob?.size) continue;
      if (blob.size <= max && !sharpestWithinMax) sharpestWithinMax = blob;
      if (blob.size <= target) return imageFile(blob, originalName, suffix, type);
    }
    if (sharpestWithinMax) return imageFile(sharpestWithinMax, originalName, suffix, type);
  }
  throw new BarImageCompressionError("too_large");
}

export async function compressBarZoneImage(file: File): Promise<File> {
  const image = await loadBarImageSource(file);
  try {
    return await renderCompressedImage(image.source, image.width, image.height, STEPS, BAR_IMAGE_TARGET_BYTES, BAR_IMAGE_MAX_BYTES, file.name);
  } finally {
    image.close();
  }
}
import { inferredType } from "@/lib/bar/image-file-type";
