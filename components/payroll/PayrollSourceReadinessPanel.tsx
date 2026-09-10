import type { CSSProperties } from "react";
import type { PayrollSourceExport, PayrollSourceEmployee } from "@/lib/payroll/source-export/types";
import { formatVnd } from "@/lib/payroll/payroll-page-money";

const sumAdjustments=(employee:PayrollSourceEmployee)=>employee.adjustments.incentives.length+employee.adjustments.penalties.length+employee.adjustments.advances.length;

export default function PayrollSourceReadinessPanel({source,lang}:{source:PayrollSourceExport;lang:"ko"|"vi"}){
  const vi=lang==="vi";
  const attendanceIssueCount=source.employees.filter(employee=>employee.attendance.unresolved.length>0).length;
  const pendingCount=source.employees.reduce((sum,employee)=>sum+employee.extraWork.pendingCount,0);
  const staleCount=source.employees.reduce((sum,employee)=>sum+employee.extraWork.staleCount,0);
  const settingReviewCount=source.employees.filter(employee=>employee.tax.requiresReview||employee.insurance.settingVersionId===null).length;
  const metrics=[
    [vi?"Nhân viên":"대상 직원",source.employees.length],
    [vi?"Đã sẵn sàng":"자료 준비 완료",source.readiness.readyEmployeeCount],
    [vi?"Lỗi chấm công":"근태 문제 직원",attendanceIssueCount],
    [vi?"Làm thêm chưa duyệt":"추가근무 미검토",pendingCount],
    [vi?"Cần duyệt lại":"재검토",staleCount],
    [vi?"Cần kiểm tra BH/TNCN":"보험/TNCN 확인",settingReviewCount],
    [vi?"Có thể chuyển T8":"T8 전달 가능",source.readiness.readyEmployeeCount],
  ] as const;
  return <section style={s.panel} aria-label={vi?"Chuẩn bị dữ liệu lương tháng":"월 급여 원천 준비"}>
    <div style={s.heading}><div><h2 style={s.title}>{vi?"Chuẩn bị dữ liệu lương tháng":"월 급여 자료 준비"}</h2><p style={s.help}>{vi?"Dữ liệu nguồn để kế toán tính lương trên T8. Các số tiền là giá trị tham khảo trước khi kế toán chốt.":"T8에서 최종 급여를 계산하기 위한 원천 자료입니다. 표시 금액은 회계 확정 전 참고값입니다."}</p></div><span style={source.readiness.blockedEmployeeCount>0?s.blockedBadge:s.readyBadge}>{source.readiness.blockedEmployeeCount>0?(vi?`${source.readiness.blockedEmployeeCount} người bị chặn`:`${source.readiness.blockedEmployeeCount}명 전달 불가`):(vi?"Sẵn sàng":"전달 가능")}</span></div>
    <div style={s.metrics}>{metrics.map(([label,value])=><div key={label} style={s.metric}><span>{label}</span><b>{value}</b></div>)}</div>
    <div style={s.table} role="table" aria-label={vi?"Trạng thái dữ liệu nguồn theo nhân viên":"직원별 급여 원천 상태"}>
      <div style={s.header} role="row"><span>{vi?"Nhân viên":"직원"}</span><span>{vi?"Hợp đồng":"계약"}</span><span>{vi?"Chấm công":"근태"}</span><span>{vi?"Làm thêm":"추가근무"}</span><span>{vi?"Điều chỉnh":"조정"}</span><span>{vi?"BH/TNCN":"보험/TNCN"}</span><span>{vi?"Chuyển T8":"회계전달"}</span></div>
      {source.employees.map(employee=><EmployeeRow key={employee.employee.employeeId} employee={employee} vi={vi}/>) }
    </div>
    <small style={s.hash}>Hash {source.sourceHash.slice(0,12)}… · {vi?"Tạo lúc":"생성"} {source.generatedAt} · {vi?"Chưa đồng bộ Google Sheet":"Google Sheet 미동기화"}</small>
  </section>;
}

function EmployeeRow({employee,vi}:{employee:PayrollSourceEmployee;vi:boolean}){
  const attendanceIssues=employee.attendance.unresolved.length;
  const approvedExtra=employee.extraWork.approvedRegular.length+employee.extraWork.approvedPartTime.length;
  const extraProblem=employee.extraWork.pendingCount+employee.extraWork.staleCount;
  const settingsOkay=!employee.tax.requiresReview&&employee.insurance.settingVersionId!==null;
  return <details style={s.employee}>
    <summary style={s.row}>
      <b>{employee.employee.displayName}</b>
      <Status okay={Boolean(employee.contract)} text={employee.contract?(vi?"Xong":"완료"):(vi?"Thiếu":"누락")}/>
      <Status okay={attendanceIssues===0} text={attendanceIssues?`${attendanceIssues}${vi?" lỗi":"건"}`:(vi?"Xong":"완료")}/>
      <Status okay={extraProblem===0} text={extraProblem?`${vi?"Chờ ":"확인 "}${extraProblem}`:`${vi?"Duyệt ":"승인 "}${approvedExtra}`}/>
      <span>{sumAdjustments(employee)}{vi?" mục":"건"}</span>
      <Status okay={settingsOkay} text={settingsOkay?(vi?"Xong":"확인완료"):(vi?"Kiểm tra":"확인필요")}/>
      <Status okay={employee.readiness.readyForAccounting} text={employee.readiness.readyForAccounting?(vi?"Có thể":"가능"):(vi?"Không thể":"불가")}/>
    </summary>
    <div style={s.details}>
      <Detail title={vi?"Hợp đồng":"계약"} value={employee.contract?`${employee.contract.payType} · ${vi?"Lương cơ bản":"기본급"} ${formatVnd(employee.contract.baseSalaryAmount)} · ${vi?"Tăng cố định":"고정 인상"} ${formatVnd(employee.contract.fixedRaiseAmount)} · ${vi?"Tăng theo cấp":"레벨 인상"} ${formatVnd(employee.level.appliedRaiseAmount??0)} · ${vi?"Ngày công chuẩn":"기준 근무일"} ${employee.contract.standardWorkdays??"—"} · rev ${employee.contract.revision}`:(vi?"Chưa có hợp đồng":"계약 없음")}/>
      <Detail title={vi?"Chấm công":"근태"} value={`${vi?"Ngày công":"정상출근"} ${employee.attendance.recognizedAttendanceDays} · ${vi?"Nghỉ":"휴무"} ${employee.attendance.leave.length} · ${vi?"Trễ":"지각"} ${employee.attendance.late.length} · ${vi?"Về sớm":"조퇴"} ${employee.attendance.earlyLeave.length} · ${vi?"Vắng không phép":"무단결근"} ${employee.attendance.unauthorizedAbsence.length} · ${vi?"Chưa hoàn tất":"미완료"} ${employee.attendance.unresolved.length}`}/>
      <Detail title={vi?"Làm thêm":"추가근무"} value={`${vi?"Đã duyệt":"승인"} ${approvedExtra} · ${vi?"Chưa duyệt":"미검토"} ${employee.extraWork.pendingCount} · ${vi?"Cần duyệt lại":"재검토"} ${employee.extraWork.staleCount}`}/>
      <Detail title={vi?"Điều chỉnh":"조정"} value={`${vi?"Thưởng":"인센티브"} ${employee.adjustments.incentives.length} · ${vi?"Phạt":"벌금"} ${employee.adjustments.penalties.length} · ${vi?"Ứng":"가불"} ${employee.adjustments.advances.length}`}/>
      <Detail title={vi?"BH/TNCN tham khảo":"보험/TNCN 참고"} value={`BH ${formatVnd(employee.insurance.referenceEmployeeAmount??0)} (setting ${employee.insurance.settingVersionId??"—"}, rev ${employee.insurance.revision??"—"}) · TNCN ${employee.tax.referenceCalculatedAmount===null?"—":formatVnd(employee.tax.referenceCalculatedAmount)} (setting ${employee.tax.settingVersionId??"—"}, policy ${employee.tax.policyVersionId??"—"})${employee.tax.requiresReview?` · ${vi?"Cần kiểm tra":"확인 필요"}`:""}`}/>
      {!employee.readiness.readyForAccounting?<p role="alert" style={s.reasons}>{vi?"Lý do bị chặn":"전달 불가 원인"}: {employee.readiness.blockingCodes.join(", ")}</p>:null}
      {employee.readiness.warningCodes.length>0?<p style={s.warnings}>{vi?"Cảnh báo":"참고 경고"}: {employee.readiness.warningCodes.join(", ")}</p>:null}
      <small style={s.hash}>Employee hash {employee.sourceHash}</small>
    </div>
  </details>;
}

function Status({okay,text}:{okay:boolean;text:string}){return <span style={okay?s.statusOkay:s.statusProblem}>{text}</span>}
function Detail({title,value}:{title:string;value:string}){return <div style={s.detail}><b>{title}</b><span>{value}</span></div>}

const s={panel:{display:"grid",gap:10,padding:14,border:"1px solid #bfdbfe",borderRadius:14,background:"#f8fbff"},heading:{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10},title:{margin:0,fontSize:17},help:{margin:"4px 0 0",fontSize:11,color:"#64748b",lineHeight:1.45},readyBadge:{padding:"4px 8px",borderRadius:999,background:"#dcfce7",color:"#166534",fontSize:10,fontWeight:900,whiteSpace:"nowrap"},blockedBadge:{padding:"4px 8px",borderRadius:999,background:"#ffedd5",color:"#9a3412",fontSize:10,fontWeight:900,whiteSpace:"nowrap"},metrics:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(105px,1fr))",gap:6},metric:{display:"flex",justifyContent:"space-between",gap:6,padding:"7px 8px",borderRadius:9,background:"#fff",border:"1px solid #e2e8f0",fontSize:10.5},table:{display:"grid",gap:4,overflowX:"auto"},header:{display:"grid",gridTemplateColumns:"minmax(100px,1.3fr) repeat(6,minmax(74px,1fr))",gap:6,minWidth:650,padding:"6px 8px",fontSize:10,fontWeight:900,color:"#64748b"},employee:{minWidth:650,border:"1px solid #e2e8f0",borderRadius:9,background:"#fff",overflow:"hidden"},row:{display:"grid",gridTemplateColumns:"minmax(100px,1.3fr) repeat(6,minmax(74px,1fr))",alignItems:"center",gap:6,padding:"8px",fontSize:10.5,cursor:"pointer",listStyle:"none"},statusOkay:{display:"inline-flex",width:"fit-content",padding:"2px 5px",borderRadius:999,background:"#f1f5f9",color:"#475569",fontWeight:800},statusProblem:{display:"inline-flex",width:"fit-content",padding:"2px 5px",borderRadius:999,background:"#ffedd5",color:"#9a3412",fontWeight:900},details:{display:"grid",gap:5,padding:"8px 10px",borderTop:"1px solid #e2e8f0",background:"#f8fafc"},detail:{display:"flex",justifyContent:"space-between",gap:12,fontSize:10.5},reasons:{margin:0,padding:"6px 8px",borderRadius:7,background:"#fff7ed",color:"#9a3412",fontSize:10.5},warnings:{margin:0,color:"#92400e",fontSize:10.5},hash:{fontSize:9.5,color:"#64748b",overflowWrap:"anywhere"}} satisfies Record<string,CSSProperties>;
