const TARGET_IMAGE_BYTES = 60 * 1024;
const MAX_IMAGE_BYTES = 100 * 1024;
const WEBP_MIME_TYPE = "image/webp";
const JPEG_MIME_TYPE = "image/jpeg";

const COMPRESSION_STEPS = [
  { maxSide: 640, webpQuality: 0.62, jpegQuality: 0.62 },
  { maxSide: 512, webpQuality: 0.58, jpegQuality: 0.58 },
  { maxSide: 480, webpQuality: 0.54, jpegQuality: 0.54 },
  { maxSide: 420, webpQuality: 0.5, jpegQuality: 0.5 },
  { maxSide: 360, webpQuality: 0.46, jpegQuality: 0.46 },
] as const;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export type CompressedInventoryImage = {
  file: File;
  originalBytes: number;
  compressedBytes: number;
};

export class InventoryImageCompressionError extends Error {
  code: "unsupported_format" | "compression_failed" | "too_large";

  constructor(
    code: InventoryImageCompressionError["code"],
    message = code
  ) {
    super(message);
    this.name = "InventoryImageCompressionError";
    this.code = code;
  }
}

export const formatFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
};

const getFileExtension = (fileName: string) =>
  fileName.split(".").pop()?.toLowerCase() || "";

const getImageType = (file: File) => {
  if (file.type) return file.type;

  const extension = getFileExtension(file.name);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  return "";
};

const getCompressedFileName = (fileName: string, extension: "webp" | "jpg") => {
  const baseName = fileName.replace(/\.[^.]+$/, "").trim() || "inventory-photo";
  return `${baseName}.${extension}`;
};

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  type: typeof WEBP_MIME_TYPE | typeof JPEG_MIME_TYPE,
  quality: number
) =>
  new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });

const loadImageBitmap = async (file: File) => {
  if (typeof createImageBitmap !== "function") return null;

  try {
    return await createImageBitmap(file, {
      imageOrientation: "from-image",
    } as ImageBitmapOptions);
  } catch {
    return null;
  }
};

const loadHtmlImage = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new InventoryImageCompressionError("unsupported_format"));
    };
    image.src = objectUrl;
  });

const getImageSource = async (file: File) => {
  const bitmap = await loadImageBitmap(file);
  if (bitmap) {
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  const image = await loadHtmlImage(file);
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => undefined,
  };
};

export const compressInventoryImage = async (
  file: File
): Promise<CompressedInventoryImage> => {
  const imageType = getImageType(file);

  if (!ALLOWED_IMAGE_TYPES.has(imageType)) {
    throw new InventoryImageCompressionError("unsupported_format");
  }

  const image = await getImageSource(file);

  try {
    const compressAs = async (
      type: typeof WEBP_MIME_TYPE | typeof JPEG_MIME_TYPE,
      extension: "webp" | "jpg"
    ) => {
      let bestUnderLimit: Blob | null = null;

      for (const step of COMPRESSION_STEPS) {
        const ratio = Math.min(1, step.maxSide / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * ratio));
        const height = Math.max(1, Math.round(image.height * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        if (!context) {
          throw new InventoryImageCompressionError("compression_failed");
        }

        context.drawImage(image.source, 0, 0, width, height);

        const quality =
          type === WEBP_MIME_TYPE ? step.webpQuality : step.jpegQuality;
        const blob = await canvasToBlob(canvas, type, quality);
        if (!blob || blob.size <= 0) {
          continue;
        }

        if (blob.size <= TARGET_IMAGE_BYTES) {
          return {
            blob,
            extension,
            type,
          };
        }

        if (blob.size <= MAX_IMAGE_BYTES) {
          bestUnderLimit = blob;
        }
      }

      return bestUnderLimit
        ? {
            blob: bestUnderLimit,
            extension,
            type,
          }
        : null;
    };

    const compressed =
      (await compressAs(WEBP_MIME_TYPE, "webp")) ||
      (await compressAs(JPEG_MIME_TYPE, "jpg"));

    if (compressed) {
      return {
        file: new File(
          [compressed.blob],
          getCompressedFileName(file.name, compressed.extension),
          { type: compressed.type }
        ),
        originalBytes: file.size,
        compressedBytes: compressed.blob.size,
      };
    }

    throw new InventoryImageCompressionError("too_large");
  } finally {
    image.close();
  }
};
