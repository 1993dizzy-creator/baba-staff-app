import { createHash } from "node:crypto";

const VOLATILE_HASH_KEYS = new Set(["calculatedAt", "capturedAt", "generatedAt"]);

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => !VOLATILE_HASH_KEYS.has(key) && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function canonicalizePayrollHashInput(value: unknown) {
  return canonicalJson(value);
}

export function stablePayrollSourceHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
