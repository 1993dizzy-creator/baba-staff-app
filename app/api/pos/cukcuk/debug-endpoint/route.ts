import { NextResponse } from "next/server";
import { CukcukAuthError, loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";
import {
  findTaxCandidateFields,
  readJsonSafely,
  type JsonObject,
} from "@/lib/pos/cukcuk/products";

export const runtime = "nodejs";

type DebugBody = {
  endpoint?: unknown;
  method?: unknown;
  query?: unknown;
  body?: unknown;
};

function isSafeEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("/api/")) return false;
  if (value.startsWith("//")) return false;
  if (value.includes("://")) return false;
  return true;
}

function normalizeMethod(value: unknown) {
  if (value === "POST") return "POST";
  return "GET";
}

function normalizeQuery(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const params = new URLSearchParams();
  Object.entries(value as JsonObject).forEach(([key, item]) => {
    if (item === null || item === undefined) return;
    params.set(key, String(item));
  });

  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function POST(req: Request) {
  const guardResponse = requirePosAdminSecret(req);
  if (guardResponse) return guardResponse;

  try {
    const body = (await req.json().catch(() => ({}))) as DebugBody;

    if (!isSafeEndpoint(body.endpoint)) {
      return NextResponse.json(
        {
          ok: false,
          error: "endpoint must be a CUKCUK Open Platform relative path starting with /api/.",
        },
        { status: 400 }
      );
    }

    const method = normalizeMethod(body.method);
    const query = normalizeQuery(body.query);
    const auth = await loginCukcuk();
    const endpoint = `${body.endpoint}${query}`;
    const response = await fetch(`${auth.request.baseUrl}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        CompanyCode: auth.companyCode,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? JSON.stringify(body.body || {}) : undefined,
      cache: "no-store",
    });
    const raw = await readJsonSafely(response);

    return NextResponse.json({
      ok: response.ok,
      request: {
        endpoint,
        method,
      },
      status: response.status,
      taxCandidateFields: findTaxCandidateFields(raw),
      raw,
    });
  } catch (error) {
    if (error instanceof CukcukAuthError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          status: error.status ?? 500,
          data: error.raw,
        },
        { status: 500 }
      );
    }

    console.error("[CUKCUK_DEBUG_ENDPOINT_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
