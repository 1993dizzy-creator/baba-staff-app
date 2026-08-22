"use client";

import { usePathname } from "next/navigation";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getLedgerTabs } from "@/lib/navigation/ledger-tabs";

const wrapperStyle = { maxWidth: 800, margin: "0 auto", padding: "0 16px" };

export default function LedgerSubNav() {
  const pathname = usePathname();
  const { lang } = useLanguage();
  return <div style={wrapperStyle}><SubNav tabs={getLedgerTabs(pathname, lang)} /></div>;
}
