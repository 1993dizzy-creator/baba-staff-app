"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import {
  BarField,
  BarSegmentedControl,
  BarSheet,
  keepingInputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
} from "@/components/bar/keeping/KeepingUi";
import type { LedgerEntry, LedgerEntryItem } from "@/lib/ledger/entries";
import {
  formatLedgerAmountInput,
  parseLedgerAmount,
  sanitizeLedgerAmountInput,
} from "@/lib/ledger/manual-entry-amount";
import {
  isManualExpenseCategory,
  manualExpenseCategoryLabel,
  manualExpenseCategorySort,
} from "@/lib/ledger/manual-entry-policy";
import styles from "./entries.module.css";

type Account = {
  id: number;
  code: string;
  type: string;
  display_name: string;
  is_active: boolean;
  is_business_fund: boolean;
  balance: number;
  openingBalance: number;
};
type Category = {
  id: number;
  name: string;
  kind: "income" | "expense";
  parent_id: number | null;
  parent?: { name?: string } | null;
};
type Partner = {
  id: number;
  name: string;
  ledgerPartyId: number;
  paymentMode: "immediate" | "postpaid";
  defaultFundAccountId: number | null;
  isActive: boolean;
};
type LedgerData = {
  month: string;
  accounts: Account[];
  categories: Category[];
  partners: Partner[];
  entries: LedgerEntry[];
};
type EntryFilter = "all" | "income" | "expense" | "manual" | "pending";
type EntryType = "expense" | "income" | "transfer" | "balance_adjustment";
type CandidateDraft = {
  item: LedgerEntryItem;
  resolution: "immediate" | "payable";
  categoryId: string;
  fundAccountId: string;
  memo: string;
};
type DateGroup = {
  date: string;
  rows: LedgerEntry[];
  income: number;
  expense: number;
};

const currentMonth = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
const localTime = () =>
  new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16);
const money = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount))} ₫`;
const accountShortName: Record<string, string> = {
  store_cash: "현금",
  vuong_personal_custody: "Vương 개인",
  cho_personal_custody: "Cho 개인",
  baba_corporate_bank: "법인",
};
const accountOrder: Record<string, number> = {
  store_cash: 0,
  baba_corporate_bank: 1,
  vuong_personal_custody: 2,
  cho_personal_custody: 3,
};
const todayDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const monthNoticeCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
};
const monthControlStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  gap: 8,
};
const monthButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "9px 10px",
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 800,
};
const monthInputStyle: CSSProperties = {
  ...ui.input,
  width: "100%",
  minWidth: 0,
  padding: "9px 10px",
  fontSize: 13,
  borderRadius: 10,
};

export default function LedgerEntriesPage() {
  const { lang } = useLanguage(),
    vi = lang === "vi";
  const [month, setMonth] = useState(currentMonth),
    [data, setData] = useState<LedgerData | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [closed, setClosed] = useState(false);
  const [filter, setFilter] = useState<EntryFilter>("all"),
    [search, setSearch] = useState(""),
    [manualOpen, setManualOpen] = useState(false),
    [selected, setSelected] = useState<LedgerEntry | null>(null),
    [candidateDraft, setCandidateDraft] = useState<CandidateDraft | null>(null);
  const [saving, setSaving] = useState(false),
    [detailMessage, setDetailMessage] = useState(""),
    [posDetail, setPosDetail] = useState<Record<string, unknown> | null>(null),
    [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set());
  const addButtonRef = useRef<HTMLButtonElement>(null),
    initializedMonthRef = useRef("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const [ledgerResponse, closeResponse] = await Promise.all([
          fetch(`/api/admin/ledger?month=${month}`, {
            cache: "no-store",
            signal,
          }),
          fetch(`/api/admin/ledger/month-close?month=${month}`, {
            cache: "no-store",
            signal,
          }),
        ]);
        const [ledgerBody, closeBody] = await Promise.all([
          ledgerResponse.json(),
          closeResponse.json(),
        ]);
        if (!ledgerResponse.ok || !closeResponse.ok)
          throw new Error(ledgerBody.code ?? closeBody.code ?? "LOAD_FAILED");
        setData(ledgerBody);
        setClosed(closeBody.state === "closed");
      } catch (cause) {
        if ((cause as Error).name !== "AbortError")
          setError(
            vi
              ? "Không thể tải sổ. Vui lòng thử lại sau."
              : "장부를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [month, vi],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const groups = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase(),
      byDate = new Map<string, DateGroup>();
    for (const entry of data?.entries ?? []) {
      if (filter === "income" && entry.direction !== "income") continue;
      if (filter === "expense" && entry.direction !== "expense") continue;
      if (filter === "manual" && entry.origin !== "manual") continue;
      if (filter === "pending" && entry.status !== "pending") continue;
      if (
        keyword &&
        !`${entry.title} ${entry.subtitle} ${entry.accountName ?? ""} ${entry.categoryName ?? ""}`
          .toLocaleLowerCase()
          .includes(keyword)
      )
        continue;
      const group = byDate.get(entry.businessDate) ?? {
        date: entry.businessDate,
        rows: [],
        income: 0,
        expense: 0,
      };
      group.rows.push(entry);
      if (entry.direction === "income") group.income += entry.amount;
      if (entry.direction === "expense") group.expense += entry.amount;
      byDate.set(entry.businessDate, group);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [data?.entries, filter, search]);
  const businessAccounts = useMemo(
    () =>
      (data?.accounts ?? [])
        .filter(
          (account) =>
            account.is_active &&
            account.is_business_fund &&
            account.type !== "card_clearing",
        )
        .sort(
          (a, b) => (accountOrder[a.code] ?? 99) - (accountOrder[b.code] ?? 99),
        ),
    [data?.accounts],
  );
  const openingTotal = useMemo(
    () =>
      businessAccounts.reduce(
        (sum, account) => sum + account.openingBalance,
        0,
      ),
    [businessAccounts],
  );
  const monthlyTotals = useMemo(
    () =>
      (data?.entries ?? []).reduce(
        (totals, entry) => {
          if (entry.direction === "income") totals.income += entry.amount;
          if (entry.direction === "expense") totals.expense += entry.amount;
          return totals;
        },
        { income: 0, expense: 0 },
      ),
    [data?.entries],
  );
  useEffect(() => {
    if (!data || data.month !== month || initializedMonthRef.current === month)
      return;
    const dates = [
        ...new Set(data.entries.map((entry) => entry.businessDate)),
      ].sort(),
      today = todayDate(),
      defaultDate = dates.includes(today) ? today : dates.at(-1);
    setExpandedDates(defaultDate ? new Set([defaultDate]) : new Set());
    initializedMonthRef.current = month;
  }, [data, month]);
  function shiftMonth(delta: number) {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    setMonth(date.toISOString().slice(0, 7));
  }
  async function openEntry(entry: LedgerEntry) {
    setSelected(entry);
    setCandidateDraft(null);
    setDetailMessage("");
    setPosDetail(null);
    if (entry.drilldown === "pos" && entry.transactionId) {
      try {
        const response = await fetch(
            `/api/admin/ledger/transactions/${entry.transactionId}/pos-drilldown`,
            { cache: "no-store" },
          ),
          body = await response.json();
        if (!response.ok) throw new Error(body.code);
        setPosDetail(body.drilldown);
      } catch {
        setDetailMessage(
          vi
            ? "Không thể tải chi tiết hóa đơn POS."
            : "POS 영수증 상세를 불러오지 못했습니다.",
        );
      }
    }
  }
  function editCandidate(item: LedgerEntryItem) {
    if (selected)
      setCandidateDraft({
        item,
        resolution: selected.defaultResolution ?? "immediate",
        categoryId: String(item.categoryId ?? ""),
        fundAccountId: String(selected.defaultFundAccountId ?? ""),
        memo: "",
      });
  }
  async function resolveCandidate() {
    if (!selected || !candidateDraft?.item.candidateId) return;
    setSaving(true);
    setDetailMessage("");
    try {
      const response = await fetch(
          `/api/admin/ledger/candidates/${candidateDraft.item.candidateId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resolution: candidateDraft.resolution,
              categoryId: Number(candidateDraft.categoryId),
              partyId: selected.partyId,
              fundAccountId:
                candidateDraft.resolution === "immediate"
                  ? Number(candidateDraft.fundAccountId)
                  : null,
              dueDate: null,
              memo: candidateDraft.memo || null,
              reason: null,
            }),
          },
        ),
        body = await response.json();
      if (!response.ok) throw new Error(body.code);
      setSelected(null);
      setCandidateDraft(null);
      await load();
    } catch (cause) {
      setDetailMessage(
        `${vi ? "Không thể ghi sổ." : "반영하지 못했습니다."} ${(cause as Error).message}`,
      );
    } finally {
      setSaving(false);
    }
  }
  function toggleDate(date: string) {
    setExpandedDates((current) => {
      const next = new Set(current);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }
  return (
    <Container noPaddingTop>
      <main className={styles.page}>
        <button
          ref={addButtonRef}
          type="button"
          disabled={closed}
          className={styles.addButton}
          onClick={() => setManualOpen(true)}
        >
          {vi ? "Thêm giao dịch" : "장부 내역 추가"}
        </button>
        <section
          style={monthNoticeCardStyle}
          aria-label={vi ? "Chọn tháng" : "월 선택"}
        >
          <div style={monthControlStyle}>
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label={vi ? "Tháng trước" : "이전 달"}
              style={monthButtonStyle}
            >
              {vi ? "Trước" : "이전"}
            </button>
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              aria-label={vi ? "Chọn tháng" : "월 선택"}
              style={monthInputStyle}
            />
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label={vi ? "Tháng sau" : "다음 달"}
              style={monthButtonStyle}
            >
              {vi ? "Sau" : "다음"}
            </button>
          </div>
        </section>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {data ? (
          <>
            <section
              className={styles.summaryGrid}
              aria-label={vi ? "Tổng hợp sổ tháng" : "월 장부 요약"}
            >
              <article className={`${styles.summaryCard} ${styles.incomeCard}`}>
                <span className={styles.summaryLabel}>
                  <i aria-hidden="true">💰</i>
                  {vi ? "Thu" : "수입"}
                </span>
                <strong>{money(monthlyTotals.income)}</strong>
                <small>{vi ? "Theo sổ tháng này" : "당월 장부 기준"}</small>
              </article>
              <article className={`${styles.summaryCard} ${styles.expenseCard}`}>
                <span className={styles.summaryLabel}>
                  <i aria-hidden="true">💸</i>
                  {vi ? "Chi" : "지출"}
                </span>
                <strong>{money(monthlyTotals.expense)}</strong>
                <small>{vi ? "Theo sổ tháng này" : "당월 장부 기준"}</small>
              </article>
            </section>
            <section
              className={styles.openingSection}
              aria-labelledby="opening-title"
            >
              <div className={styles.sectionTitle}>
                <h2 id="opening-title">
                  <span aria-hidden="true">🏦</span>
                  {vi ? "Số dư đầu tháng" : "당월 시재"}
                </h2>
                <span>{vi ? "Cố định đầu tháng" : "월초 고정"}</span>
              </div>
              <div className={styles.openingGrid}>
                {businessAccounts.map((account) => (
                  <article key={account.id}>
                    <span>{localizedAccountName(account, lang)}</span>
                    <strong>{money(account.openingBalance)}</strong>
                  </article>
                ))}
              </div>
              <div className={styles.openingTotal}>
                <span>
                  {vi ? "Tổng số dư đầu tháng" : "시재 합계"}
                </span>
                <strong>{money(openingTotal)}</strong>
              </div>
            </section>
            <section
              className={styles.filters}
              aria-label={vi ? "Bộ lọc sổ" : "장부 필터"}
            >
              <div className={styles.filterTabs}>
                {(
                  [
                    ["all", vi ? "Tất cả" : "전체"],
                    ["income", vi ? "Thu" : "수입"],
                    ["expense", vi ? "Chi" : "지출"],
                    ["manual", vi ? "Thủ công" : "수동"],
                    ["pending", vi ? "Cần xác nhận" : "확인 필요"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={
                  vi
                    ? "Tìm đối tác, nội dung, tài khoản"
                    : "거래처, 내용, 계정 검색"
                }
                aria-label={vi ? "Tìm kiếm sổ" : "장부 검색"}
              />
            </section>
            <section
              className={styles.book}
              aria-label={vi ? "Sổ hàng tháng" : "월간 장부"}
            >
              {loading ? (
                <p className={styles.empty}>
                  {vi ? "Đang tải sổ..." : "장부를 불러오는 중입니다."}
                </p>
              ) : groups.length === 0 ? (
                <p className={styles.empty}>
                  {vi
                    ? "Không có giao dịch phù hợp."
                    : "조건에 맞는 내역이 없습니다."}
                </p>
              ) : (
                groups.map((group) => {
                  const expanded =
                      Boolean(search.trim()) || expandedDates.has(group.date),
                    panelId = `ledger-date-${group.date}`;
                  return (
                    <section className={styles.dateGroup} key={group.date}>
                      <button
                        type="button"
                        className={styles.dateHeader}
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        onClick={() => toggleDate(group.date)}
                      >
                        <strong>{formatDate(group.date, lang)}</strong>
                        <span>
                          {group.rows.length} {vi ? "giao dịch" : "건"}
                          {group.income > 0
                            ? ` · ${vi ? "Thu" : "수입"} ${money(group.income)}`
                            : ""}
                          {group.expense > 0
                            ? ` · ${vi ? "Chi" : "지출"} ${money(group.expense)}`
                            : ""}
                        </span>
                        <i
                          aria-hidden
                          className={
                            expanded
                              ? styles.dateChevronOpen
                              : styles.dateChevron
                          }
                        >
                          ›
                        </i>
                      </button>
                      {expanded ? (
                        <div id={panelId}>
                          {group.rows.map((entry) => (
                            <button
                              type="button"
                              className={styles.entryRow}
                              key={entry.id}
                              onClick={() => void openEntry(entry)}
                            >
                              <span
                                className={`${styles.direction} ${styles[entry.direction]}`}
                              >
                                {entry.direction === "income"
                                  ? vi
                                    ? "Thu"
                                    : "수입"
                                  : entry.direction === "expense"
                                    ? vi
                                      ? "Chi"
                                      : "지출"
                                    : vi
                                      ? "Chuyển"
                                      : "이체"}
                              </span>
                              <span className={styles.entryMain}>
                                <strong>{entry.title}</strong>
                                <span> · {entryMeta(entry, lang)}</span>
                              </span>
                              {entry.status === "pending" ? (
                                <span className={styles.pendingBadge}>
                                  {vi ? "Cần xác nhận" : "확인 필요"}
                                </span>
                              ) : null}
                              <strong
                                className={
                                  entry.direction === "income"
                                    ? styles.amountIncome
                                    : entry.direction === "expense"
                                      ? styles.amountExpense
                                      : styles.amountTransfer
                                }
                              >
                                {entry.direction === "income"
                                  ? "+"
                                  : entry.direction === "expense"
                                    ? "−"
                                    : ""}
                                {money(entry.amount)}
                              </strong>
                              <span aria-hidden className={styles.chevron}>
                                ›
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  );
                })
              )}
            </section>
          </>
        ) : loading ? (
          <p className={styles.empty}>
            {vi ? "Đang tải sổ..." : "장부를 불러오는 중입니다."}
          </p>
        ) : null}
        {data ? (
          <aside className={styles.balanceBar}>
            <div className={styles.balanceInner}>
              <strong>{vi ? "Tiền hiện có" : "현재 보유금"}</strong>
              <div>
                {businessAccounts.map((account) => (
                  <span key={account.id}>
                    <small>{localizedAccountName(account, lang)}</small>
                    <b>{money(account.balance)}</b>
                  </span>
                ))}
              </div>
            </div>
          </aside>
        ) : null}
        {manualOpen && data ? (
          <ManualEntrySheet
            lang={lang}
            data={data}
            month={month}
            saving={saving}
            setSaving={setSaving}
            onClose={() => setManualOpen(false)}
            returnFocusRef={addButtonRef}
            onSaved={async () => {
              setManualOpen(false);
              await load();
            }}
          />
        ) : null}
        {selected ? (
          <EntryDetailSheet
            lang={lang}
            entry={selected}
            accounts={data?.accounts ?? []}
            categories={data?.categories ?? []}
            candidateDraft={candidateDraft}
            setCandidateDraft={setCandidateDraft}
            editCandidate={editCandidate}
            resolveCandidate={resolveCandidate}
            saving={saving}
            message={detailMessage}
            posDetail={posDetail}
            onClose={() => {
              setSelected(null);
              setCandidateDraft(null);
            }}
          />
        ) : null}
      </main>
    </Container>
  );
}

function EntryDetailSheet({
  lang,
  entry,
  accounts,
  categories,
  candidateDraft,
  setCandidateDraft,
  editCandidate,
  resolveCandidate,
  saving,
  message,
  posDetail,
  onClose,
}: {
  lang: "ko" | "vi";
  entry: LedgerEntry;
  accounts: Account[];
  categories: Category[];
  candidateDraft: CandidateDraft | null;
  setCandidateDraft: (draft: CandidateDraft | null) => void;
  editCandidate: (item: LedgerEntryItem) => void;
  resolveCandidate: () => Promise<void>;
  saving: boolean;
  message: string;
  posDetail: Record<string, unknown> | null;
  onClose: () => void;
}) {
  const vi = lang === "vi";
  const payments = (posDetail?.payments ?? []) as Array<
    Record<string, unknown>
  >;
  return (
    <BarSheet
      kind="bottom"
      title={`${entry.title} ${vi ? "Chi tiết" : "상세"}`}
      closeLabel={vi ? "Đóng" : "닫기"}
      saving={saving}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={onClose}
          style={{ ...secondaryButtonStyle, width: "100%" }}
        >
          {vi ? "Đóng" : "닫기"}
        </button>
      }
    >
      <div className={styles.detailSummary}>
        <span>
          {formatDate(entry.businessDate, lang)} ·{" "}
          {entry.status === "pending"
            ? vi
              ? "Cần xác nhận"
              : "확인 필요"
            : vi
              ? "Đã ghi sổ"
              : "반영 완료"}
        </span>
        <strong>{money(entry.amount)}</strong>
        <small>
          {entry.accountName ?? (vi ? "Không có tài khoản" : "계정 없음")} ·{" "}
          {entry.categoryName
            ? manualExpenseCategoryLabel(entry.categoryName, lang)
            : vi
              ? "Nhiều danh mục"
              : "분류 혼합"}
        </small>
      </div>
      {message ? (
        <p className={styles.error} role="alert">
          {message}
        </p>
      ) : null}
      {entry.drilldown === "inventory" ? (
        <div className={styles.itemList}>
          {entry.items.map((item) => (
            <article key={item.candidateId ?? item.transactionId}>
              <div>
                <strong>{item.name}</strong>
                <span>
                  {item.quantity == null
                    ? ""
                    : `${item.quantity.toLocaleString("ko-KR")} · `}
                  {item.unitPrice == null ? "" : money(item.unitPrice)}
                </span>
              </div>
              <b>{money(item.amount)}</b>
              {entry.status === "pending" ? (
                <button type="button" onClick={() => editCandidate(item)}>
                  {vi ? "Sửa và ghi sổ" : "수정·반영"}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {payments.length ? (
        <div className={styles.itemList}>
          {payments.map((payment, index) => (
            <article key={String(payment.paymentId ?? index)}>
              <div>
                <strong>
                  {String(
                    payment.refNo ??
                      `${vi ? "Hóa đơn" : "영수증"} ${index + 1}`,
                  )}
                </strong>
                <span>
                  {String(
                    payment.paymentMethod ??
                      (vi ? "Phương thức thanh toán" : "결제수단"),
                  )}
                </span>
              </div>
              <b>{money(Number(payment.paymentAmount ?? 0))}</b>
            </article>
          ))}
        </div>
      ) : null}
      {candidateDraft ? (
        <div className={styles.candidateEditor}>
          <h3>{candidateDraft.item.name}</h3>
          <BarSegmentedControl
            label={vi ? "Phương thức xử lý" : "처리 방식"}
            value={candidateDraft.resolution}
            disabled={saving}
            onChange={(resolution) =>
              setCandidateDraft({ ...candidateDraft, resolution })
            }
            options={[
              {
                value: "immediate",
                label: vi ? "Thanh toán ngay" : "즉시 결제",
              },
              {
                value: "payable",
                label: vi ? "Ghi nhận công nợ" : "미지급 등록",
              },
            ]}
          />
          <BarField label={vi ? "Danh mục chi phí" : "비용 카테고리"} required>
            {({ id }) => (
              <select
                id={id}
                value={candidateDraft.categoryId}
                onChange={(event) =>
                  setCandidateDraft({
                    ...candidateDraft,
                    categoryId: event.target.value,
                  })
                }
                style={keepingInputStyle}
              >
                {categories
                  .filter(
                    (row) => row.kind === "expense" && row.parent_id !== null,
                  )
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {manualExpenseCategoryLabel(row.name, lang)}
                    </option>
                  ))}
              </select>
            )}
          </BarField>
          {candidateDraft.resolution === "immediate" ? (
            <BarField
              label={vi ? "Tài khoản thanh toán thực tế" : "실제 지급 계정"}
              required
            >
              {({ id }) => (
                <select
                  id={id}
                  value={candidateDraft.fundAccountId}
                  onChange={(event) =>
                    setCandidateDraft({
                      ...candidateDraft,
                      fundAccountId: event.target.value,
                    })
                  }
                  style={keepingInputStyle}
                >
                  <option value="">{vi ? "Chọn" : "선택"}</option>
                  {accounts
                    .filter(
                      (row) => row.is_active && row.type !== "card_clearing",
                    )
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.display_name}
                      </option>
                    ))}
                </select>
              )}
            </BarField>
          ) : null}
          <BarField label={vi ? "Ghi chú" : "메모"}>
            {({ id }) => (
              <input
                id={id}
                value={candidateDraft.memo}
                onChange={(event) =>
                  setCandidateDraft({
                    ...candidateDraft,
                    memo: event.target.value,
                  })
                }
                style={keepingInputStyle}
              />
            )}
          </BarField>
          <p className={styles.editorHelp}>
            {vi
              ? "Thay đổi này chỉ áp dụng cho giao dịch sổ hiện tại và không thay đổi thiết lập thanh toán mặc định của đối tác."
              : "이 변경은 해당 장부 내역에만 적용되며 거래처 기본 결제설정은 변경하지 않습니다."}
          </p>
          <button
            type="button"
            disabled={
              saving ||
              !candidateDraft.categoryId ||
              (candidateDraft.resolution === "immediate" &&
                !candidateDraft.fundAccountId)
            }
            onClick={() => void resolveCandidate()}
            style={{ ...primaryButtonStyle, width: "100%" }}
          >
            {saving
              ? vi
                ? "Đang ghi sổ…"
                : "반영 중…"
              : vi
                ? "Ghi mặt hàng này vào sổ"
                : "이 품목 장부에 반영"}
          </button>
        </div>
      ) : null}
      {entry.status === "confirmed" && entry.origin === "auto" ? (
        <p className={styles.policyNote}>
          {vi
            ? "Ảnh chụp dữ liệu nguồn được giữ nguyên. Thay đổi trong tháng đã khóa được xử lý theo chính sách điều chỉnh sổ hiện hành."
            : "원본 snapshot은 보존됩니다. 마감된 월의 변경은 기존 장부 정정 정책으로 처리됩니다."}
        </p>
      ) : null}
    </BarSheet>
  );
}

function ManualEntrySheet({
  lang,
  data,
  month,
  saving,
  setSaving,
  onClose,
  onSaved,
  returnFocusRef,
}: {
  lang: "ko" | "vi";
  data: LedgerData;
  month: string;
  saving: boolean;
  setSaving: (value: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const initial = localTime(),
    vi = lang === "vi";
  const [type, setType] = useState<EntryType>("expense"),
    [amount, setAmount] = useState(""),
    [occurredDate, setOccurredDate] = useState(initial.slice(0, 10)),
    [occurredTime, setOccurredTime] = useState(initial.slice(11, 16)),
    [categoryId, setCategoryId] = useState(""),
    [partnerId, setPartnerId] = useState(""),
    [fromAccountId, setFromAccountId] = useState(""),
    [toAccountId, setToAccountId] = useState(""),
    [memo, setMemo] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState("");
  const categories =
      type === "expense"
        ? data.categories
            .filter(isManualExpenseCategory)
            .sort(manualExpenseCategorySort)
        : data.categories.filter((row) => row.kind === "income"),
    accounts = data.accounts.filter((row) => row.is_active),
    selectedPartner = data.partners.find((row) => String(row.id) === partnerId);
  function changeType(next: EntryType) {
    setType(next);
    setCategoryId("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const amountValue = parseLedgerAmount(amount);
      if (amountValue === null)
        throw new Error(
          vi
            ? "Số tiền phải là số nguyên dương hợp lệ."
            : "금액은 안전한 범위의 양의 정수여야 합니다.",
        );
      const response = await fetch("/api/admin/ledger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            amount: amountValue,
            occurredAt: `${occurredDate}T${occurredTime}:00+07:00`,
            recognitionMonth:
              type === "income" || type === "expense" ? `${month}-01` : null,
            categoryId:
              type === "income" || type === "expense"
                ? Number(categoryId)
                : null,
            partyId:
              type === "expense"
                ? (selectedPartner?.ledgerPartyId ?? null)
                : null,
            fromAccountId:
              type === "expense" ||
              type === "transfer" ||
              (type === "balance_adjustment" && Number(amount) < 0)
                ? Number(fromAccountId)
                : null,
            toAccountId:
              type === "income" ||
              type === "transfer" ||
              (type === "balance_adjustment" && Number(amount) >= 0)
                ? Number(toAccountId)
                : null,
            memo,
            reason,
          }),
        }),
        body = await response.json();
      if (!response.ok) throw new Error(body.code);
      await onSaved();
    } catch (cause) {
      setError(
        `${vi ? "Không thể lưu." : "저장하지 못했습니다."} ${(cause as Error).message}`,
      );
    } finally {
      setSaving(false);
    }
  }
  const outgoing =
      type === "expense" ||
      type === "transfer" ||
      (type === "balance_adjustment" && Number(amount) < 0),
    incoming =
      type === "income" ||
      type === "transfer" ||
      (type === "balance_adjustment" && Number(amount) >= 0);
  return (
    <BarSheet
      kind="bottom"
      topAligned
      comfortableTop
      title={vi ? "Thêm giao dịch" : "장부 내역 추가"}
      closeLabel={vi ? "Đóng" : "닫기"}
      saving={saving}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <button
          form="manual-ledger-entry"
          disabled={saving}
          style={{ ...primaryButtonStyle, width: "100%" }}
        >
          {saving
            ? vi
              ? "Đang lưu..."
              : "저장 중…"
            : vi
              ? "Lưu vào sổ"
              : "장부에 저장"}
        </button>
      }
    >
      <form
        id="manual-ledger-entry"
        className={styles.manualForm}
        onSubmit={submit}
      >
        <BarSegmentedControl
          scrollable
          label={vi ? "Loại giao dịch" : "거래 유형"}
          value={type}
          disabled={saving}
          onChange={changeType}
          options={[
            { value: "expense", label: `💸 ${vi ? "Chi" : "지출"}` },
            { value: "income", label: `💰 ${vi ? "Thu" : "수입"}` },
            { value: "transfer", label: `🔄 ${vi ? "Chuyển tiền" : "이체"}` },
            {
              value: "balance_adjustment",
              label: `⚖️ ${vi ? "Điều chỉnh số dư" : "잔액조정"}`,
            },
          ]}
        />
        <div className={styles.manualGrid}>
          <div
            className={`${styles.manualRow} ${type === "income" || type === "expense" ? "" : styles.manualSingle}`}
          >
            <BarField label={`💵 ${vi ? "Số tiền" : "금액"}`} required compact>
              {({ id }) => (
                <input
                  id={id}
                  required
                  inputMode="numeric"
                  autoComplete="off"
                  value={formatLedgerAmountInput(amount)}
                  onChange={(event) =>
                    setAmount(sanitizeLedgerAmountInput(event.target.value))
                  }
                  style={keepingInputStyle}
                />
              )}
            </BarField>
            {type === "income" || type === "expense" ? (
              <BarField
                label={`🏷️ ${vi ? "Danh mục" : "카테고리"}`}
                required
                compact
              >
                {({ id }) => (
                  <select
                    id={id}
                    required
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    style={keepingInputStyle}
                  >
                    <option value="">{vi ? "Chọn" : "선택"}</option>
                    {categories.map((row) => (
                      <option key={row.id} value={row.id}>
                        {type === "expense"
                          ? manualExpenseCategoryLabel(row.name, lang)
                          : row.name}
                      </option>
                    ))}
                  </select>
                )}
              </BarField>
            ) : null}
          </div>
          <div className={styles.manualRow}>
            <BarField
              label={`📅 ${vi ? "Ngày phát sinh" : "발생일"}`}
              required
              compact
            >
              {({ id }) => (
                <input
                  id={id}
                  required
                  type="date"
                  value={occurredDate}
                  onChange={(event) => setOccurredDate(event.target.value)}
                  style={keepingInputStyle}
                />
              )}
            </BarField>
            <BarField
              label={`🕒 ${vi ? "Thời gian" : "시간"}`}
              required
              compact
            >
              {({ id }) => (
                <input
                  id={id}
                  required
                  type="time"
                  value={occurredTime}
                  onChange={(event) => setOccurredTime(event.target.value)}
                  style={keepingInputStyle}
                />
              )}
            </BarField>
          </div>
          <div
            className={`${styles.manualRow} ${type === "transfer" || type === "expense" ? "" : styles.manualSingle}`}
          >
            {outgoing ? (
              <AccountField
                lang={lang}
                label={`🏦 ${type === "balance_adjustment" ? (vi ? "Tài khoản điều chỉnh" : "조정 계정") : vi ? "Tài khoản chi" : "출금 계정"}`}
                value={fromAccountId}
                setValue={setFromAccountId}
                accounts={accounts}
              />
            ) : null}
            {incoming ? (
              <AccountField
                lang={lang}
                label={`🏦 ${type === "balance_adjustment" ? (vi ? "Tài khoản điều chỉnh" : "조정 계정") : vi ? "Tài khoản nhận" : "입금 계정"}`}
                value={toAccountId}
                setValue={setToAccountId}
                accounts={accounts}
              />
            ) : null}
            {type === "expense" ? (
              <BarField
                label={`🤝 ${vi ? "Đối tác (không bắt buộc)" : "거래처 (선택)"}`}
                compact
              >
                {({ id }) => (
                  <select
                    id={id}
                    value={partnerId}
                    onChange={(event) => setPartnerId(event.target.value)}
                    style={keepingInputStyle}
                  >
                    <option value="">{vi ? "Không có" : "없음"}</option>
                    {data.partners
                      .filter((row) => row.isActive)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </select>
                )}
              </BarField>
            ) : null}
          </div>
          {type === "balance_adjustment" ? (
            <div className={styles.manualFull}>
              <BarField
                label={`⚖️ ${vi ? "Lý do điều chỉnh" : "조정 사유"}`}
                required
                compact
              >
                {({ id }) => (
                  <input
                    id={id}
                    required
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    style={keepingInputStyle}
                  />
                )}
              </BarField>
            </div>
          ) : null}
          <div className={styles.manualFull}>
            <BarField label={`📝 ${vi ? "Ghi chú" : "메모"}`} compact>
              {({ id }) => (
                <input
                  id={id}
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  style={keepingInputStyle}
                />
              )}
            </BarField>
          </div>
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </BarSheet>
  );
}
function AccountField({
  lang,
  label,
  value,
  setValue,
  accounts,
}: {
  lang: "ko" | "vi";
  label: string;
  value: string;
  setValue: (value: string) => void;
  accounts: Account[];
}) {
  return (
    <BarField label={label} required compact>
      {({ id }) => (
        <select
          id={id}
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
          style={keepingInputStyle}
        >
          <option value="">{lang === "vi" ? "Chọn" : "선택"}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.display_name}
            </option>
          ))}
        </select>
      )}
    </BarField>
  );
}
function entryMeta(entry: LedgerEntry, lang: "ko" | "vi" = "ko") {
  const vi = lang === "vi",
    subtitle = entry.subtitle.replace(/\s*·\s*확인 필요/g, "");
  return [
    subtitle,
    entry.accountName ?? (vi ? "Không có tài khoản" : "계정 없음"),
    entry.origin === "manual" ? (vi ? "Thủ công" : "수동") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
function formatDate(date: string, lang: "ko" | "vi" = "ko") {
  const [, month, day] = date.split("-").map(Number);
  return lang === "vi" ? `${day}/${month}` : `${month}월 ${day}일`;
}
function localizedAccountName(account: Account, lang: "ko" | "vi") {
  if (lang === "ko")
    return accountShortName[account.code] ?? account.display_name;
  return (
    (
      {
        store_cash: "Tiền mặt",
        baba_corporate_bank: "Công ty",
        vuong_personal_custody: "Cá nhân Vương",
        cho_personal_custody: "Cá nhân Cho",
      } as Record<string, string>
    )[account.code] ?? account.display_name
  );
}
