const TARGET_BYTES = 160 * 1024;
export const BAR_IMAGE_MAX_BYTES = 250 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const STEPS = [
  { side: 1200, quality: 0.8 },
  { side: 1100, quality: 0.74 },
  { side: 1000, quality: 0.7 },
  { side: 900, quality: 0.66 },
  { side: 800, quality: 0.62 },
  { side: 700, quality: 0.58 },
] as const;

export class BarImageCompressionError extends Error {
  constructor(public code: "unsupported_format" | "compression_failed" | "too_large") {
    super(code);
    this.name = "BarImageCompressionError";
  }
}

const inferredType = (file: File) => {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext ? `image/${ext}` : "";
};

async function loadSource(file: File) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* HTMLImageElement fallback also covers browsers without HEIC decoding. */ }
  }
  return new Promise<{ source: HTMLImageElement; width: number; height: number; close: () => void }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined }); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new BarImageCompressionError("unsupported_format")); };
    image.src = url;
  });
}

const toBlob = (canvas: HTMLCanvasElement, type: "image/webp" | "image/jpeg", quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export async function compressBarZoneImage(file: File): Promise<File> {
  if (!ALLOWED.has(inferredType(file))) throw new BarImageCompressionError("unsupported_format");
  const image = await loadSource(file);
  try {
    for (const type of ["image/webp", "image/jpeg"] as const) {
      let best: Blob | null = null;
      for (const step of STEPS) {
        const ratio = Math.min(1, step.side / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * ratio));
        canvas.height = Math.max(1, Math.round(image.height * ratio));
        const context = canvas.getContext("2d");
        if (!context) throw new BarImageCompressionError("compression_failed");
        context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
        const blob = await toBlob(canvas, type, step.quality);
        if (!blob?.size) continue;
        if (blob.size <= TARGET_BYTES) return asFile(blob, file.name, type);
        if (blob.size <= BAR_IMAGE_MAX_BYTES) best = blob;
      }
      if (best) return asFile(best, file.name, type);
    }
    throw new BarImageCompressionError("too_large");
  } finally {
    image.close();
  }
}

function asFile(blob: Blob, originalName: string, type: "image/webp" | "image/jpeg") {
  const base = originalName.replace(/\.[^.]+$/, "").trim() || "bar-zone";
  return new File([blob], `${base}.${type === "image/webp" ? "webp" : "jpg"}`, { type });
}

