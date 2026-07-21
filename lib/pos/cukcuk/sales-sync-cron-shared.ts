import crypto from "crypto";
import { NextResponse } from "next/server";

export type JsonObject = Record<string, unknown>;

const DEFAULT_LIMIT = 100;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getBearerToken(req: Request) {
  const authorization = req.headers.get("authorization")?.trim() || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || "";
}

function getNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

// Shared by /api/cron/sales-sync (current business date) and
// /api/cron/sales-sync-final (previous, just-closed business date) so both
// crons authorize, call, and normalize the sync-to-sales response identically.
export function authorizeCron(req: Request) {
  const expected = process.env.CRON_SECRET?.trim();

  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured." },
      { status: 403 }
    );
  }

  const actual =
    getBearerToken(req) || req.headers.get("x-cron-secret")?.trim() || "";

  if (!actual || !safeEqual(actual, expected)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized cron request." },
      { status: 401 }
    );
  }

  return null;
}

async function readJson(res: Response) {
  return (await res.json().catch(() => null)) as JsonObject | null;
}

export function normalizeSyncResponse(syncJson: JsonObject | null, elapsedMs: number) {
  const result =
    syncJson?.result && typeof syncJson.result === "object"
      ? (syncJson.result as JsonObject)
      : null;
  const skipped = syncJson?.skipped === true;

  return {
    ok: syncJson?.ok === true,
    skipped,
    reason: typeof syncJson?.reason === "string" ? syncJson.reason : null,
    businessDate:
      typeof syncJson?.businessDate === "string"
        ? syncJson.businessDate
        : typeof (syncJson?.request as JsonObject | undefined)?.businessDate ===
            "string"
          ? ((syncJson?.request as JsonObject).businessDate as string)
          : null,
    syncRunId: getOptionalNumber(result?.syncRunId),
    lastSyncRunId: getOptionalNumber(syncJson?.lastSyncRunId),
    invoiceCount: getNumber(result?.invoiceCount ?? syncJson?.receiptCount),
    lineCount: getNumber(result?.lineCount ?? syncJson?.lineCount),
    createdCount: skipped
      ? getNumber(syncJson?.createdCount)
      : getNumber(result?.receiptCreatedCount) +
        getNumber(result?.lineCreatedCount) +
        getNumber(result?.paymentCreatedCount),
    updatedCount: skipped
      ? getNumber(syncJson?.updatedCount)
      : getNumber(result?.receiptUpdatedCount) +
        getNumber(result?.lineUpdatedCount) +
        getNumber(result?.lineStaleExcludedCount) +
        getNumber(result?.paymentUpdatedCount),
    canceledCount: getNumber(result?.canceledCount ?? syncJson?.canceledCount),
    statusChangedCount: getNumber(result?.statusChangedCount),
    elapsedMs,
  };
}

function resolveResponseBusinessDate(syncJson: JsonObject | null, fallback: string) {
  return typeof syncJson?.businessDate === "string"
    ? syncJson.businessDate
    : typeof (syncJson?.request as JsonObject | undefined)?.businessDate === "string"
      ? ((syncJson?.request as JsonObject).businessDate as string)
      : fallback;
}

// businessDate is only passed through when explicitly provided (the final
// cron does this); the normal cron omits it so sync-to-sales resolves the
// current business date itself from the store settings time module.
export async function callSalesSyncRoute(params: {
  origin: string;
  posAdminSecret: string;
  businessDate?: string;
  limit?: number;
}) {
  const startedAt = Date.now();
  const body: JsonObject = {
    force: false,
    limit: params.limit ?? DEFAULT_LIMIT,
  };
  if (params.businessDate) {
    body.businessDate = params.businessDate;
  }

  const syncRes = await fetch(
    `${params.origin}/api/pos/cukcuk/sainvoices/sync-to-sales`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pos-admin-secret": params.posAdminSecret,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    }
  );

  const elapsedMs = Date.now() - startedAt;
  const syncJson = await readJson(syncRes);

  return { syncRes, syncJson, elapsedMs };
}

export function buildSalesSyncCronResponse(params: {
  syncRes: Response;
  syncJson: JsonObject | null;
  elapsedMs: number;
  fallbackBusinessDate: string;
}) {
  const businessDate = resolveResponseBusinessDate(params.syncJson, params.fallbackBusinessDate);

  if (!params.syncRes.ok || params.syncJson?.ok === false) {
    return NextResponse.json(
      {
        ok: false,
        businessDate,
        elapsedMs: params.elapsedMs,
        error:
          typeof params.syncJson?.error === "string"
            ? params.syncJson.error
            : `sales sync failed: HTTP ${params.syncRes.status}`,
      },
      { status: params.syncRes.status }
    );
  }

  return NextResponse.json({
    ...normalizeSyncResponse(params.syncJson, params.elapsedMs),
    businessDate,
  });
}
