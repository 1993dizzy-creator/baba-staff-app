"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { notificationText } from "@/lib/text/notifications";
import { isSafeInternalHref } from "@/lib/notifications/types";

// Push click landing (01-B). The protected layout has already required a login. The server
// re-checks recipient + current permission and returns an internal path only; anything else
// (not a recipient, permission lost, resolved without a path, error) lands on the center.
function OpenNotification() {
  const router = useRouter();
  const params = useSearchParams();
  const { lang } = useLanguage();
  const t = notificationText[lang];
  const id = params.get("id");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      let target = "/notifications";
      if (id && /^[1-9]\d{0,15}$/.test(id)) {
        try {
          const response = await fetch(`/api/notifications/push/open?id=${id}`, { cache: "no-store", signal: controller.signal });
          const json = await response.json().catch(() => null);
          if (response.ok && json?.ok === true && isSafeInternalHref(json.href)) target = json.href;
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (!controller.signal.aborted) router.replace(target);
    })();
    return () => controller.abort();
  }, [id, router]);

  return <Container><p style={{ padding: "28px 0", textAlign: "center", color: "#6b7280", fontSize: 14 }}>{t.loading}</p></Container>;
}

export default function NotificationOpenPage() {
  return (
    <Suspense fallback={null}>
      <OpenNotification />
    </Suspense>
  );
}
