import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;
type CategoryGroupType = "food" | "drink" | "uncategorized";

const CATEGORY_GROUP_TYPES = new Set<CategoryGroupType>([
  "food",
  "drink",
  "uncategorized",
]);

function canManageCategoryGroups(role: unknown) {
  return role === "owner" || role === "master" || role === "manager";
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isCategoryGroupType(value: string): value is CategoryGroupType {
  return CATEGORY_GROUP_TYPES.has(value as CategoryGroupType);
}

function isMissingCategoryGroupTableError(error: unknown) {
  if (!error || typeof error !== "object") return false;

  const value = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  const code = typeof value.code === "string" ? value.code : "";
  const message = [value.message, value.details, value.hint]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();

  return (
    code === "PGRST205" ||
    code === "42P01" ||
    message.includes("schema cache") ||
    message.includes("relation") && message.includes("does not exist") ||
    message.includes("could not find the table")
  );
}

function missingCategoryGroupTableResponse() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "category group mapping table is missing; run the Supabase migration first.",
    },
    { status: 503 }
  );
}

async function getAdminActor(actorUsername: string) {
  if (!actorUsername) return null;

  const { data } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (!data || !canManageCategoryGroups(data.role)) return null;
  return data;
}

export async function GET(req: Request) {
  try {
    const actorUsername = getString(
      new URL(req.url).searchParams.get("actorUsername")
    );
    const actor = await getAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const { data, error } = await supabaseServer
      .from("pos_category_group_mappings")
      .select(
        "id, category_name, group_type, display_name, note, created_at, updated_at, updated_by"
      )
      .order("category_name", { ascending: true });

    if (error) {
      if (isMissingCategoryGroupTableError(error)) {
        return missingCategoryGroupTableResponse();
      }
      throw error;
    }

    return NextResponse.json({
      ok: true,
      mappings: data || [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load category group mappings.",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actorUsername = getString(body.actorUsername);
    const categoryName = getString(body.categoryName);
    const groupType = getString(body.groupType);

    if (!categoryName || categoryName.length > 200) {
      return NextResponse.json(
        { ok: false, error: "categoryName is required." },
        { status: 400 }
      );
    }

    if (!isCategoryGroupType(groupType)) {
      return NextResponse.json(
        { ok: false, error: "Invalid groupType." },
        { status: 400 }
      );
    }

    const actor = await getAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const now = new Date().toISOString();
    const { data, error } = await supabaseServer
      .from("pos_category_group_mappings")
      .upsert(
        {
          category_name: categoryName,
          group_type: groupType,
          updated_at: now,
          updated_by: actor.username,
        },
        { onConflict: "category_name" }
      )
      .select(
        "id, category_name, group_type, display_name, note, created_at, updated_at, updated_by"
      )
      .single();

    if (error) {
      if (isMissingCategoryGroupTableError(error)) {
        return missingCategoryGroupTableResponse();
      }
      throw error;
    }

    return NextResponse.json({
      ok: true,
      mapping: data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to save category group mapping.",
      },
      { status: 500 }
    );
  }
}
