"use client";

import { useCallback, useState, type FormEvent } from "react";
import type { RecurringMonthStatus, RecurringPlanRow } from "@/lib/ledger/recurring-expenses";
import styles from "../ledger-settings.module.css";

// Not mounted since the 2026-10-28 A plan (임대료·준비금 manages rent); kept for creating
// the next lease's plan version once its terms are confirmed.
// 정기비용 (e.g. 매장 임대료): monthly accrual recognitions only. Loaded when the card
// is opened, so the 기본설정 tab keeps its two reads. Plan creation and monthly sync
// go through the deployed RPCs; the database rejects closed months.

type Category = { id: number; name: string; parent_id: number | null };
type Data = { currentMonth: string; plans: RecurringPlanRow[]; categories: Category[]; months: RecurringMonthStatus[] };

const text = {
  ko: {
    title: "정기비용 (매월 발생 비용)",
    planCount: (count: number) => `${count}개`,
    info: "정기비용은 매월 비용(발생 기준)만 기록합니다. 선납금 지급·임대료 준비금 적립과 별개이며 자금 이동을 만들지 않습니다. 마감된 월에는 반영되지 않으므로, 먼저 해당 월을 재검토(잠금 해제)해야 합니다.",
    loading: "불러오는 중…",
    loadFailed: (code: string) => `정기비용을 불러오지 못했습니다: ${code}`,
    noPlans: "등록된 정기비용이 없습니다.",
    perMonth: "/월",
    from: (month: string, to: string | null) => to ? `${month} ~ ${to.slice(0, 7)}` : `${month}부터`,
    active: "사용 중", inactive: "종료",
    monthsTitle: "월별 반영 상태",
    closure: { open: "열림", closed: "마감", reopened: "재검토 중" },
    recognized: (id: number) => `반영됨 #${id}`,
    missing: "미반영",
    cancelled: "취소됨",
    sync: "반영",
    closedHint: "마감됨 · 재검토 후 반영",
    confirmSync: (month: string, count: number, amount: string) => `${month} 정기비용 ${count}건(${amount})을 비용으로 반영합니다. 자금 이동은 생기지 않습니다. 계속할까요?`,
    synced: (month: string, created: number) => `${month}: ${created}건 반영했습니다.`,
    alreadySynced: (month: string) => `${month}: 이미 반영되어 변경이 없습니다.`,
    addPlan: "정기비용 추가", closeAdd: "닫기",
    name: "이름", category: "비용 분류", amount: "월 금액", day: "인식일", startMonth: "시작 월", key: "고유 키 (영문 소문자·숫자·-)", memo: "메모",
    createHelp: "계획만 저장합니다. 비용은 각 월의 '반영' 또는 마감 화면에서 기록됩니다. 같은 분류의 사용 중 정기비용이 있으면 중복 인식을 막기 위해 추가할 수 없습니다.",
    create: "계획 저장",
    confirmCreate: (name: string, amount: string, month: string) => `${name} · 월 ${amount} · ${month}부터 계획을 저장합니다. 계속할까요?`,
    created: "정기비용 계획을 저장했습니다.",
    failed: (code: string) => `처리하지 못했습니다: ${code}`,
  },
  vi: {
    title: "Chi phí định kỳ (phát sinh hằng tháng)",
    planCount: (count: number) => `${count} mục`,
    info: "Chi phí định kỳ chỉ ghi nhận chi phí hằng tháng (theo phát sinh). Tách biệt với tiền trả trước và quỹ dự phòng tiền thuê, không tạo dòng tiền. Không ghi nhận vào tháng đã chốt; cần mở kiểm tra lại tháng đó trước.",
    loading: "Đang tải…",
    loadFailed: (code: string) => `Không tải được chi phí định kỳ: ${code}`,
    noPlans: "Chưa có chi phí định kỳ.",
    perMonth: "/tháng",
    from: (month: string, to: string | null) => to ? `${month} ~ ${to.slice(0, 7)}` : `Từ ${month}`,
    active: "Đang dùng", inactive: "Đã kết thúc",
    monthsTitle: "Trạng thái ghi nhận theo tháng",
    closure: { open: "Đang mở", closed: "Đã chốt", reopened: "Đang kiểm tra lại" },
    recognized: (id: number) => `Đã ghi nhận #${id}`,
    missing: "Chưa ghi nhận",
    cancelled: "Đã hủy",
    sync: "Ghi nhận",
    closedHint: "Đã chốt · ghi nhận sau khi mở lại",
    confirmSync: (month: string, count: number, amount: string) => `Ghi nhận ${count} chi phí định kỳ (${amount}) cho ${month}. Không tạo dòng tiền. Tiếp tục?`,
    synced: (month: string, created: number) => `${month}: đã ghi nhận ${created} mục.`,
    alreadySynced: (month: string) => `${month}: đã ghi nhận trước đó, không thay đổi.`,
    addPlan: "Thêm chi phí định kỳ", closeAdd: "Đóng",
    name: "Tên", category: "Phân loại chi phí", amount: "Số tiền mỗi tháng", day: "Ngày ghi nhận", startMonth: "Tháng bắt đầu", key: "Mã duy nhất (chữ thường·số·-)", memo: "Ghi chú",
    createHelp: "Chỉ lưu kế hoạch. Chi phí được ghi khi bấm 'Ghi nhận' từng tháng hoặc ở màn hình chốt sổ. Không thể thêm nếu cùng phân loại đã có chi phí định kỳ đang dùng, để tránh ghi nhận trùng.",
    create: "Lưu kế hoạch",
    confirmCreate: (name: string, amount: string, month: string) => `Lưu kế hoạch ${name} · ${amount}/tháng · từ ${month}. Tiếp tục?`,
    created: "Đã lưu kế hoạch chi phí định kỳ.",
    failed: (code: string) => `Không xử lý được: ${code}`,
  },
} as const;

const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
const emptyForm = (month: string) => ({ name: "", categoryId: "", amount: "", recognitionDay: "1", effectiveFrom: month, sourceKeyPrefix: "", memo: "" });

export default function RecurringExpensePanel({ lang }: { lang: "ko" | "vi" }) {
  const copy = text[lang];
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(() => emptyForm(""));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/ledger/recurring-expenses", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.code ?? "LOAD_FAILED");
      setData(body as Data);
    } catch (cause) {
      setError(copy.loadFailed((cause as Error).message));
    } finally {
      setLoading(false);
    }
  }, [copy]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data && !loading) void load();
  }

  async function post(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/ledger/recurring-expenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.code ?? "FAILED");
    return result;
  }

  async function syncMonth(row: RecurringMonthStatus) {
    const missing = row.items.filter(item => item.status === "missing");
    if (!window.confirm(copy.confirmSync(row.month, missing.length, money(missing.reduce((sum, item) => sum + item.amount, 0))))) return;
    setWorking(true); setMessage(""); setError("");
    try {
      const result = await post({ action: "sync", month: row.month });
      const created = Number(result?.result?.createdCount ?? 0);
      setMessage(created ? copy.synced(row.month, created) : copy.alreadySynced(row.month));
      await load();
    } catch (cause) {
      setError(copy.failed((cause as Error).message));
    } finally {
      setWorking(false);
    }
  }

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(copy.confirmCreate(form.name, money(Number(form.amount)), form.effectiveFrom))) return;
    setWorking(true); setMessage(""); setError("");
    try {
      await post({ action: "create_plan", name: form.name, categoryId: Number(form.categoryId), amount: Number(form.amount), recognitionDay: Number(form.recognitionDay), effectiveFrom: form.effectiveFrom, sourceKeyPrefix: form.sourceKeyPrefix, memo: form.memo || null });
      setMessage(copy.created); setFormOpen(false); setForm(emptyForm(data?.currentMonth ?? ""));
      await load();
    } catch (cause) {
      setError(copy.failed((cause as Error).message));
    } finally {
      setWorking(false);
    }
  }

  const categoryName = (id: number | string) => data?.categories.find(category => Number(category.id) === Number(id))?.name ?? `#${id}`;
  const activePlans = data?.plans.filter(plan => plan.is_active).length ?? 0;
  return <section className={`${styles.card} ${styles.accordionCard}`}>
    <button type="button" className={styles.accordionHeader} aria-expanded={open} aria-controls="settings-recurring-expenses" onClick={toggle}>
      <h2>📅 {copy.title}</h2><span className={styles.countBadge}>{data ? copy.planCount(activePlans) : "…"}</span><span className={styles.accordionChevron} aria-hidden>{open ? "⌃" : "›"}</span>
    </button>
    {open ? <div id="settings-recurring-expenses" className={styles.accordionBody}>
      <p className={`${styles.infoPanel} ${styles.compactInfo}`}>{copy.info}</p>
      {message ? <p role="status" className={styles.notice}>{message}</p> : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {loading && !data ? <p className={styles.mutedHelp}>{copy.loading}</p> : null}
      {data ? <>
        <div className={styles.settingRows}>
          {data.plans.length ? data.plans.map(plan => <div className={styles.settingRow} key={plan.id}>
            <div className={styles.settingRowMain}>
              <span className={styles.settingRowTitle}>{categoryName(plan.category_id)} · {copy.from(plan.effective_from.slice(0, 7), plan.effective_to)}</span>
              <strong>{plan.name} · {money(Number(plan.amount))}{copy.perMonth}</strong>
              {plan.memo ? <small>{plan.memo}</small> : null}
            </div>
            <span className={plan.is_active ? styles.statusActive : styles.statusInactive}>{plan.is_active ? copy.active : copy.inactive}</span>
          </div>) : <p className={styles.mutedHelp}>{copy.noPlans}</p>}
        </div>
        {data.months.some(row => row.items.length) ? <div className={styles.recurringMonths}>
          <strong className={styles.recurringMonthsTitle}>{copy.monthsTitle}</strong>
          {data.months.filter(row => row.items.length).map(row => <div className={styles.recurringMonthRow} key={row.month}>
            <div className={styles.recurringMonthHead}>
              <strong>{row.month}</strong>
              <span className={row.closure === "closed" ? styles.statusInactive : styles.statusActive}>{copy.closure[row.closure]}</span>
              {row.missingCount && row.closure !== "closed" ? <button type="button" className={styles.settingRowAction} disabled={working} onClick={() => void syncMonth(row)}>{copy.sync}</button> : null}
              {row.missingCount && row.closure === "closed" ? <small className={styles.mutedHelp}>{copy.closedHint}</small> : null}
            </div>
            {row.items.map(item => <div className={styles.recurringItem} key={item.planId}>
              <span>{item.planName}</span>
              <span className={item.status === "missing" ? styles.recurringMissing : undefined}>{item.status === "recognized" && item.transactionId ? copy.recognized(item.transactionId) : item.status === "cancelled" ? copy.cancelled : copy.missing}</span>
              <strong>{money(item.amount)}</strong>
            </div>)}
          </div>)}
        </div> : null}
        <div className={styles.buttonRow}>
          <button type="button" className={styles.secondary} aria-expanded={formOpen} onClick={() => { setFormOpen(value => !value); setForm(current => current.effectiveFrom ? current : emptyForm(data.currentMonth)); }}>{formOpen ? copy.closeAdd : copy.addPlan}</button>
        </div>
        {formOpen ? <form className={styles.formGrid} onSubmit={createPlan}>
          <label>{copy.name}<input required className={styles.input} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <label>{copy.category}<select required className={styles.input} value={form.categoryId} onChange={event => setForm({ ...form, categoryId: event.target.value })}><option value="" />{data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label>{copy.amount}<input required type="number" min="0.001" step="0.001" className={styles.input} value={form.amount} onChange={event => setForm({ ...form, amount: event.target.value })} /></label>
          <label>{copy.day}<input required type="number" min="1" max="31" className={styles.input} value={form.recognitionDay} onChange={event => setForm({ ...form, recognitionDay: event.target.value })} /></label>
          <label>{copy.startMonth}<input required type="month" className={styles.input} value={form.effectiveFrom} onChange={event => setForm({ ...form, effectiveFrom: event.target.value })} /></label>
          <label>{copy.key}<input required pattern="[a-z0-9_\-]{1,40}" className={styles.input} value={form.sourceKeyPrefix} onChange={event => setForm({ ...form, sourceKeyPrefix: event.target.value })} /></label>
          <label className={styles.spanTwo}>{copy.memo}<input className={styles.input} value={form.memo} onChange={event => setForm({ ...form, memo: event.target.value })} /></label>
          <p className={`${styles.infoPanel} ${styles.spanTwo}`}>{copy.createHelp}</p>
          <button className={styles.primary} disabled={working}>{copy.create}</button>
        </form> : null}
      </> : null}
    </div> : null}
  </section>;
}
