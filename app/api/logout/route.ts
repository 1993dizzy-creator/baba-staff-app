import { NextResponse } from "next/server";
import { clearServerSessionCookie } from "@/lib/auth/server-session";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearServerSessionCookie(response);
  return response;
}
