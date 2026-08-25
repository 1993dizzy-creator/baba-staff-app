export type LedgerEntryItem = {
  candidateId?: number;
  transactionId?: number;
  name: string;
  quantity?: number | null;
  unitPrice?: number | null;
  amount: number;
  categoryId?: number | null;
  categoryName?: string | null;
  paymentMode?: "immediate" | "payable";
  fundAccountId?: number | null;
  dueDate?: string | null;
  payableStatus?: string | null;
  paidAmount?: number;
  memo?: string | null;
};

export type LedgerEntry = {
  id: string;
  businessDate: string;
  direction: "income" | "expense" | "transfer";
  origin: "auto" | "manual";
  status: "confirmed" | "pending";
  title: string;
  subtitle: string;
  amount: number;
  accountName: string | null;
  categoryName: string | null;
  transactionId: number | null;
  drilldown: "inventory" | "pos" | "payroll" | "generic";
  defaultResolution?: "immediate" | "payable";
  defaultFundAccountId?: number | null;
  partyId?: number | null;
  items: LedgerEntryItem[];
};

export type TransactionRow = {
  id: number | string; type: string; business_date: string; amount: number | string;
  party_id?: number | string | null;
  correction_of_id?: number | string | null;
  economic_effect_sign?: number | string | null; source_type: string; source_key?: string | null;
  memo?: string | null; category?: { id?: number | string; name?: string | null } | null; party?: { name?: string | null } | null;
  source_snapshot?: Record<string, unknown> | null;
  movements?: Array<{ amount?: number | string; fund_account?: { id?: number | string; display_name?: string | null } | null }>;
  payable?: { id?: number|string; due_date?:string|null; status?:string|null; allocations?:Array<{allocated_amount?:number|string}> }|null;
};

export type CandidateRow = {
  id: number | string; business_date: string; proposed_amount: number | string;
  proposed_category_id?: number | string | null; proposed_party_id?: number | string | null;
  source_snapshot?: Record<string, unknown> | null;
  category?: { name?: string | null } | null; party?: { name?: string | null } | null;
};

export type PartnerLedgerDefault = {
  paymentMode: "immediate" | "postpaid";
  defaultFundAccountId: number | null;
  defaultFundAccountName: string | null;
};

const value = (input: unknown) => Number(input ?? 0);
const inventoryItem = (row: CandidateRow | TransactionRow): LedgerEntryItem => {
  const snapshot = row.source_snapshot ?? {};
  return {
    ...(Object.hasOwn(row, "proposed_amount") ? { candidateId: value((row as CandidateRow).id) } : { transactionId: value(row.id) }),
    name: String(snapshot.item_name ?? snapshot.item_name_vi ?? "품목"),
    quantity: snapshot.change_quantity == null ? null : value(snapshot.change_quantity),
    unitPrice: snapshot.purchase_price == null ? null : value(snapshot.purchase_price),
    amount: Object.hasOwn(row, "proposed_amount") ? value((row as CandidateRow).proposed_amount) : value((row as TransactionRow).amount),
    categoryId: Object.hasOwn(row, "proposed_category_id") ? ((row as CandidateRow).proposed_category_id == null ? null : value((row as CandidateRow).proposed_category_id)) : ((row as TransactionRow).category?.id == null ? null : value((row as TransactionRow).category?.id)),
    categoryName: row.category?.name ?? (snapshot.category ? String(snapshot.category) : null),
    ...(!Object.hasOwn(row, "proposed_amount") ? {
      paymentMode: (row as TransactionRow).payable ? "payable" as const : "immediate" as const,
      fundAccountId: (row as TransactionRow).movements?.find(item=>value(item.amount)<0)?.fund_account?.id == null ? null : value((row as TransactionRow).movements?.find(item=>value(item.amount)<0)?.fund_account?.id),
      dueDate: (row as TransactionRow).payable?.due_date ?? null,
      payableStatus: (row as TransactionRow).payable?.status ?? null,
      paidAmount: ((row as TransactionRow).payable?.allocations??[]).reduce((sum,item)=>sum+value(item.allocated_amount),0),
      memo: (row as TransactionRow).memo ?? null,
    } : {}),
  };
};

function paymentBucket(sourceKey: string | null | undefined) {
  return sourceKey?.split(":").at(-1) ?? "other";
}

function posTitle(bucket: string) {
  if (bucket === "cash") return "POS 현금매출";
  if (bucket === "card") return "POS 카드매출";
  if (bucket === "transfer") return "POS 계좌이체 매출";
  return "POS 기타매출";
}

export function buildLedgerEntries(
  transactions: readonly TransactionRow[],
  candidates: readonly CandidateRow[],
  partnerDefaultsByParty: ReadonlyMap<number, PartnerLedgerDefault>,
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const inventoryGroups = new Map<string, LedgerEntry>();
  const reversedInventoryIds = new Set(
    transactions
      .filter(row => row.source_type === "inventory_purchase_reversal" && row.correction_of_id != null)
      .map(row => value(row.correction_of_id)),
  );

  for (const row of transactions) {
    if (row.type === "opening") continue;
    if (row.source_type === "inventory_purchase_reversal") continue;
    if (row.source_type === "inventory_purchase_candidate" || row.source_type === "inventory_purchase_rebook") {
      if (reversedInventoryIds.has(value(row.id))) continue;
    }
    const transactionId = value(row.id);
    const amount = value(row.amount);
    const expense = value(row.economic_effect_sign) < 0 || row.type === "expense" || row.type === "expense_recognition" || row.type === "payable_payment";
    const direction = row.type === "transfer" || row.type === "card_settlement" ? "transfer" : expense ? "expense" : "income";
    const movement = row.movements?.find(item => direction === "income" ? value(item.amount) > 0 : value(item.amount) < 0) ?? row.movements?.[0];
    const accountName = movement?.fund_account?.display_name ?? null;
    const automatic = row.source_type !== "manual";

    if (row.source_type === "inventory_purchase_candidate" || row.source_type === "inventory_purchase_rebook") {
      const partyName = row.party?.name ?? "거래처 미지정";
      const key = `confirmed-inventory:${row.business_date}:${row.party_id ?? partyName}:${accountName ?? "payable"}`;
      const group = inventoryGroups.get(key) ?? {
        id: key, businessDate: row.business_date, direction: "expense", origin: "auto", status: "confirmed",
        title: partyName, subtitle: "0품목", amount: 0, accountName: accountName ?? "미지급",
        categoryName: row.category?.name ?? null, transactionId, drilldown: "inventory", items: [],
      } satisfies LedgerEntry;
      group.amount += amount;
      group.items.push(inventoryItem(row));
      group.subtitle = `${group.items.length}품목`;
      inventoryGroups.set(key, group);
      continue;
    }

    const snapshot = row.source_snapshot ?? {};
    const pos = row.source_type === "pos_sales_daily_payment";
    const payroll = row.source_type.includes("payroll");
    entries.push({
      id: `transaction:${transactionId}`, businessDate: row.business_date, direction,
      origin: automatic ? "auto" : "manual", status: "confirmed",
      title: pos ? posTitle(paymentBucket(row.source_key)) : payroll ? "급여 · 인건비" : row.memo || row.party?.name || row.category?.name || "장부 거래",
      subtitle: pos ? `영수증 ${value(snapshot.receiptCount)}건` : row.category?.name ?? (automatic ? "자동 장부" : "수동 입력"),
      amount, accountName, categoryName: row.category?.name ?? null, transactionId,
      drilldown: pos ? "pos" : payroll ? "payroll" : "generic", items: [],
    });
  }

  for (const row of candidates) {
    const partyId = row.proposed_party_id == null ? null : value(row.proposed_party_id);
    const defaults = partyId === null ? undefined : partnerDefaultsByParty.get(partyId);
    const resolution = defaults?.paymentMode === "postpaid" ? "payable" : "immediate";
    const partyName = row.party?.name ?? "거래처 미지정";
    const accountName = resolution === "payable" ? "미지급" : defaults?.defaultFundAccountName ?? "결제계정 확인 필요";
    const key = `pending-inventory:${row.business_date}:${partyId ?? "none"}:${resolution}:${defaults?.defaultFundAccountId ?? "none"}`;
    const group = inventoryGroups.get(key) ?? {
      id: key, businessDate: row.business_date, direction: "expense", origin: "auto", status: "pending",
      title: partyName, subtitle: "0품목 · 확인 필요", amount: 0, accountName,
      categoryName: row.category?.name ?? null, transactionId: null, drilldown: "inventory",
      defaultResolution: resolution, defaultFundAccountId: defaults?.defaultFundAccountId ?? null,
      partyId, items: [],
    } satisfies LedgerEntry;
    group.amount += value(row.proposed_amount);
    group.items.push(inventoryItem(row));
    group.subtitle = `${group.items.length}품목 · 확인 필요`;
    inventoryGroups.set(key, group);
  }

  entries.push(...inventoryGroups.values());
  return entries.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || Number(b.status === "pending") - Number(a.status === "pending") || b.amount - a.amount);
}
