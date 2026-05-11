"use client";

import { useCallback, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

type MappingStatus =
  | "direct"
  | "manual"
  | "unmapped"
  | "option"
  | "recipe"
  | "ignore";

type DirectStatus = "pending" | "applied";

type Summary = {
  invoiceCount: number;
  lineCount: number;
  direct: number;
  manual: number;
  unmapped: number;
  option: number;
  recipe: number;
  ignore: number;
  skippedAlreadyAppliedCount: number;
  pendingCount: number;
  appliedCount: number;
};

type DirectPreviewItem = {
  id: string;
  code: string;
  name: string;
  unit: string;
  currentQuantity: number;
  deductQuantity: number;
  expectedAfterQuantity: number;
  status: DirectStatus;
};

type ReviewItem = {
  id: string;
  status: Exclude<MappingStatus, "direct">;
  code: string;
  name: string;
  quantity: number;
  reason: string;
};

type FilterStatus = "all" | ReviewItem["status"];

const emptySummary: Summary = {
  invoiceCount: 0,
  lineCount: 0,
  direct: 0,
  manual: 0,
  unmapped: 0,
  option: 0,
  recipe: 0,
  ignore: 0,
  skippedAlreadyAppliedCount: 0,
  pendingCount: 0,
  appliedCount: 0,
};

const adminTabs = [
  { label: "검수", active: true },
  { label: "상품", active: false },
  { label: "매핑", active: false },
  { label: "레시피", active: false },
  { label: "내역", active: false },
  { label: "설정", active: false },
];

function getVietnamBusinessDate() {
  const nowInVietnam = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
  );

  if (nowInVietnam.getHours() < 3) {
    nowInVietnam.setDate(nowInVietnam.getDate() - 1);
  }

  const year = nowInVietnam.getFullYear();
  const month = String(nowInVietnam.getMonth() + 1).padStart(2, "0");
  const day = String(nowInVietnam.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getBusinessWindowText(businessDate: string) {
  if (!businessDate) return "-";

  const [year, month, day] = businessDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);

  const startText = `${start.getFullYear()}-${String(
    start.getMonth() + 1
  ).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")} 16:00`;

  const endText = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(end.getDate()).padStart(2, "0")} 03:00`;

  return `${startText} ~ ${endText} (+07)`;
}

function getStoredActor() {
  if (typeof window === "undefined") {
    return { actorUsername: "", actorName: "" };
  }

  try {
    const raw = window.localStorage.getItem("baba_user");
    if (!raw) return { actorUsername: "", actorName: "" };

    const user = JSON.parse(raw) as {
      username?: string;
      name?: string;
      full_name?: string;
    };

    return {
      actorUsername: user.username || "",
      actorName: user.name || user.full_name || user.username || "",
    };
  } catch {
    return { actorUsername: "", actorName: "" };
  }
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toText(value: unknown, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

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

function findArrayByCandidateKeys(
  value: unknown,
  candidateKeys: string[],
  depth = 0
): Record<string, unknown>[] {
  if (depth > 5) return [];

  if (Array.isArray(value)) {
    const rows = asArray(value);

    if (
      rows.length > 0 &&
      rows.some((row) =>
        candidateKeys.some((key) => Object.prototype.hasOwnProperty.call(row, key))
      )
    ) {
      return rows;
    }

    return [];
  }

  const record = asRecord(value);
  const entries = Object.values(record);

  for (const child of entries) {
    const found = findArrayByCandidateKeys(child, candidateKeys, depth + 1);
    if (found.length > 0) return found;
  }

  return [];
}

function getMappingType(row: Record<string, unknown>) {
  return String(
    row.mapping_type ??
    row.mappingType ??
    row.mapping_status ??
    row.mappingStatus ??
    row.status ??
    ""
  ).toLowerCase();
}

function getRowCode(row: Record<string, unknown>) {
  return toText(
    row.inventory_code ??
    row.inventoryCode ??
    row.pos_item_code ??
    row.posItemCode ??
    row.itemCode ??
    row.item_code ??
    row.code
  );
}

function getRowName(row: Record<string, unknown>) {
  return toText(
    row.inventory_item_name ??
    row.inventoryItemName ??
    row.inventory_name ??
    row.pos_item_name ??
    row.posItemName ??
    row.itemName ??
    row.item_name ??
    row.name
  );
}

function getRowUnit(row: Record<string, unknown>) {
  return toText(
    row.inventory_unit ??
    row.inventoryUnit ??
    row.unit ??
    row.unitName ??
    row.unit_name,
    ""
  );
}

function getRowQuantity(row: Record<string, unknown>) {
  return toNumber(
    row.quantity ??
    row.qty ??
    row.deduct_quantity ??
    row.deductQuantity ??
    row.total_deduct_quantity ??
    row.totalDeductQuantity
  );
}

function getPayload(json: unknown) {
  const root = asRecord(json);

  if (root.result && typeof root.result === "object") {
    return asRecord(root.result);
  }

  if (root.data && typeof root.data === "object") {
    return asRecord(root.data);
  }

  return root;
}

function normalizeReviewStatus(value: unknown): ReviewItem["status"] {
  const status = String(value || "").toLowerCase();

  if (status === "recipe") return "recipe";
  if (status === "ignore") return "ignore";
  if (status === "option") return "option";
  if (status === "manual" || status === "hold") return "manual";

  return "unmapped";
}

function normalizeDirectStatus(value: unknown): DirectStatus {
  return String(value || "").toLowerCase() === "applied" ? "applied" : "pending";
}

function parseSummary(payload: Record<string, unknown>): Summary {
  const summary = asRecord(payload.summary);

  return {
    invoiceCount: toNumber(payload.invoiceCount ?? summary.invoiceCount),
    lineCount: toNumber(payload.lineCount ?? summary.lineCount),
    direct: toNumber(summary.direct ?? payload.direct),
    manual: toNumber(summary.manual ?? payload.manual),
    unmapped: toNumber(summary.unmapped ?? payload.unmapped),
    option: toNumber(summary.option ?? payload.option),
    recipe: toNumber(summary.recipe ?? payload.recipe),
    ignore: toNumber(summary.ignore ?? payload.ignore),
    skippedAlreadyAppliedCount: toNumber(
      payload.skippedAlreadyAppliedCount ?? summary.skippedAlreadyAppliedCount
    ),
    pendingCount: toNumber(
      payload.pendingCount ??
      payload.pendingDeductionCount ??
      summary.pending ??
      summary.pendingCount
    ),
    appliedCount: toNumber(
      payload.appliedCount ?? summary.applied ?? summary.appliedCount
    ),
  };
}

function parseDirectItems(payload: Record<string, unknown>): DirectPreviewItem[] {
  const deductionRows = firstArray(
    payload.directPreviewItems,
    payload.pendingDeductions,
    payload.directDeductions,
    payload.inventoryDeductions,
    payload.deductions

  );

  const explicitLineRows = firstArray(
    payload.lines,
    payload.lineItems,
    payload.posLines,
    payload.items,
    payload.reviewItems
  );

  const foundLineRows =
    explicitLineRows.length > 0
      ? explicitLineRows
      : findArrayByCandidateKeys(payload, [
        "mapping_type",
        "mappingType",
        "mapping_status",
        "mappingStatus",
        "pos_item_code",
        "posItemCode",
        "itemCode",
        "itemName",
        "pos_item_name",
        "posItemName",
      ]);

  const directLineRows = foundLineRows.filter((row) => {
    const mappingType = getMappingType(row);
    return mappingType === "direct";
  });

  const deductionByCode = new Map<
    string,
    {
      code: string;
      name: string;
      unit: string;
      currentQuantity: number;
      deductQuantity: number;
      expectedAfterQuantity: number;
      status: DirectStatus;
    }
  >();

  for (const row of deductionRows) {
    const code = getRowCode(row);
    if (!code || code === "-") continue;

    const previous = deductionByCode.get(code);

    const currentQuantity = toNumber(
      row.current_quantity ??
      row.currentQuantity ??
      row.before_quantity ??
      row.beforeQuantity ??
      previous?.currentQuantity
    );

    const deductQuantity = getRowQuantity(row);

    const totalDeductQuantity = previous
      ? previous.deductQuantity + deductQuantity
      : deductQuantity;

    const expectedAfterQuantity = toNumber(
      row.expected_after_quantity ??
      row.expectedAfterQuantity ??
      row.after_quantity ??
      row.afterQuantity ??
      (currentQuantity ? currentQuantity - totalDeductQuantity : 0)
    );

    deductionByCode.set(code, {
      code,
      name: getRowName(row),
      unit: getRowUnit(row),
      currentQuantity,
      deductQuantity: totalDeductQuantity,
      expectedAfterQuantity,
      status: normalizeDirectStatus(row.status),
    });
  }

  const lineRowsByCode = new Map<string, Record<string, unknown>[]>();

  for (const row of directLineRows) {
    const code = getRowCode(row);
    if (!code || code === "-") continue;

    const rows = lineRowsByCode.get(code) ?? [];
    rows.push(row);
    lineRowsByCode.set(code, rows);
  }

  const targetCodes =
    lineRowsByCode.size > 0
      ? Array.from(lineRowsByCode.keys())
      : Array.from(deductionByCode.keys());

  return targetCodes.map((code, index) => {
    const lineRows = lineRowsByCode.get(code) ?? [];
    const firstLine = lineRows[0];
    const deduction = deductionByCode.get(code);

    const lineQuantitySum = lineRows.reduce(
      (sum, row) => sum + getRowQuantity(row),
      0
    );

    const nameFromLine = firstLine ? getRowName(firstLine) : "-";
    const unitFromLine = firstLine ? getRowUnit(firstLine) : "";

    const currentQuantity =
      deduction?.currentQuantity ??
      toNumber(
        firstLine?.current_quantity ??
        firstLine?.currentQuantity ??
        firstLine?.before_quantity ??
        firstLine?.beforeQuantity
      );

    const deductQuantity =
      deduction?.deductQuantity ??
      lineQuantitySum ??
      toNumber(firstLine?.quantity ?? firstLine?.qty);

    const expectedAfterQuantity =
      deduction?.expectedAfterQuantity ??
      toNumber(
        firstLine?.expected_after_quantity ??
        firstLine?.expectedAfterQuantity ??
        firstLine?.after_quantity ??
        firstLine?.afterQuantity ??
        (currentQuantity ? currentQuantity - deductQuantity : 0)
      );

    return {
      id: `${code}-${index}`,
      code,
      name:
        nameFromLine && nameFromLine !== "-"
          ? nameFromLine
          : deduction?.name || "-",
      unit:
        unitFromLine && unitFromLine !== "-"
          ? unitFromLine
          : deduction?.unit || "",
      currentQuantity,
      deductQuantity,
      expectedAfterQuantity,
      status: deduction?.status ?? "pending",
    };
  });
}


function parseReviewItems(payload: Record<string, unknown>): ReviewItem[] {
  const explicitRows = firstArray(
    payload.reviewItems,
    payload.lines,
    payload.lineItems,
    payload.posLines,
    payload.items
  );

  const lineRows =
    explicitRows.length > 0
      ? explicitRows
      : findArrayByCandidateKeys(payload, [
        "mapping_type",
        "mappingType",
        "mapping_status",
        "mappingStatus",
        "pos_item_code",
        "posItemCode",
        "itemCode",
        "itemName",
        "pos_item_name",
        "posItemName",
      ]);

  return lineRows
    .map((row, index) => {
      const mappingType = getMappingType(row);

      if (
        mappingType === "direct" ||
        mappingType === "applied" ||
        mappingType === "pending"
      ) {
        return null;
      }

      const status = normalizeReviewStatus(mappingType);

      const code = toText(
        row.pos_item_code ??
        row.posItemCode ??
        row.itemCode ??
        row.item_code ??
        row.code ??
        row.inventory_code
      );

      const name = toText(
        row.pos_item_name ??
        row.posItemName ??
        row.itemName ??
        row.item_name ??
        row.name ??
        row.inventory_item_name
      );

      return {
        id: toText(
          row.id ??
          row.refDetailId ??
          row.ref_detail_id ??
          row.lineId ??
          row.line_id ??
          `${code}-${index}`
        ),
        status,
        code,
        name,
        quantity: toNumber(row.quantity ?? row.qty),
        reason: toText(
          row.reason ??
          row.note ??
          row.mapping_reason ??
          row.mappingReason ??
          getDefaultReason(status)
        ),
      };
    })
    .filter((item): item is ReviewItem => item !== null);
}

function getDefaultReason(status: ReviewItem["status"]) {
  if (status === "manual") return "자동 차감 전 수동 확인이 필요한 항목입니다.";
  if (status === "recipe") return "레시피 차감 설정이 필요한 항목입니다.";
  if (status === "option") return "Parent 상품에 연결되는 옵션 라인입니다.";
  if (status === "ignore") return "재고 차감 대상에서 제외된 항목입니다.";

  return "POS 상품과 inventory 품목 매핑이 필요합니다.";
}

function statusMeta(status: MappingStatus | DirectStatus) {
  if (status === "direct") {
    return {
      label: "Direct",
      bg: "#dcfce7",
      color: "#166534",
      border: "#bbf7d0",
    };
  }

  if (status === "applied") {
    return {
      label: "Applied",
      bg: "#e0f2fe",
      color: "#075985",
      border: "#bae6fd",
    };
  }

  if (status === "pending") {
    return {
      label: "Pending",
      bg: "#fef3c7",
      color: "#92400e",
      border: "#fde68a",
    };
  }

  if (status === "manual") {
    return {
      label: "Manual",
      bg: "#fef3c7",
      color: "#92400e",
      border: "#fde68a",
    };
  }

  if (status === "recipe") {
    return {
      label: "Recipe",
      bg: "#ecfdf5",
      color: "#047857",
      border: "#a7f3d0",
    };
  }

  if (status === "ignore") {
    return {
      label: "Ignore",
      bg: "#f3f4f6",
      color: "#4b5563",
      border: "#e5e7eb",
    };
  }

  if (status === "option") {
    return {
      label: "Option",
      bg: "#f3e8ff",
      color: "#6b21a8",
      border: "#e9d5ff",
    };
  }

  return {
    label: "Unmapped",
    bg: "#fee2e2",
    color: "#991b1b",
    border: "#fecaca",
  };
}

function moneyLike(value: number) {
  return value.toLocaleString("ko-KR");
}

export default function AdminPosPage() {
  const defaultBusinessDate = useMemo(() => getVietnamBusinessDate(), []);

  const [businessDate, setBusinessDate] = useState(defaultBusinessDate);
  const [filter, setFilter] = useState<FilterStatus>("all");

  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [directItems, setDirectItems] = useState<DirectPreviewItem[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);

  const [applyResult, setApplyResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState("");

  const filteredReviewItems = useMemo(() => {
    if (filter === "all") return reviewItems;
    return reviewItems.filter((item) => item.status === filter);
  }, [filter, reviewItems]);

  const businessWindowText = useMemo(
    () => getBusinessWindowText(businessDate),
    [businessDate]
  );

  const hasData =
    summary.invoiceCount > 0 ||
    summary.lineCount > 0 ||
    directItems.length > 0 ||
    reviewItems.length > 0;

  const loadDryRun = useCallback(async (targetDate: string) => {
    const actor = getStoredActor();

    if (!actor.actorUsername) {
      setErrorMessage("로그인 정보를 찾지 못했습니다. 다시 로그인 후 시도하세요.");
      return;
    }

    setLoading(true);
    setErrorMessage("");

    try {
      const res = await fetch("/api/admin/pos/dry-run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          businessDate: targetDate,
          limit: 100,
          actorUsername: actor.actorUsername,
        }),
      });

      const json = await res.json().catch(() => null);
      const root = asRecord(json);

      if (!res.ok || root.ok === false) {
        throw new Error(
          toText(
            root.error ?? root.message,
            `dry-run 요청 실패: HTTP ${res.status}`
          )
        );
      }

      const payload = getPayload(json);

      setSummary(parseSummary(payload));
      setDirectItems(parseDirectItems(payload));
      setReviewItems(parseReviewItems(payload));
      setApplyResult("");
      setLastLoadedAt(
        new Date().toLocaleString("ko-KR", {
          timeZone: "Asia/Ho_Chi_Minh",
        })
      );
    } catch (error) {
      setSummary(emptySummary);
      setDirectItems([]);
      setReviewItems([]);

      setErrorMessage(
        error instanceof Error
          ? error.message
          : "dry-run 조회 중 알 수 없는 오류가 발생했습니다."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleApply() {
    const actor = getStoredActor();

    if (!actor.actorUsername) {
      setErrorMessage("로그인 정보를 찾지 못했습니다. 다시 로그인 후 시도하세요.");
      return;
    }

    const confirmed = window.confirm(
      `${businessDate} 영업일의 direct pending 차감을 실제 inventory에 반영합니다.\n\nApply는 내부에서 saveDryRun:true를 먼저 실행한 뒤 실제 차감을 수행합니다.\n\n실행할까요?`
    );

    if (!confirmed) return;

    setApplying(true);
    setErrorMessage("");
    setApplyResult("");

    try {
      const res = await fetch("/api/admin/pos/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          businessDate,
          limit: 100,
          actorUsername: actor.actorUsername,
        }),
      });

      const json = await res.json().catch(() => null);
      const root = asRecord(json);

      if (!res.ok || root.ok === false) {
        throw new Error(
          toText(root.error ?? root.message, `apply 요청 실패: HTTP ${res.status}`)
        );
      }

      setApplyResult(JSON.stringify(json, null, 2));
      await loadDryRun(businessDate);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "apply 실행 중 알 수 없는 오류가 발생했습니다."
      );
    } finally {
      setApplying(false);
    }
  }

  const summaryCards = [
    {
      label: "Invoice",
      value: summary.invoiceCount,
      sub: "영수증",
      tone: "default" as const,
    },
    {
      label: "Lines",
      value: summary.lineCount,
      sub: "판매 라인",
      tone: "default" as const,
    },
    {
      label: "Direct",
      value: summary.direct,
      sub: "자동 후보",
      tone: "green" as const,
    },
    {
      label: "Manual",
      value: summary.manual,
      sub: "수동 확인",
      tone: "amber" as const,
    },
    {
      label: "Unmapped",
      value: summary.unmapped,
      sub: "매핑 필요",
      tone: "red" as const,
    },
    {
      label: "Option",
      value: summary.option,
      sub: "옵션 라인",
      tone: "purple" as const,
    },
    {
      label: "Pending",
      value: summary.pendingCount,
      sub: "차감 대기",
      tone: "amber" as const,
    },
    {
      label: "Applied",
      value: summary.appliedCount,
      sub: "차감 완료",
      tone: "blue" as const,
    },
  ];

  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <nav style={styles.topTabs} aria-label="POS 관리 메뉴">
          {adminTabs.map((tab) => (
            <button
              key={tab.label}
              type="button"
              disabled={!tab.active}
              style={tab.active ? styles.topTabActive : styles.topTabDisabled}
            >
              {tab.label}
              {!tab.active ? <span style={styles.readyLabel}>준비중</span> : null}
            </button>
          ))}
        </nav>

        <section style={styles.hero}>
          <div>
            <div style={styles.eyebrow}>CUKCUK POS</div>
            <h1 style={styles.title}>POS 관리</h1>
          </div>

          <p style={styles.description}>
            POS 판매 내역을 불러와 앱 재고에서 자동으로 빠질 항목과 직접 확인할 항목을 구분합니다.
          </p>
        </section>

        <section style={styles.queryCard}>
          <div style={styles.queryTop}>
            <label style={styles.inputGroup}>
              <span style={styles.label}>Business Date</span>
              <input
                type="date"
                value={businessDate}
                onChange={(e) => setBusinessDate(e.target.value)}
                style={styles.dateInput}
              />
            </label>

            <div style={styles.queryActions}>
              <button
                type="button"
                onClick={() => {
                  setBusinessDate(defaultBusinessDate);
                  void loadDryRun(defaultBusinessDate);
                }}
                disabled={loading || applying}
                style={styles.secondaryButton}
              >
                오늘
              </button>

              <button
                type="button"
                onClick={() => loadDryRun(businessDate)}
                disabled={loading || applying}
                style={
                  loading || applying
                    ? styles.primaryButtonDisabled
                    : styles.primaryButton
                }
              >
                {loading ? "조회 중..." : "조회"}
              </button>
            </div>
          </div>

          <div style={styles.windowBox}>
            <span style={styles.windowLabel}>영업일 기준</span>
            <strong style={styles.windowText}>{businessWindowText}</strong>
          </div>

          {lastLoadedAt ? (
            <div style={styles.loadedBox}>마지막 조회: {lastLoadedAt}</div>
          ) : null}

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

        <section style={styles.stack}>
          <Card title="Direct 처리 상태" rightText="자동 차감">
            {directItems.length === 0 ? (
              <EmptyText
                text={
                  hasData
                    ? "자동 차감 항목이 없습니다."
                    : "아직 조회 전입니다."
                }
              />
            ) : (
              <div style={styles.directList}>
                {directItems.map((item) => (
                  <div key={item.id} style={styles.directRow}>
                    <div style={styles.directRowMain}>
                      <div style={styles.directName}>{item.name}</div>

                      <div style={styles.directMeta}>
                        <span>
                          현재 {moneyLike(item.currentQuantity)}
                          {item.unit ? ` ${item.unit}` : ""}
                        </span>
                        <span style={styles.directMinus}>
                          차감 -{moneyLike(item.deductQuantity)}
                          {item.unit ? ` ${item.unit}` : ""}
                        </span>
                        <span>
                          예상 {moneyLike(item.expectedAfterQuantity)}
                          {item.unit ? ` ${item.unit}` : ""}
                        </span>
                      </div>
                    </div>

                    <StatusBadge status={item.status} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <section style={styles.reviewCard}>
            <div style={styles.cardHeader}>
              <div>
                <h2 style={styles.sectionTitle}>수동 확인 / 매핑 필요</h2>
                <p style={styles.sectionDesc}>
                  manual, unmapped, option, recipe, ignore 라인을 확인합니다.
                </p>
              </div>
            </div>

            <div style={styles.filters}>
              <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
                전체
              </FilterButton>
              <FilterButton
                active={filter === "manual"}
                onClick={() => setFilter("manual")}
              >
                Manual
              </FilterButton>
              <FilterButton
                active={filter === "unmapped"}
                onClick={() => setFilter("unmapped")}
              >
                Unmapped
              </FilterButton>
              <FilterButton
                active={filter === "option"}
                onClick={() => setFilter("option")}
              >
                Option
              </FilterButton>
              <FilterButton
                active={filter === "recipe"}
                onClick={() => setFilter("recipe")}
              >
                Recipe
              </FilterButton>
              <FilterButton
                active={filter === "ignore"}
                onClick={() => setFilter("ignore")}
              >
                Ignore
              </FilterButton>
            </div>

            {filteredReviewItems.length === 0 ? (
              <EmptyText
                text={
                  hasData
                    ? "현재 필터에 해당하는 항목이 없습니다."
                    : "dry-run 조회 결과가 없습니다."
                }
              />
            ) : (
              <div style={styles.reviewList}>
                {filteredReviewItems.map((item) => (
                  <div key={item.id} style={styles.reviewItem}>
                    <div style={styles.reviewMain}>
                      <StatusBadge status={item.status} />

                      <div style={styles.reviewTextBox}>
                        <div style={styles.reviewName}>
                          {item.code} · {item.name}
                        </div>
                        <div style={styles.reviewReason}>{item.reason}</div>
                      </div>
                    </div>

                    <div style={styles.reviewQty}>x{moneyLike(item.quantity)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Card title="처리 상태" rightText="중복 방지">
            <div style={styles.summaryRows}>
              <SummaryRow label="차감 대기" value={summary.pendingCount} />
              <SummaryRow label="차감 완료" value={summary.appliedCount} />
              <SummaryRow label="중복 제외" value={summary.skippedAlreadyAppliedCount} />
              <SummaryRow label="레시피 후보" value={summary.recipe} />
              <SummaryRow label="차감 제외" value={summary.ignore} />
            </div>

            <div style={styles.noticeBox}>
              생맥주·수제맥주와 옵션 항목은 자동 차감하지 않습니다. 이미 처리된 판매 내역은 다시 차감되지 않습니다.
            </div>
          </Card>

          <section style={styles.applyCard}>
            <div>
              <h2 style={styles.applyTitle}>Apply 실행</h2>
              <p style={styles.applyDesc}>
                같은 businessDate로 saveDryRun:true를 먼저 실행한 뒤 pending direct
                차감을 실제 inventory에 반영합니다.
              </p>
            </div>

            <button
              type="button"
              onClick={handleApply}
              disabled={applying || loading}
              style={
                applying || loading
                  ? styles.dangerButtonDisabled
                  : styles.dangerButton
              }
            >
              {applying ? "Apply 중..." : "Apply 실행"}
            </button>
          </section>

          {applyResult ? (
            <details style={styles.rawBox}>
              <summary style={styles.rawSummary}>apply 응답 보기</summary>
              <pre style={styles.rawPre}>{applyResult}</pre>
            </details>
          ) : null}


        </section>
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
  tone?: "default" | "green" | "amber" | "red" | "blue" | "purple";
}) {
  const toneStyle = {
    default: { bg: "#ffffff", border: "#e5e7eb", color: "#111827" },
    green: { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534" },
    amber: { bg: "#fffbeb", border: "#fde68a", color: "#92400e" },
    red: { bg: "#fef2f2", border: "#fecaca", color: "#991b1b" },
    blue: { bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" },
    purple: { bg: "#faf5ff", border: "#e9d5ff", color: "#6b21a8" },
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
      <div style={{ ...styles.statValue, color: toneStyle.color }}>
        {moneyLike(value)}
      </div>
      <div style={styles.statSub}>{sub}</div>
    </div>
  );
}

function Card({
  title,
  rightText,
  children,
}: {
  title: string;
  rightText?: string;
  children: ReactNode;
}) {
  return (
    <section style={styles.card}>
      <div style={styles.cardHeader}>
        <h2 style={styles.sectionTitle}>{title}</h2>
        {rightText ? <span style={styles.cardRightText}>{rightText}</span> : null}
      </div>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { status: MappingStatus | DirectStatus }) {
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

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={styles.summaryRow}>
      <span>{label}</span>
      <strong>{moneyLike(value)}</strong>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
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

function EmptyText({ text }: { text: string }) {
  return <div style={styles.emptyText}>{text}</div>;
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f5f2",
    color: "#111827",
    padding: "12px 12px 96px",
  },
  wrap: {
    width: "100%",
    maxWidth: 760,
    margin: "0 auto",
  },
  topTabs: {
    display: "flex",
    gap: 7,
    overflowX: "auto",
    padding: "2px 0 10px",
    marginBottom: 2,
  },
  topTabActive: {
    flexShrink: 0,
    height: 34,
    border: "1px solid #111827",
    borderRadius: 999,
    background: "#111827",
    color: "#ffffff",
    padding: "0 13px",
    fontSize: 13,
    fontWeight: 950,
    cursor: "default",
  },
  topTabDisabled: {
    flexShrink: 0,
    height: 34,
    border: "1px solid #e5e7eb",
    borderRadius: 999,
    background: "#ffffff",
    color: "#9ca3af",
    padding: "0 11px",
    fontSize: 13,
    fontWeight: 900,
    cursor: "not-allowed",
  },
  readyLabel: {
    marginLeft: 5,
    fontSize: 10,
    fontWeight: 900,
    color: "#c4c4c4",
  },
  hero: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 15,
    marginBottom: 10,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: 950,
    color: "#6b7280",
    letterSpacing: 0.5,
  },
  title: {
    margin: "4px 0 8px",
    fontSize: 23,
    lineHeight: 1.15,
    fontWeight: 950,
    color: "#111827",
  },
  description: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.48,
    color: "#4b5563",
    fontWeight: 650,
  },
  queryCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 13,
    marginBottom: 10,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  queryTop: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 9,
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
  dateInput: {
    width: "100%",
    height: 40,
    border: "1px solid #d1d5db",
    borderRadius: 13,
    padding: "0 11px",
    fontSize: 14,
    fontWeight: 850,
    color: "#111827",
    background: "#ffffff",
  },
  queryActions: {
    display: "flex",
    gap: 7,
  },
  primaryButton: {
    height: 40,
    border: "1px solid #111827",
    borderRadius: 13,
    padding: "0 14px",
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
    padding: "0 14px",
    background: "#9ca3af",
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 950,
    cursor: "not-allowed",
    whiteSpace: "nowrap",
  },
  secondaryButton: {
    height: 40,
    border: "1px solid #e5e7eb",
    borderRadius: 13,
    padding: "0 12px",
    background: "#ffffff",
    color: "#374151",
    fontSize: 13,
    fontWeight: 950,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  windowBox: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "10px 11px",
    borderRadius: 15,
    background: "#f9fafb",
    border: "1px solid #eef0f3",
    marginBottom: 8,
  },
  windowLabel: {
    fontSize: 11,
    color: "#6b7280",
    fontWeight: 900,
  },
  windowText: {
    fontSize: 12,
    color: "#111827",
    fontWeight: 850,
    lineHeight: 1.4,
    wordBreak: "keep-all",
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
    gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))",
    gap: 8,
    marginBottom: 10,
  },
  statCard: {
    border: "1px solid #e5e7eb",
    borderRadius: 17,
    padding: 10,
    minHeight: 78,
    boxShadow: "0 6px 16px rgba(15, 23, 42, 0.04)",
  },
  statLabel: {
    fontSize: 11,
    fontWeight: 900,
    color: "#6b7280",
    marginBottom: 6,
  },
  statValue: {
    fontSize: 22,
    lineHeight: 1,
    fontWeight: 950,
    marginBottom: 7,
  },
  statSub: {
    fontSize: 11,
    lineHeight: 1.35,
    color: "#6b7280",
    fontWeight: 800,
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 13,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
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
  cardRightText: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 950,
    color: "#6b7280",
    background: "#f3f4f6",
    padding: "5px 8px",
    borderRadius: 999,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 9,
  },
  directItem: {
    border: "1px solid #e5e7eb",
    borderRadius: 17,
    padding: 11,
    background: "#fcfcfd",
  },
  itemTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "flex-start",
    marginBottom: 11,
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
    fontSize: 15,
    fontWeight: 950,
    color: "#111827",
    wordBreak: "keep-all",
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
  quantityGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))",
    gap: 7,
  },
  miniMetric: {
    padding: "9px 10px",
    background: "#ffffff",
    border: "1px solid #eef0f3",
    borderRadius: 14,
  },
  miniLabel: {
    fontSize: 11,
    color: "#6b7280",
    fontWeight: 900,
    marginBottom: 4,
  },
  miniValue: {
    fontSize: 14,
    color: "#111827",
    fontWeight: 950,
  },
  miniValueNegative: {
    fontSize: 14,
    color: "#dc2626",
    fontWeight: 950,
  },
  unit: {
    fontSize: 11,
    color: "#6b7280",
    fontWeight: 850,
  },
  reviewCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 13,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  filters: {
    display: "flex",
    gap: 7,
    overflowX: "auto",
    paddingBottom: 8,
    marginBottom: 4,
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
  reviewList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  reviewItem: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 10,
    alignItems: "center",
    padding: "11px 0",
    borderBottom: "1px solid #f3f4f6",
  },
  reviewMain: {
    display: "flex",
    gap: 9,
    alignItems: "flex-start",
    minWidth: 0,
  },
  reviewTextBox: {
    minWidth: 0,
  },
  reviewName: {
    fontSize: 13,
    fontWeight: 950,
    color: "#111827",
    marginBottom: 4,
    lineHeight: 1.35,
  },
  reviewReason: {
    fontSize: 12,
    lineHeight: 1.42,
    color: "#6b7280",
    fontWeight: 650,
  },
  reviewQty: {
    fontSize: 13,
    fontWeight: 950,
    color: "#111827",
    whiteSpace: "nowrap",
  },
  emptyText: {
    padding: "24px 10px",
    textAlign: "center",
    color: "#9ca3af",
    fontSize: 13,
    fontWeight: 750,
  },
  summaryRows: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginBottom: 11,
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    padding: "9px 0",
    borderBottom: "1px solid #f3f4f6",
    fontSize: 13,
    color: "#374151",
    fontWeight: 700,
  },
  noticeBox: {
    padding: 11,
    borderRadius: 15,
    background: "#eff6ff",
    border: "1px solid #bfdbfe",
    color: "#1e40af",
    fontSize: 12,
    lineHeight: 1.45,
    fontWeight: 700,
  },
  applyCard: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 12,
    alignItems: "center",
    background: "#111827",
    borderRadius: 20,
    padding: 14,
    color: "#ffffff",
    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.16)",
  },
  applyTitle: {
    margin: 0,
    fontSize: 15,
    fontWeight: 950,
    color: "#ffffff",
  },
  applyDesc: {
    margin: "5px 0 0",
    fontSize: 12,
    lineHeight: 1.45,
    color: "#d1d5db",
    fontWeight: 650,
  },
  dangerButton: {
    height: 40,
    border: "1px solid #ef4444",
    borderRadius: 13,
    padding: "0 13px",
    background: "#ef4444",
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 950,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  dangerButtonDisabled: {
    height: 40,
    border: "1px solid #9ca3af",
    borderRadius: 13,
    padding: "0 13px",
    background: "#9ca3af",
    color: "#ffffff",
    fontSize: 13,
    fontWeight: 950,
    cursor: "not-allowed",
    whiteSpace: "nowrap",
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
  directList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },

  directRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 10,
    alignItems: "center",
    padding: "9px 0",
    borderBottom: "1px solid #f3f4f6",
  },

  directRowMain: {
    minWidth: 0,
  },

  directName: {
    fontSize: 13,
    lineHeight: 1.35,
    fontWeight: 950,
    color: "#111827",
    marginBottom: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  directMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: "5px 10px",
    fontSize: 11,
    lineHeight: 1.35,
    color: "#6b7280",
    fontWeight: 800,
  },

  directMinus: {
    color: "#dc2626",
    fontWeight: 950,
  },
} satisfies Record<string, CSSProperties>;