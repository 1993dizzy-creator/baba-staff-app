"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getLedgerTabs } from "@/lib/navigation/ledger-tabs";

const wrapperStyle = { maxWidth: 800, margin: "0 auto", padding: "0 16px" };

function LedgerTabs({ month }: { month?: string | null }) {
  const pathname = usePathname();
  const { lang } = useLanguage();
  return <div style={wrapperStyle}><SubNav tabs={getLedgerTabs(pathname, lang, month)} /></div>;
}

// The tabs carry the URL's selected month between 대시보드 and 장부작성.
function LedgerTabsWithMonth() {
  return <LedgerTabs month={useSearchParams().get("month")} />;
}

export default function LedgerSubNav() {
  return <Suspense fallback={<LedgerTabs />}><LedgerTabsWithMonth /></Suspense>;
}
