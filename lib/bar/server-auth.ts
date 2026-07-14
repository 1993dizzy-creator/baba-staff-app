import "server-only";

import { NextResponse } from "next/server";
import { readServerSession } from "@/lib/auth/server-session";
import { supabaseServer } from "@/lib/supabase/server";

export type BarServerActor = {
  id: number;
  username: string;
  name: string;
  full_name: string | null;
  role: string;
  part: string | null;
  position: string | null;
  is_active: boolean;
};

export async function getBarServerActor() {
  let session;
  try {
    session = await readServerSession();
  } catch (error) {
    console.error("[BAR_SESSION_CONFIG_ERROR]", error);
    return {
      actor: null,
      response: NextResponse.json(
        { ok: false, error: "Server session is not configured." },
        { status: 500 }
      ),
    };
  }

  if (!session) {
    return {
      actor: null,
      response: NextResponse.json(
        { ok: false, error: "Re-login required", code: "RELOGIN_REQUIRED" },
        { status: 401 }
      ),
    };
  }

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, name, full_name, role, part, position, is_active")
    .eq("id", session.uid)
    .maybeSingle();

  if (error) throw new Error(`Failed to verify BAR actor: ${error.message}`);
  if (!data || data.is_active !== true) {
    return {
      actor: null,
      response: NextResponse.json(
        { ok: false, error: "Inactive or missing user", code: "RELOGIN_REQUIRED" },
        { status: 401 }
      ),
    };
  }

  const actorId = Number(data.id);
  if (!Number.isSafeInteger(actorId) || actorId < 1) {
    console.error("[BAR_ACTOR_ID_INVALID]");
    return {
      actor: null,
      response: NextResponse.json(
        { ok: false, error: "Invalid user session", code: "RELOGIN_REQUIRED" },
        { status: 401 }
      ),
    };
  }

  return {
    actor: {
      ...data,
      id: actorId,
      name: data.name || data.full_name || data.username,
    } as BarServerActor,
    response: null,
  };
}
