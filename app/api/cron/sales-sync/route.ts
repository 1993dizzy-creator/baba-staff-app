import crypto from "crypto";
import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

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

function normalizeSyncResponse(syncJson: JsonObject | null, elapsedMs: number) {
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

function authorizeCron(req: Request) {
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

export async function GET(req: Request) {
  const guardResponse = authorizeCron(req);
  if (guardResponse) return guardResponse;

  const posAdminSecret = process.env.POS_ADMIN_SECRET?.trim();

  if (!posAdminSecret) {
    return NextResponse.json(
      { ok: false, error: "POS_ADMIN_SECRET is not configured." },
      { status: 403 }
    );
  }

  const businessDate = getBusinessDate();
  const origin = new URL(req.url).origin;
  const startedAt = Date.now();

  // Configure schedule outside the app, for example in Vercel Cron.
  // This route intentionally always uses force=false.
  const syncRes = await fetch(
    `${origin}/api/pos/cukcuk/sainvoices/sync-to-sales`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pos-admin-secret": posAdminSecret,
      },
      body: JSON.stringify({
        businessDate,
        force: false,
        limit: DEFAULT_LIMIT,
      }),
      cache: "no-store",
    }
  );

  const elapsedMs = Date.now() - startedAt;
  const syncJson = await readJson(syncRes);

  if (!syncRes.ok || syncJson?.ok === false) {
    return NextResponse.json(
      {
        ok: false,
        businessDate,
        elapsedMs,
        error:
          typeof syncJson?.error === "string"
            ? syncJson.error
            : `sales sync failed: HTTP ${syncRes.status}`,
      },
      { status: syncRes.status }
    );
  }

  return NextResponse.json({
    ...normalizeSyncResponse(syncJson, elapsedMs),
    businessDate,
  });
}
