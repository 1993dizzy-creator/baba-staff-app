// Request bodies of the manual transaction edit / cancel routes.
const CHANGE_KEYS = new Set(["occurredAt", "type", "amount", "categoryId", "partyId", "fromAccountId", "toAccountId", "title", "memo"]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const reasonOf = (value: unknown) => typeof value === "string" && value.trim() && value.trim().length <= 500 ? value.trim() : null;
// The stored version string is passed back unchanged (microseconds included).
const versionOf = (value: unknown) => typeof value === "string" && TIMESTAMP.test(value) ? value : null;
const nullableId = (value: unknown) => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);

export function parseManualTransactionUpdate(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !["expectedUpdatedAt", "changes", "reason"].includes(key))) return null;
  const expectedUpdatedAt = versionOf(value.expectedUpdatedAt), reason = reasonOf(value.reason);
  const changes = value.changes;
  if (!expectedUpdatedAt || !reason || !changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const entries = Object.entries(changes as Record<string, unknown>);
  if (!entries.length || entries.some(([key]) => !CHANGE_KEYS.has(key))) return null;
  for (const [key, field] of entries) {
    const ok = key === "occurredAt" ? typeof field === "string" && TIMESTAMP.test(field)
      : key === "type" ? field === "income" || field === "expense" || field === "transfer"
      : key === "amount" ? typeof field === "number" && Number.isSafeInteger(field) && field > 0
      : key === "title" ? field === null || (typeof field === "string" && field.length <= 160)
      : key === "memo" ? field === null || (typeof field === "string" && field.length <= 2000)
      : nullableId(field);
    if (!ok) return null;
  }
  return { expectedUpdatedAt, reason, changes: Object.fromEntries(entries) };
}

export function parseManualTransactionCancel(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !["expectedUpdatedAt", "reason"].includes(key))) return null;
  const expectedUpdatedAt = versionOf(value.expectedUpdatedAt), reason = reasonOf(value.reason);
  return expectedUpdatedAt && reason ? { expectedUpdatedAt, reason } : null;
}
