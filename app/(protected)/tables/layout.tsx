"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { tablesNavigationText } from "@/lib/text/tables-navigation";
import styles from "./navigation.module.css";

export default function TablesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { lang } = useLanguage();
  const t = tablesNavigationText[lang];
  const isOverview = pathname === "/tables" || pathname === "/tables/reservations";

  return <>
    <div className={styles.navigation}>
      <nav aria-label={t.mainNavigation}>
        <SubNav tabs={[
          { href: "/tables", label: t.overview, active: isOverview },
          { href: "/tables/kitchen", label: t.kitchen, active: pathname === "/tables/kitchen" },
          { href: "/tables/bar", label: "BAR", active: pathname === "/tables/bar" },
        ]} />
      </nav>
      {isOverview ? <nav className={styles.subNavigation} aria-label={t.overview}>
        {[
          { href: "/tables", label: t.tables },
          { href: "/tables/reservations", label: t.reservations },
        ].map(tab => <Link key={tab.href} href={tab.href}
          aria-current={pathname === tab.href ? "page" : undefined}
          className={styles.subTab}>{tab.label}</Link>)}
      </nav> : null}
    </div>
    {children}
  </>;
}
