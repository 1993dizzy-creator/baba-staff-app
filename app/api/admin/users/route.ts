import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

type JsonObject = Record<string, unknown>;

type UserRow = {
  id: number | string;
  username: string;
  name: string | null;
  full_name: string | null;
  role: string | null;
  part: string | null;
  position: string | null;
  gender: string | null;
  birth_date: string | null;
  hire_date: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
  is_active: boolean | null;
};

const USER_SELECT = `
  id,
  username,
  name,
  full_name,
  role,
  part,
  position,
  birth_date,
  hire_date,
  gender,
  work_start_time,
  work_end_time,
  is_active
`;

const ROLE_ORDER = new Map([
  ["owner", 0],
  ["master", 1],
]);

const POSITION_ORDER = new Map([
  ["manager", 2],
  ["leader", 3],
  ["staff", 4],
]);

const ALLOWED_ROLES = new Set(["owner", "manager", "leader", "staff"]);
const BLOCKED_FORM_ROLES = new Set(["master", "admin"]);
const ALLOWED_POSITIONS = new Set(["owner", "manager", "leader", "staff"]);
const ALLOWED_UPDATE_KEYS = new Set([
  "name",
  "full_name",
  "role",
  "part",
  "position",
  "gender",
  "birth_date",
  "hire_date",
  "work_start_time",
  "work_end_time",
  "is_active",
]);

function normalizeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nullableText(value: unknown) {
  const text = normalizeText(value);
  return text || null;
}

function nullableDate(value: unknown) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function nullableTime(value: unknown) {
  const text = normalizeText(value);
  return /^\d{2}:\d{2}$/.test(text) ? text : null;
}

function normalizeRole(value: unknown) {
  const role = normalizeText(value);
  return ALLOWED_ROLES.has(role) ? role : null;
}

function getLang(value: unknown) {
  return value === "vi" ? "vi" : "ko";
}

function getBlockedRoleError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể chọn quyền này."
    : "선택할 수 없는 권한입니다.";
}

function getMasterEditError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể chỉnh sửa tài khoản master."
    : "마스터 계정은 수정할 수 없습니다.";
}

function getBlockedPositionError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể chọn chức vụ này."
    : "선택할 수 없는 직급입니다.";
}

async function getAdminActor(actorUsername: unknown) {
  const username = normalizeText(actorUsername);

  if (!username) return null;

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", username)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify admin actor: ${error.message}`);
  }

  if (data?.role !== "owner" && data?.role !== "master") return null;
  return data;
}

function sortUsers(users: UserRow[]) {
  return [...users].sort((a, b) => {
    const aRank =
      ROLE_ORDER.get(a.role || "") ??
      POSITION_ORDER.get((a.position || "").toLowerCase()) ??
      99;
    const bRank =
      ROLE_ORDER.get(b.role || "") ??
      POSITION_ORDER.get((b.position || "").toLowerCase()) ??
      99;
    const rankDiff = aRank - bRank;
    if (rankDiff !== 0) return rankDiff;

    const activeDiff = Number(b.is_active === true) - Number(a.is_active === true);
    if (activeDiff !== 0) return activeDiff;

    const aName = (a.name || a.full_name || a.username || "").toLowerCase();
    const bName = (b.name || b.full_name || b.username || "").toLowerCase();
    return aName.localeCompare(bName);
  });
}

function normalizeUpdate(input: JsonObject) {
  const update: JsonObject = {};

  Object.entries(input).forEach(([key, value]) => {
    if (!ALLOWED_UPDATE_KEYS.has(key)) return;

    if (key === "role") {
      const role = normalizeRole(value);
      if (role) update.role = role;
      return;
    }

    if (key === "is_active") {
      update.is_active = value === true;
      return;
    }

    if (key === "birth_date" || key === "hire_date") {
      update[key] = nullableDate(value);
      return;
    }

    if (key === "work_start_time" || key === "work_end_time") {
      update[key] = nullableTime(value);
      return;
    }

    update[key] = nullableText(value);
  });

  return update;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const actor = await getAdminActor(searchParams.get("actorUsername"));

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const { data, error } = await supabaseServer.from("users").select(USER_SELECT);

    if (error) {
      throw new Error(`Failed to fetch users: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      users: sortUsers((data || []) as UserRow[]),
    });
  } catch (error) {
    console.error("[ADMIN_USERS_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch users.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const actor = await getAdminActor(body.actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const id = body.id;
    const lang = getLang(body.lang);

    if (typeof id !== "number" && typeof id !== "string") {
      return NextResponse.json(
        { ok: false, error: "User id is required" },
        { status: 400 }
      );
    }

    const inputUpdates = (body.updates || {}) as JsonObject;
    const requestedRole = normalizeText(inputUpdates.role);

    if (BLOCKED_FORM_ROLES.has(requestedRole)) {
      return NextResponse.json(
        { ok: false, error: getBlockedRoleError(lang) },
        { status: 403 }
      );
    }

    if (Object.prototype.hasOwnProperty.call(inputUpdates, "position")) {
      const requestedPosition = normalizeText(inputUpdates.position);

      if (!ALLOWED_POSITIONS.has(requestedPosition)) {
        return NextResponse.json(
          { ok: false, error: getBlockedPositionError(lang) },
          { status: 400 }
        );
      }
    }

    const update = normalizeUpdate(inputUpdates);

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { ok: false, error: "No editable fields" },
        { status: 400 }
      );
    }

    const { data: target, error: targetError } = await supabaseServer
      .from("users")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();

    if (targetError) {
      throw new Error(`Failed to fetch target user: ${targetError.message}`);
    }

    if (!target) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 }
      );
    }

    if (target.role === "master") {
      return NextResponse.json(
        {
          ok: false,
          error: getMasterEditError(lang),
        },
        { status: 403 }
      );
    }

    const { data, error } = await supabaseServer
      .from("users")
      .update(update)
      .eq("id", id)
      .select(USER_SELECT)
      .single();

    if (error) {
      throw new Error(`Failed to update user: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      user: data as UserRow,
    });
  } catch (error) {
    console.error("[ADMIN_USERS_PATCH_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to update user.",
      },
      { status: 500 }
    );
  }
}
