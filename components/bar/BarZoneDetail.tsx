import type { BarZoneDefinition } from "@/lib/bar/zone-map";
import { ui } from "@/lib/styles/ui";

type BarZoneDetailText = {
  selectZone: string;
  selectedZone: string;
  zoneCode: string;
  keepingUnavailable: string;
  noPhoto: string;
  noItems: string;
  futureManagement: string;
};

export default function BarZoneDetail({
  zone,
  lang,
  text,
}: {
  zone: BarZoneDefinition | null;
  lang: "ko" | "vi";
  text: BarZoneDetailText;
}) {
  if (!zone) {
    return (
      <section
        aria-live="polite"
        style={{
          ...ui.card,
          minHeight: 112,
          padding: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#6b7280",
          fontSize: 15,
          fontWeight: 800,
          textAlign: "center",
        }}
      >
        {text.selectZone}
      </section>
    );
  }

  const label = lang === "vi" ? zone.labelVi : zone.labelKo;
  const description = lang === "vi" ? zone.descriptionVi : zone.descriptionKo;

  return (
    <section aria-live="polite" style={{ ...ui.card, padding: 18 }}>
      <div style={{ color: "#6b7280", fontSize: 12, fontWeight: 800 }}>
        {text.selectedZone}
      </div>
      <h2 style={{ margin: "5px 0 4px", color: "#111827", fontSize: 21 }}>
        {label}
      </h2>
      <div style={{ color: "#6b7280", fontSize: 13, fontWeight: 700 }}>
        {text.zoneCode}: {zone.code}
      </div>
      <p style={{ margin: "14px 0", color: "#374151", fontSize: 14, lineHeight: 1.6 }}>
        {description}
      </p>
      {!zone.selectableForKeeping ? (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 12px",
            border: "1px solid #fbbf24",
            borderRadius: 10,
            background: "#fffbeb",
            color: "#92400e",
            fontSize: 13,
            fontWeight: 900,
          }}
        >
          {text.keepingUnavailable}
        </div>
      ) : null}
      <div
        style={{
          padding: 13,
          borderRadius: 10,
          background: "#f3f4f6",
          color: "#4b5563",
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        <div>{text.noPhoto}</div>
        <div>{text.noItems}</div>
      </div>
      <p
        style={{
          margin: "14px 0 0",
          color: "#6b7280",
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1.5,
        }}
      >
        {text.futureManagement}
      </p>
    </section>
  );
}
