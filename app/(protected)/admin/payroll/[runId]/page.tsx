"use client";

import { use, useEffect, useState, type CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import LoadingState from "@/components/LoadingState";
import PayrollRunLedgerView, { type PayrollRunLedger } from "@/components/payroll/PayrollRunLedgerView";
import { useLanguage } from "@/lib/language-context";

type LoadState={status:"loading"}|{status:"notFound"}|{status:"error"}|{status:"ready";ledger:PayrollRunLedger};

// 급여장부 조회 전용 페이지: 기존 runs/[runId] 응답만 읽고, 본문 표시는 PayrollRunLedgerView가 맡는다(읽기 전용).
export default function PayrollRunPage({params}:{params:Promise<{runId:string}>}){
  const {runId}=use(params);const{lang}=useLanguage();const vi=lang==="vi";
  const[state,setState]=useState<LoadState>({status:"loading"});const[reloadKey,setReloadKey]=useState(0);
  // 장부 조회: 배치 ID가 바뀌거나 다시 조회하면 이전 요청을 취소하고, 응답의 run.id가 현재 배치와 같을 때만 반영한다.
  // 조회 실패(error)와 장부 없음(notFound)을 구분하고, 실패 시에는 이전 금액·인원수를 보여주지 않는다.
  useEffect(()=>{const controller=new AbortController();setState({status:"loading"});void(async()=>{try{const response=await fetch(`/api/admin/payroll/runs/${runId}`,{cache:"no-store",signal:controller.signal});const data=await response.json().catch(()=>null);if(controller.signal.aborted)return;if(response.status===404||data?.code==="RUN_NOT_FOUND"||data?.code==="INVALID_RUN_ID"){setState({status:"notFound"});return}if(!response.ok||!data?.ok||!data.run||String(data.run.id)!==String(runId)||!Array.isArray(data.employees))throw new Error(data?.code??"PAYROLL_RUN_READ_FAILED");setState({status:"ready",ledger:{runId,run:data.run,employees:data.employees,allocations:Array.isArray(data.allocations)?data.allocations:[],residuals:Array.isArray(data.residuals)?data.residuals:[],fundAccounts:Array.isArray(data.fundAccounts)?data.fundAccounts:[],audit:Array.isArray(data.audit)?data.audit:[],mealAllowanceEligibleUserIds:data.mealAllowanceEligibleUserIds??[]}})}catch(cause){if(controller.signal.aborted||(cause as Error).name==="AbortError")return;setState({status:"error"})}})();return()=>controller.abort()},[runId,reloadKey]);
  const ledger=state.status==="ready"&&state.ledger.runId===runId?state.ledger:null;
  // 상단 급여관리 탭(PayrollSubNav)이 돌아갈 월: URL ?month를 배치의 실제 급여월로 맞춘다.
  // 직접 진입(/admin/payroll/4)이나 다른 월 파라미터여도 장부 월(예: 2026-10)이 우선한다. 별도 ← 급여관리 버튼은 두지 않는다.
  const router=useRouter();const pathname=usePathname();const searchParams=useSearchParams();
  const ledgerMonth=ledger?.run.payroll_month.slice(0,7)??null;const urlMonth=searchParams.get("month");
  useEffect(()=>{if(!ledgerMonth||urlMonth===ledgerMonth)return;const query=new URLSearchParams(searchParams.toString());query.set("month",ledgerMonth);router.replace(`${pathname}?${query.toString()}`,{scroll:false})},[ledgerMonth,urlMonth,pathname,router,searchParams]);
  if(state.status==="loading")return <Container><main style={styles.page}><LoadingState label={vi?"Đang tải sổ chi trả lương…":"급여 지급내역을 불러오는 중입니다…"} variant="page"/></main></Container>;
  if(state.status==="notFound")return <Container><main style={styles.page}><p style={styles.stateBox}>{vi?"Không có sổ chi trả lương này.":"해당 급여 지급내역이 없습니다."}</p></main></Container>;
  if(state.status==="error"||!ledger)return <Container><main style={styles.page}><div role="alert" style={styles.errorBox}><span>{vi?"Không thể tải sổ lương. Số tiền và số người không được hiển thị cho đến khi tải lại thành công.":"급여장부를 불러오지 못했습니다. 다시 조회에 성공할 때까지 금액·인원수를 표시하지 않습니다."}</span><button type="button" style={styles.retryButton} onClick={()=>setReloadKey(key=>key+1)}>{vi?"Tải lại":"다시 조회"}</button></div></main></Container>;
  // 배치가 바뀌면 탭·펼침·검색 상태를 초기화한다(key).
  return <Container><main style={styles.page}><PayrollRunLedgerView key={ledger.runId} ledger={ledger} lang={lang}/></main></Container>;
}

const styles={
  // 하단 고정 네비(60px)와 홈 인디케이터(safe-area)에 마지막 내용이 가리지 않도록 여백을 둔다.
  page:{display:"grid",gap:10,paddingBottom:"calc(32px + env(safe-area-inset-bottom))",minWidth:0},
  stateBox:{margin:0,padding:16,border:"1px solid #e5e7eb",borderRadius:12,background:"#fff",textAlign:"center",color:"#6b7280",fontSize:13},
  errorBox:{display:"grid",gap:8,padding:12,borderRadius:10,background:"#fef2f2",color:"#b91c1c",fontSize:13,lineHeight:1.45},
  retryButton:{justifySelf:"start",minHeight:34,padding:"6px 12px",border:"1px solid #fca5a5",borderRadius:9,background:"#fff",color:"#b91c1c",fontSize:12,fontWeight:800},
} satisfies Record<string,CSSProperties>;
