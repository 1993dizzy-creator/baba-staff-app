import type { MenuSalesItem } from "@/lib/sales/menu-sales";

/**
 * BABA-specific employment agreement, not a general payroll configuration.
 *
 * Quyen currently receives 3% of the monthly C5/J7/J8 menu sales amount as
 * the kitchen-lead incentive. There is exactly one employee and one policy,
 * so adding a settings screen or policy table would create unnecessary
 * operational surface area. The employee is resolved by username (never by a
 * production numeric id), and the rate is expressed in basis points to avoid
 * ambiguous floating-point policy constants.
 *
 * The sales amount MUST come from the same menu-sales projection used by
 * /admin/sales/monthly, including option amounts attributed to their parent
 * menu. Payroll never adds this number directly: the monthly job persists one
 * payroll_monthly_adjustments row, protected by source_type/source_key
 * uniqueness and the existing paid-payroll lock.
 *
 * If BABA adds more employees, menu sets, or incentive formulas, migrate this
 * source-level agreement to a general policy system instead of growing a list
 * of special cases here.
 */
export const QUYEN_MENU_SALES_INCENTIVE_POLICY = {
  username: "quyen",
  itemCodes: ["C5", "J7", "J8"],
  rateBasisPoints: 300,
  effectiveFromMonth: "2026-09",
  sourceType: "sales_menu_incentive",
  sourceVersion: "v1",
} as const;

export type QuyenMenuSalesIncentiveCalculation = {
  month: string;
  items: Array<{ itemCode: string; quantity: number; amount: number }>;
  totalQuantity: number;
  totalSalesAmount: number;
  rateBasisPoints: number;
  incentiveAmount: number;
  reason: string;
  note: string;
  businessDate: string;
  sourceType: typeof QUYEN_MENU_SALES_INCENTIVE_POLICY.sourceType;
  sourceKey: string;
};

export type ExistingSalesMenuIncentiveAdjustment = {
  id: number;
  amount: number;
  businessDate: string;
  reason: string;
  note: string | null;
  cancelledAt: string | null;
};

export type SalesMenuIncentiveAdjustmentInput = {
  userId: number;
  payrollMonth: string;
  kind: "incentive";
  category: "sales";
  amount: number;
  businessDate: string;
  reason: string;
  note: string;
  sourceType: typeof QUYEN_MENU_SALES_INCENTIVE_POLICY.sourceType;
  sourceKey: string;
  createdBy: number;
};

export interface QuyenMenuSalesIncentiveRepository {
  resolveUserId(username: string, systemAccount: boolean): Promise<number | null>;
  isPayrollPaid(month: string, userId: number): Promise<boolean>;
  findAdjustment(sourceType: string, sourceKey: string): Promise<ExistingSalesMenuIncentiveAdjustment | null>;
  createAdjustment(input: SalesMenuIncentiveAdjustmentInput): Promise<void>;
  updateAdjustment(id: number, input: SalesMenuIncentiveAdjustmentInput): Promise<void>;
}

function formatQuantity(value: number) {
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function formatAmount(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

export function getPayrollMonthLastDate(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

export function getQuyenMenuSalesIncentiveSourceKey(month: string) {
  return `quyen-menu-sales-incentive:${month}:${QUYEN_MENU_SALES_INCENTIVE_POLICY.sourceVersion}`;
}

export function calculateQuyenMenuSalesIncentive(
  month: string,
  menuSalesItems: readonly MenuSalesItem[]
): QuyenMenuSalesIncentiveCalculation {
  const sums = new Map<string, { itemCode: string; quantity: number; amount: number }>(
    QUYEN_MENU_SALES_INCENTIVE_POLICY.itemCodes.map((itemCode) => [
      itemCode,
      { itemCode, quantity: 0, amount: 0 },
    ])
  );

  for (const item of menuSalesItems) {
    const itemCode = item.itemCode?.trim().toUpperCase();
    if (!itemCode || !sums.has(itemCode)) continue;
    const sum = sums.get(itemCode)!;
    sum.quantity += Number(item.quantity || 0);
    sum.amount += Number(item.amount || 0);
  }

  const items = QUYEN_MENU_SALES_INCENTIVE_POLICY.itemCodes.map(
    (itemCode) => sums.get(itemCode)!
  );
  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);
  const totalSalesAmount = items.reduce((total, item) => total + item.amount, 0);
  const incentiveAmount = Math.round(
    totalSalesAmount * QUYEN_MENU_SALES_INCENTIVE_POLICY.rateBasisPoints / 10_000
  );
  const ratePercent = QUYEN_MENU_SALES_INCENTIVE_POLICY.rateBasisPoints / 100;
  const itemNotes = items.map(
    (item) => `${item.itemCode}: ${formatQuantity(item.quantity)}개 / ${formatAmount(item.amount)} VND`
  );

  return {
    month,
    items,
    totalQuantity,
    totalSalesAmount,
    rateBasisPoints: QUYEN_MENU_SALES_INCENTIVE_POLICY.rateBasisPoints,
    incentiveAmount,
    reason: `Quyen ${QUYEN_MENU_SALES_INCENTIVE_POLICY.itemCodes.join("/")} 메뉴 판매 인센티브 ${ratePercent}%`,
    note: [
      ...itemNotes,
      `합계: ${formatQuantity(totalQuantity)}개 / ${formatAmount(totalSalesAmount)} VND`,
      `비율: ${ratePercent}%`,
      `인센티브: ${formatAmount(incentiveAmount)} VND`,
    ].join("\n"),
    businessDate: getPayrollMonthLastDate(month),
    sourceType: QUYEN_MENU_SALES_INCENTIVE_POLICY.sourceType,
    sourceKey: getQuyenMenuSalesIncentiveSourceKey(month),
  };
}

export function resolveQuyenMenuSalesIncentiveCronTarget(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (day !== 1) return { ok: false as const, reason: "not_first_day" as const };

  const target = new Date(Date.UTC(year, month - 2, 1));
  const targetMonth = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}`;
  if (targetMonth < QUYEN_MENU_SALES_INCENTIVE_POLICY.effectiveFromMonth) {
    return { ok: false as const, reason: "before_effective_month" as const, targetMonth };
  }
  return { ok: true as const, targetMonth };
}

function sameAdjustment(
  existing: ExistingSalesMenuIncentiveAdjustment,
  calculation: QuyenMenuSalesIncentiveCalculation
) {
  return existing.cancelledAt === null
    && existing.amount === calculation.incentiveAmount
    && existing.businessDate === calculation.businessDate
    && existing.reason === calculation.reason
    && existing.note === calculation.note;
}

/**
 * Persists exactly one automatic adjustment for the month. source_key is
 * deterministic, so retries converge on the same row; an unpaid row may be
 * refreshed after late POS corrections, while the existing database paid-lock
 * remains authoritative once Quyen's payroll has been paid. This is why the
 * calculation is kept out of the payroll engine itself: the adjustment ledger
 * is the auditable boundary between final POS sales and salary calculation.
 */
export async function syncQuyenMenuSalesIncentive(params: {
  calculation: QuyenMenuSalesIncentiveCalculation;
  repository: QuyenMenuSalesIncentiveRepository;
}) {
  const { calculation, repository } = params;
  if (calculation.incentiveAmount <= 0) {
    return { status: "no_sales" as const, month: calculation.month };
  }

  const [userId, createdBy] = await Promise.all([
    repository.resolveUserId(QUYEN_MENU_SALES_INCENTIVE_POLICY.username, false),
    repository.resolveUserId("pos", true),
  ]);
  if (!userId) return { status: "target_user_not_found" as const, month: calculation.month };
  if (!createdBy) return { status: "system_actor_not_found" as const, month: calculation.month };
  if (await repository.isPayrollPaid(calculation.month, userId)) {
    return { status: "locked" as const, month: calculation.month };
  }

  const input: SalesMenuIncentiveAdjustmentInput = {
    userId,
    payrollMonth: `${calculation.month}-01`,
    kind: "incentive",
    category: "sales",
    amount: calculation.incentiveAmount,
    businessDate: calculation.businessDate,
    reason: calculation.reason,
    note: calculation.note,
    sourceType: calculation.sourceType,
    sourceKey: calculation.sourceKey,
    createdBy,
  };
  const existing = await repository.findAdjustment(calculation.sourceType, calculation.sourceKey);
  if (!existing) {
    await repository.createAdjustment(input);
    return { status: "created" as const, month: calculation.month, amount: calculation.incentiveAmount };
  }
  if (sameAdjustment(existing, calculation)) {
    return { status: "unchanged" as const, month: calculation.month, amount: calculation.incentiveAmount };
  }

  await repository.updateAdjustment(existing.id, input);
  return { status: "updated" as const, month: calculation.month, amount: calculation.incentiveAmount };
}
