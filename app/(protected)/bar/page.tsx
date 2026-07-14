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
    equipmentShort: t.equipmentShort,
    mapAriaLabel: t.mapAriaLabel,
  };

  return (
    <div style={{ minWidth: 0, maxWidth: "100%", padding: "0 0 24px" }}>
      <section
        style={{
          minWidth: 0,
          padding: 0,
          marginBottom: 8,
          border: "1px solid #dcdfe4",
          borderRadius: 10,
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
          marginBottom: 14,
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
          keepingUnavailable: t.keepingUnavailable,
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
