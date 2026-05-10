import type { CSSProperties, ReactNode } from "react";
import Container from "@/components/Container";

type BadgeTone = "success" | "pending" | "muted" | "warning";

const styles: Record<string, CSSProperties> = {
  page: {
    padding: "18px 0 88px",
  },
  header: {
    marginBottom: 18,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: 700,
    color: "#6b7280",
    marginBottom: 6,
  },
  title: {
    margin: 0,
    fontSize: 24,
    fontWeight: 800,
    color: "#111827",
    letterSpacing: "-0.03em",
  },
  description: {
    margin: "8px 0 0",
    fontSize: 14,
    lineHeight: 1.55,
    color: "#6b7280",
  },
  section: {
    marginTop: 14,
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    padding: 16,
    boxShadow: "0 8px 20px rgba(15, 23, 42, 0.04)",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: "#111827",
    letterSpacing: "-0.02em",
  },
  sectionCaption: {
    margin: "4px 0 0",
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 1.45,
  },
  statusList: {
    display: "grid",
    gap: 10,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 0",
    borderTop: "1px solid #f3f4f6",
  },
  statusRowFirst: {
    borderTop: "none",
    paddingTop: 0,
  },
  statusLabel: {
    fontSize: 14,
    fontWeight: 700,
    color: "#111827",
  },
  statusDesc: {
    marginTop: 3,
    fontSize: 12,
    color: "#6b7280",
    lineHeight: 1.45,
  },
  badge: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 26,
    padding: "0 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    whiteSpace: "nowrap",
  },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
  },
  summaryCard: {
    border: "1px solid #eef2f7",
    background: "#f9fafb",
    borderRadius: 14,
    padding: 13,
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "#6b7280",
    marginBottom: 7,
  },
  summaryValue: {
    fontSize: 19,
    fontWeight: 900,
    color: "#111827",
    letterSpacing: "-0.03em",
  },
  summarySub: {
    marginTop: 5,
    fontSize: 12,
    color: "#9ca3af",
  },
  syncPanel: {
    display: "grid",
    gap: 10,
  },
  syncBox: {
    border: "1px dashed #d1d5db",
    borderRadius: 14,
    padding: 13,
    background: "#f9fafb",
  },
  syncLabel: {
    fontSize: 12,
    fontWeight: 800,
    color: "#6b7280",
    marginBottom: 6,
  },
  syncValue: {
    fontSize: 14,
    fontWeight: 800,
    color: "#111827",
  },
  button: {
    width: "100%",
    height: 44,
    border: "none",
    borderRadius: 14,
    background: "#111827",
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 800,
    opacity: 0.42,
    cursor: "not-allowed",
  },
  empty: {
    border: "1px dashed #d1d5db",
    background: "#f9fafb",
    borderRadius: 14,
    padding: "22px 14px",
    textAlign: "center",
  },
  emptyIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#111827",
    color: "#ffffff",
    fontSize: 18,
    marginBottom: 10,
  },
  emptyTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 800,
    color: "#111827",
  },
  emptyDesc: {
    margin: "6px 0 0",
    fontSize: 13,
    color: "#6b7280",
    lineHeight: 1.5,
  },
};

function getBadgeStyle(tone: BadgeTone): CSSProperties {
  if (tone === "success") {
    return {
      ...styles.badge,
      color: "#047857",
      background: "#ecfdf5",
      border: "1px solid #a7f3d0",
    };
  }

  if (tone === "warning") {
    return {
      ...styles.badge,
      color: "#b45309",
      background: "#fffbeb",
      border: "1px solid #fde68a",
    };
  }

  if (tone === "pending") {
    return {
      ...styles.badge,
      color: "#374151",
      background: "#f3f4f6",
      border: "1px solid #e5e7eb",
    };
  }

  return {
    ...styles.badge,
    color: "#6b7280",
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
  };
}

function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: BadgeTone;
}) {
  return <span style={getBadgeStyle(tone)}>{children}</span>;
}

function SectionCard({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <section style={styles.section}>
      <div style={styles.card}>
        <div style={styles.sectionHeader}>
          <div>
            <h2 style={styles.sectionTitle}>{title}</h2>
            {caption ? <p style={styles.sectionCaption}>{caption}</p> : null}
          </div>
        </div>

        {children}
      </div>
    </section>
  );
}

function StatusRow({
  label,
  description,
  badge,
  tone,
  first,
}: {
  label: string;
  description: string;
  badge: string;
  tone: BadgeTone;
  first?: boolean;
}) {
  return (
    <div
      style={{
        ...styles.statusRow,
        ...(first ? styles.statusRowFirst : {}),
      }}
    >
      <div>
        <div style={styles.statusLabel}>{label}</div>
        <div style={styles.statusDesc}>{description}</div>
      </div>

      <Badge tone={tone}>{badge}</Badge>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div style={styles.summaryCard}>
      <div style={styles.summaryLabel}>{label}</div>
      <div style={styles.summaryValue}>{value}</div>
      <div style={styles.summarySub}>{sub}</div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div style={styles.empty}>
      <div style={styles.emptyIcon}>{icon}</div>
      <h3 style={styles.emptyTitle}>{title}</h3>
      <p style={styles.emptyDesc}>{description}</p>
    </div>
  );
}

export default function SalesPage() {
  return (
    <Container>
      <main style={styles.page}>
        <header style={styles.header}>
          <div style={styles.eyebrow}>POS SALES</div>
          <h1 style={styles.title}>매출 관리</h1>
          <p style={styles.description}>
            CUKCUK POS 연동 기반으로 매출 데이터를 불러오고 재고 차감을
            준비합니다.
          </p>
        </header>

        <SectionCard
          title="POS 연동 상태"
          caption="현재는 로그인 테스트 성공 이후, 판매 데이터 조회 연결을 준비하는 단계입니다."
        >
          <div style={styles.statusList}>
            <StatusRow
              first
              label="POS 로그인 테스트"
              description="CUKCUK Open Platform 인증 토큰 발급 확인 완료"
              badge="성공"
              tone="success"
            />
            <StatusRow
              label="판매 데이터 조회"
              description="주문 목록 / 주문 상세 API 연결 예정"
              badge="준비 중"
              tone="pending"
            />
            <StatusRow
              label="재고 자동 차감"
              description="inventory.code 기준 매칭 후 차감 구조 설계 예정"
              badge="준비 중"
              tone="pending"
            />
          </div>
        </SectionCard>

        <SectionCard
          title="오늘 매출 요약"
          caption="POS 판매 데이터 조회 API 연결 후 실제 값이 표시됩니다."
        >
          <div style={styles.summaryGrid}>
            <SummaryCard label="오늘 매출" value="-" sub="준비 중" />
            <SummaryCard label="주문 수" value="-" sub="준비 중" />
            <SummaryCard label="재고 차감 대기" value="-" sub="준비 중" />
            <SummaryCard label="미매칭 품목" value="-" sub="준비 중" />
          </div>
        </SectionCard>

        <SectionCard
          title="POS 데이터 동기화"
          caption="아직 실제 API 호출은 연결하지 않습니다."
        >
          <div style={styles.syncPanel}>
            <div style={styles.syncBox}>
              <div style={styles.syncLabel}>조회 기간</div>
              <div style={styles.syncValue}>오늘 영업일 기준 · 준비 중</div>
            </div>

            <button type="button" disabled style={styles.button}>
              POS 데이터 불러오기
            </button>
          </div>
        </SectionCard>

        <SectionCard title="주문 목록">
          <EmptyState
            icon="₫"
            title="아직 불러온 주문이 없습니다"
            description="POS 판매 데이터 조회 API 연결 후 주문 목록이 표시됩니다."
          />
        </SectionCard>

        <SectionCard title="미매칭 품목">
          <EmptyState
            icon="!"
            title="미매칭 품목 없음"
            description="POS 상품 코드와 inventory.code가 일치하지 않는 품목이 여기에 표시됩니다."
          />
        </SectionCard>
      </main>
    </Container>
  );
}