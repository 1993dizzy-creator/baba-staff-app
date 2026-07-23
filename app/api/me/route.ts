import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export async function GET() {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { authenticated: false, code: auth.code },
        { status: auth.status, headers: NO_STORE_HEADERS }
      );
    }

    return NextResponse.json(
      {
        authenticated: true,
        user: auth.actor,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("[ME_GET_ERROR]", error);
    return NextResponse.json(
      { authenticated: false, code: "ME_CHECK_FAILED" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

export async function POST() {
  return NextResponse.json(
    { authenticated: false, code: "METHOD_NOT_ALLOWED" },
    {
      status: 405,
      headers: { ...NO_STORE_HEADERS, Allow: "GET" },
    }
  );
}
