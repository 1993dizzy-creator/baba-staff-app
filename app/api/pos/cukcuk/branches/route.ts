import { NextResponse } from "next/server";
import {
  CukcukAuthError,
  loginCukcuk,
} from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";

export const runtime = "nodejs";

type CukcukBranch = {
  Id?: string;
  ID?: string;
  Code?: string;
  Name?: string;
  IsBaseDepot?: boolean;
  IsChainBranch?: boolean;
  Inactive?: boolean;
  [key: string]: unknown;
};

type CukcukBranchResponse = {
  Code?: number;
  ErrorType?: number;
  ErrorMessage?: string;
  Success?: boolean;
  Environment?: string;
  Data?: CukcukBranch[];
  Total?: number;
  [key: string]: unknown;
};

async function readJsonSafely(response: Response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return {
      rawText: text,
    };
  }
}

function normalizeBranch(branch: CukcukBranch) {
  return {
    id: branch.Id ?? branch.ID ?? null,
    code: branch.Code ?? null,
    name: branch.Name ?? null,
    isBaseDepot: branch.IsBaseDepot ?? false,
    isChainBranch: branch.IsChainBranch ?? false,
    inactive: branch.Inactive ?? false,
  };
}

export async function GET(req: Request) {
  const guardResponse = requirePosAdminSecret(req);
  if (guardResponse) return guardResponse;

  const { searchParams } = new URL(req.url);
  const includeInactive = searchParams.get("includeInactive") === "true";

  try {
    const auth = await loginCukcuk();

    const endpoint = `/api/v1/branchs/all?includeInactive=${includeInactive}`;

const response = await fetch(`${auth.request.baseUrl}${endpoint}`, {
  method: "GET",
  headers: {
    Authorization: `Bearer ${auth.accessToken}`,
    CompanyCode: auth.companyCode,
  },
  cache: "no-store",
});

    const raw = (await readJsonSafely(response)) as CukcukBranchResponse | null;

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          status: response.status,
          error: "CUKCUK branches HTTP error",
          data: raw,
        },
        { status: 500 }
      );
    }

    if (!raw?.Success) {
      return NextResponse.json(
        {
          ok: false,
          status: response.status,
          error: "CUKCUK branches request failed",
          data: raw,
        },
        { status: 500 }
      );
    }

    const branches = Array.isArray(raw.Data)
      ? raw.Data.map(normalizeBranch)
      : [];

    return NextResponse.json({
      ok: true,
      request: {
        endpoint,
        includeInactive,
      },
      result: {
        status: response.status,
        total: raw.Total ?? branches.length,
        branches,
      },
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

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
