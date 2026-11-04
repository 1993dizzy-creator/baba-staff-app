"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState, type CSSProperties } from "react";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { formatVnd } from "@/lib/payroll/payroll-page-money";
import { payrollLabel } from "@/lib/payroll/ui-labels";
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

export default function PayrollRunPage({params}:{params:Promise<{runId:string}>}){
  const {runId}=use(params);const{lang}=useLanguage();const vi=lang==="vi";
  const[state,setState]=useState<LoadState>({status:"loading"});const[reloadKey,setReloadKey]=useState(0);
  const[query,setQuery]=useState("");const[filter,setFilter]=useState<PaymentLedgerFilter>("all");
  // 장부 조회: 배치 ID가 바뀌거나 다시 조회하면 이전 요청을 취소하고, 응답의 run.id가 현재 배치와 같을 때만 반영한다.
  // 조회 실패(error)와 장부 없음(notFound)을 구분하고, 실패 시에는 이전 금액·인원수를 보여주지 않는다.
  useEffect(()=>{const controller=new AbortController();setState({status:"loading"});void(async()=>{try{const response=await fetch(`/api/admin/payroll/runs/${runId}`,{cache:"no-store",signal:controller.signal});const data=await response.json().catch(()=>null);if(controller.signal.aborted)return;if(response.status===404||data?.code==="RUN_NOT_FOUND"||data?.code==="INVALID_RUN_ID"){setState({status:"notFound"});return}if(!response.ok||!data?.ok||!data.run||String(data.run.id)!==String(runId)||!Array.isArray(data.employees))throw new Error(data?.code??"PAYROLL_RUN_READ_FAILED");setState({status:"ready",ledger:{runId,run:data.run,employees:data.employees,mealAllowanceEligibleUserIds:data.mealAllowanceEligibleUserIds??[]}})}catch(cause){if(controller.signal.aborted||(cause as Error).name==="AbortError")return;setState({status:"error"})}})();return()=>controller.abort()},[runId,reloadKey]);
  const ledger=state.status==="ready"&&state.ledger.runId===runId?state.ledger:null;
  const employees=useMemo(()=>ledger?.employees??[],[ledger]);
  const counts=useMemo(()=>countPaymentLedgerFilters(employees),[employees]);
  const differenceRows=useMemo(()=>buildDifferenceReview(employees),[employees]);
  const filtered=useMemo(()=>employees.filter(employee=>matchesPaymentLedgerFilter(employee,filter)&&matchesPaymentLedgerQuery(employee,query)),[employees,filter,query]);
  const back=<Link href="/admin/payroll">{vi?"Quay lại":"돌아가기"}</Link>;
  if(state.status==="loading")return <Container><p>{vi?"Đang tải…":"불러오는 중…"}</p></Container>;
  if(state.status==="notFound")return <Container><p style={styles.muted}>{vi?"Không có sổ chi trả lương này.":"해당 급여 지급내역이 없습니다."}</p>{back}</Container>;
  if(state.status==="error"||!ledger)return <Container><div role="alert" style={styles.errorBox}><span>{vi?"Không thể tải sổ lương. Số tiền và số người không được hiển thị cho đến khi tải lại thành công.":"급여장부를 불러오지 못했습니다. 다시 조회에 성공할 때까지 금액·인원수를 표시하지 않습니다."}</span><button type="button" style={styles.retryButton} onClick={()=>setReloadKey(key=>key+1)}>{vi?"Tải lại":"다시 조회"}</button></div>{back}</Container>;
  const run=ledger.run;const mealAllowanceEligibleUserIds=ledger.mealAllowanceEligibleUserIds;
  const mealAllowanceEligibleSet=new Set(mealAllowanceEligibleUserIds);
  const month=run.payroll_month.slice(0,7);const title=vi?`Sổ lương ${month.slice(5)}/${month.slice(0,4)}`:`${month.slice(0,4)}년 ${Number(month.slice(5))}월 급여장부`;
  const filterLabel=(value:PaymentLedgerFilter)=>value==="all"?(vi?"Tất cả":"전체"):value==="paid"?(vi?"Đã trả":"지급완료"):value==="unpaid"?(vi?"Chưa trả":"미지급"):(vi?"Có chênh lệch":"차액발생");
  return <Container><main style={styles.page}><Link href="/admin/payroll">← {vi?"Quản lý lương":"급여관리"}</Link><header style={styles.header}><div><h1 style={styles.title}>{title}</h1><span style={styles.badge}>{run.status==="completed"?(vi?"Hoàn tất":"완료"):(vi?"Đang chi trả":"지급 중")}</span></div><b>{run.paid_employee_count} / {run.target_employee_count}{vi?" người":"명"}</b></header>
    <section style={styles.card}><Row label={vi?"Bắt đầu":"시작일"} value={new Date(run.started_at).toLocaleString(vi?"vi-VN":"ko-KR")}/>{run.completed_at&&<Row label={vi?"Hoàn tất":"완료일"} value={new Date(run.completed_at).toLocaleString(vi?"vi-VN":"ko-KR")}/>}<Row label={vi?"Tổng lương tính":"계산 실수령 총액"} value={formatVnd(run.calculated_net_total)}/><Row label={vi?"Tổng thực trả":"실제 지급 총액"} value={formatVnd(run.actual_paid_total)}/><Row label={vi?"Tổng chênh lệch":"전체 차액"} value={formatVnd(run.difference_total)}/><Row label={vi?"Bảo hiểm công ty":"회사 보험부담"} value={formatVnd(run.employer_insurance_total)}/><Row label={vi?"Bảo hiểm giám đốc":"법인장 보험비"} value={formatVnd(run.director_insurance_amount)}/><Row label={vi?"Nộp cơ quan bảo hiểm":"보험기관 납부액"} value={formatVnd(run.insurance_remittance_total)}/><Row label={vi?"Tổng chi phí nhân công":"실제 총인건비"} value={formatVnd(run.actual_company_cost_total)} strong/></section>
    {differenceRows.length>0&&<section style={styles.differenceCard} aria-label={vi?"Kiểm tra chênh lệch":"차액 검토"}>
      <h2 style={styles.differenceTitle}>{vi?"Kiểm tra chênh lệch":"차액 검토"}</h2>
      <Row label={vi?"Số nhân viên có chênh lệch":"차액발생 직원"} value={`${differenceRows.length}${vi?" người":"명"}`}/>
      {/* 배치에 저장된 전체 차액(기존 지급장부 집계 기준·부호 그대로). 개별 값을 다시 더해 섞지 않는다. */}
      <Row label={vi?"Tổng chênh lệch đã lưu":"저장된 전체 차액 합계"} value={formatVnd(run.difference_total)} strong/>
      <ul style={styles.differenceList}>{differenceRows.map(row=><li key={row.employee.id} style={styles.differenceItem}>
        <b>{row.employee.employee_name}</b>
        <Row label={vi?"Lương tính":"계산금액"} value={row.calculatedAmount===null?"—":formatVnd(row.calculatedAmount)}/>
        <Row label={vi?"Thực trả":"실제 지급액"} value={row.actualAmount===null?"—":formatVnd(row.actualAmount)}/>
        <Row label={vi?"Chênh lệch":"차액"} value={formatVnd(row.differenceAmount)} strong/>
        <Row label={vi?"Lý do":"사유"} value={row.reason??(vi?"Chưa ghi lý do":"사유 미기록")} muted={row.reason===null}/>
      </li>)}</ul>
    </section>}
    <section style={styles.list}><h2 style={styles.subtitle}>{vi?"Chi trả theo nhân viên":"직원별 지급 내역"}</h2>
      <input style={styles.search} value={query} onChange={event=>setQuery(event.target.value)} placeholder={vi?"Tìm tên nhân viên":"직원명 검색"} aria-label={vi?"Tìm tên nhân viên":"직원명 검색"}/>
      <div style={styles.filters} role="group" aria-label={vi?"Bộ lọc chi trả":"지급 필터"}>{PAYMENT_LEDGER_FILTERS.map(value=><button key={value} type="button" aria-pressed={filter===value} style={filter===value?{...styles.filter,...styles.filterActive}:styles.filter} onClick={()=>setFilter(value)}>{filterLabel(value)} <span style={styles.filterCount}>{counts[value]}</span></button>)}</div>
      {employees.length===0?<p style={styles.muted}>{vi?"Chưa có bản ghi chi trả của nhân viên.":"직원 지급 기록이 없습니다."}</p>:filtered.length===0?<p style={styles.muted}>{vi?"Không có nhân viên phù hợp.":"조건에 맞는 직원이 없습니다."}</p>:<EmployeeList employees={filtered} mealAllowanceEligibleSet={mealAllowanceEligibleSet} lang={lang}/>}
    </section>
  </main></Container>;
}

function EmployeeList({employees,mealAllowanceEligibleSet,lang}:{employees:Employee[];mealAllowanceEligibleSet:Set<number>;lang:"ko"|"vi"}){
  const vi=lang==="vi";
  return <>{employees.map(employee=><article key={employee.id} style={styles.employee}><div style={styles.employeeHead}><div><b>{employee.employee_name}</b>{mealAllowanceEligibleSet.has(employee.user_id)?<span style={styles.mealBadge} title={mealAllowanceBadgeLabel(lang)} aria-label={mealAllowanceBadgeLabel(lang)}>🍚</span>:null}<small style={styles.meta}>{[employee.part_snapshot,employee.position_snapshot].filter(Boolean).join(" · ")}</small></div><span style={employee.payment_status==="paid"?styles.paid:styles.unpaid}>{employee.payment_status==="paid"?(vi?"Đã trả":"지급완료"):(vi?"Chưa trả":"미지급")}</span></div>{employee.payment_status==="paid"?<><Row label={vi?"Lương tính":"계산 실수령액"} value={formatVnd(employee.calculated_net_amount??0)}/><Row label={vi?"Thực trả":"실제 지급액"} value={formatVnd(employee.actual_paid_amount??0)} strong/><Row label={vi?"Chênh lệch":"차액"} value={formatVnd(employee.difference_amount??0)}/>
    <details style={styles.detail}><summary style={styles.summary}>{vi?"Chi tiết chi trả":"지급 상세"}</summary><div style={styles.detailBody}>
      <Row label={vi?"Ngày trả":"지급일"} value={employee.payment_date??"—"}/><Row label={vi?"Người xử lý":"지급 처리자"} value={actorName(employee.paid_actor)}/><Row label={vi?"Thời gian xử lý":"지급 시각"} value={employee.paid_at?new Date(employee.paid_at).toLocaleString(vi?"vi-VN":"ko-KR"):"—"}/>
      <Row label={vi?"Lý do chênh lệch":"차액 사유"} value={employee.difference_reason?.trim()?employee.difference_reason:Number(employee.difference_amount??0)!==0?(vi?"Chưa ghi lý do":"사유 미기록"):"—"} muted={!employee.difference_reason?.trim()}/>
      {employee.calculation_snapshot&&<details><summary style={styles.summary}>{vi?"Xem dữ liệu tính lương đã cố định":"지급 당시 계산 snapshot 보기"}</summary><SnapshotSummary items={summarizePaymentSnapshot(employee.calculation_snapshot)} lang={lang}/><pre style={styles.snapshot}>{JSON.stringify(employee.calculation_snapshot,null,2)}</pre></details>}
    </div></details></>:<p style={styles.muted}>{vi?"Chưa xử lý chi trả.":"아직 지급되지 않았습니다."}</p>}</article>)}</>;
}

// 스냅샷 요약: 구조가 확인된 항목만 표시하고, 없으면 원본 JSON 확인을 안내한다(값을 추측하지 않음).
function SnapshotSummary({items,lang}:{items:SnapshotSummaryItem[];lang:"ko"|"vi"}){
  const vi=lang==="vi";
  if(items.length===0)return <p style={styles.muted}>{vi?"Không có mục tóm tắt được. Hãy xem dữ liệu gốc bên dưới.":"요약 가능한 항목이 없습니다. 아래 원본을 확인해주세요."}</p>;
  const label:Record<SnapshotSummaryItem["key"],[string,string]>={payType:["급여 형태","Loại lương"],combinedSalary:["합산급여","Tổng lương cố định"],recognizedWorkdays:["인정 근무일","Ngày công ghi nhận"],recognizedMinutes:["인정 근무시간","Thời gian công ghi nhận"],workAppliedAmount:["근무 반영액","Lương theo công"],incentiveAmount:["인센티브","Thưởng"],penaltyAmount:["패널티","Phạt"],preInsurancePayoutAmount:["보험 공제 전 지급대상액","Tổng trước khấu trừ BH"],employeeInsuranceDeductionAmount:["직원 보험 공제","Khấu trừ BH nhân viên"],employeePitDeductionAmount:["직원 TNCN 공제","Khấu trừ TNCN nhân viên"],advanceAmount:["가불","Ứng lương"],netPayoutAmount:["최종 실수령액","Thực nhận cuối cùng"]};
  const display=(item:SnapshotSummaryItem)=>item.key==="payType"?payrollLabel(lang,String(item.value)):item.key==="recognizedWorkdays"?`${item.value}${vi?" ngày":"일"}`:item.key==="recognizedMinutes"?`${item.value}${vi?" phút":"분"}`:formatVnd(Number(item.value));
  return <div style={styles.snapshotSummary}>{items.map(item=><Row key={item.key} label={label[item.key][vi?1:0]} value={display(item)}/>)}</div>;
}
function actorName(actor:Employee["paid_actor"]){return actor?.name||actor?.full_name||actor?.username||"—"}
function Row({label,value,strong=false,muted=false}:{label:string;value:string;strong?:boolean;muted?:boolean}){return <div style={styles.row}><span>{label}</span><b style={strong?styles.strong:muted?styles.mutedValue:undefined}>{value}</b></div>}
const styles={page:{display:"grid",gap:14,paddingBottom:32},header:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12},title:{margin:"0 0 7px",fontSize:20},badge:{display:"inline-block",padding:"4px 8px",borderRadius:999,background:"#e0f2fe",color:"#075985",fontSize:11,fontWeight:800},card:{display:"grid",gap:7,padding:14,border:"1px solid #bfdbfe",borderRadius:12,background:"#eff6ff"},differenceCard:{display:"grid",gap:7,padding:14,border:"1px solid #fcd34d",borderRadius:12,background:"#fffbeb"},differenceTitle:{margin:0,fontSize:15,color:"#92400e"},differenceList:{listStyle:"none",margin:0,padding:0,display:"grid",gap:6},differenceItem:{display:"grid",gap:4,padding:10,borderRadius:9,background:"#fff",border:"1px solid #fde68a"},row:{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:12,minWidth:0,fontSize:12},strong:{fontSize:14,color:"#1d4ed8"},mutedValue:{color:"#9a3412",fontWeight:700},list:{display:"grid",gap:8},subtitle:{margin:0,fontSize:17},search:{width:"100%",minHeight:38,boxSizing:"border-box",padding:"8px 10px",border:"1px solid #d1d5db",borderRadius:10,fontSize:13},filters:{display:"flex",flexWrap:"wrap",gap:6},filter:{minHeight:32,padding:"5px 10px",border:"1px solid #d1d5db",borderRadius:999,background:"#fff",color:"#374151",fontSize:12,fontWeight:800},filterActive:{background:"#111827",borderColor:"#111827",color:"#fff"},filterCount:{marginLeft:3,opacity:.75},employee:{display:"grid",gap:7,padding:12,border:"1px solid #e5e7eb",borderRadius:11,background:"#fff"},employeeHead:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8},mealBadge:{marginLeft:5,fontSize:12,lineHeight:1},meta:{display:"block",marginTop:2,color:"#64748b",fontSize:10},paid:{padding:"3px 7px",borderRadius:999,background:"#dcfce7",color:"#166534",fontSize:10,fontWeight:800},unpaid:{padding:"3px 7px",borderRadius:999,background:"#f1f5f9",color:"#475569",fontSize:10,fontWeight:800},muted:{margin:0,color:"#64748b",fontSize:12},detail:{display:"grid",gap:6},detailBody:{display:"grid",gap:7,marginTop:7},summary:{cursor:"pointer",fontSize:11,fontWeight:700,color:"#475569"},snapshotSummary:{display:"grid",gap:5,margin:"7px 0",padding:8,borderRadius:8,background:"#f8fafc"},snapshot:{maxWidth:"100%",overflow:"auto",padding:8,borderRadius:8,background:"#0f172a",color:"#e2e8f0",fontSize:9},errorBox:{display:"grid",gap:8,padding:12,borderRadius:10,background:"#fef2f2",color:"#b91c1c",fontSize:13,lineHeight:1.45},retryButton:{justifySelf:"start",minHeight:34,padding:"6px 12px",border:"1px solid #fca5a5",borderRadius:9,background:"#fff",color:"#b91c1c",fontSize:12,fontWeight:800}} satisfies Record<string,CSSProperties>;
