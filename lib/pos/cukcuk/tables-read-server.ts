import "server-only";
import { parseTableCatalog, type TableCatalog } from "@/lib/sales/table-overview";
import { openOrdersBranchId } from "./open-orders-scope";

// OFF by default. Enabling this is a separate Owner-approved operational step.
// No login, request, retry or credential access occurs while disabled.
let cached: { until: number; branch: string; pending: boolean; value: Promise<TableCatalog> } | undefined;
export function loadTableCatalog(now = new Date()): Promise<TableCatalog> {
  if (process.env.POS_TABLES_READ_ENABLED?.trim() !== "true") {
    return Promise.resolve({ status: "not_enabled", collectedAt: null, tables: [] });
  }
  const branch = openOrdersBranchId();
  if (cached && cached.branch === branch && (cached.pending || cached.until > now.getTime())) return cached.value;
  const value = readCatalog(branch);
  // Single-flight and a five minute cooldown (including failure). No per-staff login storm or automatic retries.
  const entry = { branch, until: now.getTime() + 5 * 60_000, pending: true, value };
  cached = entry;
  void value.finally(() => { entry.pending = false; });
  return value;
}

async function readCatalog(branch: string): Promise<TableCatalog> {
  try {
    const [{ loginCukcuk }, { buildCukcukHeaders, CUKCUK_BASE_URL }] = await Promise.all([
      import("./auth"), import("./sales-receipt-sync"),
    ]);
    const login = await loginCukcuk();
    const response = await fetch(`${CUKCUK_BASE_URL}/api/v1/tables/${encodeURIComponent(branch)}`, {
      method: "GET", headers: buildCukcukHeaders(login.accessToken, login.companyCode),
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw Error("TABLES_UNAVAILABLE");
    return parseTableCatalog(await response.json(), new Date().toISOString());
  } catch {
    // Provider payloads/auth errors can contain tokens. Never log or return them.
    return { status: "unavailable", collectedAt: null, tables: [] };
  }
}
