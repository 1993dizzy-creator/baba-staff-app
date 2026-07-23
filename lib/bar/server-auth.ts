import "server-only";

import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";

export type BarServerActor = {
  id: number;
  username: string;
  name: string;
  role: string;
  part: string | null;
  position: string | null;
  is_active: true;
};

export async function getBarServerActor() {
  const auth = await getAuthenticatedActor();
  if (!auth.ok) {
    return {
      actor: null,
      response: NextResponse.json(
        {
          ok: false,
          error: auth.status === 500 ? "Failed to verify BAR session" : "Login is required",
          code: auth.code,
        },
        { status: auth.status }
      ),
    };
  }

  return {
    actor: {
      ...auth.actor,
      // getAuthenticatedActor() only succeeds after reloading the session UID
      // from users and confirming that the current DB row is active.
      is_active: true,
    } satisfies BarServerActor,
    response: null,
  };
}
