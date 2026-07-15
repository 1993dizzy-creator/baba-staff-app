import { BarImageCompressionError } from "@/lib/bar/image-compression";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const DETAIL_STEPS = [{ side: 1600, quality: .84 }, { side: 1500, quality: .78 }, { side: 1300, quality: .72 }, { side: 1100, quality: .66 }] as const;
const THUMB_STEPS = [{ side: 480, quality: .76 }, { side: 420, quality: .7 }, { side: 360, quality: .64 }] as const;

async function source(file: File) {
  if (!ALLOWED.has(file.type.toLowerCase())) throw new BarImageCompressionError("unsupported_format");
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    return new Promise<{ image: HTMLImageElement; width: number; height: number; close: () => void }>((resolve, reject) => {
      const url = URL.createObjectURL(file); const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve({ image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined }); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new BarImageCompressionError("unsupported_format")); };
      image.src = url;
    });
  }
}

async function render(image: CanvasImageSource, width: number, height: number, steps: readonly { side: number; quality: number }[], max: number, name: string) {
  let best: Blob | null = null;
  for (const step of steps) {
    const ratio = Math.min(1, step.side / Math.max(width, height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext("2d"); if (!context) throw new BarImageCompressionError("compression_failed");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", step.quality));
    if (blob?.size && blob.size <= max) { best = blob; if (blob.size <= max * .7) break; }
  }
  if (!best) throw new BarImageCompressionError("too_large");
  return new File([best], `${name}.webp`, { type: "image/webp" });
}

export async function compressKeepingImage(file: File) {
  const loaded = await source(file);
  try {
    const base = file.name.replace(/\.[^.]+$/, "") || "keeping";
    const [detail, thumbnail] = await Promise.all([
      render(loaded.image, loaded.width, loaded.height, DETAIL_STEPS, 700 * 1024, `${base}-main`),
      render(loaded.image, loaded.width, loaded.height, THUMB_STEPS, 120 * 1024, `${base}-thumb`),
    ]);
    return { detail, thumbnail };
  } finally { loaded.close(); }
}
