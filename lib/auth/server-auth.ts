import "server-only";

import { readServerSession, type ServerSessionPayload } from "@/lib/auth/server-session";
import { supabaseServer } from "@/lib/supabase/server";

export type AuthenticatedActor = {
  id: number;
  username: string;
  name: string;
  role: string;
  part: string | null;
  position: string | null;
};

export type AuthenticationFailureCode =
  | "RELOGIN_REQUIRED"
  | "SESSION_CONFIG_ERROR"
  | "FORBIDDEN";

type AuthenticationSuccess = {
  ok: true;
  actor: AuthenticatedActor;
  session: ServerSessionPayload;
};

type AuthenticationFailure = {
  ok: false;
  status: 401 | 403 | 500;
  code: AuthenticationFailureCode;
};

export type AuthenticationResult =
  | AuthenticationSuccess
  | AuthenticationFailure;

export async function getAuthenticatedActor(): Promise<AuthenticationResult> {
  let session;
  try {
    session = await readServerSession();
  } catch (error) {
    console.error("[SERVER_SESSION_CONFIG_ERROR]", error);
    return { ok: false, status: 500, code: "SESSION_CONFIG_ERROR" };
  }

  if (!session) {
    return { ok: false, status: 401, code: "RELOGIN_REQUIRED" };
  }

  const { data, error } = await supabaseServer
    .from("users")
    .select("id,username,name,full_name,role,part,position,is_active")
    .eq("id", session.uid)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify authenticated actor: ${error.message}`);
  }
  if (!data || data.is_active !== true) {
    return { ok: false, status: 401, code: "RELOGIN_REQUIRED" };
  }

  const id = Number(data.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return { ok: false, status: 401, code: "RELOGIN_REQUIRED" };
  }

  return {
    ok: true,
    session,
    actor: {
      id,
      username: String(data.username),
      name: String(data.name || data.full_name || data.username),
      role: String(data.role || "").trim().toLowerCase(),
      part: data.part == null ? null : String(data.part),
      position: data.position == null ? null : String(data.position),
    },
  };
}

export async function requireRole(
  allowedRoles: readonly string[]
): Promise<AuthenticationResult> {
  const result = await getAuthenticatedActor();
  if (!result.ok) return result;
  if (!allowedRoles.includes(result.actor.role)) {
    return { ok: false, status: 403, code: "FORBIDDEN" };
  }
  return result;
}
