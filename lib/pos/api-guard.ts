import "server-only";
import crypto from "crypto";
import { NextResponse } from "next/server";

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function requirePosAdminSecret(req: Request) {
  const expected = process.env.POS_ADMIN_SECRET?.trim();

  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error: "POS admin API is disabled. POS_ADMIN_SECRET is not configured.",
      },
      { status: 403 }
    );
  }

  const actual = req.headers.get("x-pos-admin-secret")?.trim() || "";

  if (!actual || !safeEqual(actual, expected)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unauthorized POS admin request.",
      },
      { status: 401 }
    );
  }

  return null;
}
