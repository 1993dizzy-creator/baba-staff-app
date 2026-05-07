"use client";

import type { CSSProperties } from "react";
import Container from "@/components/Container";

export default function SalesPage() {
  return (
    <Container>
      <section style={pageStyle}>
        <div>
          <h1 style={titleStyle}>매출 관리</h1>
          <p style={descriptionStyle}>
            CUKCUK POS 연동 기반으로 새로 준비 중입니다.
          </p>
        </div>

        <div style={statusGridStyle}>
          <StatusCard label="POS 로그인 테스트" value="성공" tone="success" />
          <StatusCard label="기존 수기 매출 기능" value="제거 예정" tone="muted" />
          <StatusCard
            label="다음 단계"
            value="POS 판매 데이터 조회 API 연결"
            tone="info"
          />
        </div>
      </section>
    </Container>
  );
}

function StatusCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "success" | "muted" | "info";
}) {
  const color = toneColorMap[tone];

  return (
    <div style={{ ...cardStyle, borderColor: color.border }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ ...valueStyle, color: color.text }}>{value}</div>
    </div>
  );
}

const toneColorMap = {
  success: {
    border: "#bbf7d0",
    text: "#15803d",
  },
  muted: {
    border: "#e5e7eb",
    text: "#4b5563",
  },
  info: {
    border: "#bfdbfe",
    text: "#1d4ed8",
  },
} as const;

const pageStyle: CSSProperties = {
  display: "grid",
  gap: 16,
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "#111827",
  fontSize: 22,
  fontWeight: 900,
  lineHeight: 1.25,
};

const descriptionStyle: CSSProperties = {
  margin: "8px 0 0",
  color: "#6b7280",
  fontSize: 14,
  fontWeight: 700,
  lineHeight: 1.45,
};

const statusGridStyle: CSSProperties = {
  display: "grid",
  gap: 10,
};

const cardStyle: CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 14,
};

const labelStyle: CSSProperties = {
  color: "#6b7280",
  fontSize: 12,
  fontWeight: 800,
  marginBottom: 6,
};

const valueStyle: CSSProperties = {
  color: "#111827",
  fontSize: 15,
  fontWeight: 900,
  lineHeight: 1.35,
};
