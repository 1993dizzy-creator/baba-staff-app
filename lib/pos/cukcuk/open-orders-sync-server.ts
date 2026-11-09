import "server-only";
import { randomUUID } from "node:crypto";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { openOrdersBranchId, openOrdersScope } from "@/lib/pos/cukcuk/open-orders-scope";
import { buildCukcukHeaders, CUKCUK_BASE_URL } from "@/lib/pos/cukcuk/sales-receipt-sync";
import { supabaseServer } from "@/lib/supabase/server";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import {
  OPEN_ORDERS_REQUEST_TIMEOUT_MS,
  OPEN_ORDERS_RPC,
  OpenOrderSyncError,
  openOrdersRpcErrorCode,
  runOpenOrderSync,
  type OrderRequest,
  type OrderTransport,
} from "./open-orders-core";

// Central (server/cron) collector for CUKCUK in-progress orders.
// Timing: collection ends by claim + OPEN_ORDERS_RUN_BUDGET_MS (150s) inside the 3-minute
// lease. A future cron route must allow at least that duration (e.g. maxDuration >= 180).
// NOT ACTIVATED: no route or cron calls this yet. Activation needs the DB draft
// (docs/sql/pos-open-orders-v1-draft.sql) applied and POS_OPEN_ORDERS_SYNC_ENABLED=true.
// Browsers never call CUKCUK: they read the snapshot via /api/admin/sales/today.

const REQUEST_TIMEOUT_MS = OPEN_ORDERS_REQUEST_TIMEOUT_MS;

export function openOrdersSyncEnabled() {
  return process.env.POS_OPEN_ORDERS_SYNC_ENABLED?.trim() === "true";
}

/** The shared login (lib/pos/cukcuk/auth.ts) has no timeout; bound it here without changing it. */
async function loginWithTimeout() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loginCukcuk(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OpenOrderSyncError("provider_timeout", "login")), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof OpenOrderSyncError) throw error;
    throw new OpenOrderSyncError("provider_token_expired", "login failed");
  } finally {
    clearTimeout(timer);
  }
}

function createCukcukOrderTransport(): OrderTransport {
  let headers: Record<string, string> | null = null;
  return {
    async login() {
      const login = await loginWithTimeout();
      headers = buildCukcukHeaders(login.accessToken, login.companyCode);
    },
    async send(request: OrderRequest) {
      if (!headers) throw new OpenOrderSyncError("provider_token_expired", "no session");
      const url = request.kind === "page"
        ? `${CUKCUK_BASE_URL}/api/v1/orders/paging`
        : `${CUKCUK_BASE_URL}/api/v1/orders/${encodeURIComponent(request.orderId)}`;
      const init: RequestInit = request.kind === "page"
        ? { method: "POST", headers, body: JSON.stringify({ Page: request.page, Limit: request.limit, BranchId: request.branchId, LastSyncDate: request.lastSyncDate }) }
        : { method: "GET", headers };
      try {
        const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        return { status: response.status, json: await response.json().catch(() => null) };
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new OpenOrderSyncError("provider_timeout", request.kind);
        }
        throw new OpenOrderSyncError("provider_http_failure", request.kind);
      }
    },
  };
}

// Service-role client calling the public SECURITY INVOKER wrappers only.
async function rpc(name: string, args: Record<string, unknown>) {
  if (!(Object.values(OPEN_ORDERS_RPC) as string[]).includes(name)) throw new Error("open_orders_rpc_missing");
  const { data, error } = await supabaseServer.rpc(name, args);
  if (error) throw new Error(openOrdersRpcErrorCode(error));
  return data as Record<string, unknown>;
}

/** One central run for the current configured business date. */
export async function runCentralOpenOrderSync(now = new Date()) {
  if (!openOrdersSyncEnabled()) return { status: "not_enabled" };
  const adapter = await loadBusinessTimeAdapter(now);
  const businessDate = adapter.databaseBusinessDate;
  const cutoff = adapter.snapshot.cutoff;
  // Business day D starts at D cutoff (Asia/Ho_Chi_Minh, +07:00, no DST).
  const windowFrom = new Date(`${businessDate}T${cutoff}:00+07:00`).toISOString();
  return runOpenOrderSync(
    { rpc, transport: createCukcukOrderTransport(), uuid: randomUUID },
    { scope: openOrdersScope(), branchId: openOrdersBranchId(), businessDate, windowFrom, cutoff }
  );
}
