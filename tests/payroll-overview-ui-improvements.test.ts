import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { calculatePayrollInsuranceTotals } from "../lib/payroll/insurance.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { getPayrollHeaderAmount } from "../lib/payroll/payroll-page-display.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { formatPositiveIntegerInput, normalizePositiveIntegerInput } from "../lib/payroll/positive-integer-input.ts";

const read=(path:string)=>fs.readFileSync(path,"utf8");
const card=read("components/payroll/CompensationCard.tsx");
const page=read("app/(protected)/admin/payroll/page.tsx");
const copy=read("lib/text/payroll-overview.ts");
const projection=read("lib/payroll/overview-projection.ts");

test("adjustment modal alone is top-aligned with emoji labels and centered actions",()=>{
  assert.match(card,/placement="top"/);
  for(const emoji of ["💰","📅","📝","📌"]) assert.match(card,new RegExp(emoji));
  assert.match(card,/modalFooter: \{ display: "flex", justifyContent: "center"/);
  assert.match(card,/modalAction: \{ minWidth: 148, maxWidth: "100%" \}/);
  assert.match(card,/busy \|\| mutationCompleted/);
});

test("part totals include the localized part and full employee count without the old help",()=>{
  assert.match(card,/partName: string/);
  assert.match(card,/employees\.length/);
  assert.match(page,/partName=\{partLabel\(l,group\.part\)\}/);
  assert.match(page,/group\.part !== "owner"/);
  assert.doesNotMatch(card,/t\.totalHelp/);
});

test("cost card is a compact three-column bilingual grouped table",()=>{
  assert.match(page,/gridTemplateColumns:"minmax\(0,32%\) minmax\(0,34%\) minmax\(0,34%\)"/);
  assert.match(page,/whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"/);
  assert.match(page,/CostGroup title=\{table\.payrollGroup\}/);
  assert.match(page,/CostGroup title=\{table\.companyGroup\}/);
  assert.doesNotMatch(page,/auxiliary\/\>|paddingLeft:24/);
  for(const phrase of ["설명","현재","예상","급여내용","회사지출","Nội dung","Hiện tại","Dự kiến","Chi phí công ty"]) assert.match(copy,new RegExp(phrase));
});

test("projected summary uses monthly contract amount and only registered adjustments",()=>{
  const employee={
    contract:{},
    amounts:{combinedSalary:8_000_000,contractMonthlyEquivalent:null,incentiveAmount:100_000,overtimeAmount:50_000,otherAdditionAmount:20_000,automaticPenaltyAmount:30_000,manualPenaltyAmount:20_000,otherDeductionAmount:10_000,employeeInsuranceDeductionAmount:100_000,employerInsuranceAmount:200_000},
  };
  assert.equal(getPayrollHeaderAmount(employee),8_000_000);
  assert.match(projection,/getPayrollHeaderAmount\(employee\)/);
  assert.match(projection,/incentiveAmount[\s\S]+overtimeAmount[\s\S]+otherAdditionAmount[\s\S]+automaticPenaltyAmount[\s\S]+manualPenaltyAmount[\s\S]+otherDeductionAmount/);
  const result=calculatePayrollInsuranceTotals({
    preInsurancePayoutAmounts:[8_110_000],
    employeeDeductionAmounts:[100_000],
    employerAmounts:[200_000],
    directorAmount:300_000,
  });
  assert.deepEqual(result,{
    totalPreInsurancePayoutAmount:8_110_000,
    totalEmployeeInsuranceDeductionAmount:100_000,
    totalNetAmount:8_010_000,
    totalEmployerInsuranceAmount:200_000,
    directorInsuranceAmount:300_000,
    totalInsuranceRemittanceAmount:600_000,
    totalCompanyCostAmount:8_610_000,
  });
  assert.match(projection,/unavailableEmployeeCount/);
  assert.match(projection,/partial: unavailableEmployeeCount > 0/);
});

test("adjustment amount input normalizes positive integers and displays grouping separators",()=>{
  assert.equal(normalizePositiveIntegerInput("234324324"),"234324324");
  assert.equal(formatPositiveIntegerInput("234324324"),"234,324,324");
  assert.equal(normalizePositiveIntegerInput("1,500,000"),"1500000");
  assert.equal(normalizePositiveIntegerInput("0001500"),"1500");
  assert.equal(normalizePositiveIntegerInput("-12.5abc"),"125");
  assert.equal(normalizePositiveIntegerInput("abc"),"");
  assert.match(card,/type="text"[\s\S]+inputMode="numeric"[\s\S]+pattern="\[0-9\]\*"/);
  assert.match(card,/amount: Number\(amount\)/);
});

test("adjustment fields distinguish required reasons from optional internal notes",()=>{
  for(const phrase of ["사유 (필수)","내부 메모 (선택)","양수 정수로 입력하세요. 입력 금액은 급여에 추가됩니다.","양수 정수로 입력하세요. 입력 금액은 급여에서 자동 차감됩니다.","Lý do (bắt buộc)","Ghi chú nội bộ (không bắt buộc)","Nhập số nguyên dương. Khoản phạt sẽ tự động được trừ.","매출 목표 달성 보너스","비품 파손","필요한 추가 내용을 입력하세요."]) assert.ok(card.includes(phrase),phrase);
});

test("cost table uses concise bilingual labels and uniform row alignment",()=>{
  for(const phrase of ["지급대상액","직원 보험공제","실수령액","회사 보험부담","법인장 보험비","보험기관 납부액","총인건비","Khoản chi trả","BH nhân viên","Thực nhận","BH công ty","BH giám đốc","Nộp bảo hiểm","Tổng nhân sự"]) assert.ok(copy.includes(phrase),phrase);
  assert.match(page,/descriptionHeader:\{textAlign:"left"\}/);
  assert.doesNotMatch(page,/auxiliary|paddingLeft:16|paddingLeft:24/);
  assert.match(page,/fontSize:10\.5[\s\S]+fontVariantNumeric:"tabular-nums",fontSize:10\.5/);
});
