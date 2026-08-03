"use client";
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import PayrollModal from "@/components/payroll/PayrollModal";
import type {
  PayrollMonthlyAdjustment,
  PayrollOverviewEmployee,
} from "@/lib/payroll/overview";
import { money } from "@/lib/payroll/ui-labels";
import { attendanceText } from "@/lib/text";
import { payrollOverviewText } from "@/lib/text/payroll-overview";
const compact = (value: number) =>
  value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(2))}M VND`
    : `${Math.round(value / 1000)}K VND`;
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
  const [modal, setModal] = useState<"incentive" | "penalty" | null>(null);
  const combined = employee.amounts.combinedSalary;
  const header = future
    ? "—"
    : !employee.contract
      ? t.contractUnset
      : combined === null
        ? t.levelBaseRequired
        : compact(combined);
  const employeeAge = age(employee.birthDate);
  const positionLabel = employee.position
    ? (attendance.positions[
        employee.position as keyof typeof attendance.positions
      ] ?? employee.position)
    : employee.username;
  return (
    <article style={s.card}>
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
          title={combined === null ? header : money(combined)}
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
              <Row
                label={t.contractSalary}
                value={money(employee.amounts.contractSalary ?? 0)}
              />
              <Row
                label={t.fixedRaise}
                value={`+${money(employee.amounts.fixedRaiseAmount ?? 0)}`}
              />
              <Row
                label={t.levelRaise}
                value={`+${money(employee.amounts.levelRaiseAmount ?? 0)}`}
              />
              <Row label={t.combinedSalary} value={money(combined)} strong />
              <button style={s.rowButton} onClick={() => setModal("incentive")}>
                <span>{t.incentive}</span>
                <b>
                  +{money(employee.amounts.incentiveAmount)} ·{" "}
                  {employee.amounts.incentiveCount}
                  {t.count}
                </b>
              </button>
              <button style={s.rowButton} onClick={() => setModal("penalty")}>
                <span>{t.penalty}</span>
                <b>
                  -{money(employee.amounts.penaltyAmount)} ·{" "}
                  {employee.amounts.penaltyCount}
                  {t.count}
                </b>
              </button>
              <Row
                label={`${t.accruedWork} · ${Number(employee.recognizedWorkdays.toFixed(2))}${t.days}`}
                value={
                  employee.amounts.workAppliedAmount === null
                    ? t.settingsRequired
                    : money(employee.amounts.workAppliedAmount)
                }
              />
              <Row
                label={t.preInsurancePayout}
                value={money(employee.amounts.preInsurancePayoutAmount)}
              />
              <Row
                label={t.insuranceBase}
                value={money(employee.amounts.insuranceBaseAmount)}
              />
              <Row
                label={t.employeeInsuranceDeduction}
                value={`-${money(employee.amounts.employeeInsuranceDeductionAmount)}`}
              />
              <Row
                label={t.netPayout}
                value={
                  employee.amounts.currentAmount === null
                    ? t.settingsRequired
                    : money(employee.amounts.netPayoutAmount)
                }
                strong
              />
              <Row
                label={t.employerInsurance}
                value={money(employee.amounts.employerInsuranceAmount)}
              />
              {employee.amounts.employerInsuranceAmount > 0 && (
                <small>{t.employerInsuranceHelp}</small>
              )}
              {employee.unresolvedAttendanceCount > 0 && (
                <Row
                  label={t.unresolvedAttendance}
                  value={`${employee.unresolvedAttendanceCount}${t.days}`}
                />
              )}
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
        value={money(values.reduce((a, b) => a + b, 0))}
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
              <b>-{money(item.amount)}</b>
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
              {kind === "incentive" ? "+" : "-"}
              {money(item.amount)}
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
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div style={s.row}>
      <span>{label}</span>
      <b style={strong ? { fontSize: 14 } : undefined}>{value}</b>
    </div>
  );
}
const s = {
  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "6px 9px",
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
  amount: { fontSize: 12, fontWeight: 900, whiteSpace: "nowrap" },
  expandIcon: {
    fontSize: 13,
    color: "#6b7280",
    width: 12,
    textAlign: "center",
    flexShrink: 0,
  },
  detail: {
    display: "grid",
    gap: 6,
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
  },
  rowButton: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    width: "100%",
    padding: "7px 0",
    border: 0,
    background: "transparent",
  },
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
