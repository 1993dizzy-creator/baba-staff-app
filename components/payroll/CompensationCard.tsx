"use client";
import Link from "next/link";
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
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
import { buildPayrollPartTotals, getPayrollApplicabilityBadges, getPayrollCalculatedNetAmount } from "@/lib/payroll/payroll-dashboard";
import { payrollOverviewText } from "@/lib/text/payroll-overview";
import {
  getPaymentBadgePresentation,
  reviewLabel,
  shouldShowPaymentDifferenceReason,
} from "@/lib/payroll/ui-labels";
import { getEmployeeRoleLabel } from "@/lib/common/roles";
import AttendancePerfectScoreBadge from "@/components/attendance/AttendancePerfectScoreBadge";
import PartTimeExtraWorkSection from "@/components/payroll/PartTimeExtraWorkSection";
import { lookupEmployeePaymentStatus } from "@/lib/payroll/payment-result-check";
import { getPayrollReviewReasons, payrollReviewCategoryHref, payrollReviewCategoryLabel, type PayrollReviewCategory, type PayrollReviewReasons } from "@/lib/payroll/review-reasons";
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
  asOfDate,
  future,
  monthClosed,
  refresh,
  paymentLocked = false,
  mealAllowanceEligible = false,
  attendanceBonusEligible = false,
}: {
  employee: PayrollOverviewEmployee;
  expanded: boolean;
  toggle: () => void;
  lang: "ko" | "vi";
  month: string;
  asOfDate?: string;
  future: boolean;
  monthClosed: boolean;
  refresh: () => Promise<boolean>;
  paymentLocked?: boolean;
  mealAllowanceEligible?: boolean;
  attendanceBonusEligible?: boolean;
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
  const hourlyContractReview = employee.contract?.payType === "hourly" && combined === null && employee.levelInfo.reason !== "MISSING_BASE_DATE";
  const headerAmount = getPayrollHeaderAmount(employee, future);
  const header = future
    ? "—"
    : !employee.contract
      ? t.contractUnset
      : combined === null
        ? (hourlyContractReview ? t.hourlyContractHoursRequired : t.levelBaseRequired)
        : formatPayrollHeaderAmount(headerAmount ?? combined);
  const calculatedNetAmount = getPayrollCalculatedNetAmount(employee, future);
  const applicabilityBadges = getPayrollApplicabilityBadges({ employee, month, monthClosed, attendanceBonusEligible, mealAllowanceEligible, lang });
  const attendanceBadge = applicabilityBadges.find(badge => badge.key === "attendance");
  const employeeAge = age(employee.birthDate);
  const positionLabel = employee.role
    ? getEmployeeRoleLabel(employee.role, lang)
    : employee.username;
  const extraWorkCount = employee.partTimeExtraWork.length;
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
  // 확인 필요 사유: overview 판정(calculationStatus·warningCodes)을 분류만 한다. 미래 월은 전원 "계산 전"이라 생략.
  const reviewReasons = future ? null : getPayrollReviewReasons(employee, false, lang);
  const extraWorkAnchorId = `payroll-extra-work-${employee.userId}`;
  const [extraWorkScrollRequested, setExtraWorkScrollRequested] = useState(false);
  const [moreReasonsOpen, setMoreReasonsOpen] = useState(false);
  // 배지 클릭은 카드를 닫지 않는다: 접혀 있으면 펼친 뒤, 렌더된 추가근무 검토 섹션으로 스크롤한다.
  const focusExtraWork = () => { if (!expanded) toggle(); setExtraWorkScrollRequested(true); };
  useEffect(() => {
    if (!extraWorkScrollRequested || !expanded) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(extraWorkAnchorId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setExtraWorkScrollRequested(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, extraWorkAnchorId, extraWorkScrollRequested]);
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
          {extraWorkCount > 0 ? (
            <span style={s.extraWorkBadge} title={extraWorkBadgeLabel} aria-label={extraWorkBadgeLabel}>⏱️</span>
          ) : null}
          <span style={s.separator}>·</span>
          <span style={s.position}>{positionLabel}</span>
        </span>
        <span style={s.headerPayment}>
        {headerAmount !== null && <span style={s.amountCaption} title={lang === "vi" ? "Lương hợp đồng" : "계약급여"}>{lang === "vi" ? "HĐ" : "계약"}</span>}
        <b
          style={s.amount}
          title={headerAmount === null ? header : formatVnd(headerAmount)}
        >
          {header}
        </b>
        {employee.payment?.payment_status === "paid" && <span style={{ ...s.paymentBadge, ...(paymentBadge.adjusted ? s.adjustedPaymentBadge : {}) }}>{paymentBadge.label}</span>}
        </span>
        <span style={s.expandIcon} aria-hidden="true">
          {expanded ? "⌃" : "⌄"}
        </span>
      </button>
      {(!future || mealAllowanceEligible || (attendanceBonusEligible && employee.attendanceStanding?.perfectAttendanceCurrent === true)) && (
        <div style={s.amountStrip}>
          <span style={s.applicabilityBadges} role="group" aria-label={lang === "vi" ? "Đối tượng áp dụng trong tháng" : "조회 월 적용 대상"}>
            {/* A closed month may retain the old perfect-attendance indicator
                without an applied bonus. Keep that meaning, without duplicating it. */}
            {!future && attendanceBadge
              ? <span role="img" style={s.applicabilityBadge} aria-label={attendanceBadge.description} title={attendanceBadge.description}>💯</span>
              : <AttendancePerfectScoreBadge eligible={attendanceBonusEligible} show={employee.attendanceStanding?.perfectAttendanceCurrent===true} vi={lang==="vi"}/>}
            {future
              ? mealAllowanceEligible && <span role="img" style={s.applicabilityBadge} aria-label={mealAllowanceBadgeLabel(lang)} title={mealAllowanceBadgeLabel(lang)}>🍚</span>
              : applicabilityBadges.filter(badge => badge.key !== "attendance").map(badge => <span key={badge.key} role={badge.key === "tax" ? undefined : "img"} style={{...s.applicabilityBadge,...(badge.key === "tax" ? s.taxApplicabilityBadge : {})}} aria-label={badge.description} title={badge.description}>{badge.key === "meal" ? "🍚" : badge.key === "insurance" ? "🛡️" : badge.label}</span>)}
          </span>
          {!future && <span style={s.amountStripCell}>
            {reviewReasons && reviewReasons.categories.length > 0 ? <>
              <ReviewProblemBadge category={reviewReasons.categories[0]} userId={employee.userId} month={month} lang={lang} onExtraWork={focusExtraWork} />
              {reviewReasons.categories.length > 1 && <button type="button" style={s.reviewMoreButton} aria-expanded={moreReasonsOpen} aria-controls={`payroll-review-more-${employee.userId}`} title={reviewReasons.categories.slice(1).map(category => payrollReviewCategoryLabel(category, lang)).join(", ")} onClick={() => setMoreReasonsOpen(open => !open)}>+{reviewReasons.categories.length - 1}</button>}
            </> : <>
              <span style={s.amountStripLabel}>{lang === "vi" ? "Thực nhận đã tính" : "계산 실수령"}</span>
              {calculatedNetAmount === null
                ? <b style={{ ...s.amountStripValue, ...s.amountStripReview }}>{lang === "vi" ? "Cần kiểm tra" : "확인 필요"}</b>
                : <b style={s.amountStripValue}>{formatVnd(calculatedNetAmount)}</b>}
            </>}
          </span>}
          {!future && moreReasonsOpen && reviewReasons && reviewReasons.categories.length > 1 && <div id={`payroll-review-more-${employee.userId}`} style={s.reviewMoreList}>
            {reviewReasons.categories.slice(1).map(category => <ReviewProblemBadge key={category} category={category} userId={employee.userId} month={month} lang={lang} onExtraWork={focusExtraWork} />)}
          </div>}
        </div>
      )}
      {expanded && (
        <div style={s.detail}>
          {!employee.contract ? (
            <>
              <p>{t.noContract}</p>
              <Link
                href={`/admin/payroll/settings?tab=employee&userId=${employee.userId}&month=${month}`}
              >
                {t.payrollSettingsLink}
              </Link>
            </>
          ) : combined === null ? (
            <>
              <p>{hourlyContractReview ? t.hourlyContractHoursRequired : t.levelBaseRequired}</p>
              <Link href={hourlyContractReview ? "/admin/payroll/settings" : "/admin/users"}>{hourlyContractReview ? t.payrollSettingsLink : t.employeeSettingsLink}</Link>
            </>
          ) : (
            <>
              <CollapsibleDetailSection icon="💰" title={detailText.salaryComposition} summary={formatContractRate(combined, employee.contract.payType, lang)} first>
                <Row label={t.contractSalary} value={formatContractRate(employee.amounts.contractSalary, employee.contract.payType, lang)} />
                <Row label={t.fixedRaise} value={formatContractRate(employee.amounts.fixedRaiseAmount, employee.contract.payType, lang, "+")} />
                <Row label={t.levelRaise} value={formatContractRate(employee.amounts.levelRaiseAmount, employee.contract.payType, lang, "+")} />
                {employee.levelInfo.eligible && (employee.levelApplication.raiseExcluded === "salary_raise_disabled" || employee.levelInfo.salaryRaiseEnabled === false)
                  ? <p>{t.levelRaiseNotApplied}</p>
                  : employee.levelInfo.eligible && employee.contract.payType === "daily" && employee.levelInfo.earnedRaiseCount > 0
                    ? <p>{t.dailyLevelRaiseNotApplied}</p>
                    : null}
                <CombinedSalarySummary
                  label={t.combinedSalary}
                  value={formatContractRate(combined, employee.contract.payType, lang)}
                  monthlyEquivalent={employee.contract.payType === "hourly" ? employee.amounts.contractMonthlyEquivalent : null}
                  monthlyEquivalentLabel={detailText.monthlyEquivalent}
                  monthlyEquivalentHelp={detailText.monthlyEquivalentHelp}
                />
              </CollapsibleDetailSection>

              <CollapsibleDetailSection icon="📅" title={detailText.monthApplication} summary={employee.amounts.workAppliedAmount === null ? (lang === "vi" ? "Cần kiểm tra" : "확인 필요") : formatVnd(employee.amounts.workAppliedAmount)} summaryReview={employee.amounts.workAppliedAmount === null}>
                <small style={s.help}>{lang === "vi" ? "Ngày chốt tính" : "계산 기준일"} · {asOfDate ?? "—"}</small>
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
              </CollapsibleDetailSection>

              {employee.contract.calculationBasis !== "fixed_monthly" && <div id={extraWorkAnchorId} style={s.extraWorkAnchor}><PartTimeExtraWorkSection employee={employee} month={month} lang={lang} refresh={refresh} /></div>}

              <DetailSection icon="🛡️" title={lang === "vi" ? "Tính thực nhận nhân viên" : "직원 지급 계산"}>
                <Row label={t.preInsurancePayout} value={formatVnd(employee.amounts.preInsurancePayoutAmount)} highlight="subtotal" />
                {(employee.insuranceEnrolled || employee.amounts.employeeInsuranceDeductionAmount > 0) && <Row label={t.employeeInsuranceDeduction} value={formatSignedVnd(employee.amounts.employeeInsuranceDeductionAmount, "-")} />}
                {employee.amounts.advanceAmount > 0 && <Row label={t.advance} value={formatSignedVnd(employee.amounts.advanceAmount, "-")} />}
                {employee.amounts.otherDeductionAmount > 0 && <details style={s.taxDetails}><summary style={s.taxDetailsSummary}>{lang === "vi" ? "Khoản trừ khác đã tính trong tổng trên" : "지급대상액에 이미 반영된 기타 공제"}</summary><Row label={t.otherDeduction} value={formatSignedVnd(employee.amounts.otherDeductionAmount, "-")} /></details>}
              {(employee.tax.status === "requires_review" || employee.tax.taxMode === "resident_progressive") && <DetailSection icon="🧾" title={taxText.title}>
                {employee.tax.status === "requires_review" ? <><p role="alert" style={s.error}>{taxText.requiresReview} ({employee.tax.warningCodes.join(", ")})</p><Link href={`/admin/payroll/settings?tab=employee&userId=${employee.userId}&month=${month}`}>{taxText.settings}</Link></> : <>
                  <Row label={employee.tax.taxBurdenMode === "company_bears" ? (lang === "vi" ? "Công ty chịu · Nhân viên khấu trừ" : "회사 부담 적용 · 직원 공제") : (lang === "vi" ? "Áp dụng · Nhân viên khấu trừ" : "적용 · 직원 공제")} value={formatVnd(employee.tax.employeePitDeductionAmount)} />
                  <details style={s.taxDetails}>
                    <summary style={s.taxDetailsSummary}>{taxText.details}</summary>
                    <div style={s.taxDetailsRows}>
                      <Row label={taxText.taxableIncome} value={formatVnd(employee.tax.taxableIncomeAmount)} />
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
                <Row label={t.netPayout} value={employee.amounts.currentAmount === null ? t.settingsRequired : formatVnd(employee.amounts.netPayoutAmount)} highlight="net" />
                {employee.insuranceEnrolled && <details style={s.taxDetails}><summary style={s.taxDetailsSummary}>{t.insuranceBase}</summary><Row label={t.insuranceBase} value={formatVnd(employee.amounts.insuranceBaseAmount)} /></details>}
                {employee.unresolvedAttendanceCount > 0 && <Row label={t.unresolvedAttendance} value={`${employee.unresolvedAttendanceCount}${t.days}`} />}
              </DetailSection>
              {(employee.amounts.employerInsuranceAmount > 0 || employee.amounts.companyPitAmount > 0) && <DetailSection icon="🏢" title={lang === "vi" ? "Chi phí riêng của công ty" : "회사 별도 비용"}>
                {employee.amounts.employerInsuranceAmount > 0 && <Row label={t.employerInsurance} value={formatVnd(employee.amounts.employerInsuranceAmount)} muted />}
                {employee.amounts.companyPitAmount > 0 && <Row label={t.companyPit} value={formatVnd(employee.amounts.companyPitAmount)} muted />}
                <small style={s.help}>{lang === "vi" ? "Không khấu trừ vào thực nhận nhân viên." : "직원 실수령액에서 차감하지 않습니다."}</small>
              </DetailSection>}
              {!future && <>{(monthClosed || employee.payment?.payment_status === "paid") && <button type="button" style={s.paymentButton} disabled={employee.payment?.payment_status !== "paid" && (paymentLocked || !monthClosed || employee.calculationStatus !== "calculable" || !employee.calculationHash)} onClick={()=>setPaymentOpen(true)}>{employee.payment?.payment_status === "paid" ? (lang === "vi" ? "Xem chi tiết chi trả" : "지급 내역 확인") : paymentLocked && monthClosed ? (lang === "vi" ? "Chi trả sau khi tải danh sách" : "목록 조회 후 지급 가능") : !monthClosed ? (lang === "vi" ? "Tháng lương chưa kết thúc" : "급여 월 미종료") : employee.calculationStatus !== "calculable" || !employee.calculationHash ? (lang === "vi" ? "Không thể chi trả" : "지급 불가") : (lang === "vi" ? "Chi trả lương" : "급여 지급")}</button>}{!monthClosed&&employee.payment?.payment_status!=="paid"&&<small style={s.help}>{lang==="vi"?"Có thể chi trả sau khi tháng lương kết thúc.":"급여 대상 월 종료 후 지급 가능"}</small>}{blockingReasonLabels.length>0&&<div role="alert" style={s.blockingReasons}><b style={s.blockingReasonsTitle}>{lang==="vi"?"Lý do chưa thể chi trả":"지급 불가 사유"}</b><ul style={s.blockingReasonList}>{blockingReasonLabels.map(label=><li key={label}>{label}</li>)}</ul>{reviewReasons&&<ReviewReasonActions reasons={reviewReasons} userId={employee.userId} month={month} lang={lang} onExtraWork={focusExtraWork}/>}</div>}</>}
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
      {paymentOpen && <PaymentModal employee={employee} month={month} lang={lang} close={()=>setPaymentOpen(false)} refresh={refresh} paymentLocked={paymentLocked}/>}
    </article>
  );
}
// 확인 필요 배지: 2차-B 사유 분류의 해결 위치로 바로 이동한다(근태 상세·급여설정·카드 내 추가근무).
// 카드 헤더 버튼 밖에 있으므로 버튼 중첩이 없고, 클릭해도 카드를 닫지 않는다.
function ReviewProblemBadge({ category, userId, month, lang, onExtraWork }: { category: PayrollReviewCategory; userId: number; month: string; lang: "ko" | "vi"; onExtraWork: () => void }) {
  const label = payrollReviewCategoryLabel(category, lang);
  if (category === "extraWork") return <button type="button" style={s.reviewProblemBadge} onClick={onExtraWork}>{label} ›</button>;
  const href = payrollReviewCategoryHref(category, userId, month);
  return href ? <Link href={href} style={s.reviewProblemBadge}>{label} ›</Link> : <span style={{ ...s.reviewProblemBadge, ...s.reviewProblemBadgeStatic }}>{label}</span>;
}
// 상세 섹션 접힘형 배너: 제목 오른쪽에 요약 금액, 클릭하면 기존 내역을 그대로 보여준다(섹션별 독립 상태, 기본 접힘).
function CollapsibleDetailSection({ icon, title, summary, summaryReview = false, children, first = false }: { icon: string; title: string; summary: string; summaryReview?: boolean; children: ReactNode; first?: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section style={{ ...s.detailSection, ...(first ? s.firstDetailSection : {}) }}>
      <div style={{ ...s.collapsibleGroup, ...(open ? s.collapsibleGroupOpen : {}) }}>
        <button type="button" style={{ ...s.collapsibleHeader, ...(open ? s.collapsibleHeaderOpen : {}) }} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
          <span style={s.sectionTitle}>
            <span aria-hidden="true" style={s.collapsibleChevron}>{open ? "⌄" : "›"}</span>
            <span aria-hidden="true" style={s.sectionIcon}>{icon}</span>{title}
          </span>
          <span style={s.collapsibleSummary}>
            <b style={{ ...s.collapsibleSummaryValue, ...(summaryReview ? s.amountStripReview : {}) }}>{summary}</b>
          </span>
        </button>
        {open && <div id={bodyId} style={{ ...s.sectionRows, ...s.collapsibleBody }}>{children}</div>}
      </div>
    </section>
  );
}
function ReviewReasonActions({ reasons, userId, month, lang, onExtraWork }: { reasons: PayrollReviewReasons; userId: number; month: string; lang: "ko" | "vi"; onExtraWork: () => void }) {
  const vi = lang === "vi";
  const actions: { key: string; href: string | null; text: string }[] = [];
  for (const category of reasons.categories) {
    if (category === "extraWork") { actions.push({ key: category, href: null, text: vi ? "Xem làm thêm giờ" : "추가근무 검토" }); continue; }
    const href = payrollReviewCategoryHref(category, userId, month);
    // 계약·보험/TNCN은 같은 급여설정 화면이라 한 번만 보여준다.
    if (!href || actions.some(action => action.href === href)) continue;
    actions.push({ key: category, href, text: category === "attendance" ? (vi ? "Xem chấm công" : "근태 상세") : category === "level" ? (vi ? "Quản lý nhân viên" : "직원관리") : (vi ? "Cài đặt lương" : "급여설정") });
  }
  if (actions.length === 0) return null;
  return <div style={s.reviewReasonActions}>{actions.map(action => action.href
    ? <Link key={action.key} href={action.href} style={s.reviewReasonAction}>{action.text} ›</Link>
    : <button key={action.key} type="button" style={s.reviewReasonAction} onClick={onExtraWork}>{action.text} ›</button>)}</div>;
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
  const vi = lang === "vi";
  const totals = buildPayrollPartTotals(employees, getPayrollHeaderAmount, future);
  const people = (count: number) => vi ? `${count} ${t.people}` : `${count}${t.people}`;
  const title = vi
    ? `Tổng ${partName} (${people(employees.length)})`
    : `${partName} 합계 (${people(employees.length)})`;
  const excludedLine = (names: string[]) => `${people(names.length)} · ${names.join(", ")}`;
  return (
    <div style={s.total}>
      <b style={s.totalTitle}>{title}</b>
      {future ? (
        <small style={{...s.help,fontSize:12}}>{t.beforeCalculationPeriod}</small>
      ) : (
        <>
          <div style={s.totalRow}><span style={s.totalLabel}>{vi ? "Lương hợp đồng (quy đổi tháng)" : "계약급여 (월 환산)"}</span><b style={s.totalAmount}>{formatVnd(totals.contractMonthlyTotal)}</b></div>
          <div style={s.totalRow}><span style={s.totalLabel}>{vi ? "Thực nhận đã tính" : "계산 실수령"}</span><b style={s.totalAmount}>{formatVnd(totals.netTotal)}</b></div>
          <div style={{...s.totalRow,borderBottom:0}}><span style={s.totalLabel}>{vi ? `Thực trả (${people(totals.paidCount)})` : `실제 지급 (${people(totals.paidCount)})`}</span><b style={s.totalAmount}>{formatVnd(totals.paidTotal)}</b></div>
          {totals.contractExcluded.length > 0 && (
            <small style={s.totalExcluded}>{vi ? "Chưa tính lương hợp đồng" : "계약급여 합계 제외"}: {excludedLine(totals.contractExcluded)}</small>
          )}
          {totals.netExcluded.length > 0 && (
            <small style={s.totalExcluded}>{vi ? "Chưa tính thực nhận (cần kiểm tra)" : "실수령 합계 제외 (확인 필요)"}: {excludedLine(totals.netExcluded)}</small>
          )}
        </>
      )}
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
  // New advances are entered in the ledger (지출 → 👥 가불) so the payroll
  // deduction and the cash payment are always created together.
  const selectedKind = kind === "incentive" ? "incentive" : "penalty";
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
            {selectedKind === "incentive" ? t.addIncentive : t.addPenalty}
          </button>
        )}</div>}
    >
      <div style={s.list}>
        {kind === "incentive" &&
          (employee.automaticIncentives ?? []).map((item, index) => (
            <article key={`${item.category}:${index}`} style={s.item}>
              <span style={s.itemText}>
                {lang === "vi" ? "Thưởng chuyên cần" : "개근 보너스"}
              </span>
              <b style={s.itemAmount}>{formatSignedVnd(item.amount, "+")}</b>
              <small style={s.itemMeta}>
                {lang === "vi" ? "Tự động" : "자동 적용"}
              </small>
            </article>
          ))}
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
        {list.map((item) => {
          const automaticSales = item.sourceType === "sales_menu_incentive";
          // Ledger-created advances are paired with a cash payment; not cancellable here.
          const ledgerAdvance = item.sourceKey?.startsWith("ledger-payroll-advance:") ?? false;
          return (
            <article key={item.id} style={s.item}>
              <span style={s.itemText}>
                {item.businessDate.slice(5)} · {automaticSales
                  ? (lang === "vi" ? "Thưởng doanh số menu tự động" : "자동 판매 인센티브")
                  : item.kind === "advance" ? t.advance : item.kind === "penalty" ? t.manualPenalty : item.category}
              </span>
              <b style={s.itemAmount}>
                {formatSignedVnd(item.amount, kind === "incentive" ? "+" : "-")}
              </b>
              <span style={{...s.itemDetail,...(automaticSales?s.automaticAdjustmentDetail:{})}}>
                {item.reason}
                {item.note ? `${automaticSales ? "\n" : " · "}${item.note}` : ""}
              </span>
              <small style={s.itemMeta}>
                {new Date(item.createdAt).toLocaleString(
                  lang === "vi" ? "vi-VN" : "ko-KR",
                )}
              </small>
              {!automaticSales && !ledgerAdvance && <button
                style={s.cancel}
                disabled={busy}
                onClick={() => setCancelTarget(item)}
              >
                {t.cancel}
              </button>}
            </article>
          );
        })}
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
          {kind === "penalty" && <p style={s.fieldHelp}>{lang === "vi"
            ? "Ứng lương được nhập tại Sổ sách › Thêm giao dịch › Chi › 👥 Ứng lương."
            : "가불은 장부 › 장부 내역 추가 › 지출 › 👥 가불에서 등록합니다."}</p>}
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
type PaymentOutcome={kind:"checking"}|{kind:"unknown"}|{kind:"paid";confirmed:boolean;refreshed:boolean}|{kind:"alreadyPaid";refreshed:boolean};
function paymentOutcomeMessage(outcome:PaymentOutcome,vi:boolean){
  if(outcome.kind==="checking")return vi?"Không nhận được phản hồi của yêu cầu chi trả. Đang kiểm tra bản ghi chi trả hiện có để xác nhận đã xử lý hay chưa.":"지급 요청의 응답을 받지 못했습니다. 기존 지급 기록을 조회해 처리 여부를 확인하고 있습니다.";
  if(outcome.kind==="unknown")return vi?"Chưa xác nhận được kết quả chi trả. Để tránh chi trả trùng, đừng chi trả lại — hãy bấm \"Kiểm tra lại kết quả chi trả\".":"지급 처리 여부를 확인하지 못했습니다. 중복 지급을 막기 위해 다시 지급하지 말고 '지급 결과 다시 확인'을 눌러주세요.";
  const head=outcome.kind==="alreadyPaid"?(vi?"Đã có bản ghi chi trả cho nhân viên này nên không chi trả trùng.":"이미 지급된 기록이 있어 중복 지급하지 않았습니다."):outcome.confirmed?(vi?"Đã xác nhận bản ghi chi trả. Chi trả lương đã hoàn tất.":"지급 기록이 확인되었습니다. 급여 지급이 완료되었습니다."):(vi?"Chi trả lương đã hoàn tất.":"급여 지급이 완료되었습니다.");
  return outcome.refreshed?head:`${head} ${vi?"Tuy nhiên chưa tải lại được danh sách lương. Đừng chi trả lại — hãy tải lại danh sách.":"다만 급여 목록을 다시 불러오지 못했습니다. 다시 지급하지 말고 목록을 다시 조회해주세요."}`;
}
function PaymentModal({employee,month,lang,close,refresh,paymentLocked}:{employee:PayrollOverviewEmployee;month:string;lang:"ko"|"vi";close:()=>void;refresh:()=>Promise<boolean>;paymentLocked:boolean}){
  const vi=lang==="vi";const payment=employee.payment;const calculated=employee.amounts.netPayoutAmount;
  const [actual,setActual]=useState(String(payment?.actual_paid_amount??calculated));const [date,setDate]=useState(payment?.payment_date??new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));const [reason,setReason]=useState(payment?.difference_reason??"");const[cancelMode,setCancelMode]=useState(false);const[cancelReason,setCancelReason]=useState("");const[busy,setBusy]=useState(false);const[error,setError]=useState("");
  const [fundAccounts,setFundAccounts]=useState<Array<{id:number;code:string;display_name:string}>>([]);
  const [fundAccountId,setFundAccountId]=useState<number|null>(payment?.fund_account_id??null);
  const [accountsLoaded,setAccountsLoaded]=useState(false);
  useEffect(()=>{
    let active=true;
    void fetch("/api/admin/payroll/fund-accounts").then(async response=>{
      const data=await response.json();
      if(!response.ok)throw new Error("PAYROLL_FUND_ACCOUNTS_READ_FAILED");
      if(!active)return;
      const accounts=Array.isArray(data.accounts)?data.accounts as Array<{id:number;code:string;display_name:string}>:[];
      setFundAccounts(accounts);
      setFundAccountId(current=>current??(payment?.fund_account_id && accounts.some(account=>account.id===payment.fund_account_id)?payment.fund_account_id:data.defaultFundAccountId??null));
      setAccountsLoaded(true);
    }).catch(()=>{if(active){setAccountsLoaded(true);setError(vi?"Không thể tải tài khoản chi trả.":"지급 계좌를 불러오지 못했습니다.")}});
    return()=>{active=false};
  },[payment?.fund_account_id,vi]);
  const actualNumber=Number(actual||0);const difference=actualNumber-calculated;const actor=payment?.paid_actor;const actorLabel=actor?.name||actor?.full_name||actor?.username||"—";
  // 지급 결과(outcome)가 정해지면 같은 지급 요청을 다시 보내지 않는다. 응답 유실 등으로 결과가 불확실하면
  // 기존 지급 기록을 조회해 처리 여부를 먼저 확인하고, 확인 전에는 지급 버튼 대신 "결과 다시 확인"만 제공한다.
  const [outcome,setOutcome]=useState<PaymentOutcome|null>(null);
  async function confirmPaymentResult(){setOutcome({kind:"checking"});const status=await lookupEmployeePaymentStatus(month,employee.userId);if(status==="paid"){setOutcome({kind:"paid",confirmed:true,refreshed:await refresh()});return}if(status==="unpaid"){setOutcome(null);setError(vi?"Đã kiểm tra: chưa có bản ghi chi trả. Lương chưa được chi trả — hãy kiểm tra nội dung rồi chi trả lại.":"지급 기록을 확인한 결과 지급되지 않았습니다. 입력값을 확인한 뒤 다시 지급할 수 있습니다.");return}setOutcome({kind:"unknown"})}
  async function recheckPaymentResult(){if(busy)return;setBusy(true);setError("");try{await confirmPaymentResult()}finally{setBusy(false)}}
  async function reloadAfterPayment(){if(busy||!outcome||(outcome.kind!=="paid"&&outcome.kind!=="alreadyPaid"))return;setBusy(true);try{const refreshed=await refresh();setOutcome({...outcome,refreshed})}finally{setBusy(false)}}
  async function submit(){if(busy||outcome||paymentLocked||!accountsLoaded||!fundAccountId||actualNumber<1||(difference!==0&&!reason.trim())||!employee.calculationHash)return;setBusy(true);setError("");try{let response:Response;try{response=await fetch("/api/admin/payroll/payments",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({month,userId:employee.userId,calculationHash:employee.calculationHash,actualPaidAmount:actualNumber,differenceReason:reason,paymentDate:date,fundAccountId})})}catch{await confirmPaymentResult();return}const data=await response.json().catch(()=>null);if(!data||typeof data!=="object"){await confirmPaymentResult();return}if(!response.ok){if(data.code==="PAYROLL_EMPLOYEE_ALREADY_PAID"){setOutcome({kind:"alreadyPaid",refreshed:await refresh()});return}if(data.code==="PAYROLL_CALCULATION_STALE")await refresh();const preflight=data.code==="PAYROLL_BATCH_PREFLIGHT_FAILED"&&Array.isArray(data.employees)?data.employees.map((item:{employeeName:string;reasonCodes:string[]})=>`${item.employeeName}: ${item.reasonCodes.join(", ")}`).join("\n"):null;throw new Error(preflight?`${vi?data.messageVi:data.message}\n${preflight}`:["PAYROLL_MONTH_NOT_CLOSED","PAYROLL_CALCULATION_STALE","PAYROLL_FUND_ACCOUNT_INVALID","PAYROLL_LEDGER_PROJECTION_FAILED"].includes(data.code)?(vi?data.messageVi:data.message):(vi?"Không thể xử lý chi trả.":"급여를 지급하지 못했습니다."))}const refreshed=await refresh();if(refreshed){close();return}setOutcome({kind:"paid",confirmed:false,refreshed:false})}catch(cause){setError(cause instanceof Error?cause.message:(vi?"Không thể xử lý chi trả.":"급여를 지급하지 못했습니다."))}finally{setBusy(false)}}
  async function cancelPayment(){if(busy||!cancelReason.trim()||!employee.batchId)return;setBusy(true);setError("");try{const response=await fetch("/api/admin/payroll/payments",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:employee.batchId,userId:employee.userId,reason:cancelReason})});if(!response.ok)throw new Error(vi?"Không thể hủy chi trả.":"지급을 취소하지 못했습니다.");await refresh();close()}catch(cause){setError(cause instanceof Error?cause.message:(vi?"Không thể hủy chi trả.":"지급을 취소하지 못했습니다."))}finally{setBusy(false)}}
  return <PayrollModal placement="top" title={payment?.payment_status==="paid"?(vi?"Chi tiết chi trả":"지급 내역"):(vi?"Chi trả lương":"급여 지급")} closeLabel={vi?"Đóng":"닫기"} onClose={()=>{if(!busy)close()}} footer={<div style={s.modalFooter}>{outcome?.kind==="checking"?<button type="button" style={{...s.primary,...s.modalAction}} disabled>{vi?"Đang kiểm tra kết quả…":"지급 결과 확인 중…"}</button>:outcome?.kind==="unknown"?<button type="button" style={{...s.primary,...s.modalAction}} disabled={busy} onClick={()=>void recheckPaymentResult()}>{vi?"Kiểm tra lại kết quả chi trả":"지급 결과 다시 확인"}</button>:outcome&&!outcome.refreshed?<button type="button" style={{...s.primary,...s.modalAction}} disabled={busy} onClick={()=>void reloadAfterPayment()}>{vi?"Tải lại danh sách lương":"급여 목록 다시 조회"}</button>:payment?.payment_status==="paid"?(employee.batchStatus==="paying"?<button type="button" style={{...s.danger,...s.modalAction}} disabled={busy||paymentLocked||cancelMode&&!cancelReason.trim()} onClick={()=>cancelMode?void cancelPayment():setCancelMode(true)}>{cancelMode?(vi?"Xác nhận hủy":"지급 취소 실행"):(vi?"Hủy chi trả":"지급 취소")}</button>:null):outcome?null:<button type="button" style={{...s.primary,...s.modalAction}} disabled={busy||!accountsLoaded||!fundAccountId||paymentLocked||actualNumber<1||(difference!==0&&!reason.trim())} onClick={()=>void submit()}>{vi?"Chi trả":"지급"}</button>}</div>}>
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
          fundAccountName={payment.fund_account_id==null?(vi?"Lịch sử chi trả · chưa chỉ định tài khoản":"기존 지급 기록 · 계좌 미지정"):(payment.fund_account?.display_name??fundAccounts.find(account=>account.id===payment.fund_account_id)?.display_name??(vi?`Tài khoản #${payment.fund_account_id}`:`계좌 #${payment.fund_account_id}`))}
          actorLabel={actorLabel}
          paidAt={payment.paid_at}
          lang={lang}
        />
      ) : (
        <UnpaidPaymentForm
          actual={actual}
          difference={difference}
          date={date}
          fundAccounts={fundAccounts}
          fundAccountId={fundAccountId}
          accountsLoaded={accountsLoaded}
          reason={reason}
          lang={lang}
          onActualChange={setActual}
          onDateChange={setDate}
          onFundAccountChange={setFundAccountId}
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
      {outcome?<p role={outcome.kind==="unknown"||(outcome.kind!=="checking"&&!outcome.refreshed)?"alert":"status"} style={outcome.kind==="paid"||outcome.kind==="alreadyPaid"?s.paymentNotice:s.error}>{paymentOutcomeMessage(outcome,vi)}</p>:paymentLocked&&payment?.payment_status!=="paid"?<p role="status" style={s.error}>{vi?"Danh sách lương đang được tải hoặc chưa được cập nhật. Vui lòng chi trả sau khi tải lại danh sách.":"급여 목록을 조회 중이거나 최신 자료가 아닙니다. 목록 조회가 완료된 뒤 지급해주세요."}</p>:null}
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
  fundAccountName,
  actorLabel,
  paidAt,
  lang,
}: {
  actualAmount: number;
  differenceAmount: number;
  differenceReason: string | null;
  paymentDate: string | null;
  fundAccountName: string;
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
        <PaymentKeyValue label={vi ? "Tài khoản chi trả" : "지급계좌"} value={fundAccountName} wrap />
        <PaymentKeyValue label={vi ? "Người xử lý" : "지급 처리자"} value={actorLabel} wrap />
        <PaymentKeyValue label={vi ? "Thời gian xử lý" : "지급 시각"} value={paidAt ? new Date(paidAt).toLocaleString(vi ? "vi-VN" : "ko-KR") : "—"} wrap />
        </PaymentCard>
      </PaymentSection>
    </>
  );
}

function UnpaidPaymentForm({ actual, difference, date, fundAccounts, fundAccountId, accountsLoaded, reason, lang, onActualChange, onDateChange, onFundAccountChange, onReasonChange }: {
  actual: string;
  difference: number;
  date: string;
  fundAccounts: Array<{id:number;code:string;display_name:string}>;
  fundAccountId: number|null;
  accountsLoaded: boolean;
  reason: string;
  lang: "ko" | "vi";
  onActualChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onFundAccountChange: (value: number|null) => void;
  onReasonChange: (value: string) => void;
}) {
  const vi = lang === "vi";
  return (
    <>
      <PaymentSection icon="💳" title={vi ? "Thông tin chi trả" : "지급 정보"}>
        <PaymentCard>
          <PaymentField label={vi ? "Ngày trả" : "지급일"}>
            <input style={s.paymentInput} type="date" value={date} onChange={event=>onDateChange(event.target.value)} />
          </PaymentField>
          <PaymentField label={vi ? "Số tiền thực trả" : "실제 지급액"}>
            <input style={s.paymentInput} type="text" inputMode="numeric" value={formatPositiveIntegerInput(actual)} onChange={event=>onActualChange(normalizePositiveIntegerInput(event.target.value))} />
          </PaymentField>
          <PaymentKeyValue label={vi ? "Chênh lệch" : "차액"} value={formatVnd(difference)} />
          <PaymentField label={vi ? "Tài khoản chi trả" : "지급계좌"}>
            <select style={s.paymentInput} value={fundAccountId??""} disabled={!accountsLoaded} onChange={event=>onFundAccountChange(event.target.value?Number(event.target.value):null)}>
              <option value="">{vi ? "Chọn tài khoản chi trả" : "지급계좌 선택"}</option>
              {fundAccounts.map(account=><option key={account.id} value={account.id}>{account.display_name}</option>)}
            </select>
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
  extraWorkBadge: { padding: "1px 4px", borderRadius: 999, background: "#f1f5f9", fontSize: 11, lineHeight: 1.2, flexShrink: 0 },
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
  amountCaption: { color:"#94a3b8", fontSize:9.5, fontWeight:800, whiteSpace:"nowrap" },
  amountStrip: { display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)", alignItems:"center", gap:8, width:"100%", marginTop:5, paddingTop:5, borderTop:"1px dashed #e5e7eb", minWidth:0, boxSizing:"border-box" },
  applicabilityBadges: { display:"flex", flexWrap:"wrap", alignItems:"center", gap:4, minWidth:0 },
  applicabilityBadge: { display:"inline-flex", alignItems:"center", maxWidth:"100%", color:"#475569", fontSize:14, lineHeight:1.3 },
  taxApplicabilityBadge: { fontSize:11, fontWeight:800 },
  amountStripCell: { display:"flex", flexWrap:"wrap", justifyContent:"flex-end", alignItems:"baseline", columnGap:6, minWidth:0 },
  amountStripLabel: { color:"#64748b", fontSize:10, fontWeight:700, lineHeight:1.3, overflowWrap:"anywhere", minWidth:0 },
  amountStripValue: { maxWidth:"100%", color:"#1d4ed8", fontSize:12, fontWeight:900, overflowWrap:"anywhere", fontVariantNumeric:"tabular-nums", textAlign:"right" },
  amountStripReview: { color:"#b45309", fontSize:11 },
  paymentBadge: { padding:"2px 6px", borderRadius:999, background:"#dcfce7", color:"#166534", fontSize:9, fontWeight:800, whiteSpace:"nowrap" },
  adjustedPaymentBadge: { background:"#fef3c7", color:"#92400e" },
  expandIcon: {
    fontSize: 13,
    color: "#6b7280",
    width: 12,
    textAlign: "center",
    flexShrink: 0,
  },
  detail: {
    display: "grid",
    gap: 8,
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
  rowLabel: { minWidth: 0, color: "#475569", fontSize:12, lineHeight:1.35, overflowWrap:"anywhere" },
  rowAmount: { flexShrink: 0, textAlign: "right", whiteSpace: "nowrap", fontSize:12, fontVariantNumeric: "tabular-nums" },
  wrappingAmount: { minWidth: 0, flexShrink:1, whiteSpace: "normal", lineHeight: 1.35 },
  highlightRow: { marginTop: 2, padding: "5px 6px", borderRadius: 8, background: "#fff" },
  highlightAmount: { flexShrink: 0, textAlign: "right", whiteSpace: "nowrap", fontSize: 13, fontWeight: 900, fontVariantNumeric: "tabular-nums" },
  combinedSummary: { display: "grid", gap: 3 },
  monthlyEquivalent: { display: "grid", gap: 2, paddingTop: 5, borderTop: "1px solid #e2e8f0" },
  monthlyEquivalentLabel: { minWidth: 0, color: "#64748b", fontWeight: 700 },
  monthlyEquivalentAmount: { flexShrink: 0, color: "#334155", textAlign: "right", whiteSpace: "nowrap", fontSize: 12, fontWeight: 800, fontVariantNumeric: "tabular-nums" },
  monthlyEquivalentHelp: { color: "#94a3b8", fontSize: 10, lineHeight: 1.3 },
  subtotalRow: { marginTop: 4, background: "#fff", boxShadow: "inset 0 1px #e2e8f0" },
  subtotalAmount: { fontSize: 12 },
  netHighlightRow: { background: "#eff6ff", boxShadow: "inset 0 1px #bfdbfe" },
  netHighlightAmount: { color: "#1d4ed8", fontSize: 15 },
  mutedRow: { background: "#f8fafc", padding: "6px 8px", borderRadius: 7 },
  mutedLabel: { color: "#64748b" },
  mutedAmount: { color: "#475569", fontWeight: 800 },
  detailSection: { display: "grid", gap: 4, paddingTop: 8, borderTop: "1px solid #f1f5f9" },
  firstDetailSection: { paddingTop: 0, borderTop: 0 },
  sectionTitle: { margin: 0, display: "flex", alignItems: "center", gap: 5, fontSize: 12, lineHeight: 1.25, fontWeight: 900, color: "#475569", letterSpacing: ".01em" },
  sectionIcon: { width: 14, fontSize: 12, lineHeight: 1, textAlign: "center", opacity: .82 },
  sectionRows: { width: "100%", minWidth:0, boxSizing: "border-box", display: "grid", gap: 4 },
  taxDetails: { fontSize: 10.5, color: "#64748b" },
  taxDetailsSummary: { cursor: "pointer", fontWeight: 700 },
  taxDetailsRows: { display: "grid", gap: 5, marginTop: 6, padding: "7px 8px", borderRadius: 8, background: "#fff" },
  adjustmentButton: { width: "100%", minWidth: 0, minHeight: 34, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 9px", alignItems: "center", gap: 6, padding: "4px 0", fontSize:12, textAlign: "left", cursor: "pointer" },
  incentiveButton: { border:0, borderBottom:"1px solid #e5e7eb", background: "transparent", color: "#475569" },
  penaltyButton: { border:0, borderBottom:"1px solid #e5e7eb", background: "transparent", color: "#475569" },
  disabledButton: { opacity:.55, cursor:"not-allowed" },
  adjustmentCopy: { minWidth: 0, display: "flex", flexWrap:"wrap", alignItems:"baseline", gap: "1px 4px" },
  adjustmentHint: { fontSize: 10, fontWeight: 600, opacity: .72 },
  adjustmentValue: { fontWeight: 800, whiteSpace: "nowrap", textAlign: "right", fontVariantNumeric: "tabular-nums" },
  chevron: { fontSize: 15, lineHeight: 1, fontWeight: 900 },
  help: { color: "#64748b", lineHeight: 1.45 },
  totalTitle: { fontSize: 12, fontWeight: 800, color: "#334155" },
  totalRow: { display:"grid", gridTemplateColumns:"minmax(0,1fr) auto", alignItems:"baseline", gap:10, padding:"7px 0", borderBottom:"1px solid #e5e7eb", minWidth:0, fontSize:12, lineHeight:1.5 },
  totalLabel: { minWidth:0, textAlign:"left", color:"#475569", overflowWrap:"anywhere" },
  totalAmount: { textAlign:"right", whiteSpace:"nowrap", fontSize:12, fontWeight:700, fontVariantNumeric:"tabular-nums" },
  totalExcluded: { display: "block", marginTop:6, padding: "7px", borderRadius: 8, background: "#fffbeb", color: "#92400e", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" },
  total: {
    display: "grid",
    gap: 0,
    padding: "10px",
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
  paymentNotice: { margin: 0, padding: 10, borderRadius: 9, background: "#f0fdf4", color: "#166534", fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" },
  modalAction: { minWidth: 148, maxWidth: "100%" },
  paymentButton: { minHeight:42, border:0, borderRadius:10, background:"#111827", color:"#fff", fontWeight:800 },
  reviewProblemBadge: { display:"inline-flex", alignItems:"center", maxWidth:"100%", minHeight:24, padding:"2px 8px", border:"1px solid #fcd34d", borderRadius:999, background:"#fef3c7", color:"#92400e", fontSize:10.5, lineHeight:1.3, fontWeight:800, textDecoration:"none", cursor:"pointer", overflowWrap:"anywhere", textAlign:"left", boxSizing:"border-box" },
  reviewProblemBadgeStatic: { cursor:"default" },
  reviewMoreButton: { minHeight:24, padding:"2px 7px", border:"1px solid #e5e7eb", borderRadius:999, background:"#f3f4f6", color:"#4b5563", fontSize:10.5, fontWeight:800, cursor:"pointer" },
  reviewMoreList: { gridColumn:"1 / -1", display:"flex", flexWrap:"wrap", justifyContent:"flex-end", gap:4, minWidth:0 },
  // 접힘: 기존 배경·정렬 유지(투명 테두리로 펼칠 때 레이아웃 흔들림 방지). 펼침: 연회색 헤더 + 구분선 + 상세 여백으로 한 그룹.
  // 접힘·펼침에서 바뀌는 값은 개별 속성(borderColor, backgroundColor)만 쓴다 — 축약/개별 속성 혼용 시 React 경고.
  collapsibleGroup: { margin:"0 -6px", borderWidth:1, borderStyle:"solid", borderColor:"transparent", borderRadius:8, overflow:"hidden", minWidth:0 },
  collapsibleGroupOpen: { borderColor:"#e5e7eb" },
  collapsibleHeader: { width:"100%", display:"grid", gridTemplateColumns:"minmax(0,1fr) auto", alignItems:"center", gap:8, minHeight:34, padding:"2px 5px", border:0, backgroundColor:"transparent", textAlign:"left", cursor:"pointer", minWidth:0, boxSizing:"border-box" },
  collapsibleHeaderOpen: { backgroundColor:"#f3f4f6" },
  collapsibleBody: { borderTop:"1px solid #e5e7eb", padding:"8px 10px 10px" },
  collapsibleSummary: { display:"inline-flex", alignItems:"center", gap:6, minWidth:0 },
  collapsibleSummaryValue: { color:"#111827", fontSize:12.5, fontWeight:900, fontVariantNumeric:"tabular-nums", whiteSpace:"nowrap" },
  collapsibleChevron: { width:12, flex:"0 0 12px", display:"inline-flex", alignItems:"center", justifyContent:"center", color:"#64748b", fontSize:14, lineHeight:1, fontWeight:900 },
  reviewReasonActions: { display:"flex", flexWrap:"wrap", gap:6, marginTop:4 },
  reviewReasonAction: { display:"inline-flex", alignItems:"center", minHeight:30, padding:"4px 10px", border:"1px solid #fca5a5", borderRadius:8, background:"#fff", color:"#991b1b", fontSize:11.5, fontWeight:800, textDecoration:"none", cursor:"pointer" },
  extraWorkAnchor: { scrollMarginTop:72, minWidth:0 },
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
  automaticAdjustmentDetail: { whiteSpace: "pre-line", lineHeight: 1.45 },
  itemMeta: { minWidth: 0, color: "#64748b", fontSize: 10 },
} satisfies Record<string, CSSProperties>;
