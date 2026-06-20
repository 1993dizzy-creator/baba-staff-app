import { NextResponse } from "next/server";
import { getMappingAdminActor } from "@/lib/pos/mapping-admin";
import { isMissingMappingSchemaError } from "@/lib/pos/mapping-catalog";
import { validatePosMappings } from "@/lib/pos/mapping-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const actorUsername = (
      new URL(req.url).searchParams.get("actorUsername") || ""
    ).trim();
    const actor = await getMappingAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const result = await validatePosMappings();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (isMissingMappingSchemaError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "POS mapping catalog migration has not been applied.",
        },
        { status: 503 }
      );
    }

    console.error("[ADMIN_POS_MAPPINGS_VALIDATION_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to validate POS mappings.",
      },
      { status: 500 }
    );
  }
}
