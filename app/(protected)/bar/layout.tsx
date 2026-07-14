"use client";

import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getBarTabs } from "@/lib/navigation/bar-tabs";

export default function BarLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { lang } = useLanguage();

  return (
    <Container noPaddingTop>
      <SubNav tabs={getBarTabs(pathname, lang)} />
      {children}
    </Container>
  );
}
