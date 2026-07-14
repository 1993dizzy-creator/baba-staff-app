"use client";

import { useLanguage } from "@/lib/language-context";
import { barText } from "@/lib/text/bar";
import { ui } from "@/lib/styles/ui";

export default function BarLogsPage() {
  const { lang } = useLanguage();
  const t = barText[lang];

  return (
    <div style={{ padding: "12px 0 20px" }}>
      <h1 style={{ margin: 0, fontSize: 26, color: "#111827" }}>
        {t.logsTitle}
      </h1>
      <p
        style={{
          margin: "8px 0 16px",
          color: "#6b7280",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {t.logsDescription}
      </p>
      <section
        style={{
          ...ui.card,
          minHeight: 180,
          padding: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#6b7280",
          fontSize: 15,
          fontWeight: 800,
          textAlign: "center",
        }}
      >
        {t.logsPreparing}
      </section>
    </div>
  );
}
