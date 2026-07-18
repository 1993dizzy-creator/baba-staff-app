"use client";

import Image from "next/image";
import { useState } from "react";
import { BAR_COLORS } from "@/lib/bar/colors";
import type { BarZoneRecord } from "@/lib/bar/types";
import {
  BAR_FRONT_IMAGE_HEIGHT,
  BAR_FRONT_IMAGE_SRC,
  BAR_FRONT_IMAGE_WIDTH,
  BAR_ZONE_MAP_VIEW_BOX,
  SHOW_BAR_MAP_DEBUG,
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
  equipmentShort: string;
  mapAriaLabel: string;
};

type BarZoneMapProps = {
  selectedCode: string | null;
  onSelect: (zone: BarZoneDefinition) => void;
  labels: BarZoneMapLabels;
  lang: "ko" | "vi";
  expanded?: boolean;
  zoneData?: Record<string, BarZoneRecord>;
};

const colors = {
  storageLine: "#f9fafb",
  equipmentLine: "#fbbf24",
  hoverFill: "rgba(255, 255, 255, 0.18)",
  selectedFill: "rgba(37, 99, 235, 0.42)",
  selectedLine: "#60a5fa",
  focusLine: "#facc15",
  labelBackground: "rgba(17, 24, 39, 0.78)",
  labelText: "#ffffff",
  doorLine: "rgba(255, 255, 255, 0.6)",
  connector: "rgba(255, 255, 255, 0.5)",
  debugLine: "rgba(239, 68, 68, 0.5)",
} as const;

export default function BarZoneMap({
  selectedCode,
  onSelect,
  labels,
  lang,
  expanded = false,
  zoneData = {},
}: BarZoneMapProps) {
  const [hoveredCode, setHoveredCode] = useState<string | null>(null);
  const [focusedCode, setFocusedCode] = useState<string | null>(null);

  return (
    <div style={{ width: "100%", minWidth: expanded ? 1100 : 0 }}>
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: `${BAR_FRONT_IMAGE_WIDTH} / ${BAR_FRONT_IMAGE_HEIGHT}`,
          overflow: "hidden",
          borderRadius: 10,
          background: "#111827",
        }}
      >
        <Image
          src={BAR_FRONT_IMAGE_SRC}
          alt={labels.mapAriaLabel}
          width={BAR_FRONT_IMAGE_WIDTH}
          height={BAR_FRONT_IMAGE_HEIGHT}
          priority={!expanded}
          sizes={expanded ? "1100px" : "(max-width: 800px) calc(100vw - 32px), 768px"}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
        />

        <svg
          viewBox={BAR_ZONE_MAP_VIEW_BOX}
          preserveAspectRatio="xMidYMid meet"
          width="100%"
          height="100%"
          role="group"
          aria-label={labels.mapAriaLabel}
          style={{ position: "absolute", inset: 0, display: "block" }}
        >
          <defs>
            <pattern
              id={`bar-equipment-pattern-${expanded ? "expanded" : "default"}`}
              width="16"
              height="16"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="16" stroke={colors.equipmentLine} strokeWidth="5" opacity="0.32" />
            </pattern>
          </defs>

          {barZones.map((zone) => {
            const isSelected = selectedCode === zone.code;
            const isHovered = hoveredCode === zone.code;
            const isFocused = focusedCode === zone.code;
            const label = lang === "vi" ? zone.labelVi : zone.labelKo;
            const hit = zone.hitSvg ?? zone.svg;
            const assigneeColor = zoneData[zone.code]?.assignee?.colorKey;
            const activeKeepingCount = zoneData[zone.code]?.activeKeepingCount ?? 0;
            const countLabel = lang === "vi" ? `${activeKeepingCount} chai đang được lưu giữ` : `활성 키핑 ${activeKeepingCount}건`;
            const lineColor = assigneeColor
              ? BAR_COLORS[assigneeColor].css
              : zone.kind === "equipment" ? colors.equipmentLine : colors.storageLine;
            const isMiddle = zone.level === "middle";
            const labelX = isMiddle
              ? zone.label?.x ?? zone.svg.x + zone.svg.width / 2
              : zone.level === "lower"
                ? zone.svg.x + zone.svg.width / 2
                : zone.svg.x + 34;
            const labelY = isMiddle
              ? zone.label?.y ?? 422
              : zone.level === "lower"
                ? zone.svg.y + 42
                : zone.svg.y + 18;

            return (
              <g
                key={zone.code}
                role="button"
                tabIndex={0}
                aria-label={`${label} (${zone.code})${activeKeepingCount > 0 ? `, ${countLabel}` : ""}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(zone)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(zone);
                  }
                }}
                onMouseEnter={() => setHoveredCode(zone.code)}
                onMouseLeave={() => setHoveredCode(null)}
                onFocus={() => setFocusedCode(zone.code)}
                onBlur={() => setFocusedCode(null)}
                style={{ cursor: "pointer", outline: "none" }}
              >
                <rect
                  x={hit.x}
                  y={hit.y}
                  width={hit.width}
                  height={hit.height}
                  fill="rgba(255, 255, 255, 0.01)"
                />
                {isMiddle ? (
                  <rect
                    x={labelX - 34}
                    y={labelY - 20}
                    width={68}
                    height={40}
                    rx={8}
                    fill="rgba(255, 255, 255, 0.01)"
                  />
                ) : null}
                {isMiddle ? (
                  <line
                    x1={labelX}
                    y1={labelY + 18}
                    x2={labelX}
                    y2={zone.svg.y}
                    stroke={isSelected || isFocused ? lineColor : colors.connector}
                    strokeWidth={isSelected || isFocused ? 3 : 1.5}
                    strokeDasharray="7 7"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                ) : null}
                <rect
                  x={zone.svg.x}
                  y={zone.svg.y}
                  width={zone.svg.width}
                  height={zone.svg.height}
                  rx={3}
                  fill={
                    isSelected
                      ? colors.selectedFill
                      : isHovered || isFocused
                        ? colors.hoverFill
                        : zone.kind === "equipment"
                          ? `url(#bar-equipment-pattern-${expanded ? "expanded" : "default"})`
                          : "none"
                  }
                  stroke={lineColor}
                  strokeWidth={isFocused ? 6 : isSelected ? 5 : 2.5}
                  style={{ filter: isSelected || isFocused ? `drop-shadow(0 0 5px ${lineColor})` : undefined }}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
                {zone.level === "lower" ? (
                  <line
                    x1={zone.svg.x + zone.svg.width / 2}
                    y1={zone.svg.y + 10}
                    x2={zone.svg.x + zone.svg.width / 2}
                    y2={zone.svg.y + zone.svg.height - 8}
                    stroke={colors.doorLine}
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                ) : null}
                <g pointerEvents="none">
                  <rect
                    x={labelX - 29}
                    y={labelY - 14}
                    width={58}
                    height={28}
                    rx={5}
                    fill={isSelected ? lineColor : colors.labelBackground}
                    stroke={isFocused ? colors.focusLine : "none"}
                    strokeWidth={isFocused ? 3 : 0}
                  />
                  <text
                    x={labelX}
                    y={labelY + 1}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={16}
                    fontWeight="800"
                    fill={colors.labelText}
                  >
                    {zone.code}
                  </text>
                  {activeKeepingCount > 0 ? <g aria-label={countLabel}>
                    <rect x={labelX + 34} y={labelY - 12} width={activeKeepingCount > 99 ? 40 : 34} height={24} rx={12} fill="#eff6ff" stroke="#93c5fd" strokeWidth={1.5} />
                    <text x={labelX + (activeKeepingCount > 99 ? 54 : 51)} y={labelY + 1} textAnchor="middle" dominantBaseline="middle" fontSize={13} fontWeight="900" fill="#1d4ed8">{activeKeepingCount}</text>
                  </g> : null}
                  {zone.kind === "equipment" ? (
                    <>
                      <rect
                        x={zone.svg.x + 69}
                        y={zone.svg.y + 5}
                        width={72}
                        height={26}
                        rx={5}
                        fill="rgba(146, 64, 14, 0.86)"
                      />
                      <text
                        x={zone.svg.x + 105}
                        y={zone.svg.y + 19}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={13}
                        fontWeight="800"
                        fill={colors.labelText}
                      >
                        {labels.equipmentShort}
                      </text>
                    </>
                  ) : null}
                </g>
              </g>
            );
          })}

          {SHOW_BAR_MAP_DEBUG ? (
            <g aria-hidden="true" pointerEvents="none">
              {Array.from({ length: 15 }, (_, index) => index * 100).map((x) => (
                <line key={`debug-x-${x}`} x1={x} y1={0} x2={x} y2={734} stroke={colors.debugLine} strokeWidth={1} />
              ))}
              {Array.from({ length: 8 }, (_, index) => index * 100).map((y) => (
                <line key={`debug-y-${y}`} x1={0} y1={y} x2={1491} y2={y} stroke={colors.debugLine} strokeWidth={1} />
              ))}
            </g>
          ) : null}
        </svg>
      </div>

    </div>
  );
}
