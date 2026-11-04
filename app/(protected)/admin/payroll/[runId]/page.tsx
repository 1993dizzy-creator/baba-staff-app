"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState, type CSSProperties } from "react";
import Container from "@/components/Container";
import LoadingState from "@/components/LoadingState";
import { useLanguage } from "@/lib/language-context";
import { formatVnd } from "@/lib/payroll/payroll-page-money";
import { partLabel, payrollLabel } from "@/lib/payroll/ui-labels";
import { mealAllowanceBadgeLabel } from "@/components/payroll/CompensationCard";
import {
  buildDifferenceReview,
  countPaymentLedgerFilters,
  matchesPaymentLedgerFilter,
  matchesPaymentLedgerQuery,
  PAYMENT_LEDGER_FILTERS,
  summarizePaymentSnapshot,
  type PaymentLedgerFilter,
  type SnapshotSummaryItem,
} from "@/lib/payroll/payment-ledger-view";

type Run={id:number;payroll_month:string;status:"paying"|"completed";target_employee_count:number;paid_employee_count:number;calculated_net_total:number;actual_paid_total:number;difference_total:number;employee_insurance_total:number;employer_insurance_total:number;director_insurance_amount:number;insurance_remittance_total:number;actual_company_cost_total:number;started_at:string;completed_at:string|null};
type Employee={id:number;user_id:number;employee_name:string;part_snapshot:string|null;position_snapshot:string|null;payment_status:"unpaid"|"paid";calculated_net_amount:number|null;actual_paid_amount:number|null;difference_amount:number|null;difference_reason:string|null;payment_date:string|null;paid_at:string|null;calculation_snapshot:Record<string,unknown>|null;paid_actor?:{name:string|null;full_name:string|null;username:string|null}|null};
type Ledger={runId:string;run:Run;employees:Employee[];mealAllowanceEligibleUserIds:number[]};
type LoadState={status:"loading"}|{status:"notFound"}|{status:"error"}|{status:"ready";ledger:Ledger};
type Lang="ko"|"vi";

// 차액 표시: 저장된 difference_amount(실제 지급 − 계산 실수령) 부호를 그대로 보여준다.
function signedVnd(value:number){return value>0?`+${formatVnd(value)}`:formatVnd(value)}
function dateTime(value:string|null,vi:boolean){return value?new Date(value).toLocaleString(vi?"vi-VN":"ko-KR"):"—"}

export default function PayrollRunPage({params}:{params:Promise<{runId:string}>}){
  const {runId}=use(params);const{lang}=useLanguage();const vi=lang==="vi";
  const[state,setState]=useState<LoadState>({status:"loading"});const[reloadKey,setReloadKey]=useState(0);
  const[query,setQuery]=useState("");const[filter,setFilter]=useState<PaymentLedgerFilter>("all");
  const[expandedId,setExpandedId]=useState<number|null>(null);
  // 장부 조회: 배치 ID가 바뀌거나 다시 조회하면 이전 요청을 취소하고, 응답의 run.id가 현재 배치와 같을 때만 반영한다.
  // 조회 실패(error)와 장부 없음(notFound)을 구분하고, 실패 시에는 이전 금액·인원수를 보여주지 않는다.
  useEffect(()=>{const controller=new AbortController();setState({status:"loading"});setExpandedId(null);void(async()=>{try{const response=await fetch(`/api/admin/payroll/runs/${runId}`,{cache:"no-store",signal:controller.signal});const data=await response.json().catch(()=>null);if(controller.signal.aborted)return;if(response.status===404||data?.code==="RUN_NOT_FOUND"||data?.code==="INVALID_RUN_ID"){setState({status:"notFound"});return}if(!response.ok||!data?.ok||!data.run||String(data.run.id)!==String(runId)||!Array.isArray(data.employees))throw new Error(data?.code??"PAYROLL_RUN_READ_FAILED");setState({status:"ready",ledger:{runId,run:data.run,employees:data.employees,mealAllowanceEligibleUserIds:data.mealAllowanceEligibleUserIds??[]}})}catch(cause){if(controller.signal.aborted||(cause as Error).name==="AbortError")return;setState({status:"error"})}})();return()=>controller.abort()},[runId,reloadKey]);
  const ledger=state.status==="ready"&&state.ledger.runId===runId?state.ledger:null;
  const employees=useMemo(()=>ledger?.employees??[],[ledger]);
  const counts=useMemo(()=>countPaymentLedgerFilters(employees),[employees]);
  const differenceRows=useMemo(()=>buildDifferenceReview(employees),[employees]);
  const filtered=useMemo(()=>employees.filter(employee=>matchesPaymentLedgerFilter(employee,filter)&&matchesPaymentLedgerQuery(employee,query)),[employees,filter,query]);
  const back=<Link href="/admin/payroll" style={styles.back}>← {vi?"Quản lý lương":"급여관리"}</Link>;
  if(state.status==="loading")return <Container><main style={styles.page}>{back}<LoadingState label={vi?"Đang tải sổ chi trả lương…":"급여 지급내역을 불러오는 중입니다…"} variant="page"/></main></Container>;
  if(state.status==="notFound")return <Container><main style={styles.page}>{back}<p style={styles.stateBox}>{vi?"Không có sổ chi trả lương này.":"해당 급여 지급내역이 없습니다."}</p></main></Container>;
  if(state.status==="error"||!ledger)return <Container><main style={styles.page}>{back}<div role="alert" style={styles.errorBox}><span>{vi?"Không thể tải sổ lương. Số tiền và số người không được hiển thị cho đến khi tải lại thành công.":"급여장부를 불러오지 못했습니다. 다시 조회에 성공할 때까지 금액·인원수를 표시하지 않습니다."}</span><button type="button" style={styles.retryButton} onClick={()=>setReloadKey(key=>key+1)}>{vi?"Tải lại":"다시 조회"}</button></div></main></Container>;
  const run=ledger.run;const mealAllowanceEligibleUserIds=ledger.mealAllowanceEligibleUserIds;
  const mealAllowanceEligibleSet=new Set(mealAllowanceEligibleUserIds);
  const month=run.payroll_month.slice(0,7);const title=vi?`Sổ lương ${month.slice(5)}/${month.slice(0,4)}`:`${month.slice(0,4)}년 ${Number(month.slice(5))}월 급여장부`;
  const filterLabel=(value:PaymentLedgerFilter)=>value==="all"?(vi?"Tất cả":"전체"):value==="paid"?(vi?"Đã trả":"지급완료"):value==="unpaid"?(vi?"Chưa trả":"미지급"):(vi?"Có chênh lệch":"차액발생");
  function changeFilter(value:PaymentLedgerFilter){setFilter(value);setExpandedId(null)}
  return <Container><main style={styles.page}>{back}
    {/* 상단 요약: 배치에 저장된 집계 금액을 그대로 표시한다(재계산 없음). */}
    <section style={styles.summaryCard} aria-label={title}>
      <div style={styles.summaryHead}><h1 style={styles.title}>{title}</h1><span style={run.status==="completed"?styles.completedBadge:styles.payingBadge}>{run.status==="completed"?(vi?"Hoàn tất":"완료"):(vi?"Đang chi trả":"지급 중")}</span><span style={styles.headCount}>{vi?"Đã trả":"지급완료"} <b>{run.paid_employee_count} / {run.target_employee_count}</b>{vi?" người":"명"}</span></div>
      <div style={styles.mainMetric}><span style={styles.mainMetricLabel}>{vi?"Tổng thực trả":"실제 지급 합계"}</span><b style={styles.mainMetricValue}>{formatVnd(run.actual_paid_total)}</b></div>
      <div style={styles.subMetrics}><Row label={vi?"Tổng lương tính":"계산 실수령 합계"} value={formatVnd(run.calculated_net_total)}/><Row label={vi?"Tổng chênh lệch":"차액 합계"} value={formatVnd(run.difference_total)}/></div>
      <details style={styles.costDetails}><summary style={styles.summary}>{vi?"Chi tiết chi phí":"비용 상세"}</summary><div style={styles.costBody}>
        <Row label={vi?"Bảo hiểm công ty":"회사 보험부담"} value={formatVnd(run.employer_insurance_total)}/><Row label={vi?"Bảo hiểm giám đốc":"법인장 보험비"} value={formatVnd(run.director_insurance_amount)}/><Row label={vi?"Nộp cơ quan bảo hiểm":"보험기관 납부액"} value={formatVnd(run.insurance_remittance_total)}/><Row label={vi?"Tổng chi phí nhân công":"실제 총인건비"} value={formatVnd(run.actual_company_cost_total)} strong/><Row label={vi?"Bắt đầu":"시작일"} value={dateTime(run.started_at,vi)}/>{run.completed_at&&<Row label={vi?"Hoàn tất":"완료일"} value={dateTime(run.completed_at,vi)}/>}
      </div></details>
    </section>
    {/* 차액 검토: 차액 발생 직원만 한 줄씩 요약한다. 배치 전체 차액은 위 요약의 저장값 그대로이며 개별 값을 다시 더하지 않는다. */}
    {differenceRows.length>0&&<section style={styles.differenceCard} aria-label={vi?"Kiểm tra chênh lệch":"차액 검토"}>
      <div style={styles.differenceHead}><h2 style={styles.differenceTitle}>{vi?"Kiểm tra chênh lệch":"차액 검토"}</h2><span>{differenceRows.length}{vi?" người":"명"}</span></div>
      <ul style={styles.differenceList}>{differenceRows.map(row=><li key={row.employee.id} style={styles.differenceItem}>
        <div style={styles.differenceLine}><b style={styles.name}>{row.employee.employee_name}</b><b style={styles.differenceValue}>{signedVnd(row.differenceAmount)}</b></div>
        <div style={styles.differenceLine}><small style={styles.meta}>{row.calculatedAmount===null?"—":formatVnd(row.calculatedAmount)} → {row.actualAmount===null?"—":formatVnd(row.actualAmount)}</small><small style={row.reason===null?styles.missingReason:styles.meta}>{row.reason??(vi?"Chưa ghi lý do":"사유 미기록")}</small></div>
      </li>)}</ul>
    </section>}
    <section style={styles.list}><h2 style={styles.subtitle}>{vi?"Chi trả theo nhân viên":"직원별 지급 내역"}</h2>
      <input style={styles.search} value={query} onChange={event=>{setQuery(event.target.value);setExpandedId(null)}} placeholder={vi?"Tìm tên nhân viên":"직원명 검색"} aria-label={vi?"Tìm tên nhân viên":"직원명 검색"}/>
      <div style={styles.filters} role="group" aria-label={vi?"Bộ lọc chi trả":"지급 필터"}>{PAYMENT_LEDGER_FILTERS.map(value=><button key={value} type="button" aria-pressed={filter===value} style={filter===value?{...styles.filter,...styles.filterActive}:styles.filter} onClick={()=>changeFilter(value)}>{filterLabel(value)} <span style={styles.filterCount}>{counts[value]}</span></button>)}</div>
      {employees.length===0?<p style={styles.stateBox}>{vi?"Chưa có bản ghi chi trả của nhân viên.":"직원 지급 기록이 없습니다."}</p>:filtered.length===0?<p style={styles.stateBox}>{vi?"Không có nhân viên phù hợp.":"조건에 맞는 직원이 없습니다."}</p>:<EmployeeList employees={filtered} mealAllowanceEligibleSet={mealAllowanceEligibleSet} expandedId={expandedId} onToggle={id=>setExpandedId(current=>current===id?null:id)} lang={lang}/>}
    </section>
  </main></Container>;
}

// 직원 지급내역: 한 줄 요약 행 목록. 한 번에 한 명만 펼치며, 펼친 영역에 지급 상세와 지급 당시 스냅샷을 표시한다.
function EmployeeList({employees,mealAllowanceEligibleSet,expandedId,onToggle,lang}:{employees:Employee[];mealAllowanceEligibleSet:Set<number>;expandedId:number|null;onToggle:(id:number)=>void;lang:Lang}){
  const vi=lang==="vi";
  return <ul style={styles.rows}>{employees.map(employee=>{
    const paid=employee.payment_status==="paid";const open=expandedId===employee.id;const difference=Number(employee.difference_amount??0);const panelId=`payroll-ledger-employee-${employee.id}`;
    const meta=[employee.part_snapshot?partLabel(lang,employee.part_snapshot):null,employee.position_snapshot].filter(Boolean).join(" · ");
    return <li key={employee.id} style={styles.rowItem}>
      <button type="button" style={styles.rowButton} aria-expanded={open} aria-controls={panelId} onClick={()=>onToggle(employee.id)}>
        <span style={styles.rowMain}><span style={styles.nameLine}><b style={styles.name}>{employee.employee_name}</b>{mealAllowanceEligibleSet.has(employee.user_id)?<span style={styles.mealBadge} title={mealAllowanceBadgeLabel(lang)} aria-label={mealAllowanceBadgeLabel(lang)}>🍚</span>:null}</span>{meta?<small style={styles.meta}>{meta}</small>:null}</span>
        {/* 미지급 직원은 금액 대신 상태만 표시한다(0원을 지급처럼 보이지 않도록). */}
        <span style={styles.rowSide}>{paid?<b style={styles.rowAmount}>{formatVnd(employee.actual_paid_amount??0)}</b>:null}<span style={styles.rowStatusLine}><span style={paid?styles.paid:styles.unpaid}>{paid?(vi?"Đã trả":"지급완료"):(vi?"Chưa trả":"미지급")}</span>{paid&&difference!==0?<span style={styles.rowDifference}>{vi?"Chênh lệch ":"차액 "}{signedVnd(difference)}</span>:null}</span></span>
        <span aria-hidden="true" style={styles.chevron}>{open?"⌃":"⌄"}</span>
      </button>
      {open&&<div id={panelId} style={styles.detailBody}>{paid?<>
        <Row label={vi?"Lương tính":"계산 실수령액"} value={formatVnd(employee.calculated_net_amount??0)}/><Row label={vi?"Thực trả":"실제 지급액"} value={formatVnd(employee.actual_paid_amount??0)} strong/><Row label={vi?"Chênh lệch":"차액"} value={formatVnd(employee.difference_amount??0)}/>
        <Row label={vi?"Lý do chênh lệch":"차액 사유"} value={employee.difference_reason?.trim()?employee.difference_reason:difference!==0?(vi?"Chưa ghi lý do":"사유 미기록"):"—"} muted={!employee.difference_reason?.trim()}/>
        <Row label={vi?"Ngày trả":"지급일"} value={employee.payment_date??"—"}/><Row label={vi?"Người xử lý":"지급 처리자"} value={actorName(employee.paid_actor)}/><Row label={vi?"Thời gian xử lý":"지급 시각"} value={dateTime(employee.paid_at,vi)}/>
        {employee.calculation_snapshot&&<details><summary style={styles.summary}>{vi?"Xem dữ liệu tính lương đã cố định":"지급 당시 계산 snapshot 보기"}</summary><SnapshotSummary items={summarizePaymentSnapshot(employee.calculation_snapshot)} lang={lang}/><details><summary style={styles.summary}>{vi?"Dữ liệu gốc (JSON)":"원본 JSON"}</summary><pre style={styles.snapshot}>{JSON.stringify(employee.calculation_snapshot,null,2)}</pre></details></details>}
      </>:<p style={styles.muted}>{vi?"Chưa xử lý chi trả.":"아직 지급되지 않았습니다."}</p>}</div>}
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
function actorName(actor:Employee["paid_actor"]){return actor?.name||actor?.full_name||actor?.username||"—"}
function Row({label,value,strong=false,muted=false}:{label:string;value:string;strong?:boolean;muted?:boolean}){return <div style={styles.row}><span style={styles.rowLabel}>{label}</span><b style={strong?styles.strong:muted?styles.mutedValue:styles.rowValue}>{value}</b></div>}
const styles={
  page:{display:"grid",gap:12,paddingBottom:32,minWidth:0},
  back:{justifySelf:"start",fontSize:12,fontWeight:700,color:"#475569",textDecoration:"none"},
  summaryCard:{display:"grid",gap:8,minWidth:0,padding:12,border:"1px solid #bfdbfe",borderRadius:12,background:"#eff6ff"},
  summaryHead:{display:"flex",flexWrap:"wrap",alignItems:"center",gap:"4px 8px",minWidth:0},
  title:{margin:0,fontSize:17,lineHeight:1.3,fontWeight:900},
  completedBadge:{padding:"2px 7px",borderRadius:999,background:"#dcfce7",color:"#166534",fontSize:10.5,fontWeight:800},
  payingBadge:{padding:"2px 7px",borderRadius:999,background:"#dbeafe",color:"#1d4ed8",fontSize:10.5,fontWeight:800},
  headCount:{marginLeft:"auto",fontSize:12,color:"#475569",whiteSpace:"nowrap"},
  mainMetric:{display:"flex",flexWrap:"wrap",justifyContent:"space-between",alignItems:"baseline",gap:"2px 10px",minWidth:0},
  mainMetricLabel:{fontSize:12,fontWeight:800,color:"#1e3a8a"},
  mainMetricValue:{fontSize:20,lineHeight:1.2,fontWeight:900,color:"#1d4ed8",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"},
  subMetrics:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:"4px 16px",paddingTop:7,borderTop:"1px solid #bfdbfe",minWidth:0},
  costDetails:{display:"grid",minWidth:0},
  costBody:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:"5px 16px",marginTop:7,padding:9,borderRadius:9,background:"#fff",minWidth:0},
  differenceCard:{display:"grid",gap:6,minWidth:0,padding:"10px 12px",border:"1px solid #fcd34d",borderRadius:12,background:"#fffbeb"},
  differenceHead:{display:"flex",alignItems:"baseline",gap:8,fontSize:12,color:"#92400e",fontWeight:800},
  differenceTitle:{margin:0,fontSize:14,color:"#92400e"},
  differenceList:{listStyle:"none",margin:0,padding:0,display:"grid",minWidth:0,borderTop:"1px solid #fde68a"},
  differenceItem:{display:"grid",gap:2,padding:"6px 0",borderBottom:"1px solid #fde68a",minWidth:0},
  differenceLine:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,minWidth:0},
  differenceValue:{fontSize:12.5,color:"#92400e",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  missingReason:{color:"#9a3412",fontSize:10.5,fontWeight:700,textAlign:"right"},
  list:{display:"grid",gap:8,minWidth:0},
  subtitle:{margin:0,fontSize:15},
  search:{width:"100%",minHeight:36,boxSizing:"border-box",padding:"7px 10px",border:"1px solid #d1d5db",borderRadius:10,fontSize:13},
  filters:{display:"flex",flexWrap:"wrap",gap:4,minWidth:0},
  filter:{minHeight:32,padding:"4px 8px",border:"1px solid #d1d5db",borderRadius:999,background:"#fff",color:"#374151",fontSize:11.5,fontWeight:800,whiteSpace:"nowrap"},
  filterActive:{background:"#111827",borderColor:"#111827",color:"#fff"},
  filterCount:{marginLeft:2,opacity:.75},
  rows:{listStyle:"none",margin:0,padding:0,display:"grid",minWidth:0,border:"1px solid #e5e7eb",borderRadius:12,background:"#fff",overflow:"hidden"},
  rowItem:{borderTop:"1px solid #f1f5f9",minWidth:0},
  rowButton:{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto 14px",alignItems:"center",gap:8,width:"100%",minHeight:56,boxSizing:"border-box",padding:"8px 10px",border:0,background:"transparent",color:"inherit",textAlign:"left",cursor:"pointer",font:"inherit"},
  rowMain:{display:"grid",gap:2,minWidth:0},
  nameLine:{display:"flex",alignItems:"center",gap:4,minWidth:0},
  name:{minWidth:0,fontSize:13.5,lineHeight:1.3,overflowWrap:"anywhere"},
  rowSide:{display:"grid",justifyItems:"end",gap:3,minWidth:0},
  rowAmount:{fontSize:13.5,lineHeight:1.3,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",color:"#111827"},
  rowStatusLine:{display:"flex",flexWrap:"wrap",justifyContent:"flex-end",alignItems:"center",gap:4},
  rowDifference:{fontSize:10.5,fontWeight:800,color:"#92400e",whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"},
  chevron:{color:"#94a3b8",fontSize:12,textAlign:"center"},
  mealBadge:{fontSize:12,lineHeight:1},
  meta:{minWidth:0,color:"#64748b",fontSize:10.5,lineHeight:1.35,overflowWrap:"anywhere"},
  paid:{padding:"1px 6px",borderRadius:999,background:"#dcfce7",color:"#166534",fontSize:10,fontWeight:800,whiteSpace:"nowrap"},
  unpaid:{padding:"1px 6px",borderRadius:999,background:"#f1f5f9",color:"#475569",fontSize:10,fontWeight:800,whiteSpace:"nowrap"},
  detailBody:{display:"grid",gap:6,padding:"8px 10px 10px",background:"#f8fafc",borderTop:"1px dashed #e5e7eb",minWidth:0},
  row:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:12,minWidth:0,fontSize:12},
  rowLabel:{minWidth:0,color:"#475569"},
  rowValue:{minWidth:0,textAlign:"right",overflowWrap:"anywhere",fontVariantNumeric:"tabular-nums"},
  strong:{minWidth:0,textAlign:"right",fontSize:13.5,color:"#1d4ed8",fontVariantNumeric:"tabular-nums"},
  mutedValue:{minWidth:0,textAlign:"right",color:"#9a3412",fontWeight:700,overflowWrap:"anywhere"},
  muted:{margin:0,color:"#64748b",fontSize:12},
  stateBox:{margin:0,padding:16,border:"1px solid #e5e7eb",borderRadius:12,background:"#fff",textAlign:"center",color:"#6b7280",fontSize:13},
  summary:{cursor:"pointer",fontSize:11.5,fontWeight:700,color:"#475569"},
  snapshotSummary:{display:"grid",gap:5,margin:"7px 0",padding:8,borderRadius:8,background:"#fff",border:"1px solid #e5e7eb"},
  snapshot:{maxWidth:"100%",overflow:"auto",padding:8,borderRadius:8,background:"#0f172a",color:"#e2e8f0",fontSize:9},
  errorBox:{display:"grid",gap:8,padding:12,borderRadius:10,background:"#fef2f2",color:"#b91c1c",fontSize:13,lineHeight:1.45},
  retryButton:{justifySelf:"start",minHeight:34,padding:"6px 12px",border:"1px solid #fca5a5",borderRadius:9,background:"#fff",color:"#b91c1c",fontSize:12,fontWeight:800},
} satisfies Record<string,CSSProperties>;
