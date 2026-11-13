"use client";

import { useLanguage } from "@/lib/language-context";
import { tablesNavigationText } from "@/lib/text/tables-navigation";
import styles from "./navigation.module.css";

export default function ComingSoon() {
  const { lang } = useLanguage();
  return <main className={styles.placeholder}><p>{tablesNavigationText[lang].comingSoon}</p></main>;
}
