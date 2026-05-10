import { NextResponse } from "next/server";
import {
  CukcukAuthError,
  type CukcukLoginRawResponse,
  loginCukcuk,
} from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";

export const runtime = "nodejs";

function maskToken(token?: string) {
  if (!token) return token;
  if (token.length <= 12) return "마스킹됨";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

function maskLoginResponse(raw?: CukcukLoginRawResponse) {
  if (!raw) return raw;

  return {
    ...raw,
    Data: raw.Data
      ? {
          ...raw.Data,
          AccessToken: maskToken(raw.Data.AccessToken),
        }
      : raw.Data,
  };
}

export async function GET(req: Request) {
  const guardResponse = requirePosAdminSecret(req);
  if (guardResponse) return guardResponse;

  try {
    const result = await loginCukcuk();

    return NextResponse.json({
      ok: true,
      request: {
        domain: result.domain,
        appId: result.appId,
        loginTime: result.loginTime,
      },
      result: {
        status: result.status,
        data: maskLoginResponse(result.raw),
      },
    });
  } catch (error) {
    if (error instanceof CukcukAuthError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          status: error.status ?? 500,
          data: maskLoginResponse(error.raw),
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
