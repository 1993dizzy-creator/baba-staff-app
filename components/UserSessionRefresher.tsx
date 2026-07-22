"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

type CachedUser = {
  id?: string | number | null;
  username?: string | null;
  language?: string | null;
  [key: string]: unknown;
};

type MeResponse = {
  ok: boolean;
  user?: CachedUser;
  error?: string;
};

type SessionResponse = {
  authenticated: boolean;
  user?: CachedUser;
  code?: string;
};

const REFRESH_THROTTLE_MS = 60 * 1000;
const USER_UPDATED_EVENT = "baba_user_updated";

function readCachedUser() {
  try {
    const raw = window.localStorage.getItem("baba_user");
    return raw ? (JSON.parse(raw) as CachedUser) : null;
  } catch {
    return null;
  }
}

async function redirectToLogin() {
  try {
    await fetch("/api/logout", { method: "POST", keepalive: true });
  } catch {
    // Local logout must still complete if the server is unavailable.
  }
  try {
    window.localStorage.removeItem("baba_user");
  } catch {
    // Ignore storage cleanup errors during forced logout.
  }

  window.dispatchEvent(new Event(USER_UPDATED_EVENT));
  window.location.href = "/login";
}

export default function UserSessionRefresher() {
  const pathname = usePathname();
  const lastRefreshAtRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Attendance has a stricter guard that must treat only /api/session as
    // authentication. Avoid a duplicate check and the legacy /api/me fallback.
    if (pathname.startsWith("/attendance")) return;

    async function refreshUserSession(force = false) {
      if (inFlightRef.current) return;

      const now = Date.now();
      if (!force && now - lastRefreshAtRef.current < REFRESH_THROTTLE_MS) {
        return;
      }

      const cachedUser = readCachedUser();
      const username =
        typeof cachedUser?.username === "string" ? cachedUser.username : "";

      if (!username) return;

      inFlightRef.current = true;
      lastRefreshAtRef.current = now;

      try {
        const sessionResponse = await fetch("/api/session", {
          cache: "no-store",
        });
        const sessionResult = (await sessionResponse
          .json()
          .catch(() => null)) as SessionResponse | null;

        let result: MeResponse | SessionResponse | null = sessionResult;
        let responseStatus = sessionResponse.status;

        // Transitional compatibility: an expired or missing legacy cookie must
        // not interrupt attendance before attendance APIs require server auth.
        if (sessionResponse.status === 401) {
          const legacyResponse = await fetch(
            `/api/me?username=${encodeURIComponent(username)}`,
            { cache: "no-store" }
          );
          result = (await legacyResponse
            .json()
            .catch(() => null)) as MeResponse | null;
          responseStatus = legacyResponse.status;
        }

        if (responseStatus === 403 || responseStatus === 404) {
          await redirectToLogin();
          return;
        }

        const succeeded = Boolean(
          result &&
            (("authenticated" in result && result.authenticated === true) ||
              ("ok" in result && result.ok === true))
        );
        if (responseStatus >= 400 || !succeeded || !result?.user) {
          let errorCode: string | undefined;
          if (result && "error" in result) errorCode = result.error;
          else if (result && "code" in result) errorCode = result.code;
          console.warn(
            "Failed to refresh baba_user",
            errorCode
          );
          return;
        }

        const nextUser = {
          ...cachedUser,
          ...result.user,
          language: cachedUser?.language ?? result.user.language,
        };
        const previousJson = JSON.stringify(cachedUser);
        const nextJson = JSON.stringify(nextUser);

        window.localStorage.setItem("baba_user", nextJson);

        if (previousJson !== nextJson) {
          window.dispatchEvent(new Event(USER_UPDATED_EVENT));
        }
      } catch (error) {
        console.warn("Failed to refresh baba_user", error);
      } finally {
        inFlightRef.current = false;
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshUserSession();
      }
    };

    const handleFocus = () => {
      refreshUserSession();
    };

    refreshUserSession(true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [pathname]);

  return null;
}
