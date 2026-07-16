"use client";

import KeepingForm from "@/components/bar/keeping/KeepingForm";
import { useLanguage } from "@/lib/language-context";

export default function NewKeepingPage() {
  const { lang } = useLanguage();
  return (
    <div style={{ padding: "0 0 14px" }}>
      <KeepingForm lang={lang} />
    </div>
  );
}
