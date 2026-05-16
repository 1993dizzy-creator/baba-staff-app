"use client";

import { useEffect, useRef } from "react";

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

function redirectToLogin() {
  try {
    window.localStorage.removeItem("baba_user");
  } catch {
    // Ignore storage cleanup errors during forced logout.
  }

  window.dispatchEvent(new Event(USER_UPDATED_EVENT));
  window.location.href = "/login";
}

export default function UserSessionRefresher() {
  const lastRefreshAtRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
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
        const res = await fetch(
          `/api/me?username=${encodeURIComponent(username)}`,
          {
            cache: "no-store",
          }
        );

        const result = (await res.json().catch(() => null)) as MeResponse | null;

        if (res.status === 403 || res.status === 404) {
          redirectToLogin();
          return;
        }

        if (!res.ok || !result?.ok || !result.user) {
          console.warn("Failed to refresh baba_user", result?.error);
          return;
        }

        const nextUser = {
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
  }, []);

  return null;
}
