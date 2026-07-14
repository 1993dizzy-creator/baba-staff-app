"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { BarZoneDefinition } from "@/lib/bar/zone-map";
import BarZoneMap, { type BarZoneMapLabels } from "@/components/bar/BarZoneMap";

export default function BarZoneMapModal({
  selectedCode,
  onSelect,
  onClose,
  labels,
  lang,
  closeLabel,
  returnFocusRef,
}: {
  selectedCode: string | null;
  onSelect: (zone: BarZoneDefinition) => void;
  onClose: () => void;
  labels: BarZoneMapLabels;
  lang: "ko" | "vi";
  closeLabel: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const returnFocusTarget = returnFocusRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      returnFocusTarget?.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={lang === "vi" ? "Chọn khu vực BAR" : "BAR 구역 선택"}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        padding: 12,
        background: "rgba(0, 0, 0, 0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 1000,
          maxHeight: "92vh",
          padding: 14,
          borderRadius: 16,
          background: "#ffffff",
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.35)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginBottom: 8,
          }}
        >
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            style={{
              minWidth: 72,
              minHeight: 44,
              border: "1px solid #d1d5db",
              borderRadius: 10,
              background: "#ffffff",
              color: "#111827",
              fontSize: 14,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            {closeLabel}
          </button>
        </div>
        <div
          style={{
            width: "100%",
            overflowX: "auto",
            overflowY: "hidden",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <BarZoneMap
            selectedCode={selectedCode}
            onSelect={onSelect}
            labels={labels}
            lang={lang}
            expanded
          />
        </div>
      </div>
    </div>
  );
}
