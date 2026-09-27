export type OwnerInvestmentCashAction = "contribution" | "recovery";

export type OwnerInvestmentCashEventInput = {
  participantId: number;
  action: OwnerInvestmentCashAction;
  amount: number;
  occurredAt: string;
  fundAccountId: number;
  reason: string;
  memo: string | null;
};

const ALLOWED_KEYS = new Set([
  "participantId",
  "action",
  "amount",
  "occurredAt",
  "fundAccountId",
  "reason",
  "memo",
]);

export function parseOwnerInvestmentCashEventInput(value: unknown): OwnerInvestmentCashEventInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key))) return null;
  const participantId = Number(input.participantId);
  const fundAccountId = Number(input.fundAccountId);
  const amount = Number(input.amount);
  const action = input.action;
  const occurredAt = typeof input.occurredAt === "string" ? input.occurredAt.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const memo = input.memo === null || input.memo === undefined || input.memo === ""
    ? null
    : typeof input.memo === "string" ? input.memo.trim() : undefined;
  if (!Number.isSafeInteger(participantId) || participantId < 1) return null;
  if (!Number.isSafeInteger(fundAccountId) || fundAccountId < 1) return null;
  if (action !== "contribution" && action !== "recovery") return null;
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER) return null;
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) return null;
  if (!reason || reason.length > 5000 || memo === undefined || (memo?.length ?? 0) > 5000) return null;
  return { participantId, action, amount, occurredAt, fundAccountId, reason, memo };
}

export function ownerInvestmentCashEventErrorStatus(status: string) {
  if (status === "forbidden") return 403;
  if ([
    "negative_cumulative_investment",
    "investment_below_recovery_obligation",
    "closed_month",
  ].includes(status)) return 409;
  return 400;
}
