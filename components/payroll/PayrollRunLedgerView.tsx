"use client";

// /admin/payroll/[runId] 급여장부 본문(읽기 전용). page.tsx가 조회한 기존 runs/[runId] 응답만 표시하며
// 금액을 재계산·보정하거나 지급 데이터·사유·감사 원본을 바꾸지 않는다. 모바일 우선, 필요할 때만 펼친다:
//   요약(전체 출금액 + 검산 한 줄 / 계산·비용 → 세부 계산) → 실제 지급일·계좌별 출금(잔차 사유는 펼침)
//   → 차콜 탭(지급내역 / 차액 검토 / 감사 이력) → 행 펼침(핵심) → 상세 보기 → 고급 감사자료 → 원본 JSON
import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { formatVnd } from "@/lib/payroll/payroll-page-money";
import { partLabel, payrollLabel } from "@/lib/payroll/ui-labels";
import { mealAllowanceBadgeLabel } from "@/components/payroll/CompensationCard";
import {
  buildDifferenceReview,
  countPaymentLedgerFilters,
  getPaymentApplicabilityBadges,
  matchesPaymentLedgerFilter,
  matchesPaymentLedgerQuery,
  PAYMENT_LEDGER_FILTERS,
  summarizePaymentSnapshot,
  type DifferenceReviewRow,
  type PaymentApplicabilityBadge,
  type PaymentLedgerFilter,
  type SnapshotSummaryItem,
} from "@/lib/payroll/payment-ledger-view";
import {
  buildPaymentOutflows,
  payrollAuditEmployeeName,
  payrollAuditLabel,
  type OutflowAllocation,
  type OutflowLine,
  type OutflowResidual,
  type PaymentOutflows,
  type PayrollAuditEntry,
} from "@/lib/payroll/payment-outflows";
import {
  digestDifferenceReasons,
  formatAppRecordedAt,
  formatExactRecordedAt,
  isMinorDifference,
  nextRunLedgerTab,
  oneLineDifferenceReason,
  RUN_LEDGER_TABS,
  runLedgerTitle,
  shortPaymentDate,
  sortByDifferenceMagnitude,
  summarizeRunOutflow,
  type RunLedgerTab,
} from "@/lib/payroll/run-ledger-view";

export type PayrollRun={id:number;payroll_month:string;status:"paying"|"completed";target_employee_count:number;paid_employee_count:number;calculated_net_total:number;actual_paid_total:number;difference_total:number;employee_insurance_total:number;employer_insurance_total:number;director_insurance_amount:number;insurance_remittance_total:number;actual_company_cost_total:number;employee_pit_total?:number|null;company_pit_total?:number|null;advance_total?:number|null;started_at:string;completed_at:string|null};
export type PayrollRunEmployee={id:number;user_id:number;employee_name:string;part_snapshot:string|null;position_snapshot:string|null;payment_status:"unpaid"|"paid";calculated_net_amount:number|null;actual_paid_amount:number|null;difference_amount:number|null;difference_reason:string|null;payment_date:string|null;fund_account_id:number|null;paid_at:string|null;calculation_snapshot:Record<string,unknown>|null;paid_actor?:{name:string|null;full_name:string|null;username:string|null}|null};
export type PayrollFundAccount={id:number;code:string;display_name:string};
export type PayrollRunLedger={runId:string;run:PayrollRun;employees:PayrollRunEmployee[];allocations:OutflowAllocation[];residuals:OutflowResidual[];fundAccounts:PayrollFundAccount[];audit:PayrollAuditEntry[];mealAllowanceEligibleUserIds:number[]};
type Lang="ko"|"vi";

// 앱 상단 헤더·하단 네비와 같은 차콜(#111827). 탭 배경과 활성 글씨에 재사용한다.
const CHARCOAL="#111827";

// 차액 표시: 저장된 difference_amount(실제 지급 − 계산 실수령) 부호를 그대로 보여준다.
function signedVnd(value:number){return value>0?`+${formatVnd(value)}`:formatVnd(value)}
// 출금계좌 이름: 매장 현금·법인계좌는 VI 번역, 나머지는 장부 계좌 표시명. 계좌 미기록(과거 데이터)은 그대로 표기한다.
function accountName(id:number|null,accounts:PayrollFundAccount[],vi:boolean){if(id===null)return vi?"Chưa ghi tài khoản":"계좌 미기록";const account=accounts.find(item=>Number(item.id)===Number(id));if(account?.code==="store_cash")return vi?"Tiền mặt cửa hàng":"매장 현금";if(account?.code==="baba_corporate_bank")return vi?"TK công ty BABA":"BABA 법인계좌";return account?.display_name??`#${id}`}
function actorName(actor:PayrollRunEmployee["paid_actor"]){return actor?.name||actor?.full_name||actor?.username||"—"}
const amount=(value:unknown)=>{const number=Number(value);return Number.isFinite(number)?number:0};

export default function PayrollRunLedgerView({ledger,lang}:{ledger:PayrollRunLedger;lang:Lang}){
  const vi=lang==="vi";const run=ledger.run;const employees=ledger.employees;
  const month=run.payroll_month.slice(0,7);
  const title=runLedgerTitle(month,lang);
  const[tab,setTab]=useState<RunLedgerTab>("payments");
  // 지급일·계좌별 출금: 저장된 지급 기록 + 활성 분할 지급 + 배치 잔차만으로 묶는다(재계산 없음).
  const outflows=useMemo(()=>buildPaymentOutflows({employees,allocations:ledger.allocations,residuals:ledger.residuals}),[employees,ledger.allocations,ledger.residuals]);
  const summary=summarizeRunOutflow(run.actual_paid_total,outflows);
  const differenceRows=useMemo(()=>buildDifferenceReview(employees),[employees]);
  const counts=useMemo(()=>countPaymentLedgerFilters(employees),[employees]);
  const tabCount:Record<RunLedgerTab,number>={payments:employees.length,differences:differenceRows.length,audit:ledger.audit.length};
  const tabLabel:Record<RunLedgerTab,string>=vi?{payments:"Chi trả",differences:"Chênh lệch",audit:"Kiểm toán"}:{payments:"지급내역",differences:"차액 검토",audit:"감사 이력"};
  const tabRefs=useRef<Partial<Record<RunLedgerTab,HTMLButtonElement|null>>>({});
  const baseId=useId();
  function onTabKey(event:KeyboardEvent<HTMLButtonElement>){const next=nextRunLedgerTab(tab,event.key);if(!next)return;event.preventDefault();setTab(next);tabRefs.current[next]?.focus()}
  const unpaidCount=counts.unpaid;
  return <>
    {/* 요약: 주요 숫자는 전체 출금액 하나, 검산은 한 줄. 계산·비용은 접힘(세부 계산은 한 번 더 접힘). */}
    <section style={styles.summaryCard} aria-label={title} data-testid="run-ledger-summary">
      <div style={styles.summaryHead}>
        <h1 style={styles.title}>{title}</h1>
        <span style={styles.statusLine} data-testid="run-ledger-status"><span style={run.status==="completed"?styles.completedBadge:styles.payingBadge}>{run.status==="completed"?(vi?"Hoàn tất":"완료"):(vi?"Đang chi trả":"지급 중")}</span><b>{run.paid_employee_count}/{run.target_employee_count}</b>{vi?" người":"명"}{unpaidCount>0?<span style={styles.unpaidCount}>{vi?` · chưa trả ${unpaidCount}`:` · 미지급 ${unpaidCount}명`}</span>:null}</span>
      </div>
      <div style={styles.mainMetric}>
        <span style={styles.mainMetricLabel}>{vi?"Tổng chi thực tế":"전체 출금액"}</span>
        <b style={styles.mainMetricValue} data-testid="run-ledger-outflow-total">{formatVnd(summary.outflowTotal)}</b>
      </div>
      <p style={styles.checkLine} data-testid="run-ledger-outflow-check">
        <span style={styles.nowrap}>{vi?"NV thực nhận":"직원 실지급"} {formatVnd(summary.employeePaidTotal)}</span>
        {summary.residualTotal!==0?<span style={styles.nowrap}>{summary.residualTotal>0?" + ":" − "}{vi?"làm tròn":"미배분 잔차"} {formatVnd(Math.abs(summary.residualTotal))}</span>:null}
      </p>
      {!summary.paidTotalMatches&&<p role="alert" style={styles.warning}>{vi?`Tổng thực trả theo nhân viên khác tổng đã lưu của lô (${formatVnd(summary.storedPaidTotal)}). Cần kiểm tra.`:`직원별 실지급 합계가 배치 저장 합계(${formatVnd(summary.storedPaidTotal)})와 다릅니다. 확인이 필요합니다.`}</p>}
      <CostDetails run={run} vi={vi} lang={lang}/>
    </section>
    {outflows.groups.length>0&&<OutflowCard outflows={outflows} accounts={ledger.fundAccounts} vi={vi}/>}
    {/* 실제 전환되는 탭(차콜 배경): 선택한 패널 하나만 렌더링한다. */}
    <div role="tablist" aria-label={vi?"Nội dung sổ lương":"급여장부 내용"} style={styles.tabs}>
      {RUN_LEDGER_TABS.map(value=>{const selected=tab===value;return <button key={value} ref={node=>{tabRefs.current[value]=node}} type="button" role="tab" id={`${baseId}-tab-${value}`} aria-selected={selected} aria-controls={`${baseId}-panel-${value}`} tabIndex={selected?0:-1} data-testid={`run-ledger-tab-${value}`} style={selected?{...styles.tab,...styles.tabActive}:styles.tab} onClick={()=>setTab(value)} onKeyDown={onTabKey}>
        <span style={styles.tabLabel}>{tabLabel[value]}</span><span style={selected?{...styles.tabCount,...styles.tabCountActive}:styles.tabCount}>{tabCount[value]}</span>
      </button>})}
    </div>
    <div role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`} style={styles.panel} data-testid={`run-ledger-panel-${tab}`}>
      {tab==="payments"&&<PaymentsPanel ledger={ledger} month={month} outflows={outflows} counts={counts} lang={lang}/>}
      {tab==="differences"&&<DifferencePanel rows={differenceRows} storedDifferenceTotal={Number(run.difference_total)} vi={vi}/>}
      {tab==="audit"&&<AuditPanel audit={ledger.audit} vi={vi} lang={lang}/>}
    </div>
  </>;
}

// 계산·비용 상세: 핵심(APP 계산 → 차액 → 직원 실지급, 회사 인건비)만 기본. 보험·세금·가불·기록 시각은 "세부 계산 보기".
// 회사 인건비는 출금액이 아니라 보험·세금을 포함한 인식 비용임을 함께 적는다. 0₫ 세부 항목은 생략(개수만 안내).
function CostDetails({run,vi,lang}:{run:PayrollRun;vi:boolean;lang:Lang}){
  const detail:[string,number|null|undefined][]=[
    [vi?"BH nhân viên khấu trừ":"직원 보험 공제",run.employee_insurance_total],
    [vi?"BH công ty":"회사 보험부담",run.employer_insurance_total],
    [vi?"BH giám đốc":"법인장 보험비",run.director_insurance_amount],
    [vi?"Nộp cơ quan BH":"보험기관 납부액",run.insurance_remittance_total],
    [vi?"TNCN nhân viên":"직원 TNCN",run.employee_pit_total],
    [vi?"TNCN công ty":"회사 TNCN",run.company_pit_total],
    [vi?"Ứng lương đã trừ":"가불 공제",run.advance_total],
  ];
  const shown=detail.filter(([,value])=>amount(value)!==0);const hidden=detail.length-shown.length;
  return <details style={styles.costDetails} data-testid="run-ledger-cost-details"><summary style={styles.summaryToggle}>{vi?"Chi tiết tính lương · chi phí":"계산·비용 상세"}</summary><div style={styles.costBody}>
    <Row label={vi?"APP tính (thực nhận)":"APP 계산 실수령"} value={formatVnd(run.calculated_net_total)}/>
    <Row label={vi?"Chênh lệch":"차액"} value={signedVnd(amount(run.difference_total))}/>
    <Row label={vi?"NV thực nhận (đã lưu)":"직원 실지급(저장값)"} value={formatVnd(run.actual_paid_total)}/>
    <div style={styles.costDivider}/>
    <Row label={vi?"Chi phí nhân công công ty":"회사 인건비"} value={formatVnd(run.actual_company_cost_total)} strong/>
    <small style={styles.meta}>{vi?"Chi phí ghi nhận gồm bảo hiểm · thuế, không phải số tiền đã chi.":"보험·세금을 포함한 인식 비용이며 출금액과 다릅니다."}</small>
    <details data-testid="run-ledger-cost-breakdown"><summary style={styles.summaryToggle}>{vi?"Xem chi tiết tính":"세부 계산 보기"}</summary><div style={styles.nestedBody}>
      {shown.map(([label,value])=><Row key={label} label={label} value={formatVnd(amount(value))}/>)}
      {hidden>0&&<small style={styles.meta}>{vi?`Ẩn ${hidden} mục 0 ₫`:`0₫ 항목 ${hidden}개 생략`}</small>}
      <Row label={vi?"APP ghi nhận bắt đầu":"APP 기록 시작"} value={formatAppRecordedAt(run.started_at,lang)}/>
      {run.completed_at&&<Row label={vi?"APP ghi nhận hoàn tất":"APP 기록 완료"} value={formatAppRecordedAt(run.completed_at,lang)}/>}
    </div></details>
  </div></details>;
}

// 실제 지급일·출금계좌별 출금: 날짜·계좌·금액만. 잔차는 해당 계좌 행에 작은 표시, 긴 사유는 별도 펼침에서만.
function OutflowCard({outflows,accounts,vi}:{outflows:PaymentOutflows;accounts:PayrollFundAccount[];vi:boolean}){
  return <section style={styles.card} aria-label={vi?"Chi theo ngày · tài khoản":"지급일·계좌별 출금"} data-testid="run-ledger-outflows">
    <h2 style={styles.cardTitle}>{vi?"Chi theo ngày · tài khoản":"실제 지급일·계좌별 출금"}</h2>
    <ul style={styles.plainList}>{outflows.groups.map(group=><li key={`${group.paymentDate}:${group.fundAccountId}`} style={styles.outflowItem} data-testid="run-ledger-outflow-group">
      <span style={styles.outflowDate} title={group.paymentDate??undefined}>{shortPaymentDate(group.paymentDate)}</span>
      <span style={styles.outflowAccount}>{accountName(group.fundAccountId,accounts,vi)}{group.residualAmount!==0?<small style={styles.residualChip}>{vi?"làm tròn ":"잔차 "}{signedVnd(group.residualAmount)}</small>:null}</span>
      <b style={styles.outflowAmount}>{formatVnd(group.amount)}</b>
    </li>)}</ul>
    {outflows.residuals.length>0&&<details style={styles.inlineDetails} data-testid="run-ledger-residual-details"><summary style={styles.summaryToggle}>{vi?"Chênh lệch làm tròn (không phân bổ cho nhân viên)":"반올림 잔차(직원 미배분)"} · {vi?"lý do":"사유"}</summary>
      <ul style={styles.plainList}>{outflows.residuals.map(residual=><li key={residual.id} style={styles.residualItem}>
        <small style={styles.meta}>{vi?"Không phân bổ cho nhân viên nào; đã gồm trong tổng chi và chi phí công ty.":"어느 직원에게도 배분하지 않은 출금입니다(전체 출금·회사 인건비에 포함)."}</small>
        <p style={styles.fullText}>{residual.reason}</p>
      </li>)}</ul>
    </details>}
  </section>;
}

function PaymentsPanel({ledger,month,outflows,counts,lang}:{ledger:PayrollRunLedger;month:string;outflows:PaymentOutflows;counts:Record<PaymentLedgerFilter,number>;lang:Lang}){
  const vi=lang==="vi";const employees=ledger.employees;
  const[query,setQuery]=useState("");const[filter,setFilter]=useState<PaymentLedgerFilter>("all");const[expandedId,setExpandedId]=useState<number|null>(null);
  const mealAllowanceEligibleSet=useMemo(()=>new Set(ledger.mealAllowanceEligibleUserIds),[ledger.mealAllowanceEligibleUserIds]);
  const mismatched=useMemo(()=>new Set(outflows.mismatchedPaymentIds),[outflows]);
  // 한 줄 사유: 같은 배치의 사유에서 공통 문구를 빼고 직원별 안내만 남긴다(원문은 상세 보기에서 그대로).
  const shortReasons=useMemo(()=>{const digest=digestDifferenceReasons(employees.map(employee=>employee.difference_reason));return new Map(employees.map((employee,index)=>[employee.id,oneLineDifferenceReason(employee.difference_reason,digest.notes[index],digest.commonLead)]))},[employees]);
  // 차액은 별도 탭에서 본다. 지급 상태 필터는 미지급 직원이 있을 때(지급 중 배치)만 보여준다.
  const filters:PaymentLedgerFilter[]=counts.unpaid>0?PAYMENT_LEDGER_FILTERS.filter(value=>value!=="difference"):[];
  const activeFilter=filters.includes(filter)?filter:"all";
  const filtered=employees.filter(employee=>matchesPaymentLedgerFilter(employee,activeFilter)&&matchesPaymentLedgerQuery(employee,query));
  const filterLabel=(value:PaymentLedgerFilter)=>value==="all"?(vi?"Tất cả":"전체"):value==="paid"?(vi?"Đã trả":"지급완료"):(vi?"Chưa trả":"미지급");
  return <>
    {employees.length>5&&<input style={styles.search} value={query} onChange={event=>{setQuery(event.target.value);setExpandedId(null)}} placeholder={vi?"Tìm tên nhân viên":"직원명 검색"} aria-label={vi?"Tìm tên nhân viên":"직원명 검색"}/>}
    {filters.length>0&&<div style={styles.filters} role="group" aria-label={vi?"Lọc trạng thái chi trả":"지급 상태 필터"}>{filters.map(value=><button key={value} type="button" aria-pressed={activeFilter===value} style={activeFilter===value?{...styles.filter,...styles.filterActive}:styles.filter} onClick={()=>{setFilter(value);setExpandedId(null)}}>{filterLabel(value)} <span style={styles.filterCount}>{counts[value]}</span></button>)}</div>}
    {employees.length===0?<p style={styles.stateBox}>{vi?"Chưa có bản ghi chi trả của nhân viên.":"직원 지급 기록이 없습니다."}</p>
      :filtered.length===0?<p style={styles.stateBox}>{vi?"Không có nhân viên phù hợp.":"조건에 맞는 직원이 없습니다."}</p>
      :<ul style={styles.rows}>{filtered.map(employee=><EmployeeRow key={employee.id} employee={employee} month={month} lines={outflows.linesByPayment.get(employee.id)??[]} shortReason={shortReasons.get(employee.id)??null} mismatched={mismatched.has(employee.id)} accounts={ledger.fundAccounts} mealAllowanceEligible={mealAllowanceEligibleSet.has(employee.user_id)} open={expandedId===employee.id} onToggle={()=>setExpandedId(current=>current===employee.id?null:employee.id)} lang={lang}/>)}</ul>}
  </>;
}

// 직원 행: 1줄 이름·실지급액(미지급이면 상태), 2줄 부서와 예외(차액·분할)만.
// 펼침(핵심): APP 계산/실지급/차액, 실제 지급일·출금계좌(분할이면 계좌별), 한 줄 차액 사유.
// 상세 보기(2차): 적용 대상·계산 요약·사유 원문·분할 메모·처리자·APP 기록 → 고급 감사자료(정확한 시각·원본 JSON).
function EmployeeRow({employee,month,lines,shortReason,mismatched,accounts,mealAllowanceEligible,open,onToggle,lang}:{employee:PayrollRunEmployee;month:string;lines:OutflowLine[];shortReason:string|null;mismatched:boolean;accounts:PayrollFundAccount[];mealAllowanceEligible:boolean;open:boolean;onToggle:()=>void;lang:Lang}){
  const vi=lang==="vi";const paid=employee.payment_status==="paid";const difference=Number(employee.difference_amount??0);const panelId=`payroll-ledger-employee-${employee.id}`;
  const meta=[employee.part_snapshot?partLabel(lang,employee.part_snapshot):null,employee.position_snapshot].filter(Boolean).join(" · ");
  const badges=getPaymentApplicabilityBadges({snapshot:employee.calculation_snapshot,month,mealAllowanceEligible,lang});
  const notes=lines.filter(line=>line.note);
  return <li style={styles.rowItem} data-testid="run-ledger-employee">
    <button type="button" style={styles.rowButton} aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
      <span style={styles.rowLine}><b style={styles.name}>{employee.employee_name}</b>{paid?<b style={styles.rowAmount}>{formatVnd(employee.actual_paid_amount??0)}</b>:<span style={styles.unpaid}>{vi?"Chưa trả":"미지급"}</span>}</span>
      <span style={styles.rowLine}><small style={styles.meta}>{meta||"—"}</small><span style={styles.rowFlags}>{paid&&difference!==0?<span style={isMinorDifference(difference)?{...styles.rowDifference,...styles.minorDifference}:styles.rowDifference}>{vi?"CL ":"차액 "}{signedVnd(difference)}</span>:null}{lines.length>1?<span style={styles.splitBadge}>{vi?`Chia ${lines.length}`:`분할 ${lines.length}`}</span>:null}{mismatched?<span style={styles.alertChip}>!</span>:null}<span aria-hidden="true" style={styles.chevron}>{open?"▴":"▾"}</span></span></span>
    </button>
    {open&&<div id={panelId} style={styles.detailBody}>{paid?<>
      <Row label={vi?"APP tính":"APP 계산액"} value={formatVnd(employee.calculated_net_amount??0)}/>
      <Row label={vi?"Thực trả":"실지급액"} value={formatVnd(employee.actual_paid_amount??0)} strong/>
      <Row label={vi?"Chênh lệch":"차액"} value={signedVnd(difference)}/>
      <div style={styles.block}><span style={styles.rowLabel}>{vi?"Ngày chi thực tế · tài khoản":"실제 지급일 · 출금계좌"}</span><ul style={styles.plainList}>{lines.map((line,index)=><li key={index} style={styles.payLine} data-testid="run-ledger-pay-line">
        <span style={styles.payLineMain}>{line.paymentDate??"—"} · {accountName(line.fundAccountId,accounts,vi)}{line.kind==="penalty_refund"?<small style={styles.refundChip}>{vi?"hoàn phạt":"패널티 반환"}</small>:null}</span><b style={styles.nowrap}>{formatVnd(line.amount)}</b>
      </li>)}</ul></div>
      {shortReason&&<p style={styles.reasonLine} title={employee.difference_reason??undefined}><span style={styles.rowLabel}>{vi?"Lý do: ":"사유: "}</span>{shortReason}</p>}
      {difference!==0&&!employee.difference_reason?.trim()&&<p style={styles.missingReason}>{vi?"Chưa ghi lý do":"사유 미기록"}</p>}
      {mismatched&&<p role="alert" style={styles.warning}>{vi?"Tổng các khoản chia khác số thực trả. Cần kiểm tra.":"분할 지급 합계가 실제 지급액과 다릅니다. 확인이 필요합니다."}</p>}
      <details data-testid="run-ledger-employee-more"><summary style={styles.summaryToggle}>{vi?"Xem chi tiết":"상세 보기"}</summary><div style={styles.nestedBody}>
        {badges.length>0&&<StatusBadges badges={badges} month={month} lang={lang}/>}
        {employee.calculation_snapshot&&<SnapshotSummary items={summarizePaymentSnapshot(employee.calculation_snapshot)} lang={lang}/>}
        {employee.difference_reason?.trim()&&<div style={styles.block}><span style={styles.rowLabel}>{vi?"Lý do chênh lệch (nguyên văn)":"차액 사유(원문)"}</span><p style={styles.fullText}>{employee.difference_reason}</p></div>}
        {notes.length>0&&<div style={styles.block}><span style={styles.rowLabel}>{vi?"Ghi chú khoản chi":"지급 메모"}</span>{notes.map((line,index)=><p key={index} style={styles.fullText}>{line.note}</p>)}</div>}
        <Row label={vi?"Người xử lý":"지급 처리자"} value={actorName(employee.paid_actor)}/>
        <Row label={vi?"APP ghi nhận":"APP 기록"} value={formatAppRecordedAt(employee.paid_at,lang)}/>
        <AdvancedAudit vi={vi} recordedAt={employee.paid_at} raw={employee.calculation_snapshot} rawLabel="calculation_snapshot"/>
      </div></details>
    </>:<p style={styles.muted}>{vi?"Chưa xử lý chi trả.":"아직 지급되지 않았습니다."}</p>}</div>}
  </li>;
}

// 고급 감사자료: 정확한 기록 시각(베트남 시간 + 원본 ISO)과 원본 JSON(한 번 더 접힘, 내부 스크롤). 값은 그대로 보여준다.
function AdvancedAudit({vi,recordedAt,raw,rawLabel}:{vi:boolean;recordedAt:string|null;raw:unknown;rawLabel:string}){
  return <details data-testid="run-ledger-advanced"><summary style={styles.summaryToggle}>{vi?"Dữ liệu kiểm toán nâng cao":"고급 감사자료"}</summary><div style={styles.nestedBody}>
    <div style={styles.block}><span style={styles.rowLabel}>{vi?"Thời điểm ghi nhận chính xác":"정확한 기록 시각"}</span><p style={styles.fullText}>{formatExactRecordedAt(recordedAt)}</p><small style={styles.meta}>{recordedAt??"—"}</small></div>
    {raw!==null&&raw!==undefined&&<details><summary style={styles.summaryToggle}>{vi?"Xem JSON gốc":"원본 JSON 보기"} <small style={styles.meta}>({rawLabel})</small></summary><pre style={styles.snapshot}>{JSON.stringify(raw,null,2)}</pre></details>}
  </div></details>;
}

// 지급 당시 적용 대상(💯·🍚·🛡️·TNCN): 판단은 지급 당시 스냅샷 기준(getPaymentApplicabilityBadges). 상세 보기에서만 설명과 함께 표시.
function StatusBadges({badges,month,lang}:{badges:PaymentApplicabilityBadge[];month:string;lang:Lang}){
  return <ul style={styles.badgeList} aria-label={lang==="vi"?"Đối tượng áp dụng khi chi trả":"지급 당시 적용 대상"}>{badges.map(badge=>{const label=badge.key==="meal"?`${month} · ${mealAllowanceBadgeLabel(lang)}`:badge.description;return <li key={badge.key} style={styles.badgeItem} title={label}><span aria-hidden="true" style={badge.key==="tax"?styles.taxBadge:undefined}>{badge.key==="attendance"?"💯":badge.key==="meal"?"🍚":badge.key==="insurance"?"🛡️":badge.label}</span><span>{label}</span></li>})}</ul>;
}

// 차액 검토: 절대값이 큰 차이부터. 소액(1,000₫ 미만) 반올림 차이는 중립색. 공통 사유는 탭 상단 한 번만,
// 직원별 원문 전문은 행을 펼치면 항상 그대로 보인다.
function DifferencePanel({rows,storedDifferenceTotal,vi}:{rows:DifferenceReviewRow<PayrollRunEmployee>[];storedDifferenceTotal:number;vi:boolean}){
  const[openId,setOpenId]=useState<number|null>(null);
  const sorted=useMemo(()=>sortByDifferenceMagnitude(rows),[rows]);
  const digest=useMemo(()=>digestDifferenceReasons(sorted.map(row=>row.reason)),[sorted]);
  if(rows.length===0)return <p style={styles.stateBox}>{vi?"Không có nhân viên có chênh lệch.":"차액이 발생한 직원이 없습니다."}</p>;
  return <>
    <div style={styles.panelHead}><span>{vi?`${rows.length} người · xếp theo mức chênh lệch`:`차액 발생 ${rows.length}명 · 큰 차이 순`}</span><span style={styles.nowrap}>{vi?"Tổng (đã lưu) ":"합계(저장값) "}<b>{signedVnd(storedDifferenceTotal)}</b></span></div>
    {digest.commonLead&&<p style={styles.commonLead} data-testid="run-ledger-common-reason"><b>{vi?"Lý do chung: ":"공통 사유: "}</b>{digest.commonLead}</p>}
    <ul style={styles.rows}>{sorted.map((row,index)=>{const open=openId===row.employee.id;const panelId=`payroll-ledger-difference-${row.employee.id}`;const note=digest.notes[index];const minor=isMinorDifference(row.differenceAmount);return <li key={row.employee.id} style={styles.rowItem} data-testid="run-ledger-difference">
      <button type="button" style={styles.rowButton} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpenId(current=>current===row.employee.id?null:row.employee.id)}>
        <span style={styles.rowLine}><b style={styles.name}>{row.employee.employee_name}</b><b style={minor?{...styles.differenceValue,...styles.minorValue}:styles.differenceValue} data-minor={minor?"true":"false"}>{signedVnd(row.differenceAmount)}</b></span>
        <span style={styles.rowLine}><small style={styles.meta}>{row.calculatedAmount===null?"—":formatVnd(row.calculatedAmount)} → {row.actualAmount===null?"—":formatVnd(row.actualAmount)}</small><span aria-hidden="true" style={styles.chevron}>{open?"▴":"▾"}</span></span>
        {row.reason===null?<small style={styles.missingReason}>{vi?"Chưa ghi lý do":"사유 미기록"}</small>:note?<small style={styles.noteClamp}>{note}</small>:null}
      </button>
      {open&&<div id={panelId} style={styles.detailBody}><span style={styles.rowLabel}>{vi?"Lý do chênh lệch (nguyên văn)":"차액 사유(원문)"}</span>{row.reason===null?<p style={styles.missingReason}>{vi?"Chưa ghi lý do":"사유 미기록"}</p>:<p style={styles.fullText}>{row.reason}</p>}</div>}
    </li>})}</ul>
  </>;
}

// 감사 이력: 저장된 급여 감사 로그를 응답 순서(최신순) 그대로. 시각은 베트남 시간 짧은 24시간 형식.
// 펼치면 사유 전문, 고급 감사자료(정확한 시각·원본 JSON before/after).
function AuditPanel({audit,vi,lang}:{audit:PayrollAuditEntry[];vi:boolean;lang:Lang}){
  const[openId,setOpenId]=useState<number|null>(null);
  if(audit.length===0)return <p style={styles.stateBox}>{vi?"Không có lịch sử kiểm toán.":"감사 이력이 없습니다."}</p>;
  return <ul style={styles.rows}>{audit.map(entry=>{const name=payrollAuditEmployeeName(entry);const open=openId===entry.id;const panelId=`payroll-ledger-audit-${entry.id}`;
    const head:ReactNode=<><span style={styles.rowLine}><b style={styles.name}>{payrollAuditLabel(entry.action,vi)}{name?` · ${name}`:""}</b><span aria-hidden="true" style={styles.chevron}>{open?"▴":"▾"}</span></span><small style={styles.meta}>{vi?"APP ghi nhận ":"APP 기록 "}{formatAppRecordedAt(entry.created_at,lang)}</small></>;
    const raw={action:entry.action,before_snapshot:entry.before_snapshot??null,after_snapshot:entry.after_snapshot??null};
    return <li key={entry.id} style={styles.rowItem} data-testid="run-ledger-audit">
      <button type="button" style={styles.rowButton} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpenId(current=>current===entry.id?null:entry.id)}>{head}</button>
      {open?<div id={panelId} style={styles.detailBody}>{entry.reason?<p style={styles.fullText}>{entry.reason}</p>:<p style={styles.muted}>{vi?"Không có lý do ghi kèm.":"기록된 사유가 없습니다."}</p>}<AdvancedAudit vi={vi} recordedAt={entry.created_at} raw={raw} rawLabel="payroll_payment_audit_logs"/></div>:null}
    </li>})}</ul>;
}

// 스냅샷 요약: 구조가 확인된 항목만 표시하고, 없으면 원본 JSON 확인을 안내한다(값을 추측하지 않음).
function SnapshotSummary({items,lang}:{items:SnapshotSummaryItem[];lang:Lang}){
  const vi=lang==="vi";
  if(items.length===0)return <p style={styles.muted}>{vi?"Không có mục tóm tắt được. Xem JSON gốc trong dữ liệu kiểm toán nâng cao.":"요약 가능한 항목이 없습니다. 고급 감사자료의 원본 JSON을 확인해주세요."}</p>;
  const label:Record<SnapshotSummaryItem["key"],[string,string]>={payType:["급여 형태","Loại lương"],combinedSalary:["합산급여","Tổng lương cố định"],recognizedWorkdays:["인정 근무일","Ngày công ghi nhận"],recognizedMinutes:["인정 근무시간","Thời gian công ghi nhận"],workAppliedAmount:["근무 반영액","Lương theo công"],incentiveAmount:["인센티브","Thưởng"],penaltyAmount:["패널티","Phạt"],preInsurancePayoutAmount:["보험 공제 전 지급대상액","Tổng trước khấu trừ BH"],employeeInsuranceDeductionAmount:["직원 보험 공제","Khấu trừ BH nhân viên"],employeePitDeductionAmount:["직원 TNCN 공제","Khấu trừ TNCN nhân viên"],advanceAmount:["가불","Ứng lương"],netPayoutAmount:["최종 실수령액","Thực nhận cuối cùng"]};
  const display=(item:SnapshotSummaryItem)=>item.key==="payType"?payrollLabel(lang,String(item.value)):item.key==="recognizedWorkdays"?`${item.value}${vi?" ngày":"일"}`:item.key==="recognizedMinutes"?`${item.value}${vi?" phút":"분"}`:formatVnd(Number(item.value));
  return <div style={styles.snapshotSummary}>{items.map(item=><Row key={item.key} label={label[item.key][vi?1:0]} value={display(item)}/>)}</div>;
}
function Row({label,value,strong=false}:{label:string;value:string;strong?:boolean}){return <div style={styles.row}><span style={styles.rowLabel}>{label}</span><b style={strong?styles.strong:styles.rowValue}>{value}</b></div>}

const styles={
  summaryCard:{display:"grid",gap:4,minWidth:0,padding:"10px 12px",border:"1px solid #dbeafe",borderRadius:12,background:"#f8fbff"},
  summaryHead:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,minWidth:0},
  title:{margin:0,minWidth:0,fontSize:15.5,lineHeight:1.3,fontWeight:900,color:CHARCOAL,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"},
  statusLine:{display:"inline-flex",alignItems:"center",gap:5,flexShrink:0,fontSize:12,color:"#475569",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  completedBadge:{padding:"1px 7px",borderRadius:999,background:"#dcfce7",color:"#166534",fontSize:10.5,fontWeight:800},
  payingBadge:{padding:"1px 7px",borderRadius:999,background:"#dbeafe",color:"#1d4ed8",fontSize:10.5,fontWeight:800},
  unpaidCount:{color:"#b45309",fontWeight:800},
  mainMetric:{display:"grid",gap:0,minWidth:0,paddingTop:2},
  mainMetricLabel:{fontSize:11.5,fontWeight:800,color:"#475569"},
  mainMetricValue:{fontSize:"clamp(20px, 6.4vw, 24px)",lineHeight:1.2,fontWeight:900,color:"#1d4ed8",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"},
  checkLine:{margin:0,fontSize:11.5,lineHeight:1.4,color:"#475569",fontVariantNumeric:"tabular-nums",overflowWrap:"anywhere"},
  nowrap:{whiteSpace:"nowrap"},
  costDetails:{display:"grid",minWidth:0,paddingTop:4,borderTop:"1px solid #e2e8f0"},
  costBody:{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:5,marginTop:6,padding:9,borderRadius:9,background:"#fff",border:"1px solid #e5e7eb",minWidth:0},
  costDivider:{height:1,background:"#e5e7eb",margin:"2px 0"},
  nestedBody:{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:6,marginTop:5,padding:"7px 8px",borderRadius:8,background:"#fff",border:"1px solid #eef2f7",minWidth:0},
  summaryToggle:{cursor:"pointer",minHeight:28,display:"list-item",fontSize:12,fontWeight:800,color:"#475569",overflowWrap:"anywhere"},
  card:{display:"grid",gap:2,minWidth:0,padding:"8px 12px",border:"1px solid #e5e7eb",borderRadius:12,background:"#fff"},
  cardTitle:{margin:0,fontSize:13,fontWeight:900,color:CHARCOAL},
  plainList:{listStyle:"none",margin:0,padding:0,display:"grid",minWidth:0},
  outflowItem:{display:"grid",gridTemplateColumns:"auto minmax(0,1fr) auto",alignItems:"baseline",gap:10,padding:"5px 0",borderBottom:"1px solid #f1f5f9",minWidth:0,fontSize:13},
  outflowDate:{fontWeight:800,color:"#334155",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"},
  outflowAccount:{minWidth:0,color:"#334155",overflowWrap:"anywhere"},
  outflowAmount:{fontSize:13.5,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  residualChip:{display:"inline-block",marginLeft:6,padding:"0 5px",borderRadius:999,background:"#f1f5f9",color:"#475569",fontSize:10,fontWeight:800,whiteSpace:"nowrap"},
  inlineDetails:{display:"grid",gap:4,minWidth:0,paddingTop:2},
  residualItem:{display:"grid",gap:3,padding:"6px 8px",marginTop:4,borderRadius:8,background:"#f8fafc",minWidth:0,fontSize:12},
  fullText:{margin:0,fontSize:12,lineHeight:1.5,color:"#1f2937",whiteSpace:"pre-wrap",overflowWrap:"anywhere"},
  tabs:{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:4,padding:4,borderRadius:12,background:CHARCOAL,minWidth:0},
  tab:{display:"flex",flexWrap:"wrap",justifyContent:"center",alignItems:"center",gap:"2px 6px",minHeight:40,minWidth:0,padding:"5px 4px",borderWidth:0,borderRadius:9,background:"transparent",color:"#e5e7eb",font:"inherit",fontSize:12.5,fontWeight:800,cursor:"pointer"},
  tabActive:{background:"#fff",color:CHARCOAL},
  tabLabel:{minWidth:0,textAlign:"center",overflowWrap:"anywhere"},
  tabCount:{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:22,height:18,boxSizing:"border-box",padding:"0 6px",borderRadius:999,background:"rgba(255,255,255,.18)",color:"#fff",fontSize:10.5,lineHeight:1,fontVariantNumeric:"tabular-nums"},
  tabCountActive:{background:CHARCOAL,color:"#fff"},
  panel:{display:"grid",gap:8,minWidth:0},
  panelHead:{display:"flex",flexWrap:"wrap",justifyContent:"space-between",gap:"2px 10px",fontSize:12,color:"#475569",minWidth:0},
  commonLead:{margin:0,padding:"7px 9px",borderRadius:9,background:"#f8fafc",border:"1px solid #e2e8f0",color:"#334155",fontSize:11.5,lineHeight:1.45,overflowWrap:"anywhere"},
  search:{width:"100%",minHeight:38,boxSizing:"border-box",padding:"7px 10px",border:"1px solid #d1d5db",borderRadius:10,fontSize:14},
  filters:{display:"flex",flexWrap:"wrap",gap:4,minWidth:0},
  // 기본·선택 스타일 모두 border longhand만 사용(shorthand와 borderColor 혼용 시 React 스타일 경고 발생).
  filter:{minHeight:32,padding:"4px 10px",borderWidth:1,borderStyle:"solid",borderColor:"#d1d5db",borderRadius:999,background:"#fff",color:"#374151",fontSize:11.5,fontWeight:800,whiteSpace:"nowrap"},
  filterActive:{background:"#111827",borderColor:"#111827",color:"#fff"},
  filterCount:{marginLeft:2,opacity:.75},
  rows:{listStyle:"none",margin:0,padding:0,display:"grid",minWidth:0,border:"1px solid #e5e7eb",borderRadius:12,background:"#fff",overflow:"hidden"},
  rowItem:{borderTop:"1px solid #f1f5f9",minWidth:0},
  rowButton:{display:"grid",gap:2,width:"100%",minHeight:52,boxSizing:"border-box",padding:"8px 10px",border:0,background:"transparent",color:"inherit",textAlign:"left",cursor:"pointer",font:"inherit"},
  rowLine:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,minWidth:0},
  name:{minWidth:0,fontSize:13.5,lineHeight:1.3,overflowWrap:"anywhere"},
  rowAmount:{fontSize:13.5,lineHeight:1.3,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",color:"#111827"},
  rowFlags:{display:"inline-flex",flexWrap:"wrap",justifyContent:"flex-end",alignItems:"center",gap:4,flexShrink:0},
  rowDifference:{padding:"0 5px",borderRadius:999,background:"#fef3c7",fontSize:10.5,fontWeight:800,color:"#92400e",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  minorDifference:{background:"#f1f5f9",color:"#64748b",fontWeight:700},
  splitBadge:{padding:"0 6px",borderRadius:999,background:"#ede9fe",color:"#5b21b6",fontSize:10.5,fontWeight:800,whiteSpace:"nowrap"},
  alertChip:{padding:"0 6px",borderRadius:999,background:"#fee2e2",color:"#b91c1c",fontSize:10.5,fontWeight:900},
  refundChip:{display:"inline-block",marginLeft:6,padding:"0 5px",borderRadius:999,background:"#ecfdf5",color:"#047857",fontSize:10,fontWeight:800,whiteSpace:"nowrap"},
  chevron:{color:"#94a3b8",fontSize:11},
  meta:{minWidth:0,color:"#64748b",fontSize:11,lineHeight:1.35,overflowWrap:"anywhere"},
  unpaid:{padding:"1px 7px",borderRadius:999,background:"#fef3c7",color:"#92400e",fontSize:10.5,fontWeight:800,whiteSpace:"nowrap"},
  detailBody:{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:6,padding:"8px 10px 10px",background:"#f8fafc",borderTop:"1px dashed #e5e7eb",minWidth:0},
  block:{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:3,minWidth:0},
  payLine:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,padding:"2px 0",fontSize:12,minWidth:0},
  payLineMain:{minWidth:0,overflowWrap:"anywhere"},
  reasonLine:{margin:0,fontSize:11.5,lineHeight:1.4,color:"#334155",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",minWidth:0},
  badgeList:{listStyle:"none",margin:0,padding:0,display:"flex",flexWrap:"wrap",gap:4,minWidth:0},
  badgeItem:{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 7px",borderRadius:999,background:"#fff",border:"1px solid #e2e8f0",fontSize:11,color:"#334155",overflowWrap:"anywhere"},
  taxBadge:{fontSize:9.5,fontWeight:900},
  differenceValue:{fontSize:13,color:"#b45309",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  minorValue:{color:"#475569",fontWeight:700},
  noteClamp:{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",color:"#64748b",fontSize:11,lineHeight:1.35,overflowWrap:"anywhere"},
  missingReason:{margin:0,color:"#9a3412",fontSize:11,fontWeight:700},
  row:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:12,minWidth:0,fontSize:12},
  rowLabel:{minWidth:0,color:"#475569",fontSize:12},
  // 금액·일시 값은 한 줄 유지(라벨이 대신 줄바꿈).
  rowValue:{flexShrink:0,textAlign:"right",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  strong:{flexShrink:0,textAlign:"right",fontSize:13.5,color:"#1d4ed8",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"},
  warning:{margin:0,padding:"6px 8px",borderRadius:8,background:"#fff7ed",color:"#9a3412",fontSize:11.5,fontWeight:700,overflowWrap:"anywhere"},
  muted:{margin:0,color:"#64748b",fontSize:12},
  stateBox:{margin:0,padding:16,border:"1px solid #e5e7eb",borderRadius:12,background:"#fff",textAlign:"center",color:"#6b7280",fontSize:13},
  snapshotSummary:{display:"grid",gap:5,padding:8,borderRadius:8,background:"#f8fafc",border:"1px solid #e5e7eb"},
  // 원본 JSON: 최대 280px 내부 스크롤, 긴 문자열이 페이지 너비를 늘리지 않도록 상자 안에서만 가로 스크롤.
  snapshot:{boxSizing:"border-box",width:"100%",maxWidth:"100%",maxHeight:280,overflow:"auto",margin:"6px 0 0",padding:8,borderRadius:8,background:"#0f172a",color:"#e2e8f0",fontSize:10,lineHeight:1.45,whiteSpace:"pre"},
} satisfies Record<string,CSSProperties>;
