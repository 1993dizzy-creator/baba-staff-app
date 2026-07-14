"use client";

import { useState } from "react";
import {
  BAR_ZONE_MAP_VIEW_BOX,
  barUnavailableUpperCabinets,
  barZones,
  type BarZoneDefinition,
} from "@/lib/bar/zone-map";

export type BarZoneMapLabels = {
  upper: string;
  middle: string;
  lower: string;
  leftShort: string;
  rightShort: string;
  unavailable: string;
  posDirection: string;
  equipmentDirection: string;
};

type BarZoneMapProps = {
  selectedCode: string | null;
  onSelect: (zone: BarZoneDefinition) => void;
  labels: BarZoneMapLabels;
  lang: "ko" | "vi";
  expanded?: boolean;
};

const colors = {
  line: "#9ca3af",
  text: "#111827",
  mutedText: "#6b7280",
  zone: "#ffffff",
  zoneHover: "#f3f4f6",
  selected: "#111827",
  selectedText: "#ffffff",
  focus: "#f59e0b",
  unavailable: "#e5e7eb",
  doorLine: "#d1d5db",
} as const;

const GRID_X = 100;
const CELL_WIDTH = 90;

export default function BarZoneMap({
  selectedCode,
  onSelect,
  labels,
  lang,
  expanded = false,
}: BarZoneMapProps) {
  const [hoveredCode, setHoveredCode] = useState<string | null>(null);
  const [focusedCode, setFocusedCode] = useState<string | null>(null);

  const activateZone = (zone: BarZoneDefinition) => onSelect(zone);

  return (
    <div
      style={{
        width: "100%",
        minWidth: expanded ? 820 : 0,
      }}
    >
      <svg
        viewBox={BAR_ZONE_MAP_VIEW_BOX}
        width="100%"
        role="group"
        aria-label={lang === "vi" ? "Sơ đồ khu vực BAR" : "BAR 구역 구조도"}
        style={{ display: "block", overflow: "visible" }}
      >
        {Array.from({ length: 8 }, (_, index) => index + 1).map((number) => (
          <text
            key={`number-${number}`}
            x={GRID_X + (number - 0.5) * CELL_WIDTH}
            y={36}
            textAnchor="middle"
            fontSize="18"
            fontWeight="800"
            fill={colors.text}
          >
            {number}
          </text>
        ))}

        {[
          { label: labels.upper, y: 98 },
          { label: labels.middle, y: 174 },
          { label: labels.lower, y: 254 },
        ].map((row) => (
          <text
            key={row.label}
            x={76}
            y={row.y}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize="16"
            fontWeight="800"
            fill={colors.text}
          >
            {row.label}
          </text>
        ))}

        {barUnavailableUpperCabinets.map((cabinetNo) => (
          <g key={`unavailable-${cabinetNo}`} aria-hidden="true">
            <rect
              x={GRID_X + (cabinetNo - 1) * CELL_WIDTH}
              y={66}
              width={CELL_WIDTH}
              height={56}
              rx={5}
              fill={colors.unavailable}
              stroke={colors.line}
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            <text
              x={GRID_X + (cabinetNo - 0.5) * CELL_WIDTH}
              y={94}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={lang === "vi" ? 11 : 13}
              fontWeight="700"
              fill={colors.mutedText}
            >
              {labels.unavailable}
            </text>
          </g>
        ))}

        {barZones.map((zone) => {
          const isSelected = selectedCode === zone.code;
          const isHovered = hoveredCode === zone.code;
          const isFocused = focusedCode === zone.code;
          const label = lang === "vi" ? zone.labelVi : zone.labelKo;
          const shortLabel =
            zone.level === "upper"
              ? zone.side === "left"
                ? labels.leftShort
                : labels.rightShort
              : String(zone.cabinetNo);

          return (
            <g
              key={zone.code}
              role="button"
              tabIndex={0}
              aria-label={`${label} (${zone.code})`}
              aria-pressed={isSelected}
              onClick={() => activateZone(zone)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activateZone(zone);
                }
              }}
              onMouseEnter={() => setHoveredCode(zone.code)}
              onMouseLeave={() => setHoveredCode(null)}
              onFocus={() => setFocusedCode(zone.code)}
              onBlur={() => setFocusedCode(null)}
              style={{ cursor: "pointer", outline: "none" }}
            >
              <rect
                x={zone.svg.x}
                y={zone.svg.y}
                width={zone.svg.width}
                height={zone.svg.height}
                rx={5}
                fill={
                  isSelected
                    ? colors.selected
                    : isHovered || isFocused
                      ? colors.zoneHover
                      : colors.zone
                }
                stroke={isFocused ? colors.focus : isSelected ? colors.selected : colors.line}
                strokeWidth={isFocused ? 4 : isSelected ? 3 : 1.5}
              />
              {zone.level === "lower" ? (
                <line
                  x1={zone.svg.x + zone.svg.width / 2}
                  y1={zone.svg.y + 8}
                  x2={zone.svg.x + zone.svg.width / 2}
                  y2={zone.svg.y + zone.svg.height - 8}
                  stroke={isSelected ? "#6b7280" : colors.doorLine}
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
              ) : null}
              <text
                x={zone.svg.x + zone.svg.width / 2}
                y={zone.svg.y + zone.svg.height / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={zone.level === "upper" ? 13 : 17}
                fontWeight="800"
                fill={isSelected ? colors.selectedText : colors.text}
                pointerEvents="none"
              >
                {shortLabel}
              </text>
            </g>
          );
        })}

        <text x={GRID_X} y={318} fontSize="14" fontWeight="800" fill={colors.text}>
          {labels.posDirection} ←
        </text>
        <text
          x={GRID_X + CELL_WIDTH * 8}
          y={318}
          textAnchor="end"
          fontSize="14"
          fontWeight="800"
          fill={colors.text}
        >
          → {labels.equipmentDirection}
        </text>
      </svg>
    </div>
  );
}
