"use client";
import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import PayrollModal from "@/components/payroll/PayrollModal";
import type {
  PayrollMonthlyAdjustment,
  PayrollOverviewEmployee,
} from "@/lib/payroll/overview";
import {
  formatContractRate,
  formatPayrollHeaderAmount,
  formatSignedVnd,
  formatVnd,
} from "@/lib/payroll/payroll-page-money";
import { formatRecognizedWork, getPayrollHeaderAmount } from "@/lib/payroll/payroll-page-display";
import { attendanceText } from "@/lib/text";
import { payrollOverviewText } from "@/lib/text/payroll-overview";
function age(date: string | null) {
  if (!date) return null;
  const today = new Date(),
    birth = new Date(`${date}T00:00:00`);
  let result = today.getFullYear() - birth.getFullYear();
  if (
    today.getMonth() < birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())
  )
    result--;
  return result;
}
export function CompensationCard({
  employee,
  expanded,
  toggle,
  lang,
  month,
  future,
  refresh,
}: {
  employee: PayrollOverviewEmployee;
  expanded: boolean;
  toggle: () => void;
  lang: "ko" | "vi";
  month: string;
  future: boolean;
  refresh: () => Promise<boolean>;
}) {
  const t = payrollOverviewText[lang];
  const attendance = attendanceText[lang];
  const detailText = lang === "vi"
    ? { salaryComposition: "Cấu thành lương", monthApplication: "Áp dụng tháng này", insuranceAndNet: "Bảo hiểm và thực nhận", recognizedWork: "Chấm công được ghi nhận", adjustmentManage: "Thêm · hủy", finalPayout: "Thực nhận", preInsurancePayoutWithInsurance: "Thu nhập trước khấu trừ bảo hiểm", monthlyEquivalent: "Quy đổi lương tháng", monthlyEquivalentHelp: "Theo điều kiện làm đủ theo hợp đồng" }
    : { salaryComposition: "급여 구성", monthApplication: "이번 달 반영", insuranceAndNet: "보험 및 최종 지급", recognizedWork: "인정 근무", adjustmentManage: "추가·취소", finalPayout: "최종 지급액", preInsurancePayoutWithInsurance: "보험 공제 전 금액", monthlyEquivalent: "월급여 환산", monthlyEquivalentHelp: "계약 기준 풀근무 시" };
  const [modal, setModal] = useState<"incentive" | "penalty" | null>(null);
  const combined = employee.amounts.combinedSalary;
  const headerAmount = getPayrollHeaderAmount(employee, future);
  const header = future
    ? "—"
    : !employee.contract
      ? t.contractUnset
      : combined === null
        ? t.levelBaseRequired
        : formatPayrollHeaderAmount(headerAmount ?? combined);
  const employeeAge = age(employee.birthDate);
  const positionLabel = employee.position
    ? (attendance.positions[
        employee.position as keyof typeof attendance.positions
      ] ?? employee.position)
    : employee.username;
  return (
    <article style={{ ...s.card, ...(expanded ? s.expandedCard : {}) }}>
      <button style={s.head} onClick={toggle} aria-expanded={expanded}>
        <span style={s.identity}>
          <EmployeeNameWithLevel
            name={`${employee.name}${employeeAge === null ? "" : ` (${employeeAge})`}`}
            levelInfo={employee.levelInfo}
            lang={lang}
            nameStyle={s.name}
          />
          <span style={s.separator}>·</span>
          <span style={s.position}>{positionLabel}</span>
        </span>
        <b
          style={s.amount}
          title={headerAmount === null ? header : formatVnd(headerAmount)}
        >
          {header}
        </b>
        <span style={s.expandIcon} aria-hidden="true">
          {expanded ? "⌃" : "⌄"}
        </span>
      </button>
      {expanded && (
        <div style={s.detail}>
          {!employee.contract ? (
            <>
              <p>{t.noContract}</p>
              <Link
                href={`/admin/payroll/settings?tab=employee&userId=${employee.userId}`}
              >
                {t.payrollSettingsLink}
              </Link>
            </>
          ) : combined === null ? (
            <>
              <p>{t.levelBaseRequired}</p>
              <Link href="/admin/users">{t.employeeSettingsLink}</Link>
            </>
          ) : (
            <>
              <DetailSection icon="💰" title={detailText.salaryComposition} first>
                <Row label={t.contractSalary} value={formatContractRate(employee.amounts.contractSalary, employee.contract.payType, lang)} />
                <Row label={t.fixedRaise} value={formatContractRate(employee.amounts.fixedRaiseAmount, employee.contract.payType, lang, "+")} />
                <Row label={t.levelRaise} value={formatContractRate(employee.amounts.levelRaiseAmount, employee.contract.payType, lang, "+")} />
                <CombinedSalarySummary
                  label={t.combinedSalary}
                  value={formatContractRate(combined, employee.contract.payType, lang)}
                  monthlyEquivalent={employee.contract.payType === "hourly" ? employee.amounts.contractMonthlyEquivalent : null}
                  monthlyEquivalentLabel={detailText.monthlyEquivalent}
                  monthlyEquivalentHelp={detailText.monthlyEquivalentHelp}
                />
              </DetailSection>

              <DetailSection icon="📅" title={detailText.monthApplication}>
                <Row label={detailText.recognizedWork} value={formatRecognizedWork(employee.recognizedMinutes, employee.recognizedWorkdays, lang)} wrapValue />
                <Row
                  label={t.accruedWork}
                  value={employee.amounts.workAppliedAmount === null ? t.settingsRequired : formatVnd(employee.amounts.workAppliedAmount)}
                />
                <AdjustmentButton
                  kind="incentive"
                  label={t.incentive}
                  manageLabel={detailText.adjustmentManage}
                  value={`${formatSignedVnd(employee.amounts.incentiveAmount, "+")} · ${employee.amounts.incentiveCount}${t.count}`}
                  onClick={() => setModal("incentive")}
                />
                <AdjustmentButton
                  kind="penalty"
                  label={t.penalty}
                  manageLabel={detailText.adjustmentManage}
                  value={`${formatSignedVnd(employee.amounts.penaltyAmount, "-")} · ${employee.amounts.penaltyCount}${t.count}`}
                  onClick={() => setModal("penalty")}
                />
                <Row label={employee.insuranceEnrolled ? detailText.preInsurancePayoutWithInsurance : detailText.finalPayout} value={formatVnd(employee.amounts.preInsurancePayoutAmount)} highlight={employee.insuranceEnrolled ? "subtotal" : "net"} />
                {!employee.insuranceEnrolled && employee.unresolvedAttendanceCount > 0 && <Row label={t.unresolvedAttendance} value={`${employee.unresolvedAttendanceCount}${t.days}`} />}
              </DetailSection>

              {employee.insuranceEnrolled && <DetailSection icon="🛡️" title={detailText.insuranceAndNet}>
                <Row label={t.insuranceBase} value={formatVnd(employee.amounts.insuranceBaseAmount)} />
                <Row label={t.employeeInsuranceDeduction} value={formatSignedVnd(employee.amounts.employeeInsuranceDeductionAmount, "-")} />
                <Row
                  label={t.netPayout}
                  value={employee.amounts.currentAmount === null ? t.settingsRequired : formatVnd(employee.amounts.netPayoutAmount)}
                  highlight="net"
                />
                <Row label={t.employerInsurance} value={formatVnd(employee.amounts.employerInsuranceAmount)} muted />
                {employee.amounts.employerInsuranceAmount > 0 && <small style={s.help}>{t.employerInsuranceHelp}</small>}
                {employee.unresolvedAttendanceCount > 0 && <Row label={t.unresolvedAttendance} value={`${employee.unresolvedAttendanceCount}${t.days}`} />}
              </DetailSection>}
            </>
          )}
        </div>
      )}
      {modal && (
        <AdjustmentModal
          employee={employee}
          month={month}
          kind={modal}
          lang={lang}
          close={() => setModal(null)}
          refresh={refresh}
        />
      )}
    </article>
  );
}
export function CombinedPartTotal({
  employees,
  lang,
}: {
  employees: PayrollOverviewEmployee[];
  lang: "ko" | "vi";
}) {
  const t = payrollOverviewText[lang];
  const values = employees.flatMap((employee) =>
    employee.amounts.combinedSalary === null
      ? []
      : [employee.amounts.combinedSalary],
  );
  const excluded = employees.length - values.length;
  return (
    <div style={s.total}>
      <Row
        label={t.combinedSalaryTotal}
        value={formatVnd(values.reduce((a, b) => a + b, 0))}
        strong
      />
      {excluded > 0 && (
        <Row label={t.settingsRequired} value={`${excluded}${t.people}`} />
      )}
      <small>
        {t.totalHelp} {excluded > 0 ? t.reviewHelp : ""}
      </small>
    </div>
  );
}
function AdjustmentModal({
  employee,
  month,
  kind,
  lang,
  close,
  refresh,
}: {
  employee: PayrollOverviewEmployee;
  month: string;
  kind: "incentive" | "penalty";
  lang: "ko" | "vi";
  close: () => void;
  refresh: () => Promise<boolean>;
}) {
  const t = payrollOverviewText[lang];
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(`${month}-01`);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [cancelTarget, setCancelTarget] =
    useState<PayrollMonthlyAdjustment | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mutationCompleted, setMutationCompleted] = useState(false);
  const list = employee.adjustments.filter((item) => item.kind === kind);
  const saveError =
    lang === "vi"
      ? "Không thể thêm điều chỉnh lương."
      : "급여 조정 내역을 등록하지 못했습니다.";
  const cancelError =
    lang === "vi"
      ? "Không thể hủy điều chỉnh lương."
      : "급여 조정 내역을 취소하지 못했습니다.";
  const refreshError =
    lang === "vi"
      ? "Điều chỉnh đã được lưu nhưng không thể tải lại thông tin lương. Vui lòng đóng cửa sổ và kiểm tra lại."
      : "조정 내역은 반영되었지만 급여 정보를 새로 불러오지 못했습니다. 창을 닫고 다시 확인해주세요.";
  async function responseError(response: Response, fallback: string) {
    try {
      const body = await response.text();
      if (!body) return fallback;
      const data = JSON.parse(body) as { message?: string; code?: string };
      if (typeof data.message === "string" && data.message) return data.message;
      if (typeof data.code === "string" && data.code) return data.code;
      return fallback;
    } catch {
      return fallback;
    }
  }
  async function save() {
    if (busy || mutationCompleted) return;
    setError("");
    setBusy(true);
    let completed = false;
    try {
      const response = await fetch("/api/admin/payroll/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: employee.userId,
          month,
          kind,
          category: "manual",
          amount: Number(amount),
          businessDate: date,
          reason,
          note,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, saveError));
      completed = true;
      setMutationCompleted(true);
      if (!(await refresh())) throw new Error(refreshError);
      close();
    } catch (reason) {
      setError(
        completed
          ? refreshError
          : reason instanceof Error
            ? reason.message || saveError
            : saveError,
      );
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (busy || mutationCompleted || !cancelTarget || !cancelReason.trim()) return;
    setError("");
    setBusy(true);
    let completed = false;
    try {
      const response = await fetch("/api/admin/payroll/adjustments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: cancelTarget.id,
          cancellationReason: cancelReason,
        }),
      });
      if (!response.ok)
        throw new Error(await responseError(response, cancelError));
      completed = true;
      setMutationCompleted(true);
      if (!(await refresh())) throw new Error(refreshError);
      close();
    } catch (reason) {
      setError(
        completed
          ? refreshError
          : reason instanceof Error
            ? reason.message || cancelError
            : cancelError,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <PayrollModal
      title={`${month} ${kind === "incentive" ? t.incentive : t.penalty}`}
      closeLabel={lang === "vi" ? "Đóng" : "닫기"}
      onClose={() => {
        if (!busy) close();
      }}
      footer={
        cancelTarget ? (
          <button
            style={s.danger}
            disabled={busy || mutationCompleted || !cancelReason.trim()}
            onClick={cancel}
          >
            {t.cancel}
          </button>
        ) : (
          <button
            style={s.primary}
            disabled={busy || mutationCompleted || !reason || Number(amount) < 1}
            onClick={save}
          >
            {kind === "incentive" ? t.addIncentive : t.addPenalty}
          </button>
        )
      }
    >
      <div style={s.list}>
        {kind === "penalty" &&
          employee.automaticPenalties.map((item) => (
            <article
              key={`${item.category}:${item.businessDate}`}
              style={s.item}
            >
              <span>
                {item.businessDate.slice(5)} · {item.category === "late"
                  ? (lang === "vi" ? "Phạt đi muộn" : "지각 패널티")
                  : item.category === "unauthorized_absence"
                    ? (lang === "vi" ? "Phạt nghỉ không phép" : "무단결근 패널티")
                    : item.description}
                {item.category !== "unauthorized_absence" ? ` ${item.minutes}${t.minutes}` : ""}
              </span>
              <b>{formatSignedVnd(item.amount, "-")}</b>
              <small>
                {lang === "vi" ? "Tự động · chỉ đọc" : "자동 · 읽기 전용"}
              </small>
            </article>
          ))}
        {list.map((item) => (
          <article key={item.id} style={s.item}>
            <span>
              {item.businessDate.slice(5)} · {item.category}
            </span>
            <b>
              {formatSignedVnd(item.amount, kind === "incentive" ? "+" : "-")}
            </b>
            <span>
              {item.reason}
              {item.note ? ` · ${item.note}` : ""}
            </span>
            <small>
              {new Date(item.createdAt).toLocaleString(
                lang === "vi" ? "vi-VN" : "ko-KR",
              )}
            </small>
            <button
              style={s.cancel}
              disabled={busy}
              onClick={() => setCancelTarget(item)}
            >
              {t.cancel}
            </button>
          </article>
        ))}
      </div>
      {error && (
        <p role="alert" style={s.error}>
          {error}
        </p>
      )}
      {cancelTarget ? (
        <label style={s.field}>
          {t.cancellationReason}
          <textarea
            style={s.input}
            required
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
        </label>
      ) : (
        <>
          <label style={s.field}>
            {lang === "vi" ? "Số tiền" : "금액"}
            <input
              style={s.input}
              type="number"
              min="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label style={s.field}>
            {lang === "vi" ? "Ngày" : "적용일"}
            <input
              style={s.input}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label style={s.field}>
            {lang === "vi" ? "Lý do" : "사유"}
            <input
              style={s.input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label style={s.field}>
            {lang === "vi" ? "Ghi chú" : "메모"}
            <textarea
              style={s.input}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </>
      )}
    </PayrollModal>
  );
}
function Row({
  label,
  value,
  highlight,
  strong = false,
  muted = false,
  wrapValue = false,
}: {
  label: string;
  value: string;
  highlight?: "combined" | "subtotal" | "net";
  strong?: boolean;
  muted?: boolean;
  wrapValue?: boolean;
}) {
  return (
    <div style={{ ...s.row, ...(highlight ? s.highlightRow : {}), ...(highlight === "subtotal" ? s.subtotalRow : {}), ...(highlight === "net" ? s.netHighlightRow : {}), ...(muted ? s.mutedRow : {}) }}>
      <span style={{ ...s.rowLabel, ...(muted ? s.mutedLabel : {}) }}>{label}</span>
      <b style={highlight ? { ...s.highlightAmount, ...(highlight === "subtotal" ? s.subtotalAmount : {}), ...(highlight === "net" ? s.netHighlightAmount : {}) } : strong ? { ...s.rowAmount, fontSize: 14 } : { ...s.rowAmount, ...(muted ? s.mutedAmount : {}), ...(wrapValue ? s.wrappingAmount : {}) }}>{value}</b>
    </div>
  );
}

function DetailSection({ icon, title, children, first = false }: { icon: string; title: string; children: ReactNode; first?: boolean }) {
  return (
    <section style={{ ...s.detailSection, ...(first ? s.firstDetailSection : {}) }}>
      <h4 style={s.sectionTitle}><span aria-hidden="true" style={s.sectionIcon}>{icon}</span>{title}</h4>
      <div style={s.sectionRows}>{children}</div>
    </section>
  );
}

function CombinedSalarySummary({
  label,
  value,
  monthlyEquivalent,
  monthlyEquivalentLabel,
  monthlyEquivalentHelp,
}: {
  label: string;
  value: string;
  monthlyEquivalent: number | null;
  monthlyEquivalentLabel: string;
  monthlyEquivalentHelp: string;
}) {
  return (
    <div style={{ ...s.highlightRow, ...s.combinedSummary }}>
      <div style={s.row}>
        <span style={s.rowLabel}>{label}</span>
        <b style={s.highlightAmount}>{value}</b>
      </div>
      {monthlyEquivalent !== null ? <div style={s.monthlyEquivalent}>
        <div style={s.row}>
          <span style={s.monthlyEquivalentLabel}>{monthlyEquivalentLabel}</span>
          <b style={s.monthlyEquivalentAmount}>{formatVnd(monthlyEquivalent)}</b>
        </div>
        <small style={s.monthlyEquivalentHelp}>{monthlyEquivalentHelp}</small>
      </div> : null}
    </div>
  );
}

function AdjustmentButton({ kind, label, manageLabel, value, onClick }: {
  kind: "incentive" | "penalty";
  label: string;
  manageLabel: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button type="button" style={{ ...s.adjustmentButton, ...(kind === "incentive" ? s.incentiveButton : s.penaltyButton) }} onClick={onClick}>
      <span style={s.adjustmentCopy}><b>{label}</b><small style={s.adjustmentHint}>{manageLabel}</small></span>
      <span style={s.adjustmentValue}>{value}</span>
      <span aria-hidden="true" style={s.chevron}>›</span>
    </button>
  );
}
const s = {
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "6px 9px",
  },
  expandedCard: {
    background: "#f8fafc",
    border: "1px solid #cbd5e1",
    boxShadow: "0 3px 10px rgba(15, 23, 42, 0.07)",
  },
  head: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) auto 12px",
    gap: 6,
    alignItems: "center",
    border: 0,
    background: "transparent",
    padding: 0,
    textAlign: "left",
    cursor: "pointer",
  },
  identity: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    overflow: "hidden",
  },
  name: {
    fontSize: 13,
    fontWeight: 800,
    color: "#111827",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  separator: { color: "#9ca3af", flexShrink: 0 },
  position: {
    fontSize: 11,
    color: "#6b7280",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  amount: { fontSize: 12, fontWeight: 900, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  expandIcon: {
    fontSize: 13,
    color: "#6b7280",
    width: 12,
    textAlign: "center",
    flexShrink: 0,
  },
  detail: {
    display: "grid",
    gap: 12,
    marginTop: 6,
    paddingTop: 7,
    borderTop: "1px solid #e5e7eb",
    fontSize: 12,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "baseline",
    minWidth: 0,
  },
  rowLabel: { minWidth: 0, color: "#475569" },
  rowAmount: { flexShrink: 0, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  wrappingAmount: { minWidth: 0, whiteSpace: "normal", lineHeight: 1.35 },
  highlightRow: { marginTop: 2, padding: "7px 8px", borderRadius: 8, background: "#fff" },
  highlightAmount: { flexShrink: 0, textAlign: "right", whiteSpace: "nowrap", fontSize: 14, fontWeight: 900, fontVariantNumeric: "tabular-nums" },
  combinedSummary: { display: "grid", gap: 5 },
  monthlyEquivalent: { display: "grid", gap: 2, paddingTop: 5, borderTop: "1px solid #e2e8f0" },
  monthlyEquivalentLabel: { minWidth: 0, color: "#64748b", fontWeight: 700 },
  monthlyEquivalentAmount: { flexShrink: 0, color: "#334155", textAlign: "right", whiteSpace: "nowrap", fontSize: 12, fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  monthlyEquivalentHelp: { color: "#94a3b8", fontSize: 10, lineHeight: 1.3 },
  subtotalRow: { marginTop: 4, background: "#fff", boxShadow: "inset 0 1px #e2e8f0" },
  subtotalAmount: { fontSize: 13 },
  netHighlightRow: { background: "#eff6ff", boxShadow: "inset 0 1px #bfdbfe" },
  netHighlightAmount: { color: "#1d4ed8", fontSize: 15 },
  mutedRow: { background: "#f8fafc", padding: "6px 8px", borderRadius: 7 },
  mutedLabel: { color: "#64748b" },
  mutedAmount: { color: "#475569", fontWeight: 800 },
  detailSection: { display: "grid", gap: 6, paddingTop: 11, borderTop: "1px solid #f1f5f9" },
  firstDetailSection: { paddingTop: 0, borderTop: 0 },
  sectionTitle: { margin: 0, display: "flex", alignItems: "center", gap: 5, fontSize: 12, lineHeight: 1.25, fontWeight: 900, color: "#475569", letterSpacing: ".01em" },
  sectionIcon: { width: 14, fontSize: 12, lineHeight: 1, textAlign: "center", opacity: .82 },
  sectionRows: { width: "100%", boxSizing: "border-box", display: "grid", gap: 6, paddingLeft: 10 },
  adjustmentButton: { width: "100%", minWidth: 0, minHeight: 36, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 9px", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 8, textAlign: "left", cursor: "pointer" },
  incentiveButton: { border: "1px solid #dcfce7", background: "#f7fcf8", color: "#166534" },
  penaltyButton: { border: "1px solid #fee2e2", background: "#fff8f8", color: "#991b1b" },
  adjustmentCopy: { minWidth: 0, display: "grid", gap: 1 },
  adjustmentHint: { fontSize: 10, fontWeight: 600, opacity: .72 },
  adjustmentValue: { fontWeight: 800, whiteSpace: "nowrap", textAlign: "right", fontVariantNumeric: "tabular-nums" },
  chevron: { fontSize: 15, lineHeight: 1, fontWeight: 900 },
  help: { color: "#64748b", lineHeight: 1.45 },
  total: {
    display: "grid",
    gap: 5,
    padding: "9px 10px",
    border: "1px solid #e2e8f0",
    borderRadius: 11,
    background: "#f8fafc",
    fontSize: 12,
  },
  field: {
    display: "grid",
    gap: 4,
    marginTop: 8,
    fontSize: 12,
    fontWeight: 700,
  },
  input: {
    width: "100%",
    minHeight: 40,
    padding: 8,
    border: "1px solid #d1d5db",
    borderRadius: 9,
  },
  primary: {
    minHeight: 42,
    padding: "9px 13px",
    border: 0,
    borderRadius: 10,
    background: "#111827",
    color: "#fff",
    fontWeight: 800,
  },
  danger: {
    minHeight: 42,
    padding: "9px 13px",
    border: 0,
    borderRadius: 10,
    background: "#b91c1c",
    color: "#fff",
    fontWeight: 800,
  },
  cancel: {
    justifySelf: "end",
    border: "1px solid #fecaca",
    background: "#fff",
    color: "#b91c1c",
    borderRadius: 8,
    padding: "5px 8px",
  },
  error: {
    margin: 0,
    padding: 10,
    borderRadius: 9,
    background: "#fef2f2",
    color: "#b91c1c",
  },
  list: { display: "grid", gap: 7 },
  item: {
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) auto",
    gap: 4,
    padding: 8,
    border: "1px solid #e5e7eb",
    borderRadius: 9,
  },
} satisfies Record<string, CSSProperties>;
