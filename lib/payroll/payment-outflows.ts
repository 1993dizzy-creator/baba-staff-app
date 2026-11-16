// /admin/payroll/[runId] 지급장부 표시 전용(읽기 전용). 저장된 지급 기록만으로 직원별 지급 계좌·분할 지급과
// 배치 반올림 잔차를 지급일·출금계좌별로 묶는다. DB의 ledger_project_payroll_payment_group_v1과 같은 규칙:
//   - 활성(active) 분할 allocation이 있는 지급 기록 → allocation 행들이 출금 라인
//   - 없으면 → 지급 기록 1건(payment_date, fund_account_id, actual_paid_amount)이 출금 라인
//   - 배치 잔차(residual) → 어느 직원에게도 배분하지 않는 별도 출금 라인
// 금액을 재계산·보정하지 않으며, 분할 합계가 실제 지급액과 다르면 그대로 불일치로 표시한다.

export type OutflowEmployee = {
  id: number;
  employee_name: string;
  payment_status: "unpaid" | "paid";
  actual_paid_amount: number | null;
  payment_date: string | null;
  fund_account_id: number | null;
};
export type OutflowAllocation = {
  id: number;
  employee_payment_id: number;
  payment_date: string;
  fund_account_id: number;
  amount: number;
  allocation_kind: "salary" | "penalty_refund";
  note: string | null;
  status: "active" | "cancelled";
};
export type OutflowResidual = { id: number; payment_date: string; fund_account_id: number; amount: number; reason: string };

export type OutflowLine = { paymentDate: string | null; fundAccountId: number | null; amount: number; kind: "salary" | "penalty_refund"; note: string | null };
export type OutflowGroup = { paymentDate: string | null; fundAccountId: number | null; amount: number; employeeCount: number; residualAmount: number };
export type PaymentOutflows = {
  /** employee_payment id → 출금 라인. 미지급 직원은 없음. */
  linesByPayment: Map<number, OutflowLine[]>;
  /** 분할 합계 ≠ 실제 지급액인 지급 기록 id(표시 경고용, 데이터는 바꾸지 않음) */
  mismatchedPaymentIds: number[];
  groups: OutflowGroup[];
  residuals: OutflowResidual[];
  employeePaidTotal: number;
  residualTotal: number;
  outflowTotal: number;
};

const amountOf = (value: unknown) => { const number = Number(value); return Number.isFinite(number) ? number : 0; };
const groupKey = (date: string | null, account: number | null) => `${date ?? "-"}:${account ?? "-"}`;

export function buildPaymentOutflows(input: { employees: readonly OutflowEmployee[]; allocations?: readonly OutflowAllocation[] | null; residuals?: readonly OutflowResidual[] | null }): PaymentOutflows {
  const activeByPayment = new Map<number, OutflowAllocation[]>();
  for (const allocation of input.allocations ?? []) {
    if (allocation.status !== "active") continue;
    const list = activeByPayment.get(allocation.employee_payment_id) ?? [];
    list.push(allocation);
    activeByPayment.set(allocation.employee_payment_id, list);
  }
  const linesByPayment = new Map<number, OutflowLine[]>();
  const mismatchedPaymentIds: number[] = [];
  const groups = new Map<string, OutflowGroup & { payments: Set<number> }>();
  const addToGroup = (date: string | null, account: number | null, amount: number, paymentId: number | null) => {
    const key = groupKey(date, account);
    const group = groups.get(key) ?? { paymentDate: date, fundAccountId: account, amount: 0, employeeCount: 0, residualAmount: 0, payments: new Set<number>() };
    group.amount += amount;
    if (paymentId === null) group.residualAmount += amount; else group.payments.add(paymentId);
    groups.set(key, group);
  };
  let employeePaidTotal = 0;
  for (const employee of input.employees) {
    if (employee.payment_status !== "paid") continue;
    const paid = amountOf(employee.actual_paid_amount);
    employeePaidTotal += paid;
    const split = activeByPayment.get(employee.id);
    const lines: OutflowLine[] = split?.length
      ? [...split].sort((a, b) => a.payment_date.localeCompare(b.payment_date) || a.fund_account_id - b.fund_account_id || a.id - b.id)
        .map(a => ({ paymentDate: a.payment_date, fundAccountId: a.fund_account_id, amount: amountOf(a.amount), kind: a.allocation_kind, note: a.note }))
      : [{ paymentDate: employee.payment_date, fundAccountId: employee.fund_account_id, amount: paid, kind: "salary", note: null }];
    if (split?.length && lines.reduce((sum, line) => sum + line.amount, 0) !== paid) mismatchedPaymentIds.push(employee.id);
    linesByPayment.set(employee.id, lines);
    for (const line of lines) addToGroup(line.paymentDate, line.fundAccountId, line.amount, employee.id);
  }
  const residuals = [...(input.residuals ?? [])].sort((a, b) => a.payment_date.localeCompare(b.payment_date) || a.fund_account_id - b.fund_account_id);
  let residualTotal = 0;
  for (const residual of residuals) { residualTotal += amountOf(residual.amount); addToGroup(residual.payment_date, residual.fund_account_id, amountOf(residual.amount), null); }
  const sortedGroups = [...groups.values()]
    .sort((a, b) => (a.paymentDate ?? "9999").localeCompare(b.paymentDate ?? "9999") || (a.fundAccountId ?? Infinity) - (b.fundAccountId ?? Infinity))
    .map(({ payments, ...group }) => ({ ...group, employeeCount: payments.size }));
  const outflowTotal = sortedGroups.reduce((sum, group) => sum + group.amount, 0);
  return { linesByPayment, mismatchedPaymentIds, groups: sortedGroups, residuals, employeePaidTotal, residualTotal, outflowTotal };
}

export type PayrollAuditEntry = { id: number; action: string; reason: string | null; created_at: string; employee_payment_id: number | null; after_snapshot?: unknown; before_snapshot?: unknown };
const AUDIT_LABELS: Record<string, [string, string]> = {
  batch_started: ["지급 시작", "Bắt đầu chi trả"],
  employee_paid: ["직원 지급완료", "Đã trả nhân viên"],
  employee_payment_cancelled: ["직원 지급 취소", "Hủy chi trả nhân viên"],
  batch_completed: ["지급 완료", "Hoàn tất chi trả"],
  batch_reopened: ["배치 재개", "Mở lại lô"],
  special_settlement_applied: ["특별 정산 기록(정정본 실지급)", "Ghi nhận quyết toán đặc biệt"],
};
export function payrollAuditLabel(action: string, vi: boolean) { const label = AUDIT_LABELS[action]; return label ? label[vi ? 1 : 0] : action; }
/** 감사 로그 대상 직원명: 지급 당시 스냅샷의 employee_name만 쓴다(없으면 null). */
export function payrollAuditEmployeeName(entry: PayrollAuditEntry): string | null {
  for (const snapshot of [entry.after_snapshot, entry.before_snapshot]) {
    if (snapshot && typeof snapshot === "object" && typeof (snapshot as { employee_name?: unknown }).employee_name === "string") return (snapshot as { employee_name: string }).employee_name;
  }
  return null;
}
