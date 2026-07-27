"use client";

import type { CSSProperties } from "react";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { payrollText } from "@/lib/text/payroll";
import { ui } from "@/lib/styles/ui";

export default function PayrollSettingsPage() {
  const { lang } = useLanguage();
  const text = payrollText[lang];

  return (
    <Container>
      <section style={styles.card}>
        <div style={styles.eyebrow}>PAYROLL SETTINGS</div>
        <h1 style={styles.title}>{text.settingsTitle}</h1>
        <p style={styles.description}>{text.settingsDescription}</p>
        <div style={styles.notice}>{text.preparing}</div>
      </section>
    </Container>
  );
}

const styles = {
  card: { ...ui.card, padding: 20 },
  eyebrow: { ...ui.metaText, fontSize: 12, fontWeight: 900, letterSpacing: 0.7 },
  title: { margin: "6px 0 8px", fontSize: 24, fontWeight: 950, color: "#111827" },
  description: { ...ui.metaText, margin: "0 0 16px", fontSize: 14, lineHeight: 1.5 },
  notice: { padding: 14, borderRadius: 14, background: "#f9fafb", border: "1px solid #e5e7eb", fontSize: 13, lineHeight: 1.45, color: "#374151", fontWeight: 700 },
} satisfies Record<string, CSSProperties>;
