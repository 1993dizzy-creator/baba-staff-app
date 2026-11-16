export type CleaningFailure = { kind: "stale" | "unavailable" | "network" | "forbidden" | "invalid" | "request" | "saved_refresh";
  status?: number; code: string; stage?: string };

export function cleaningResponseFailure(status: number, body: { code?: string; stage?: string }): CleaningFailure {
  return { kind: status === 409 ? "stale" : status === 403 ? "forbidden" : status === 400 || status === 404 ? "invalid" : "unavailable",
    status, code: body.code ?? "CLEANING_UNAVAILABLE", stage: body.stage };
}
