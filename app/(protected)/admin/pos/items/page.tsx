"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

type PosItemStatus =
  | "direct"
  | "manual"
  | "recipe"
  | "ignore"
  | "unmapped"
  | "conflict"
  | "babaOnly";

type FilterStatus = "all" | PosItemStatus;

type Summary = {
  posCount: number;
  babaCount: number;
  directCount: number;
  needsMappingCount: number;
  manualCount: number;
  recipeCount: number;
  ignoreCount: number;
  unmappedCount: number;
  conflictCount: number;
  babaOnlyCount: number;
};

type PosPreviewItem = {
  id: string;
  status: PosItemStatus;
  code: string;
  name: string;
  unit: string;
  inventoryCode: string;
  inventoryName: string;
  reason: string;
};

const emptySummary: Summary = {
  posCount: 0,
  babaCount: 0,
  directCount: 0,
  needsMappingCount: 0,
  manualCount: 0,
  recipeCount: 0,
  ignoreCount: 0,
  unmappedCount: 0,
  conflictCount: 0,
  babaOnlyCount: 0,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && !Array.isArray(row)
  );
}

function firstArray(...values: unknown[]) {
  for (const value of values) {
    const arr = asArray(value);
    if (arr.length > 0) return arr;
  }

  return [];
}

function toText(value: unknown, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function moneyLike(value: number) {
  return value.toLocaleString("ko-KR");
}

function getPayload(json: unknown) {
  const root = asRecord(json);

  if (root.result && typeof root.result === "object") return asRecord(root.result);
  if (root.data && typeof root.data === "object") return asRecord(root.data);

  return root;
}

function normalizeStatus(value: unknown): PosItemStatus {
  const status = String(value || "").toLowerCase();

  if (status === "direct") return "direct";
  if (status === "manual" || status === "hold") return "manual";
  if (status === "recipe") return "recipe";
  if (status === "ignore") return "ignore";
  if (status === "conflict" || status === "duplicate") return "conflict";
  if (status === "babaonly" || status === "baba_only" || status === "baba-only") {
    return "babaOnly";
  }

  return "unmapped";
}

function statusMeta(status: PosItemStatus) {
  if (status === "direct") {
    return { label: "Direct", bg: "#dcfce7", color: "#166534", border: "#bbf7d0" };
  }

  if (status === "manual") {
    return { label: "Manual", bg: "#fef3c7", color: "#92400e", border: "#fde68a" };
  }

  if (status === "recipe") {
    return { label: "Recipe", bg: "#ecfdf5", color: "#047857", border: "#a7f3d0" };
  }

  if (status === "ignore") {
    return { label: "Ignore", bg: "#f3f4f6", color: "#4b5563", border: "#e5e7eb" };
  }

  if (status === "conflict") {
    return { label: "Conflict", bg: "#fee2e2", color: "#991b1b", border: "#fecaca" };
  }

  if (status === "babaOnly") {
    return { label: "BABA only", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" };
  }

  return { label: "Unmapped", bg: "#fef2f2", color: "#991b1b", border: "#fecaca" };
}

function parseSummary(payload: Record<string, unknown>, items: PosPreviewItem[]): Summary {
  const summary = asRecord(payload.summary);
  const counts = asRecord(payload.counts);

  const directCount = toNumber(
    summary.direct ??
      summary.directMatches ??
      summary.directCount ??
      counts.direct ??
      items.filter((item) => item.status === "direct").length
  );

  const manualCount = toNumber(
    summary.manual ??
      summary.manualCount ??
      counts.manual ??
      items.filter((item) => item.status === "manual").length
  );

  const recipeCount = toNumber(
    summary.recipe ??
      summary.recipeCount ??
      counts.recipe ??
      items.filter((item) => item.status === "recipe").length
  );

  const ignoreCount = toNumber(
    summary.ignore ??
      summary.ignoreCount ??
      counts.ignore ??
      items.filter((item) => item.status === "ignore").length
  );

  const unmappedCount = toNumber(
    summary.unmapped ??
      summary.unmappedCount ??
      counts.unmapped ??
      items.filter((item) => item.status === "unmapped").length
  );

  const conflictCount = toNumber(
    summary.duplicateCodeConflicts ??
      summary.conflictCount ??
      summary.conflicts ??
      counts.conflict ??
      items.filter((item) => item.status === "conflict").length
  );

  const babaOnlyCount = toNumber(
    summary.babaOnly ??
      summary.babaOnlyCount ??
      counts.babaOnly ??
      items.filter((item) => item.status === "babaOnly").length
  );

  return {
    posCount: toNumber(
      payload.posCount ??
        payload.posItemCount ??
        summary.posCount ??
        summary.posItems ??
        summary.posTotal
    ),
    babaCount: toNumber(
      payload.babaCount ??
        payload.babaInventoryCount ??
        payload.inventoryCount ??
        summary.babaCount ??
        summary.inventoryCount
    ),
    directCount,
    needsMappingCount: toNumber(
      summary.needsMapping ??
        summary.needsMappingCount ??
        payload.needsMappingCount ??
        manualCount + recipeCount + ignoreCount + unmappedCount
    ),
    manualCount,
    recipeCount,
    ignoreCount,
    unmappedCount,
    conflictCount,
    babaOnlyCount,
  };
}

function parsePosItem(
  row: Record<string, unknown>,
  status: PosItemStatus,
  index: number
): PosPreviewItem {
  const pos = asRecord(row.posItem ?? row.pos ?? row.item ?? row.pos_item);
  const inventory = asRecord(
    row.inventoryItem ?? row.inventory ?? row.babaItem ?? row.baba ?? row.inventory_item
  );

  const code = toText(
    pos.code ??
      pos.Code ??
      pos.itemCode ??
      pos.ItemCode ??
      row.posItemCode ??
      row.pos_item_code ??
      row.itemCode ??
      row.code
  );

  const name = toText(
    pos.name ??
      pos.Name ??
      pos.itemName ??
      pos.ItemName ??
      row.posItemName ??
      row.pos_item_name ??
      row.itemName ??
      row.name
  );

  const inventoryCode = toText(
    inventory.code ??
      inventory.Code ??
      row.inventoryCode ??
      row.inventory_code ??
      row.babaCode ??
      row.baba_code,
    ""
  );

  const inventoryName = toText(
    inventory.name ??
      inventory.item_name ??
      inventory.itemName ??
      row.inventoryName ??
      row.inventory_item_name ??
      row.babaName ??
      row.baba_name,
    ""
  );

  return {
    id: toText(row.id ?? row.itemId ?? row.item_id ?? `${status}-${code}-${index}`),
    status,
    code,
    name,
    unit: toText(
      pos.unitName ??
        pos.UnitName ??
        row.unitName ??
        row.unit_name ??
        row.unit ??
        row.inventory_unit,
      "-"
    ),
    inventoryCode,
    inventoryName,
    reason: toText(
      row.reason ??
        row.note ??
        row.mappingReason ??
        row.mapping_reason ??
        getDefaultReason(status)
    ),
  };
}

function getDefaultReason(status: PosItemStatus) {
  if (status === "direct") return "POS code와 inventory code가 직접 매칭된 항목입니다.";
  if (status === "manual") return "자동 차감 전 수동 확인이 필요한 항목입니다.";
  if (status === "recipe") return "레시피 차감 설정이 필요한 항목입니다.";
  if (status === "ignore") return "재고 차감 대상에서 제외된 항목입니다.";
  if (status === "conflict") return "중복 code 또는 충돌 가능성이 있어 확인이 필요합니다.";
  if (status === "babaOnly") return "BABA inventory에만 존재하는 항목입니다.";

  return "POS 상품과 inventory 품목 매핑이 필요합니다.";
}

function parseItems(payload: Record<string, unknown>) {
  const directRows = firstArray(
    payload.directMatches,
    payload.direct,
    payload.matches,
    payload.directItems
  );

  const needsMappingRows = firstArray(
    payload.needsMapping,
    payload.mappingNeeded,
    payload.unmapped,
    payload.reviewItems,
    payload.items
  );

  const conflictRows = firstArray(
    payload.duplicateCodeConflicts,
    payload.conflicts,
    payload.conflictItems
  );

  const babaOnlyRows = firstArray(payload.babaOnly, payload.babaOnlyItems, payload.inventoryOnly);

  const directItems = directRows.map((row, index) => parsePosItem(row, "direct", index));

  const needsMappingItems = needsMappingRows
    .map((row, index) => {
      const rawStatus =
        row.mappingType ??
        row.mapping_type ??
        row.status ??
        row.recommendedType ??
        row.recommended_mapping_type;

      return parsePosItem(row, normalizeStatus(rawStatus), index);
    })
    .filter((item) => item.status !== "direct");

  const conflictItems = conflictRows.map((row, index) => parsePosItem(row, "conflict", index));

  const babaOnlyItems = babaOnlyRows.map((row, index) => parsePosItem(row, "babaOnly", index));

  const map = new Map<string, PosPreviewItem>();

  [...directItems, ...needsMappingItems, ...conflictItems, ...babaOnlyItems].forEach((item) => {
    const key = `${item.status}-${item.code}-${item.name}-${item.inventoryCode}`;
    if (!map.has(key)) map.set(key, item);
  });

  return Array.from(map.values());
}

async function fetchSyncPreview(secret: string) {
  const headers = {
    "Content-Type": "application/json",
    "x-pos-admin-secret": secret,
  };

  const getRes = await fetch("/api/pos/cukcuk/inventory-items/sync-preview", {
    method: "GET",
    headers,
  });

  if (getRes.status !== 405) return getRes;

  return fetch("/api/pos/cukcuk/inventory-items/sync-preview", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

export default function AdminPosItemsPage() {
  const [adminSecret, setAdminSecret] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem("baba_pos_admin_secret") || "";
  });

  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [items, setItems] = useState<PosPreviewItem[]>([]);
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [keyword, setKeyword] = useState("");
  const [rawResult, setRawResult] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const filteredItems = useMemo(() => {
    const q = keyword.trim().toLowerCase();

    return items.filter((item) => {
      const matchedFilter = filter === "all" || item.status === filter;

      const matchedKeyword =
        !q ||
        [item.code, item.name, item.unit, item.inventoryCode, item.inventoryName, item.reason]
          .join(" ")
          .toLowerCase()
          .includes(q);

      return matchedFilter && matchedKeyword;
    });
  }, [filter, items, keyword]);

  async function handleLoad() {
    const secret = adminSecret.trim();

    if (!secret) {
      setErrorMessage("POS_ADMIN_SECRET 값을 입력해야 조회할 수 있습니다.");
      return;
    }

    setLoading(true);
    setErrorMessage("");

    try {
      window.sessionStorage.setItem("baba_pos_admin_secret", secret);

      const res = await fetchSyncPreview(secret);
      const json = await res.json().catch(() => null);
      const root = asRecord(json);

      if (!res.ok || root.ok === false) {
        throw new Error(
          toText(root.error ?? root.message, `POS 상품 조회 실패: HTTP ${res.status}`)
        );
      }

      const payload = getPayload(json);
      const parsedItems = parseItems(payload);
      const parsedSummary = parseSummary(payload, parsedItems);

      setItems(parsedItems);
      setSummary(parsedSummary);
      setRawResult(JSON.stringify(json, null, 2));
      setLastLoadedAt(new Date().toLocaleString("ko-KR"));
    } catch (error) {
      setItems([]);
      setSummary(emptySummary);
      setRawResult("");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "POS 상품 목록 조회 중 알 수 없는 오류가 발생했습니다."
      );
    } finally {
      setLoading(false);
    }
  }

  const summaryCards = [
    { label: "POS", value: summary.posCount, sub: "CUKCUK 상품", tone: "default" as const },
    { label: "BABA", value: summary.babaCount, sub: "Inventory 품목", tone: "default" as const },
    { label: "Direct", value: summary.directCount, sub: "직접 매칭", tone: "green" as const },
    { label: "Needs", value: summary.needsMappingCount, sub: "설정 필요", tone: "amber" as const },
    { label: "Unmapped", value: summary.unmappedCount, sub: "미매핑", tone: "red" as const },
    { label: "Conflict", value: summary.conflictCount, sub: "충돌 확인", tone: "red" as const },
  ];

  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <section style={styles.hero}>
          <div style={styles.heroTop}>
            <div>
              <div style={styles.eyebrow}>CUKCUK POS</div>
              <h1 style={styles.title}>POS 상품 목록</h1>
              <p style={styles.description}>
                CUKCUK에 등록된 상품과 BABA inventory code의 현재 매칭 상태를 확인합니다.
              </p>
            </div>

            <Link href="/admin/pos" style={styles.backLink}>
              POS 관리
            </Link>
          </div>

          <div style={styles.heroChips}>
            <span style={styles.heroChip}>조회 전용</span>
            <span style={styles.heroChip}>매핑 저장 없음</span>
            <span style={styles.heroChip}>재고 차감 없음</span>
          </div>
        </section>

        <section style={styles.controlCard}>
          <div style={styles.controlTop}>
            <label style={styles.inputGroup}>
              <span style={styles.label}>POS Admin Secret</span>
              <input
                type="password"
                value={adminSecret}
                onChange={(e) => setAdminSecret(e.target.value)}
                placeholder="x-pos-admin-secret"
                style={styles.secretInput}
              />
            </label>

            <button
              type="button"
              onClick={handleLoad}
              disabled={loading}
              style={loading ? styles.primaryButtonDisabled : styles.primaryButton}
            >
              {loading ? "조회 중..." : "상품 목록 조회"}
            </button>
          </div>

          <div style={styles.noticeBox}>
            <strong>현재 연결 범위</strong>
            <span>
              이 화면은 CUKCUK 상품과 BABA inventory의 매칭 상태를 조회만 합니다. 매핑 저장과
              레시피 등록은 다음 단계에서 별도 화면으로 분리합니다.
            </span>
          </div>

          {lastLoadedAt ? <div style={styles.loadedBox}>마지막 조회: {lastLoadedAt}</div> : null}
          {errorMessage ? <div style={styles.errorBox}>{errorMessage}</div> : null}
        </section>

        <section style={styles.statGrid}>
          {summaryCards.map((card) => (
            <StatCard
              key={card.label}
              label={card.label}
              value={card.value}
              sub={card.sub}
              tone={card.tone}
            />
          ))}
        </section>

        <section style={styles.filterCard}>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="POS 코드 / 상품명 / inventory 이름 검색"
            style={styles.searchInput}
          />

          <div style={styles.filters}>
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
              전체
            </FilterButton>
            <FilterButton active={filter === "direct"} onClick={() => setFilter("direct")}>
              Direct
            </FilterButton>
            <FilterButton active={filter === "manual"} onClick={() => setFilter("manual")}>
              Manual
            </FilterButton>
            <FilterButton active={filter === "recipe"} onClick={() => setFilter("recipe")}>
              Recipe
            </FilterButton>
            <FilterButton active={filter === "ignore"} onClick={() => setFilter("ignore")}>
              Ignore
            </FilterButton>
            <FilterButton active={filter === "unmapped"} onClick={() => setFilter("unmapped")}>
              Unmapped
            </FilterButton>
            <FilterButton active={filter === "conflict"} onClick={() => setFilter("conflict")}>
              Conflict
            </FilterButton>
            <FilterButton active={filter === "babaOnly"} onClick={() => setFilter("babaOnly")}>
              BABA only
            </FilterButton>
          </div>
        </section>

        <section style={styles.listCard}>
          <div style={styles.listHeader}>
            <div>
              <h2 style={styles.sectionTitle}>상품 매칭 상태</h2>
              <p style={styles.sectionDesc}>
                표시 {moneyLike(filteredItems.length)}개 / 전체 {moneyLike(items.length)}개
              </p>
            </div>
          </div>

          {filteredItems.length === 0 ? (
            <div style={styles.emptyText}>
              {items.length === 0 ? "아직 조회된 POS 상품이 없습니다." : "검색 결과가 없습니다."}
            </div>
          ) : (
            <div style={styles.itemList}>
              {filteredItems.map((item) => (
                <div key={`${item.status}-${item.code}-${item.name}-${item.inventoryCode}`} style={styles.itemCard}>
                  <div style={styles.itemTop}>
                    <div style={styles.itemTitleBox}>
                      <div style={styles.itemCode}>{item.code}</div>
                      <div style={styles.itemName}>{item.name}</div>
                      <div style={styles.itemUnit}>Unit: {item.unit}</div>
                    </div>

                    <StatusBadge status={item.status} />
                  </div>

                  <div style={styles.matchBox}>
                    <div style={styles.matchLabel}>Inventory</div>
                    <div style={styles.matchText}>
                      {item.inventoryCode || item.inventoryName
                        ? `${item.inventoryCode || "-"} · ${item.inventoryName || "-"}`
                        : "연결된 inventory 없음"}
                    </div>
                  </div>

                  <div style={styles.reasonText}>{item.reason}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={styles.bottomNote}>
          <strong>다음 단계</strong>
          <span>
            이 목록을 기준으로 `/admin/pos/mappings`에서 direct/manual/ignore 저장 기능을 만들고,
            그 다음 `/admin/pos/recipes`에서 recipe 차감 구조를 분리하는 순서가 안전합니다.
          </span>
        </section>

        {rawResult ? (
          <details style={styles.rawBox}>
            <summary style={styles.rawSummary}>sync-preview 원본 응답 보기</summary>
            <pre style={styles.rawPre}>{rawResult}</pre>
          </details>
        ) : null}
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: number;
  sub: string;
  tone?: "default" | "green" | "amber" | "red" | "blue";
}) {
  const toneStyle = {
    default: { bg: "#ffffff", border: "#e5e7eb", color: "#111827" },
    green: { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534" },
    amber: { bg: "#fffbeb", border: "#fde68a", color: "#92400e" },
    red: { bg: "#fef2f2", border: "#fecaca", color: "#991b1b" },
    blue: { bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" },
  }[tone];

  return (
    <div
      style={{
        ...styles.statCard,
        background: toneStyle.bg,
        borderColor: toneStyle.border,
      }}
    >
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color: toneStyle.color }}>{moneyLike(value)}</div>
      <div style={styles.statSub}>{sub}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: PosItemStatus }) {
  const meta = statusMeta(status);

  return (
    <span
      style={{
        ...styles.statusBadge,
        background: meta.bg,
        color: meta.color,
        borderColor: meta.border,
      }}
    >
      {meta.label}
    </span>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={active ? styles.filterButtonActive : styles.filterButton}
    >
      {children}
    </button>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f5f2",
    color: "#111827",
    padding: "14px 12px 96px",
  },
  wrap: {
    width: "100%",
    maxWidth: 760,
    margin: "0 auto",
  },
  hero: {
    background: "linear-gradient(135deg, #111827 0%, #1f2937 62%, #374151 100%)",
    borderRadius: 22,
    padding: 16,
    marginBottom: 12,
    color: "#ffffff",
    boxShadow: "0 14px 30px rgba(15, 23, 42, 0.16)",
  },
  heroTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: 900,
    color: "#d1d5db",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  title: {
    margin: "4px 0 7px",
    fontSize: 24,
    lineHeight: 1.15,
    fontWeight: 950,
    color: "#ffffff",
  },
  description: {
    margin: 0,
    maxWidth: 520,
    fontSize: 13,
    lineHeight: 1.48,
    color: "#e5e7eb",
    fontWeight: 600,
  },
  backLink: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 34,
    padding: "0 12px",
    borderRadius: 999,
    background: "rgba(255, 255, 255, 0.12)",
    border: "1px solid rgba(255, 255, 255, 0.18)",
    color: "#ffffff",
    fontSize: 12,
    fontWeight: 900,
    textDecoration: "none",
  },
  heroChips: {
    display: "flex",
    gap: 7,
    flexWrap: "wrap",
    marginTop: 14,
  },
  heroChip: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: 28,
    padding: "0 10px",
    borderRadius: 999,
    background: "rgba(255, 255, 255, 0.1)",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    color: "#f9fafb",
    fontSize: 11,
    fontWeight: 900,
  },

  controlCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 13,
    marginBottom: 10,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  controlTop: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 10,
    alignItems: "end",
    marginBottom: 10,
  },
  inputGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 0,
  },
  label: {
    fontSize: 12,
    color: "#6b7280",
    fontWeight: 900,
  },
  secretInput: {
    width: "100%",
    height: 40,
    border: "1px solid #d1d5db",
    borderRadius: 13,
    padding: "0 11px",
    fontSize: 14,
    fontWeight: 750,
    color: "#111827",
    background: "#ffffff",
  },
  primaryButton: {
    height: 40,
    border: "1px solid #111827",
    borderRadius: 13,
    padding: "0 12px",
    background: "#111827",
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 950,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  primaryButtonDisabled: {
    height: 40,
    border: "1px solid #9ca3af",
    borderRadius: 13,
    padding: "0 12px",
    background: "#9ca3af",
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 950,
    cursor: "not-allowed",
    whiteSpace: "nowrap",
  },
  noticeBox: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "10px 11px",
    borderRadius: 15,
    background: "#fffbeb",
    border: "1px solid #fde68a",
    color: "#92400e",
    fontSize: 12,
    lineHeight: 1.45,
    fontWeight: 650,
    marginBottom: 8,
  },
  loadedBox: {
    padding: "9px 11px",
    borderRadius: 14,
    background: "#ecfdf5",
    border: "1px solid #a7f3d0",
    color: "#047857",
    fontSize: 12,
    fontWeight: 800,
    marginBottom: 8,
  },
  errorBox: {
    padding: "10px 11px",
    borderRadius: 14,
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#991b1b",
    fontSize: 12,
    lineHeight: 1.45,
    fontWeight: 800,
  },

  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))",
    gap: 8,
    marginBottom: 10,
  },
  statCard: {
    border: "1px solid #e5e7eb",
    borderRadius: 17,
    padding: 11,
    minHeight: 86,
    boxShadow: "0 6px 16px rgba(15, 23, 42, 0.04)",
  },
  statLabel: {
    fontSize: 11,
    fontWeight: 900,
    color: "#6b7280",
    marginBottom: 6,
  },
  statValue: {
    fontSize: 23,
    lineHeight: 1,
    fontWeight: 950,
    color: "#111827",
    marginBottom: 7,
  },
  statSub: {
    fontSize: 11,
    lineHeight: 1.35,
    color: "#6b7280",
    fontWeight: 800,
  },

  filterCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 13,
    marginBottom: 10,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  searchInput: {
    width: "100%",
    height: 42,
    border: "1px solid #d1d5db",
    borderRadius: 14,
    padding: "0 12px",
    fontSize: 14,
    fontWeight: 750,
    color: "#111827",
    background: "#ffffff",
    marginBottom: 10,
  },
  filters: {
    display: "flex",
    gap: 7,
    overflowX: "auto",
    paddingBottom: 2,
  },
  filterButton: {
    border: "1px solid #e5e7eb",
    background: "#ffffff",
    color: "#374151",
    borderRadius: 999,
    padding: "8px 11px",
    fontSize: 12,
    fontWeight: 950,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  filterButtonActive: {
    border: "1px solid #111827",
    background: "#111827",
    color: "#ffffff",
    borderRadius: 999,
    padding: "8px 11px",
    fontSize: 12,
    fontWeight: 950,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  listCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 13,
    marginBottom: 10,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  listHeader: {
    marginBottom: 11,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.25,
    fontWeight: 950,
    color: "#111827",
  },
  sectionDesc: {
    margin: "5px 0 0",
    fontSize: 12,
    lineHeight: 1.4,
    color: "#6b7280",
    fontWeight: 650,
  },
  itemList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  itemCard: {
    border: "1px solid #eef0f3",
    borderRadius: 17,
    padding: 11,
    background: "#fcfcfd",
  },
  itemTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "flex-start",
    marginBottom: 10,
  },
  itemTitleBox: {
    minWidth: 0,
  },
  itemCode: {
    fontSize: 12,
    fontWeight: 950,
    color: "#2563eb",
    marginBottom: 3,
  },
  itemName: {
    fontSize: 14,
    lineHeight: 1.35,
    fontWeight: 950,
    color: "#111827",
    wordBreak: "keep-all",
  },
  itemUnit: {
    marginTop: 4,
    fontSize: 11,
    color: "#6b7280",
    fontWeight: 800,
  },
  statusBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    fontSize: 11,
    fontWeight: 950,
    whiteSpace: "nowrap",
  },
  matchBox: {
    padding: "9px 10px",
    borderRadius: 14,
    background: "#ffffff",
    border: "1px solid #eef0f3",
    marginBottom: 8,
  },
  matchLabel: {
    fontSize: 11,
    color: "#6b7280",
    fontWeight: 900,
    marginBottom: 4,
  },
  matchText: {
    fontSize: 12,
    lineHeight: 1.35,
    color: "#111827",
    fontWeight: 850,
  },
  reasonText: {
    fontSize: 12,
    lineHeight: 1.4,
    color: "#6b7280",
    fontWeight: 650,
  },
  emptyText: {
    padding: "30px 10px",
    textAlign: "center",
    color: "#9ca3af",
    fontSize: 13,
    fontWeight: 750,
  },
  bottomNote: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    padding: 13,
    borderRadius: 18,
    background: "#111827",
    color: "#ffffff",
    fontSize: 13,
    lineHeight: 1.45,
    fontWeight: 650,
    marginBottom: 10,
  },
  rawBox: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    padding: 13,
  },
  rawSummary: {
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 900,
    color: "#111827",
  },
  rawPre: {
    margin: "12px 0 0",
    padding: 12,
    borderRadius: 13,
    background: "#111827",
    color: "#e5e7eb",
    overflowX: "auto",
    fontSize: 11,
    lineHeight: 1.5,
  },
} satisfies Record<string, CSSProperties>;