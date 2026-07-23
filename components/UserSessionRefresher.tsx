"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { handleSessionUnauthorized } from "@/lib/auth/client-session";

type CachedUser = {
  language?: string | null;
  [key: string]: unknown;
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

export default function UserSessionRefresher() {
  const pathname = usePathname();
  const lastRefreshAtRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Attendance has its own stricter server-session guard.
    if (pathname.startsWith("/attendance")) return;

    async function refreshUserSession(force = false) {
      if (inFlightRef.current) return;

      const now = Date.now();
      if (!force && now - lastRefreshAtRef.current < REFRESH_THROTTLE_MS) {
        return;
      }

      inFlightRef.current = true;
      lastRefreshAtRef.current = now;

      try {
        const sessionResponse = await fetch("/api/session", {
          cache: "no-store",
        });
        if (sessionResponse.status === 401) {
          handleSessionUnauthorized(sessionResponse);
          return;
        }

        const sessionResult = (await sessionResponse
          .json()
          .catch(() => null)) as SessionResponse | null;

        const succeeded = Boolean(
          sessionResult?.authenticated === true
        );
        if (!sessionResponse.ok || !succeeded || !sessionResult?.user) {
          console.warn(
            "Failed to refresh baba_user",
            sessionResult?.code
          );
          return;
        }

        const cachedUser = readCachedUser();
        const nextUser = {
          ...cachedUser,
          ...sessionResult.user,
          language: cachedUser?.language ?? sessionResult.user.language,
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
