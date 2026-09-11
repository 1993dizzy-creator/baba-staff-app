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
import { formatPositiveIntegerInput, normalizePositiveIntegerInput } from "@/lib/payroll/positive-integer-input";
import { formatRecognizedWork, getPayrollHeaderAmount } from "@/lib/payroll/payroll-page-display";
import { payrollOverviewText } from "@/lib/text/payroll-overview";
import {
  getPaymentBadgePresentation,
  reviewLabel,
  shouldShowPaymentDifferenceReason,
} from "@/lib/payroll/ui-labels";
import { getEmployeeRoleLabel } from "@/lib/common/roles";
import AttendancePerfectScoreBadge from "@/components/attendance/AttendancePerfectScoreBadge";
import PartTimeExtraWorkSection from "@/components/payroll/PartTimeExtraWorkSection";
// /admin/users의 🍚 배지와 동일한 문구를 쓴다 — 식대는 회사 부담 비용이며 net pay에 추가
// 지급되는 항목이 아니므로, "지급"이 아니라 "대상"이라는 중립적 표현으로 통일한다.
export function mealAllowanceBadgeLabel(lang: "ko" | "vi") {
  return lang === "vi" ? "Đối tượng trợ cấp ăn" : "식대 대상";
}
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
  monthClosed,
  refresh,
  mealAllowanceEligible = false,
}: {
  employee: PayrollOverviewEmployee;
  expanded: boolean;
  toggle: () => void;
  lang: "ko" | "vi";
  month: string;
  future: boolean;
  monthClosed: boolean;
  refresh: () => Promise<boolean>;
  mealAllowanceEligible?: boolean;
}) {
  const t = payrollOverviewText[lang];
  const detailText = lang === "vi"
    ? { salaryComposition: "Cấu thành lương", monthApplication: "Áp dụng tháng này", insuranceAndNet: "Khấu trừ và thực nhận", recognizedWork: "Chấm công được ghi nhận", adjustmentManage: "Thêm · hủy", finalPayout: "Thực nhận", monthlyEquivalent: "Quy đổi lương tháng", monthlyEquivalentHelp: "Theo điều kiện làm đủ theo hợp đồng" }
    : { salaryComposition: "급여 구성", monthApplication: "이번 달 반영", insuranceAndNet: "공제 및 최종 지급", recognizedWork: "인정 근무", adjustmentManage: "추가·취소", finalPayout: "최종 지급액", monthlyEquivalent: "월급여 환산", monthlyEquivalentHelp: "계약 기준 풀근무 시" };
  const taxText = lang === "vi"
    ? { title:"Thuế TNCN",dependent:"Số người phụ thuộc",personal:"Giảm trừ bản thân",dependentDeduction:"Giảm trừ người phụ thuộc",insurance:"Khấu trừ bảo hiểm",taxableCompensation:"Thu nhập chịu thuế",taxableIncome:"Thu nhập tính thuế",calculated:"Thuế đã tính",employee:"Nhân viên chịu",company:"Công ty chịu",accountingName:"Tên kế toán",policyRevision:"Phiên bản chính sách",details:"Chi tiết tính thuế",requiresReview:"Cần hoàn thiện hồ sơ/chính sách TNCN trước khi trả lương.",settings:"Mở cài đặt TNCN" }
    : { title:"개인소득세(TNCN)",dependent:"부양가족 수",personal:"본인공제",dependentDeduction:"부양가족공제",insurance:"보험공제",taxableCompensation:"과세대상 급여",taxableIncome:"과세소득",calculated:"계산된 세액",employee:"직원 공제",company:"회사 부담",accountingName:"회계 명의",policyRevision:"정책 revision",details:"계산 상세",requiresReview:"지급 전에 TNCN profile/policy 확인이 필요합니다.",settings:"TNCN 설정 열기" };
  const [modal, setModal] = useState<"incentive" | "penalty" | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
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
  const positionLabel = employee.role
    ? getEmployeeRoleLabel(employee.role, lang)
    : employee.username;
  const extraWorkCount = employee.partTimeExtraWork.length;
  const extraWorkNeedsReview = employee.partTimeExtraWork.some(row => row.status === "review_required" || row.status === "stale");
  const extraWorkBadgeLabel = lang === "vi" ? `Làm thêm giờ: ${extraWorkCount} mục` : `추가근무 내역 ${extraWorkCount}건`;
  const paymentBadge = getPaymentBadgePresentation(lang, employee.payment?.difference_amount);
  // 지급 불가 상태일 때, 급여카드를 만드는 과정에서 이미 확보한 지급 차단 원인(review/tax
  // warning code)을 사용자 친화적인 문구로 보여준다. 새로운 Source Export 요청은 하지 않는다.
  const paymentBlocked = !future && monthClosed && employee.payment?.payment_status !== "paid" && (employee.calculationStatus !== "calculable" || !employee.calculationHash);
  const blockingReasonLabels = paymentBlocked
    ? (() => {
        const labels = [...new Set(employee.warningCodes.map((code) => reviewLabel(lang, code)))];
        return labels.length > 0 ? labels : [lang === "vi" ? "Chưa thể xác định kết quả tính lương." : "급여 계산 결과를 확정할 수 없습니다."];
      })()
    : [];
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
          <AttendancePerfectScoreBadge show={employee.attendanceStanding?.perfectAttendanceCurrent===true} vi={lang==="vi"}/>
          {mealAllowanceEligible ? (
            <span style={s.mealBadge} title={mealAllowanceBadgeLabel(lang)} aria-label={mealAllowanceBadgeLabel(lang)}>🍚</span>
          ) : null}
          {extraWorkCount > 0 ? (
            <span style={{ ...s.extraWorkBadge, ...(extraWorkNeedsReview ? s.extraWorkBadgeAlert : {}) }} title={extraWorkBadgeLabel} aria-label={extraWorkBadgeLabel}>⏱️</span>
          ) : null}
          <span style={s.separator}>·</span>
          <span style={s.position}>{positionLabel}</span>
        </span>
        <span style={s.headerPayment}>
        <b
          style={s.amount}
          title={headerAmount === null ? header : formatVnd(headerAmount)}
        >
          {header}
        </b>
        {employee.payment?.payment_status === "paid" && <span style={{ ...s.paymentBadge, ...(paymentBadge.adjusted ? s.adjustedPaymentBadge : {}) }}>{paymentBadge.label}</span>}
        {!future && employee.payment?.payment_status !== "paid" && <span style={s.unpaidBadge}>{lang === "vi" ? "Chưa trả" : "미지급"}</span>}
        </span>
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
                {employee.amounts.holidayWorkPremiumAmount > 0 && <Row label={t.holidayWorkPremium} value={formatSignedVnd(employee.amounts.holidayWorkPremiumAmount, "+")} />}
                <AdjustmentButton
                  kind="incentive"
                  label={t.incentive}
                  manageLabel={detailText.adjustmentManage}
                  value={`${formatSignedVnd(employee.amounts.incentiveAmount, "+")} · ${employee.amounts.incentiveCount}${t.count}`}
                  onClick={() => setModal("incentive")}
                  disabled={employee.payment?.payment_status === "paid"}
                />
                <AdjustmentButton
                  kind="penalty"
                  label={t.penalty}
                  manageLabel={detailText.adjustmentManage}
                  value={`${formatSignedVnd(employee.amounts.penaltyAmount + employee.amounts.advanceAmount, "-")} · ${employee.amounts.penaltyCount + employee.amounts.advanceCount}${t.count}`}
                  onClick={() => setModal("penalty")}
                  disabled={employee.payment?.payment_status === "paid"}
                />
                <Row label={t.preInsurancePayout} value={formatVnd(employee.amounts.preInsurancePayoutAmount)} highlight={employee.insuranceEnrolled || employee.amounts.advanceAmount > 0 ? "subtotal" : "net"} />
                {!employee.insuranceEnrolled && employee.unresolvedAttendanceCount > 0 && <Row label={t.unresolvedAttendance} value={`${employee.unresolvedAttendanceCount}${t.days}`} />}
              </DetailSection>

              {employee.contract.calculationBasis !== "fixed_monthly" && <PartTimeExtraWorkSection employee={employee} month={month} lang={lang} refresh={refresh} />}

              {(employee.insuranceEnrolled || employee.amounts.advanceAmount > 0) && <DetailSection icon="🛡️" title={detailText.insuranceAndNet}>
                {employee.insuranceEnrolled && <><Row label={t.insuranceBase} value={formatVnd(employee.amounts.insuranceBaseAmount)} />
                <Row label={t.employeeInsuranceDeduction} value={formatSignedVnd(employee.amounts.employeeInsuranceDeductionAmount, "-")} /></>}
                {employee.amounts.advanceAmount > 0 && <Row label={t.advance} value={formatSignedVnd(employee.amounts.advanceAmount, "-")} />}
                <Row
                  label={t.netPayout}
                  value={employee.amounts.currentAmount === null ? t.settingsRequired : formatVnd(employee.amounts.netPayoutAmount)}
                  highlight="net"
                />
                {employee.insuranceEnrolled && <Row label={t.employerInsurance} value={formatVnd(employee.amounts.employerInsuranceAmount)} muted />}
                {employee.amounts.employerInsuranceAmount > 0 && <small style={s.help}>{t.employerInsuranceHelp}</small>}
                {employee.unresolvedAttendanceCount > 0 && <Row label={t.unresolvedAttendance} value={`${employee.unresolvedAttendanceCount}${t.days}`} />}
              </DetailSection>}
              {(employee.tax.status === "requires_review" || employee.tax.taxMode === "resident_progressive") && <DetailSection icon="🧾" title={taxText.title}>
                {employee.tax.status === "requires_review" ? <><p role="alert" style={s.error}>{taxText.requiresReview} ({employee.tax.warningCodes.join(", ")})</p><Link href={`/admin/payroll/settings?tab=employee&userId=${employee.userId}`}>{taxText.settings}</Link></> : <>
                  <div style={s.taxSummary}>
                    <span>{taxText.taxableIncome} <b>{formatVnd(employee.tax.taxableIncomeAmount)}</b></span>
                    <span aria-hidden="true">·</span>
                    <span>{employee.tax.taxBurdenMode === "company_bears" ? taxText.company : taxText.employee} <b>{formatVnd(employee.tax.taxBurdenMode === "company_bears" ? employee.tax.companyPitAmount : employee.tax.employeePitDeductionAmount)}</b></span>
                  </div>
                  <details style={s.taxDetails}>
                    <summary style={s.taxDetailsSummary}>{taxText.details}</summary>
                    <div style={s.taxDetailsRows}>
                      <Row label={taxText.dependent} value={String(employee.tax.dependentCount)} />
                      <Row label={taxText.personal} value={formatVnd(employee.tax.personalDeductionAmount)} />
                      <Row label={taxText.dependentDeduction} value={formatVnd(employee.tax.dependentDeductionAmount)} />
                      <Row label={taxText.insurance} value={formatVnd(employee.tax.deductibleInsuranceAmount)} />
                      <Row label={taxText.taxableCompensation} value={formatVnd(employee.tax.taxableCompensationAmount)} />
                      <Row label={taxText.accountingName} value={employee.tax.accountingName ?? "—"} />
                      <Row label={taxText.policyRevision} value={`#${employee.tax.taxPolicyRevision ?? "—"}`} />
                    </div>
                  </details>
                </>}
              </DetailSection>}
              {!future && <><button type="button" style={s.paymentButton} disabled={employee.payment?.payment_status !== "paid" && (!monthClosed || employee.calculationStatus !== "calculable" || !employee.calculationHash)} onClick={()=>setPaymentOpen(true)}>{employee.payment?.payment_status === "paid" ? (lang === "vi" ? "Xem chi tiết chi trả" : "지급 내역 확인") : !monthClosed ? (lang === "vi" ? "Tháng lương chưa kết thúc" : "급여 월 미종료") : employee.calculationStatus !== "calculable" || !employee.calculationHash ? (lang === "vi" ? "Không thể chi trả" : "지급 불가") : (lang === "vi" ? "Chi trả lương" : "급여 지급")}</button>{!monthClosed&&employee.payment?.payment_status!=="paid"&&<small style={s.help}>{lang==="vi"?"Chỉ có thể chi trả sau khi tháng lương kết thúc.":"급여 대상 월이 종료된 후 지급할 수 있습니다."}</small>}{blockingReasonLabels.length>0&&<div role="alert" style={s.blockingReasons}><b style={s.blockingReasonsTitle}>{lang==="vi"?"Lý do chưa thể chi trả":"지급 불가 사유"}</b><ul style={s.blockingReasonList}>{blockingReasonLabels.map(label=><li key={label}>{label}</li>)}</ul></div>}</>}
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
      {paymentOpen && <PaymentModal employee={employee} month={month} lang={lang} close={()=>setPaymentOpen(false)} refresh={refresh}/>}
    </article>
  );
}
export function CombinedPartTotal({
  employees,
  lang,
  partName,
  future = false,
}: {
  employees: PayrollOverviewEmployee[];
  lang: "ko" | "vi";
  partName: string;
  future?: boolean;
}) {
  const t = payrollOverviewText[lang];
  const values = employees.flatMap((employee) =>
    employee.amounts.combinedSalary === null
      ? []
      : [employee.amounts.combinedSalary],
  );
  const excluded = employees.length - values.length;
  const title = lang === "vi"
    ? `${t.combinedSalaryTotal} ${partName} (${employees.length} ${t.people})`
    : `${partName} ${t.combinedSalaryTotal} (${employees.length}${t.people})`;
  return (
    <div style={s.total}>
      <Row
        label={title}
        value={future ? "—" : formatVnd(values.reduce((a, b) => a + b, 0))}
        strong
      />
      {!future && excluded > 0 && (
        <Row label={t.settingsRequired} value={`${excluded}${t.people}`} />
      )}
      {future && <small style={s.help}>{t.beforeCalculationPeriod}</small>}
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
  const [adjustmentKind, setAdjustmentKind] = useState<"penalty" | "advance">("penalty");
  const [cancelTarget, setCancelTarget] =
    useState<PayrollMonthlyAdjustment | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mutationCompleted, setMutationCompleted] = useState(false);
  const selectedKind = kind === "incentive" ? "incentive" : adjustmentKind;
  const list = employee.adjustments.filter((item) => kind === "incentive" ? item.kind === "incentive" : item.kind === "penalty" || item.kind === "advance");
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
          kind: selectedKind,
          category: selectedKind === "advance" ? "advance" : "manual",
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
      placement="top"
      title={`${month} ${kind === "incentive" ? t.incentive : t.penalty}`}
      closeLabel={lang === "vi" ? "Đóng" : "닫기"}
      onClose={() => {
        if (!busy) close();
      }}
      footer={<div style={s.modalFooter}>{cancelTarget ? (
          <button
            style={{...s.danger,...s.modalAction}}
            disabled={busy || mutationCompleted || !cancelReason.trim()}
            onClick={cancel}
          >
            {t.cancel}
          </button>
        ) : (
          <button
            style={{...s.primary,...s.modalAction}}
            disabled={busy || mutationCompleted || !reason || Number(amount) < 1}
            onClick={save}
          >
            {selectedKind === "incentive" ? t.addIncentive : selectedKind === "advance" ? t.addAdvance : t.addPenalty}
          </button>
        )}</div>}
    >
      <div style={s.list}>
        {kind === "penalty" &&
          employee.automaticPenalties.map((item) => (
            <article
              key={`${item.category}:${item.businessDate}`}
              style={s.item}
            >
              <span style={s.itemText}>
                {item.businessDate.slice(5)} · {item.category === "late"
                  ? (lang === "vi" ? "Phạt đi muộn" : "지각 패널티")
                  : item.category === "early_leave"
                    ? (lang === "vi" ? "Phạt về sớm" : "조퇴 패널티")
                    : item.category === "unauthorized_absence"
                      ? (lang === "vi" ? "Phạt nghỉ không phép" : "무단결근 패널티")
                      : item.description}
                {item.category !== "unauthorized_absence" ? ` ${item.minutes}${t.minutes}` : ""}
              </span>
              <b style={s.itemAmount}>{formatSignedVnd(item.amount, "-")}</b>
            </article>
          ))}
        {list.map((item) => (
          <article key={item.id} style={s.item}>
            <span style={s.itemText}>
              {item.businessDate.slice(5)} · {item.kind === "advance" ? t.advance : item.kind === "penalty" ? t.manualPenalty : item.category}
            </span>
            <b style={s.itemAmount}>
              {formatSignedVnd(item.amount, kind === "incentive" ? "+" : "-")}
            </b>
            <span style={s.itemDetail}>
              {item.reason}
              {item.note ? ` · ${item.note}` : ""}
            </span>
            <small style={s.itemMeta}>
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
          <span style={s.fieldLabel}>📝 {t.cancellationReason}</span>
          <textarea
            style={s.input}
            required
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
        </label>
      ) : (
        <>
          {kind === "penalty" && <label style={s.field}>
            <span style={s.fieldLabel}>⚖️ {lang === "vi" ? "Loại điều chỉnh" : "조정 종류"}</span>
            <select style={s.input} value={adjustmentKind} onChange={(e) => setAdjustmentKind(e.target.value as "penalty" | "advance")}>
              <option value="penalty">{lang === "vi" ? "Phạt" : "패널티"}</option>
              <option value="advance">{t.advance}</option>
            </select>
          </label>}
          <label style={s.field}>
            <span style={s.fieldLabel}>💰 {lang === "vi" ? "Số tiền" : "금액"}</span>
            <input
              style={s.input}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={formatPositiveIntegerInput(amount)}
              onChange={(e) => setAmount(normalizePositiveIntegerInput(e.target.value))}
            />
            <small style={s.fieldHelp}>{selectedKind === "incentive"
              ? (lang === "vi" ? "Nhập số nguyên dương. Số tiền nhập sẽ được cộng vào lương." : "양수 정수로 입력하세요. 입력 금액은 급여에 추가됩니다.")
              : selectedKind === "advance"
                ? (lang === "vi" ? "Số tiền đã ứng sẽ được trừ khỏi khoản thực nhận cuối cùng." : "이미 선지급한 가불액은 최종 실수령액에서 차감됩니다.")
                : (lang === "vi" ? "Nhập số nguyên dương. Khoản phạt sẽ tự động được trừ." : "양수 정수로 입력하세요. 입력 금액은 급여에서 자동 차감됩니다.")}</small>
          </label>
          <label style={s.field}>
            <span style={s.fieldLabel}>📅 {lang === "vi" ? "Ngày áp dụng" : "적용일"}</span>
            <input
              style={s.input}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label style={s.field}>
            <span style={s.fieldLabel}>📝 {lang === "vi" ? "Lý do (bắt buộc)" : "사유 (필수)"}</span>
            <input
              style={s.input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={selectedKind === "incentive"
                ? (lang === "vi" ? "Thưởng đạt mục tiêu doanh thu" : "매출 목표 달성 보너스")
                : selectedKind === "advance"
                  ? (lang === "vi" ? "Ứng trước một phần lương" : "급여 일부 선지급")
                  : (lang === "vi" ? "Làm hỏng vật dụng" : "비품 파손")}
            />
          </label>
          <label style={s.field}>
            <span style={s.fieldLabel}>📌 {lang === "vi" ? "Ghi chú nội bộ (không bắt buộc)" : "내부 메모 (선택)"}</span>
            <textarea
              style={s.input}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={lang === "vi" ? "Nhập nội dung bổ sung nếu cần." : "필요한 추가 내용을 입력하세요."}
            />
          </label>
        </>
      )}
    </PayrollModal>
  );
}
function PaymentModal({employee,month,lang,close,refresh}:{employee:PayrollOverviewEmployee;month:string;lang:"ko"|"vi";close:()=>void;refresh:()=>Promise<boolean>}){
  const vi=lang==="vi";const payment=employee.payment;const calculated=employee.amounts.netPayoutAmount;
  const [actual,setActual]=useState(String(payment?.actual_paid_amount??calculated));const [date,setDate]=useState(payment?.payment_date??new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));const [reason,setReason]=useState(payment?.difference_reason??"");const[cancelMode,setCancelMode]=useState(false);const[cancelReason,setCancelReason]=useState("");const[busy,setBusy]=useState(false);const[error,setError]=useState("");
  const actualNumber=Number(actual||0);const difference=actualNumber-calculated;const actor=payment?.paid_actor;const actorLabel=actor?.name||actor?.full_name||actor?.username||"—";
  async function submit(){if(busy||actualNumber<1||(difference!==0&&!reason.trim())||!employee.calculationHash)return;setBusy(true);setError("");try{const response=await fetch("/api/admin/payroll/payments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({month,userId:employee.userId,calculationHash:employee.calculationHash,actualPaidAmount:actualNumber,differenceReason:reason,paymentDate:date})});const data=await response.json();if(!response.ok){if(data.code==="PAYROLL_CALCULATION_STALE")await refresh();const preflight=data.code==="PAYROLL_BATCH_PREFLIGHT_FAILED"&&Array.isArray(data.employees)?data.employees.map((item:{employeeName:string;reasonCodes:string[]})=>`${item.employeeName}: ${item.reasonCodes.join(", ")}`).join("\n"):null;throw new Error(preflight?`${vi?data.messageVi:data.message}\n${preflight}`:data.code==="PAYROLL_MONTH_NOT_CLOSED"?(vi?data.messageVi:data.message):data.code==="PAYROLL_CALCULATION_STALE"?(vi?data.messageVi:data.message):(vi?"Không thể xử lý chi trả.":"급여를 지급하지 못했습니다."))}await refresh();close()}catch(cause){setError(cause instanceof Error?cause.message:(vi?"Không thể xử lý chi trả.":"급여를 지급하지 못했습니다."))}finally{setBusy(false)}}
  async function cancelPayment(){if(busy||!cancelReason.trim()||!employee.batchId)return;setBusy(true);setError("");try{const response=await fetch("/api/admin/payroll/payments",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:employee.batchId,userId:employee.userId,reason:cancelReason})});if(!response.ok)throw new Error(vi?"Không thể hủy chi trả.":"지급을 취소하지 못했습니다.");await refresh();close()}catch(cause){setError(cause instanceof Error?cause.message:(vi?"Không thể hủy chi trả.":"지급을 취소하지 못했습니다."))}finally{setBusy(false)}}
  return <PayrollModal placement="top" title={payment?.payment_status==="paid"?(vi?"Chi tiết chi trả":"지급 내역"):(vi?"Chi trả lương":"급여 지급")} closeLabel={vi?"Đóng":"닫기"} onClose={()=>{if(!busy)close()}} footer={<div style={s.modalFooter}>{payment?.payment_status==="paid"?(employee.batchStatus==="paying"?<button type="button" style={{...s.danger,...s.modalAction}} disabled={busy||cancelMode&&!cancelReason.trim()} onClick={()=>cancelMode?void cancelPayment():setCancelMode(true)}>{cancelMode?(vi?"Xác nhận hủy":"지급 취소 실행"):(vi?"Hủy chi trả":"지급 취소")}</button>:null):<button type="button" style={{...s.primary,...s.modalAction}} disabled={busy||actualNumber<1||(difference!==0&&!reason.trim())} onClick={()=>void submit()}>{vi?"Chi trả":"지급"}</button>}</div>}>
    <div style={s.paymentLayout}>
      <PaymentSalarySummary
        employeeName={employee.name}
        month={month}
        calculatedAmount={payment?.payment_status === "paid" ? payment.calculated_net_amount ?? calculated : calculated}
        lang={lang}
      />

      {payment?.payment_status === "paid" ? (
        <PaidPaymentDetails
          actualAmount={payment.actual_paid_amount ?? 0}
          differenceAmount={payment.difference_amount ?? 0}
          differenceReason={payment.difference_reason}
          paymentDate={payment.payment_date}
          actorLabel={actorLabel}
          paidAt={payment.paid_at}
          lang={lang}
        />
      ) : (
        <UnpaidPaymentForm
          actual={actual}
          difference={difference}
          date={date}
          reason={reason}
          lang={lang}
          onActualChange={setActual}
          onDateChange={setDate}
          onReasonChange={setReason}
        />
      )}

      {cancelMode ? (
        <PaymentSection icon="📝" title={vi ? "Lý do hủy" : "지급 취소 사유"}>
          <PaymentCard>
            <PaymentField label={vi ? "Lý do hủy (bắt buộc)" : "취소 사유 (필수)"}>
              <textarea style={{ ...s.paymentInput, ...s.paymentTextarea }} value={cancelReason} onChange={event=>setCancelReason(event.target.value)} />
            </PaymentField>
          </PaymentCard>
        </PaymentSection>
      ) : null}
      {error&&<p role="alert" style={s.error}>{error}</p>}
    </div>
  </PayrollModal>;
}

function PaymentSalarySummary({ employeeName, month, calculatedAmount, lang }: {
  employeeName: string;
  month: string;
  calculatedAmount: number;
  lang: "ko" | "vi";
}) {
  const vi = lang === "vi";
  return (
    <PaymentSection icon="💰" title={vi ? "Thông tin lương" : "급여 정보"}>
      <PaymentCard summary>
        <PaymentKeyValue label={vi ? "Nhân viên" : "직원"} value={employeeName} wrap />
        <PaymentKeyValue label={vi ? "Tháng lương" : "급여 대상 월"} value={month} />
        <PaymentKeyValue label={vi ? "Lương thực nhận tính toán" : "계산 최종 실수령액"} value={formatVnd(calculatedAmount)} />
      </PaymentCard>
    </PaymentSection>
  );
}

function PaidPaymentDetails({
  actualAmount,
  differenceAmount,
  differenceReason,
  paymentDate,
  actorLabel,
  paidAt,
  lang,
}: {
  actualAmount: number;
  differenceAmount: number;
  differenceReason: string | null;
  paymentDate: string | null;
  actorLabel: string;
  paidAt: string | null;
  lang: "ko" | "vi";
}) {
  const vi = lang === "vi";
  return (
    <>
      <PaymentSection icon="💳" title={vi ? "Kết quả chi trả" : "지급 결과"}>
        <PaymentCard>
          <PaymentKeyValue label={vi ? "Thực trả" : "실제 지급액"} value={formatVnd(actualAmount)} emphasized />
          <PaymentKeyValue label={vi ? "Chênh lệch" : "차액"} value={formatVnd(differenceAmount)} />
        </PaymentCard>
      </PaymentSection>

      {differenceReason ? (
        <PaymentSection icon="📝" title={vi ? "Lý do chênh lệch" : "차액 사유"}>
          <PaymentReasonBlock>{differenceReason}</PaymentReasonBlock>
        </PaymentSection>
      ) : null}

      <PaymentSection icon="🕒" title={vi ? "Thông tin xử lý" : "처리 정보"}>
        <PaymentCard>
        <PaymentKeyValue label={vi ? "Ngày trả" : "지급일"} value={paymentDate ?? "—"} />
        <PaymentKeyValue label={vi ? "Người xử lý" : "지급 처리자"} value={actorLabel} wrap />
        <PaymentKeyValue label={vi ? "Thời gian xử lý" : "지급 시각"} value={paidAt ? new Date(paidAt).toLocaleString(vi ? "vi-VN" : "ko-KR") : "—"} wrap />
        </PaymentCard>
      </PaymentSection>
    </>
  );
}

function UnpaidPaymentForm({ actual, difference, date, reason, lang, onActualChange, onDateChange, onReasonChange }: {
  actual: string;
  difference: number;
  date: string;
  reason: string;
  lang: "ko" | "vi";
  onActualChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onReasonChange: (value: string) => void;
}) {
  const vi = lang === "vi";
  return (
    <>
      <PaymentSection icon="💳" title={vi ? "Số tiền chi trả" : "지급 금액"}>
        <PaymentCard>
          <PaymentField label={vi ? "Số tiền thực trả" : "실제 지급액"}>
            <input style={s.paymentInput} type="text" inputMode="numeric" value={formatPositiveIntegerInput(actual)} onChange={event=>onActualChange(normalizePositiveIntegerInput(event.target.value))} />
          </PaymentField>
          <PaymentKeyValue label={vi ? "Chênh lệch" : "차액"} value={formatVnd(difference)} />
        </PaymentCard>
      </PaymentSection>

      <PaymentSection icon="📅" title={vi ? "Thông tin chi trả" : "지급 정보"}>
        <PaymentCard>
          <PaymentField label={vi ? "Ngày trả" : "지급일"}>
            <input style={s.paymentInput} type="date" value={date} onChange={event=>onDateChange(event.target.value)} />
          </PaymentField>
        </PaymentCard>
      </PaymentSection>

      {shouldShowPaymentDifferenceReason(difference) ? (
        <PaymentSection icon="📝" title={vi ? "Lý do thay đổi" : "변경 사유"}>
          <PaymentCard>
            <PaymentField label={vi ? "Lý do thay đổi (bắt buộc)" : "변경 사유 (필수)"}>
              <textarea style={{ ...s.paymentInput, ...s.paymentTextarea }} value={reason} onChange={event=>onReasonChange(event.target.value)} />
            </PaymentField>
          </PaymentCard>
        </PaymentSection>
      ) : null}
    </>
  );
}

function PaymentSection({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <section style={s.paymentSection}>
      <h4 style={s.paymentSectionTitle}><span aria-hidden="true">{icon}</span>{title}</h4>
      {children}
    </section>
  );
}

function PaymentCard({ children, summary = false }: { children: ReactNode; summary?: boolean }) {
  return <div style={{ ...s.paymentCard, ...(summary ? s.paymentSummaryCard : {}) }}>{children}</div>;
}

function PaymentField({ label, children }: { label: string; children: ReactNode }) {
  return <label style={s.paymentField}><span style={s.paymentFieldLabel}>{label}</span>{children}</label>;
}

function PaymentReasonBlock({ children }: { children: string }) {
  return <div style={{ ...s.paymentCard, ...s.paymentReasonBlock }}><p style={s.paymentReasonText}>{children}</p></div>;
}

function PaymentKeyValue({ label, value, wrap = false, emphasized = false }: { label: string; value: string; wrap?: boolean; emphasized?: boolean }) {
  return (
    <div style={s.paymentKeyValue}>
      <span style={s.paymentKey}>{label}</span>
      <b style={{ ...s.paymentValue, ...(wrap ? s.paymentValueWrap : {}), ...(emphasized ? s.paymentValueEmphasized : {}) }}>{value}</b>
    </div>
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

function AdjustmentButton({ kind, label, manageLabel, value, onClick, disabled=false }: {
  kind: "incentive" | "penalty";
  label: string;
  manageLabel: string;
  value: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" disabled={disabled} style={{ ...s.adjustmentButton, ...(kind === "incentive" ? s.incentiveButton : s.penaltyButton), ...(disabled?s.disabledButton:{}) }} onClick={onClick}>
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
  mealBadge: { fontSize: 12, lineHeight: 1, flexShrink: 0 },
  extraWorkBadge: { padding: "1px 4px", borderRadius: 999, background: "#f1f5f9", fontSize: 11, lineHeight: 1.2, flexShrink: 0 },
  extraWorkBadgeAlert: { background: "#ffedd5", boxShadow: "inset 0 0 0 1px #fed7aa" },
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
  headerPayment: { display:"flex", alignItems:"center", justifyContent:"flex-end", gap:4, minWidth:0 },
  paymentBadge: { padding:"2px 6px", borderRadius:999, background:"#dcfce7", color:"#166534", fontSize:9, fontWeight:800, whiteSpace:"nowrap" },
  adjustedPaymentBadge: { background:"#fef3c7", color:"#92400e" },
  unpaidBadge: { padding:"2px 6px", borderRadius:999, background:"#f1f5f9", color:"#475569", fontSize:9, fontWeight:800, whiteSpace:"nowrap" },
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
  taxSummary: { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "3px 6px", padding: "7px 8px", borderRadius: 8, background: "#fff", color: "#334155", fontSize: 11.5, lineHeight: 1.35 },
  taxDetails: { fontSize: 10.5, color: "#64748b" },
  taxDetailsSummary: { cursor: "pointer", fontWeight: 700 },
  taxDetailsRows: { display: "grid", gap: 5, marginTop: 6, padding: "7px 8px", borderRadius: 8, background: "#fff" },
  adjustmentButton: { width: "100%", minWidth: 0, minHeight: 36, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 9px", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 8, textAlign: "left", cursor: "pointer" },
  incentiveButton: { border: "1px solid #dcfce7", background: "#f7fcf8", color: "#166534" },
  penaltyButton: { border: "1px solid #fee2e2", background: "#fff8f8", color: "#991b1b" },
  disabledButton: { opacity:.55, cursor:"not-allowed" },
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
    gap: 6,
    marginTop: 6,
    fontSize: 12,
    fontWeight: 700,
    minWidth: 0,
  },
  fieldLabel: { display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 800, lineHeight: 1.3 },
  fieldHelp: { color: "#64748b", fontSize: 10, fontWeight: 500, lineHeight: 1.4 },
  input: {
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    minHeight: 40,
    padding: "9px 10px",
    border: "1px solid #d1d5db",
    borderRadius: 10,
    font: "inherit",
  },
  modalFooter: { display: "flex", justifyContent: "center", alignItems: "center", width: "100%" },
  modalAction: { minWidth: 148, maxWidth: "100%" },
  paymentButton: { minHeight:42, border:0, borderRadius:10, background:"#111827", color:"#fff", fontWeight:800 },
  blockingReasons: { display:"grid", gap:4, marginTop:2, padding:"8px 10px", borderRadius:9, background:"#fef2f2", border:"1px solid #fecaca", color:"#991b1b" },
  blockingReasonsTitle: { fontSize:11.5, fontWeight:900 },
  blockingReasonList: { margin:0, paddingLeft:16, display:"grid", gap:2, fontSize:11, lineHeight:1.4 },
  paymentLayout: { width:"100%", maxWidth:"100%", minWidth:0, display:"grid", gap:13, overflow:"hidden" },
  paymentSection: { width:"100%", maxWidth:"100%", minWidth:0, display:"grid", gap:6 },
  paymentSectionTitle: { margin:0, display:"flex", alignItems:"center", gap:6, color:"#475569", fontSize:12, lineHeight:1.3, fontWeight:900 },
  paymentCard: { width:"100%", maxWidth:"100%", minWidth:0, boxSizing:"border-box", display:"grid", gap:9, padding:12, border:"1px solid #e5e7eb", borderRadius:11, background:"#fff" },
  paymentSummaryCard: { background:"#f8fafc" },
  paymentReasonBlock: { background:"#f8fafc" },
  paymentReasonText: { margin:0, minWidth:0, color:"#334155", fontSize:13, lineHeight:1.55, whiteSpace:"normal", overflowWrap:"anywhere", wordBreak:"break-word" },
  paymentKeyValue: { minHeight:28, display:"grid", gridTemplateColumns:"minmax(90px, 1fr) minmax(0, auto)", alignItems:"center", columnGap:12, minWidth:0 },
  paymentKey: { minWidth:0, color:"#475569", fontSize:12, lineHeight:1.45, fontWeight:700, whiteSpace:"normal", wordBreak:"keep-all" },
  paymentValue: { minWidth:0, maxWidth:"100%", color:"#111827", fontSize:12, lineHeight:1.45, fontWeight:800, textAlign:"right", whiteSpace:"nowrap", fontVariantNumeric:"tabular-nums" },
  paymentValueWrap: { whiteSpace:"normal", overflowWrap:"anywhere", wordBreak:"break-word" },
  paymentValueEmphasized: { fontSize:16, fontWeight:900 },
  paymentField: { minWidth:0, display:"grid", gap:7 },
  paymentFieldLabel: { minWidth:0, color:"#475569", fontSize:12, lineHeight:1.45, fontWeight:700, wordBreak:"keep-all" },
  paymentInput: { width:"100%", maxWidth:"100%", minWidth:0, minHeight:42, boxSizing:"border-box", padding:"9px 10px", border:"1px solid #d1d5db", borderRadius:10, background:"#fff", color:"#111827", font:"inherit", fontSize:13 },
  paymentTextarea: { minHeight:88, resize:"vertical" },
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
    whiteSpace: "pre-line",
  },
  list: { display: "grid", gap: 5 },
  item: {
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) auto",
    gap: "3px 7px",
    padding: "6px 7px",
    border: "1px solid #e5e7eb",
    borderRadius: 9,
    fontSize: 11,
    lineHeight: 1.35,
  },
  itemText: { minWidth: 0, overflowWrap: "anywhere", color: "#475569" },
  itemAmount: { alignSelf: "start", whiteSpace: "nowrap", fontSize: 11, fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  itemDetail: { gridColumn: "1 / -1", minWidth: 0, overflowWrap: "anywhere", color: "#334155" },
  itemMeta: { minWidth: 0, color: "#64748b", fontSize: 10 },
} satisfies Record<string, CSSProperties>;
