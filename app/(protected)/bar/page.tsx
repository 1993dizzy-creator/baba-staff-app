"use client";

import { useCallback, useRef, useState } from "react";
import BarZoneDetail from "@/components/bar/BarZoneDetail";
import BarZoneMap, { type BarZoneMapLabels } from "@/components/bar/BarZoneMap";
import BarZoneMapModal from "@/components/bar/BarZoneMapModal";
import type { BarZoneDefinition } from "@/lib/bar/zone-map";
import { useLanguage } from "@/lib/language-context";
import { barText } from "@/lib/text/bar";
import { ui } from "@/lib/styles/ui";

export default function BarAreaPage() {
  const { lang } = useLanguage();
  const t = barText[lang];
  const [selectedZone, setSelectedZone] = useState<BarZoneDefinition | null>(null);
  const [isMapModalOpen, setIsMapModalOpen] = useState(false);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const closeMapModal = useCallback(() => setIsMapModalOpen(false), []);

  const mapLabels: BarZoneMapLabels = {
    upper: t.upper,
    middle: t.middle,
    lower: t.lower,
    leftShort: t.leftShort,
    rightShort: t.rightShort,
    unavailable: t.unavailable,
    posDirection: t.posDirection,
    equipmentDirection: t.equipmentDirection,
  };

  return (
    <div style={{ minWidth: 0, maxWidth: "100%", padding: "12px 0 24px" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, color: "#111827", fontSize: 26 }}>{t.areaTitle}</h1>
        <p
          style={{
            margin: "8px 0 0",
            color: "#6b7280",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {t.areaDescription}
        </p>
      </header>

      <section
        style={{
          ...ui.card,
          minWidth: 0,
          padding: 12,
          marginBottom: 12,
          overflow: "hidden",
        }}
      >
        <BarZoneMap
          selectedCode={selectedZone?.code ?? null}
          onSelect={setSelectedZone}
          labels={mapLabels}
          lang={lang}
        />
      </section>

      <button
        ref={expandButtonRef}
        type="button"
        onClick={() => setIsMapModalOpen(true)}
        style={{
          ...ui.subButton,
          minHeight: 48,
          marginBottom: 16,
          fontWeight: 800,
        }}
      >
        {t.enlargeMap}
      </button>

      <BarZoneDetail
        zone={selectedZone}
        lang={lang}
        text={{
          selectZone: t.selectZone,
          selectedZone: t.selectedZone,
          zoneCode: t.zoneCode,
          noPhoto: t.noPhoto,
          noItems: t.noItems,
          futureManagement: t.futureManagement,
        }}
      />

      {isMapModalOpen ? (
        <BarZoneMapModal
          selectedCode={selectedZone?.code ?? null}
          onSelect={setSelectedZone}
          onClose={closeMapModal}
          labels={mapLabels}
          lang={lang}
          closeLabel={t.close}
          returnFocusRef={expandButtonRef}
        />
      ) : null}
    </div>
  );
}
