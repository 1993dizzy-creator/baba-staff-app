export const KEEPING_REACTIVATE_RPC = "bar_mutate_keeping_v5";

export type ReactivateInputField =
  | "action"
  | "version"
  | "payload"
  | "storedAt"
  | "zoneCode"
  | "remainingPercent"
  | "note"
  | "files";

type ReactivatePayload = {
  zone_code: string;
  remaining_percent: number;
  stored_at: string;
  note: string | null;
};

export type ReactivateParseResult =
  | { ok: true; rpc: typeof KEEPING_REACTIVATE_RPC; version: number; payload: ReactivatePayload; detail: File | null; thumbnail: File | null }
  | { ok: false; field: ReactivateInputField; diagnostic: Record<string, unknown> };

export async function parseReactivateActionForm(
  form: FormData,
  validZone: (code: string) => Promise<boolean>
): Promise<ReactivateParseResult> {
  const action = String(form.get("action") ?? "");
  const versionValue = form.get("version");
  const version = Number(versionValue);
  const payloadText = String(form.get("payload") ?? "");
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(payloadText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch { /* reported as payload below */ }

  const detailValue = form.get("image");
  const thumbnailValue = form.get("thumbnail");
  const detail = detailValue instanceof File && detailValue.size > 0 ? detailValue : null;
  const thumbnail = thumbnailValue instanceof File && thumbnailValue.size > 0 ? thumbnailValue : null;
  const diagnostic = reactivateDiagnostic(action, versionValue, raw, detail, thumbnail);

  if (action !== "reactivate") return { ok: false, field: "action", diagnostic };
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) return { ok: false, field: "version", diagnostic };
  if (!raw) return { ok: false, field: "payload", diagnostic };

  const storedAt = typeof raw.storedAt === "string" ? raw.storedAt : "";
  if (!validDate(storedAt)) return { ok: false, field: "storedAt", diagnostic };

  const zoneCode = typeof raw.zoneCode === "string" ? raw.zoneCode.trim() : "";
  if (!zoneCode || zoneCode.length > 8 || !(await validZone(zoneCode))) return { ok: false, field: "zoneCode", diagnostic };

  const remainingPercent = Number(raw.remainingPercent);
  if (!Number.isInteger(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
    return { ok: false, field: "remainingPercent", diagnostic };
  }

  if (raw.note != null && typeof raw.note !== "string") return { ok: false, field: "note", diagnostic };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > 1000) return { ok: false, field: "note", diagnostic };
  if (Boolean(detail) !== Boolean(thumbnail)) return { ok: false, field: "files", diagnostic };

  return {
    ok: true,
    rpc: KEEPING_REACTIVATE_RPC,
    version,
    payload: { zone_code: zoneCode, remaining_percent: remainingPercent, stored_at: storedAt, note: note || null },
    detail,
    thumbnail,
  };
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function fileDiagnostic(file: File | null) {
  return file ? { present: true, mime: file.type, size: file.size } : { present: false };
}

function reactivateDiagnostic(action: string, version: FormDataEntryValue | null, raw: Record<string, unknown> | null, detail: File | null, thumbnail: File | null) {
  const note = raw?.note;
  return {
    action,
    versionPresent: version != null && String(version) !== "",
    storedAtPresent: typeof raw?.storedAt === "string" && raw.storedAt.length > 0,
    storedAtFormatValid: typeof raw?.storedAt === "string" && validDate(raw.storedAt),
    zoneCodePresent: typeof raw?.zoneCode === "string" && raw.zoneCode.trim().length > 0,
    remainingPercentType: typeof raw?.remainingPercent,
    notePresent: typeof note === "string" && note.trim().length > 0,
    noteLength: typeof note === "string" ? note.length : 0,
    main: fileDiagnostic(detail),
    thumbnail: fileDiagnostic(thumbnail),
  };
}
