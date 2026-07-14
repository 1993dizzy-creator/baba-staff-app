import { NextResponse } from "next/server";
import { canViewBar } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { getBarZones } from "@/lib/bar/server-data";

export async function GET() {
  try {
    const { actor, response } = await getBarServerActor();
    if (response || !actor) return response;
    if (!canViewBar(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ ok: true, zones: await getBarZones() });
  } catch (error) {
    console.error("[BAR_ZONES_GET_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to load BAR zones" }, { status: 500 });
  }
}

