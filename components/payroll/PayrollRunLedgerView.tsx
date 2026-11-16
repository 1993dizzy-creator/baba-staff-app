"use client";

// /admin/payroll/[runId] 급여장부 본문(읽기 전용). page.tsx가 조회한 기존 runs/[runId] 응답만 표시하며
// 금액을 재계산·보정하거나 지급 데이터를 바꾸지 않는다. 모바일 우선 구성:
//   요약(전체 출금액 + 검산 한 줄, 계산·비용은 접힘) → 지급일·계좌별 출금 → 탭(지급내역 / 차액 검토 / 감사 이력)
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
  nextRunLedgerTab,
  RUN_LEDGER_TABS,
  shortPaymentDate,
  summarizeRunOutflow,
  type RunLedgerTab,
} from "@/lib/payroll/run-ledger-view";

export type PayrollRun={id:number;payroll_month:string;status:"paying"|"completed";target_employee_count:number;paid_employee_count:number;calculated_net_total:number;actual_paid_total:number;difference_total:number;employee_insurance_total:number;employer_insurance_total:number;director_insurance_amount:number;insurance_remittance_total:number;actual_company_cost_total:number;started_at:string;completed_at:string|null};
export type PayrollRunEmployee={id:number;user_id:number;employee_name:string;part_snapshot:string|null;position_snapshot:string|null;payment_status:"unpaid"|"paid";calculated_net_amount:number|null;actual_paid_amount:number|null;difference_amount:number|null;difference_reason:string|null;payment_date:string|null;fund_account_id:number|null;paid_at:string|null;calculation_snapshot:Record<string,unknown>|null;paid_actor?:{name:string|null;full_name:string|null;username:string|null}|null};
export type PayrollFundAccount={id:number;code:string;display_name:string};
export type PayrollRunLedger={runId:string;run:PayrollRun;employees:PayrollRunEmployee[];allocations:OutflowAllocation[];residuals:OutflowResidual[];fundAccounts:PayrollFundAccount[];audit:PayrollAuditEntry[];mealAllowanceEligibleUserIds:number[]};
type Lang="ko"|"vi";

// 차액 표시: 저장된 difference_amount(실제 지급 − 계산 실수령) 부호를 그대로 보여준다.
function signedVnd(value:number){return value>0?`+${formatVnd(value)}`:formatVnd(value)}
function dateTime(value:string|null,vi:boolean){return value?new Date(value).toLocaleString(vi?"vi-VN":"ko-KR"):"—"}
// 출금계좌 이름: 매장 현금·법인계좌는 VI 번역, 나머지는 장부 계좌 표시명. 계좌 미기록(과거 데이터)은 그대로 표기한다.
function accountName(id:number|null,accounts:PayrollFundAccount[],vi:boolean){if(id===null)return vi?"Chưa ghi tài khoản":"계좌 미기록";const account=accounts.find(item=>Number(item.id)===Number(id));if(account?.code==="store_cash")return vi?"Tiền mặt cửa hàng":"매장 현금";if(account?.code==="baba_corporate_bank")return vi?"TK công ty BABA":"BABA 법인계좌";return account?.display_name??`#${id}`}
function actorName(actor:PayrollRunEmployee["paid_actor"]){return actor?.name||actor?.full_name||actor?.username||"—"}

export default function PayrollRunLedgerView({ledger,lang}:{ledger:PayrollRunLedger;lang:Lang}){
  const vi=lang==="vi";const run=ledger.run;const employees=ledger.employees;
  const month=run.payroll_month.slice(0,7);
  const title=vi?`Sổ lương ${month.slice(5)}/${month.slice(0,4)}`:`${month.slice(0,4)}년 ${Number(month.slice(5))}월 급여장부`;
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
    {/* 요약: 주요 숫자는 전체 출금액 하나. 검산은 한 줄, APP 계산·차액·회사 인건비는 접힘 상세. */}
    <section style={styles.summaryCard} aria-label={title} data-testid="run-ledger-summary">
      <div style={styles.summaryHead}>
        <h1 style={styles.title}>{title}</h1>
        <span style={run.status==="completed"?styles.completedBadge:styles.payingBadge}>{run.status==="completed"?(vi?"Hoàn tất":"완료"):(vi?"Đang chi trả":"지급 중")}</span>
        <span style={styles.headCount}>{vi?"Đã trả ":"지급완료 "}<b>{run.paid_employee_count}/{run.target_employee_count}</b>{vi?" người":"명"}{unpaidCount>0?<span style={styles.unpaidCount}>{vi?` · chưa trả ${unpaidCount}`:` · 미지급 ${unpaidCount}명`}</span>:null}</span>
      </div>
      <div style={styles.mainMetric}>
        <span style={styles.mainMetricLabel}>{vi?"Tổng chi thực tế":"전체 출금액"}</span>
        <b style={styles.mainMetricValue} data-testid="run-ledger-outflow-total">{formatVnd(summary.outflowTotal)}</b>
      </div>
      <p style={styles.checkLine} data-testid="run-ledger-outflow-check">
        <span style={styles.nowrap}>{vi?"Thực trả nhân viên":"직원 실지급"} {formatVnd(summary.employeePaidTotal)}</span>
        {summary.residualTotal!==0?<><span aria-hidden="true">{summary.residualTotal>0?" + ":" − "}</span><span style={styles.nowrap}>{vi?"chênh lệch làm tròn chưa phân bổ":"미배분 잔차"} {formatVnd(Math.abs(summary.residualTotal))}</span></>:<span style={styles.mutedInline}>{vi?" · không có chênh lệch làm tròn":" · 잔차 없음"}</span>}
      </p>
      {!summary.paidTotalMatches&&<p role="alert" style={styles.warning}>{vi?`Tổng thực trả theo nhân viên khác tổng đã lưu của lô (${formatVnd(summary.storedPaidTotal)}). Cần kiểm tra.`:`직원별 실지급 합계가 배치 저장 합계(${formatVnd(summary.storedPaidTotal)})와 다릅니다. 확인이 필요합니다.`}</p>}
      <details style={styles.costDetails} data-testid="run-ledger-cost-details"><summary style={styles.summaryToggle}>{vi?"Chi tiết tính lương · chi phí":"계산·비용 상세"}</summary><div style={styles.costBody}>
        <Row label={vi?"Tổng lương APP tính":"APP 계산 실수령 합계"} value={formatVnd(run.calculated_net_total)}/>
        <Row label={vi?"Tổng chênh lệch":"차액 합계"} value={signedVnd(Number(run.difference_total))}/>
        <Row label={vi?"Tổng thực trả (đã lưu)":"직원 실지급 합계(저장값)"} value={formatVnd(run.actual_paid_total)}/>
        <Row label={vi?"Bảo hiểm công ty":"회사 보험부담"} value={formatVnd(run.employer_insurance_total)}/>
        <Row label={vi?"Bảo hiểm giám đốc":"법인장 보험비"} value={formatVnd(run.director_insurance_amount)}/>
        <Row label={vi?"Nộp cơ quan bảo hiểm":"보험기관 납부액"} value={formatVnd(run.insurance_remittance_total)}/>
        <Row label={vi?"Chi phí nhân công công ty":"회사 인건비(실제 총인건비)"} value={formatVnd(run.actual_company_cost_total)} strong/>
        <Row label={vi?"Bắt đầu":"시작일"} value={dateTime(run.started_at,vi)}/>
        {run.completed_at&&<Row label={vi?"Hoàn tất":"완료일"} value={dateTime(run.completed_at,vi)}/>}
      </div></details>
    </section>
    {outflows.groups.length>0&&<OutflowCard outflows={outflows} accounts={ledger.fundAccounts} vi={vi}/>}
    {/* 실제 전환되는 탭: 선택한 패널 하나만 렌더링한다. */}
    <div role="tablist" aria-label={vi?"Nội dung sổ lương":"급여장부 내용"} style={styles.tabs}>
      {RUN_LEDGER_TABS.map(value=>{const selected=tab===value;return <button key={value} ref={node=>{tabRefs.current[value]=node}} type="button" role="tab" id={`${baseId}-tab-${value}`} aria-selected={selected} aria-controls={`${baseId}-panel-${value}`} tabIndex={selected?0:-1} data-testid={`run-ledger-tab-${value}`} style={selected?{...styles.tab,...styles.tabActive}:styles.tab} onClick={()=>setTab(value)} onKeyDown={onTabKey}>
        <span style={styles.tabLabel}>{tabLabel[value]}</span><span style={selected?{...styles.tabCount,...styles.tabCountActive}:styles.tabCount}>{tabCount[value]}</span>
      </button>})}
    </div>
    <div role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`} style={styles.panel} data-testid={`run-ledger-panel-${tab}`}>
      {tab==="payments"&&<PaymentsPanel ledger={ledger} month={month} outflows={outflows} counts={counts} lang={lang}/>}
      {tab==="differences"&&<DifferencePanel rows={differenceRows} storedDifferenceTotal={Number(run.difference_total)} vi={vi}/>}
      {tab==="audit"&&<AuditPanel audit={ledger.audit} vi={vi}/>}
    </div>
  </>;
}

// 지급일·출금계좌별 출금: 날짜·계좌·금액만 기본 표시. 반올림 잔차의 사유(긴 문구)는 접힘 상세에서만 보여준다.
function OutflowCard({outflows,accounts,vi}:{outflows:PaymentOutflows;accounts:PayrollFundAccount[];vi:boolean}){
  return <section style={styles.card} aria-label={vi?"Chi theo ngày · tài khoản":"지급일·계좌별 출금"} data-testid="run-ledger-outflows">
    <h2 style={styles.cardTitle}>{vi?"Chi theo ngày · tài khoản":"지급일·계좌별 출금"}</h2>
    <ul style={styles.plainList}>{outflows.groups.map(group=><li key={`${group.paymentDate}:${group.fundAccountId}`} style={styles.outflowItem} data-testid="run-ledger-outflow-group">
      <span style={styles.outflowDate} title={group.paymentDate??undefined}>{shortPaymentDate(group.paymentDate)}</span>
      <span style={styles.outflowAccount}>{accountName(group.fundAccountId,accounts,vi)}{group.residualAmount!==0?<small style={styles.residualChip}>{vi?"làm tròn ":"잔차 "}{signedVnd(group.residualAmount)}</small>:null}</span>
      <b style={styles.outflowAmount}>{formatVnd(group.amount)}</b>
    </li>)}</ul>
    {outflows.residuals.length>0&&<details style={styles.inlineDetails} data-testid="run-ledger-residual-details"><summary style={styles.summaryToggle}>{vi?"Chênh lệch làm tròn (không phân bổ cho nhân viên)":"반올림 잔차(직원 미배분)"} {signedVnd(outflows.residualTotal)}</summary>
      <ul style={styles.plainList}>{outflows.residuals.map(residual=><li key={residual.id} style={styles.residualItem}>
        <div style={styles.lineTop}><b>{residual.payment_date} · {accountName(residual.fund_account_id,accounts,vi)}</b><b style={styles.nowrap}>{signedVnd(Number(residual.amount))}</b></div>
        <small style={styles.meta}>{vi?"Khoản chi không phân bổ cho nhân viên nào (đã gồm trong tổng chi và chi phí công ty).":"어느 직원에게도 배분하지 않은 출금입니다(전체 출금·회사 인건비에 포함)."}</small>
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
      :<ul style={styles.rows}>{filtered.map(employee=><EmployeeRow key={employee.id} employee={employee} month={month} lines={outflows.linesByPayment.get(employee.id)??[]} mismatched={mismatched.has(employee.id)} accounts={ledger.fundAccounts} mealAllowanceEligible={mealAllowanceEligibleSet.has(employee.user_id)} open={expandedId===employee.id} onToggle={()=>setExpandedId(current=>current===employee.id?null:employee.id)} lang={lang}/>)}</ul>}
  </>;
}

// 직원 행(2줄): 1줄 이름·실지급액(미지급이면 상태), 2줄 부서·직책과 예외 표시(차액·분할)만. 상태 아이콘·상세는 펼침에서.
function EmployeeRow({employee,month,lines,mismatched,accounts,mealAllowanceEligible,open,onToggle,lang}:{employee:PayrollRunEmployee;month:string;lines:OutflowLine[];mismatched:boolean;accounts:PayrollFundAccount[];mealAllowanceEligible:boolean;open:boolean;onToggle:()=>void;lang:Lang}){
  const vi=lang==="vi";const paid=employee.payment_status==="paid";const difference=Number(employee.difference_amount??0);const panelId=`payroll-ledger-employee-${employee.id}`;
  const meta=[employee.part_snapshot?partLabel(lang,employee.part_snapshot):null,employee.position_snapshot].filter(Boolean).join(" · ");
  const badges=getPaymentApplicabilityBadges({snapshot:employee.calculation_snapshot,month,mealAllowanceEligible,lang});
  return <li style={styles.rowItem} data-testid="run-ledger-employee">
    <button type="button" style={styles.rowButton} aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
      <span style={styles.rowLine}><b style={styles.name}>{employee.employee_name}</b>{paid?<b style={styles.rowAmount}>{formatVnd(employee.actual_paid_amount??0)}</b>:<span style={styles.unpaid}>{vi?"Chưa trả":"미지급"}</span>}</span>
      <span style={styles.rowLine}><small style={styles.meta}>{meta||"—"}</small><span style={styles.rowFlags}>{paid&&difference!==0?<span style={styles.rowDifference}>{vi?"CL ":"차액 "}{signedVnd(difference)}</span>:null}{lines.length>1?<span style={styles.splitBadge}>{vi?`Chia ${lines.length}`:`분할 ${lines.length}`}</span>:null}{mismatched?<span style={styles.alertChip}>!</span>:null}<span aria-hidden="true" style={styles.chevron}>{open?"▴":"▾"}</span></span></span>
    </button>
    {open&&<div id={panelId} style={styles.detailBody}>{paid?<>
      {badges.length>0&&<StatusBadges badges={badges} month={month} lang={lang}/>}
      <Row label={vi?"Lương APP tính":"계산 실수령액"} value={formatVnd(employee.calculated_net_amount??0)}/>
      <Row label={vi?"Thực trả":"실제 지급액"} value={formatVnd(employee.actual_paid_amount??0)} strong/>
      <Row label={vi?"Chênh lệch":"차액"} value={formatVnd(employee.difference_amount??0)}/>
      {(difference!==0||employee.difference_reason?.trim())&&<div style={styles.block}><span style={styles.rowLabel}>{vi?"Lý do chênh lệch (nguyên văn)":"차액 사유(원문)"}</span>{employee.difference_reason?.trim()?<p style={styles.fullText}>{employee.difference_reason}</p>:<p style={styles.missingReason}>{vi?"Chưa ghi lý do":"사유 미기록"}</p>}</div>}
      <div style={styles.block}><span style={styles.rowLabel}>{vi?"Ngày trả · tài khoản":"지급일 · 출금계좌"}</span><ul style={styles.plainList}>{lines.map((line,index)=><li key={index} style={styles.payLine}>
        <div style={styles.lineTop}><span>{line.paymentDate??"—"} · {accountName(line.fundAccountId,accounts,vi)}{line.kind==="penalty_refund"?<small style={styles.refundChip}>{vi?"hoàn phạt":"패널티 반환"}</small>:null}</span><b style={styles.nowrap}>{formatVnd(line.amount)}</b></div>
        {line.note?<small style={styles.meta}>{line.note}</small>:null}
      </li>)}</ul></div>
      {mismatched&&<p role="alert" style={styles.warning}>{vi?"Tổng các khoản chia khác số thực trả. Cần kiểm tra.":"분할 지급 합계가 실제 지급액과 다릅니다. 확인이 필요합니다."}</p>}
      <Row label={vi?"Người xử lý":"지급 처리자"} value={actorName(employee.paid_actor)}/>
      <Row label={vi?"Thời gian xử lý":"지급 시각"} value={dateTime(employee.paid_at,vi)}/>
      {employee.calculation_snapshot&&<details><summary style={styles.summaryToggle}>{vi?"Xem dữ liệu tính lương đã cố định":"지급 당시 계산 snapshot 보기"}</summary><SnapshotSummary items={summarizePaymentSnapshot(employee.calculation_snapshot)} lang={lang}/><details><summary style={styles.summaryToggle}>{vi?"Dữ liệu gốc (JSON)":"원본 JSON"}</summary><pre style={styles.snapshot}>{JSON.stringify(employee.calculation_snapshot,null,2)}</pre></details></details>}
    </>:<p style={styles.muted}>{vi?"Chưa xử lý chi trả.":"아직 지급되지 않았습니다."}</p>}</div>}
  </li>;
}

// 지급 당시 적용 대상(💯·🍚·🛡️·TNCN): 판단은 지급 당시 스냅샷 기준(getPaymentApplicabilityBadges). 상세에서만 설명과 함께 표시.
function StatusBadges({badges,month,lang}:{badges:PaymentApplicabilityBadge[];month:string;lang:Lang}){
  return <ul style={styles.badgeList} aria-label={lang==="vi"?"Đối tượng áp dụng khi chi trả":"지급 당시 적용 대상"}>{badges.map(badge=>{const label=badge.key==="meal"?`${month} · ${mealAllowanceBadgeLabel(lang)}`:badge.description;return <li key={badge.key} style={styles.badgeItem} title={label}><span aria-hidden="true" style={badge.key==="tax"?styles.taxBadge:undefined}>{badge.key==="attendance"?"💯":badge.key==="meal"?"🍚":badge.key==="insurance"?"🛡️":badge.label}</span><span>{label}</span></li>})}</ul>;
}

// 차액 검토: 목록은 직원명·차액·APP→실지급 숫자와 짧은 안내만. 공통 사유는 한 번만, 원문 전문은 행을 펼치면 항상 보인다.
function DifferencePanel({rows,storedDifferenceTotal,vi}:{rows:DifferenceReviewRow<PayrollRunEmployee>[];storedDifferenceTotal:number;vi:boolean}){
  const[openId,setOpenId]=useState<number|null>(null);
  const digest=useMemo(()=>digestDifferenceReasons(rows.map(row=>row.reason)),[rows]);
  if(rows.length===0)return <p style={styles.stateBox}>{vi?"Không có nhân viên có chênh lệch.":"차액이 발생한 직원이 없습니다."}</p>;
  return <>
    <div style={styles.panelHead}><span>{vi?`${rows.length} người có chênh lệch`:`차액 발생 ${rows.length}명`}</span><span style={styles.nowrap}>{vi?"Tổng (đã lưu) ":"합계(저장값) "}<b>{signedVnd(storedDifferenceTotal)}</b></span></div>
    {digest.commonLead&&<p style={styles.commonLead} data-testid="run-ledger-common-reason"><b>{vi?"Lý do chung: ":"공통 사유: "}</b>{digest.commonLead}</p>}
    <ul style={styles.rows}>{rows.map((row,index)=>{const open=openId===row.employee.id;const panelId=`payroll-ledger-difference-${row.employee.id}`;const note=digest.notes[index];return <li key={row.employee.id} style={styles.rowItem} data-testid="run-ledger-difference">
      <button type="button" style={styles.rowButton} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpenId(current=>current===row.employee.id?null:row.employee.id)}>
        <span style={styles.rowLine}><b style={styles.name}>{row.employee.employee_name}</b><b style={styles.differenceValue}>{signedVnd(row.differenceAmount)}</b></span>
        <span style={styles.rowLine}><small style={styles.meta}>{row.calculatedAmount===null?"—":formatVnd(row.calculatedAmount)} → {row.actualAmount===null?"—":formatVnd(row.actualAmount)}</small><span aria-hidden="true" style={styles.chevron}>{open?"▴":"▾"}</span></span>
        {row.reason===null?<small style={styles.missingReason}>{vi?"Chưa ghi lý do":"사유 미기록"}</small>:note?<small style={styles.noteClamp}>{note}</small>:null}
      </button>
      {open&&<div id={panelId} style={styles.detailBody}><span style={styles.rowLabel}>{vi?"Lý do chênh lệch (nguyên văn)":"차액 사유(원문)"}</span>{row.reason===null?<p style={styles.missingReason}>{vi?"Chưa ghi lý do":"사유 미기록"}</p>:<p style={styles.fullText}>{row.reason}</p>}</div>}
    </li>})}</ul>
  </>;
}

// 감사 이력: 저장된 급여 감사 로그를 응답 순서(최신순) 그대로. 사유가 있는 항목만 펼쳐서 전문을 본다.
function AuditPanel({audit,vi}:{audit:PayrollAuditEntry[];vi:boolean}){
  const[openId,setOpenId]=useState<number|null>(null);
  if(audit.length===0)return <p style={styles.stateBox}>{vi?"Không có lịch sử kiểm toán.":"감사 이력이 없습니다."}</p>;
  // 사유 없는 항목은 펼침 표시 없이 같은 2줄 구성(항목·직원 / 시각)으로 보여준다.
  return <ul style={styles.rows}>{audit.map(entry=>{const name=payrollAuditEmployeeName(entry);const open=openId===entry.id;const panelId=`payroll-ledger-audit-${entry.id}`;
    const head:ReactNode=<><span style={styles.rowLine}><b style={styles.name}>{payrollAuditLabel(entry.action,vi)}{name?` · ${name}`:""}</b>{entry.reason?<span aria-hidden="true" style={styles.chevron}>{open?"▴":"▾"}</span>:null}</span><small style={styles.meta}>{dateTime(entry.created_at,vi)}</small></>;
    return <li key={entry.id} style={styles.rowItem} data-testid="run-ledger-audit">
      {entry.reason?<button type="button" style={styles.rowButton} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpenId(current=>current===entry.id?null:entry.id)}>{head}</button>:<div style={styles.auditPlain}>{head}</div>}
      {open&&entry.reason?<div id={panelId} style={styles.detailBody}><p style={styles.fullText}>{entry.reason}</p></div>:null}
    </li>})}</ul>;
}

// 스냅샷 요약: 구조가 확인된 항목만 표시하고, 없으면 원본 JSON 확인을 안내한다(값을 추측하지 않음).
function SnapshotSummary({items,lang}:{items:SnapshotSummaryItem[];lang:Lang}){
  const vi=lang==="vi";
  if(items.length===0)return <p style={styles.muted}>{vi?"Không có mục tóm tắt được. Hãy xem dữ liệu gốc bên dưới.":"요약 가능한 항목이 없습니다. 아래 원본을 확인해주세요."}</p>;
  const label:Record<SnapshotSummaryItem["key"],[string,string]>={payType:["급여 형태","Loại lương"],combinedSalary:["합산급여","Tổng lương cố định"],recognizedWorkdays:["인정 근무일","Ngày công ghi nhận"],recognizedMinutes:["인정 근무시간","Thời gian công ghi nhận"],workAppliedAmount:["근무 반영액","Lương theo công"],incentiveAmount:["인센티브","Thưởng"],penaltyAmount:["패널티","Phạt"],preInsurancePayoutAmount:["보험 공제 전 지급대상액","Tổng trước khấu trừ BH"],employeeInsuranceDeductionAmount:["직원 보험 공제","Khấu trừ BH nhân viên"],employeePitDeductionAmount:["직원 TNCN 공제","Khấu trừ TNCN nhân viên"],advanceAmount:["가불","Ứng lương"],netPayoutAmount:["최종 실수령액","Thực nhận cuối cùng"]};
  const display=(item:SnapshotSummaryItem)=>item.key==="payType"?payrollLabel(lang,String(item.value)):item.key==="recognizedWorkdays"?`${item.value}${vi?" ngày":"일"}`:item.key==="recognizedMinutes"?`${item.value}${vi?" phút":"분"}`:formatVnd(Number(item.value));
  return <div style={styles.snapshotSummary}>{items.map(item=><Row key={item.key} label={label[item.key][vi?1:0]} value={display(item)}/>)}</div>;
}
function Row({label,value,strong=false}:{label:string;value:string;strong?:boolean}){return <div style={styles.row}><span style={styles.rowLabel}>{label}</span><b style={strong?styles.strong:styles.rowValue}>{value}</b></div>}

const styles={
  summaryCard:{display:"grid",gap:6,minWidth:0,padding:"12px 12px 10px",border:"1px solid #bfdbfe",borderRadius:12,background:"#eff6ff"},
  summaryHead:{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"4px 8px",minWidth:0},
  title:{margin:0,fontSize:17,lineHeight:1.3,fontWeight:900,overflowWrap:"anywhere"},
  completedBadge:{padding:"2px 7px",borderRadius:999,background:"#dcfce7",color:"#166534",fontSize:10.5,fontWeight:800,whiteSpace:"nowrap"},
  payingBadge:{padding:"2px 7px",borderRadius:999,background:"#dbeafe",color:"#1d4ed8",fontSize:10.5,fontWeight:800,whiteSpace:"nowrap"},
  headCount:{marginLeft:"auto",fontSize:12,color:"#475569"},
  unpaidCount:{color:"#b45309",fontWeight:800},
  mainMetric:{display:"grid",gap:1,minWidth:0,paddingTop:4},
  mainMetricLabel:{fontSize:12,fontWeight:800,color:"#1e3a8a"},
  mainMetricValue:{fontSize:26,lineHeight:1.15,fontWeight:900,color:"#1d4ed8",fontVariantNumeric:"tabular-nums",overflowWrap:"anywhere"},
  checkLine:{margin:0,fontSize:12,lineHeight:1.45,color:"#334155",fontVariantNumeric:"tabular-nums",overflowWrap:"anywhere"},
  nowrap:{whiteSpace:"nowrap"},
  mutedInline:{color:"#64748b"},
  costDetails:{display:"grid",minWidth:0,paddingTop:6,borderTop:"1px solid #bfdbfe"},
  costBody:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:"6px 16px",marginTop:7,padding:9,borderRadius:9,background:"#fff",minWidth:0},
  summaryToggle:{cursor:"pointer",minHeight:28,display:"list-item",fontSize:12,fontWeight:800,color:"#475569",overflowWrap:"anywhere"},
  card:{display:"grid",gap:4,minWidth:0,padding:"10px 12px",border:"1px solid #e5e7eb",borderRadius:12,background:"#fff"},
  cardTitle:{margin:0,fontSize:13.5,fontWeight:900},
  plainList:{listStyle:"none",margin:0,padding:0,display:"grid",minWidth:0},
  outflowItem:{display:"grid",gridTemplateColumns:"auto minmax(0,1fr) auto",alignItems:"baseline",gap:10,padding:"6px 0",borderBottom:"1px solid #f1f5f9",minWidth:0,fontSize:13},
  outflowDate:{fontWeight:800,color:"#334155",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"},
  outflowAccount:{minWidth:0,color:"#334155",overflowWrap:"anywhere"},
  outflowAmount:{fontSize:13.5,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  residualChip:{display:"inline-block",marginLeft:6,padding:"0 5px",borderRadius:999,background:"#f1f5f9",color:"#475569",fontSize:10,fontWeight:800,whiteSpace:"nowrap"},
  inlineDetails:{display:"grid",gap:4,minWidth:0,paddingTop:4},
  residualItem:{display:"grid",gap:3,padding:"6px 8px",marginTop:4,borderRadius:8,background:"#f8fafc",minWidth:0,fontSize:12},
  lineTop:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,minWidth:0,overflowWrap:"anywhere"},
  fullText:{margin:0,fontSize:12,lineHeight:1.5,color:"#1f2937",whiteSpace:"pre-wrap",overflowWrap:"anywhere"},
  tabs:{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:4,padding:3,borderRadius:12,background:"#f1f5f9",minWidth:0},
  tab:{display:"flex",flexWrap:"wrap",justifyContent:"center",alignItems:"center",gap:"0 5px",minHeight:40,minWidth:0,padding:"5px 4px",borderWidth:0,borderRadius:9,background:"transparent",color:"#475569",font:"inherit",fontSize:12.5,fontWeight:800,cursor:"pointer"},
  tabActive:{background:"#fff",color:"#111827",boxShadow:"0 1px 3px rgba(15,23,42,.14)"},
  tabLabel:{minWidth:0,textAlign:"center",overflowWrap:"anywhere"},
  tabCount:{padding:"0 6px",borderRadius:999,background:"#e2e8f0",color:"#475569",fontSize:10.5,fontVariantNumeric:"tabular-nums"},
  tabCountActive:{background:"#111827",color:"#fff"},
  panel:{display:"grid",gap:8,minWidth:0},
  panelHead:{display:"flex",flexWrap:"wrap",justifyContent:"space-between",gap:"2px 10px",fontSize:12,color:"#475569",minWidth:0},
  commonLead:{margin:0,padding:"7px 9px",borderRadius:9,background:"#fffbeb",border:"1px solid #fde68a",color:"#78350f",fontSize:11.5,lineHeight:1.45,overflowWrap:"anywhere"},
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
  splitBadge:{padding:"0 6px",borderRadius:999,background:"#ede9fe",color:"#5b21b6",fontSize:10.5,fontWeight:800,whiteSpace:"nowrap"},
  alertChip:{padding:"0 6px",borderRadius:999,background:"#fee2e2",color:"#b91c1c",fontSize:10.5,fontWeight:900},
  refundChip:{display:"inline-block",marginLeft:6,padding:"0 5px",borderRadius:999,background:"#ecfdf5",color:"#047857",fontSize:10,fontWeight:800,whiteSpace:"nowrap"},
  chevron:{color:"#94a3b8",fontSize:11},
  meta:{minWidth:0,color:"#64748b",fontSize:11,lineHeight:1.35,overflowWrap:"anywhere"},
  unpaid:{padding:"1px 7px",borderRadius:999,background:"#fef3c7",color:"#92400e",fontSize:10.5,fontWeight:800,whiteSpace:"nowrap"},
  detailBody:{display:"grid",gap:7,padding:"8px 10px 10px",background:"#f8fafc",borderTop:"1px dashed #e5e7eb",minWidth:0},
  block:{display:"grid",gap:3,minWidth:0},
  payLine:{display:"grid",gap:1,padding:"3px 0",fontSize:12,minWidth:0},
  badgeList:{listStyle:"none",margin:0,padding:0,display:"flex",flexWrap:"wrap",gap:4,minWidth:0},
  badgeItem:{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 7px",borderRadius:999,background:"#fff",border:"1px solid #e2e8f0",fontSize:11,color:"#334155",overflowWrap:"anywhere"},
  taxBadge:{fontSize:9.5,fontWeight:900},
  differenceValue:{fontSize:13,color:"#92400e",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  noteClamp:{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",color:"#64748b",fontSize:11,lineHeight:1.35,overflowWrap:"anywhere"},
  missingReason:{margin:0,color:"#9a3412",fontSize:11,fontWeight:700},
  auditPlain:{display:"grid",gap:2,minHeight:52,boxSizing:"border-box",padding:"8px 10px",minWidth:0},
  row:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:12,minWidth:0,fontSize:12},
  rowLabel:{minWidth:0,color:"#475569",fontSize:12},
  // 금액·일시 값은 한 줄 유지(라벨이 대신 줄바꿈).
  rowValue:{flexShrink:0,textAlign:"right",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  strong:{flexShrink:0,textAlign:"right",fontSize:13.5,color:"#1d4ed8",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"},
  warning:{margin:0,padding:"6px 8px",borderRadius:8,background:"#fff7ed",color:"#9a3412",fontSize:11.5,fontWeight:700,overflowWrap:"anywhere"},
  muted:{margin:0,color:"#64748b",fontSize:12},
  stateBox:{margin:0,padding:16,border:"1px solid #e5e7eb",borderRadius:12,background:"#fff",textAlign:"center",color:"#6b7280",fontSize:13},
  snapshotSummary:{display:"grid",gap:5,margin:"7px 0",padding:8,borderRadius:8,background:"#fff",border:"1px solid #e5e7eb"},
  snapshot:{maxWidth:"100%",overflow:"auto",padding:8,borderRadius:8,background:"#0f172a",color:"#e2e8f0",fontSize:9},
} satisfies Record<string,CSSProperties>;
