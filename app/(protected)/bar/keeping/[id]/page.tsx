"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import KeepingDetail from "@/components/bar/keeping/KeepingDetail";
import { KeepingSkeleton } from "@/components/bar/keeping/KeepingBasics";
import type { BarKeeping, KeepingCapabilities } from "@/lib/bar/keeping-types";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import { safeKeepingReturnPath } from "@/lib/bar/keeping";
import { useLanguage } from "@/lib/language-context";
import { keepingText } from "@/lib/text/bar-keeping";
import { ui } from "@/lib/styles/ui";

export default function KeepingDetailPage() {
  const { lang } = useLanguage(); const t = keepingText[lang];
  const params = useParams<{ id: string }>(); const search = useSearchParams();
  const [item, setItem] = useState<BarKeeping | null>(null); const [capabilities, setCapabilities] = useState<KeepingCapabilities | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/bar/keepings/${params.id}`, { cache: "no-store" });
      if (await handleBarApiUnauthorized(response)) return;
      if (!response.ok) throw new Error(response.status === 404 ? "Not found" : t.error);
      const result = await response.json(); setItem(result.item); setCapabilities(result.capabilities);
    } catch (caught) { setError(caught instanceof Error ? caught.message : t.error); }
    finally { setLoading(false); }
  }, [params.id, t.error]);
  useEffect(() => { void load(); }, [load]);
  const back = safeKeepingReturnPath(search.get("from"));
  if (loading) return <div style={{ paddingTop: 2 }}><KeepingSkeleton /></div>;
  if (error || !item || !capabilities) return <section role="alert" style={{ ...ui.card, padding: 18, color: "#b91c1c" }}>{error || t.error}<button onClick={() => void load()} style={{ marginLeft: 8 }}>{t.retry}</button></section>;
  return <KeepingDetail item={item} capabilities={capabilities} lang={lang} back={back} onRefresh={load} />;
}
