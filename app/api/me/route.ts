import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

type MeRequestBody = {
  username?: unknown;
  id?: unknown;
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

function normalizeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function findUser(params: { username?: unknown; id?: unknown }) {
  const username = normalizeText(params.username);
  const id = normalizeText(params.id);

  if (!username && !id) {
    return {
      response: NextResponse.json(
        { ok: false, error: "username or id is required" },
        { status: 400 }
      ),
    };
  }

  let query = supabaseServer.from("users").select(USER_SELECT);

  if (username) {
    query = query.eq("username", username);
  } else {
    query = query.eq("id", id);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch user: ${error.message}`);
  }

  if (!data) {
    return {
      response: NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 }
      ),
    };
  }

  if (data.is_active === false) {
    return {
      response: NextResponse.json(
        { ok: false, error: "Inactive user" },
        { status: 403 }
      ),
    };
  }

  return {
    response: NextResponse.json({
      ok: true,
      user: data,
    }),
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const { response } = await findUser({
      username: searchParams.get("username"),
      id: searchParams.get("id"),
    });

    return response;
  } catch (error) {
    console.error("[ME_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch user.",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as MeRequestBody;
    const { response } = await findUser({
      username: body.username,
      id: body.id,
    });

    return response;
  } catch (error) {
    console.error("[ME_POST_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch user.",
      },
      { status: 500 }
    );
  }
}
