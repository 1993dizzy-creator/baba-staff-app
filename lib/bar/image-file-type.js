const EXTENSION_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

/** @param {{ name: string, type: string }} file */
export function inferredType(file) {
  const declared = file.type.trim().toLowerCase();
  if (declared) return declared;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext && Object.prototype.hasOwnProperty.call(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] : "";
}
