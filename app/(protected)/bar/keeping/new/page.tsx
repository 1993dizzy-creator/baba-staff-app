"use client";

import Link from "next/link";
import KeepingForm from "@/components/bar/keeping/KeepingForm";
import { useLanguage } from "@/lib/language-context";
import { keepingNewText } from "@/lib/text/bar-keeping-new";

export default function NewKeepingPage() {
  const { lang } = useLanguage();
  const text = keepingNewText[lang];
  return (
    <div style={{ padding: "0 0 14px" }}>
      <div style={{ display: "flex", alignItems: "center", minHeight: 36, marginBottom: 7 }}>
        <Link href="/bar/keeping" style={{ display: "inline-flex", alignItems: "center", minHeight: 36, color: "#374151", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>{text.back}</Link>
      </div>
      <KeepingForm lang={lang} />
    </div>
  );
}
