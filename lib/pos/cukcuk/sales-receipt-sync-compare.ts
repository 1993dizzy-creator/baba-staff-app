const VOLATILE_POS_KEYS = new Set([
  "modifieddate",
  "modifieddateutc",
  "updateddate",
  "lastmodifieddate",
  "lastupdateddate",
]);

export function stripVolatilePosSyncFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatilePosSyncFields);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      if (VOLATILE_POS_KEYS.has(key.replace(/[_\s-]/g, "").toLowerCase())) {
        return result;
      }
      result[key] = stripVolatilePosSyncFields(
        (value as Record<string, unknown>)[key]
      );
      return result;
    }, {});
}
