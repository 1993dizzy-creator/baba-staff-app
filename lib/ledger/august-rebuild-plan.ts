/**
 * Pure, NO-DB-WRITES BABA August 2026 reconstruction preflight.
 *
 * The 505 authoritative sheet cells are money-flow evidence, not instructions
 * to manufacture expense or revenue transactions.  This module never opens a
 * connection, changes a ledger transaction, or generates SQL.  An actual atomic
 * RPC must independently revalidate every source/row and authorization.
 *
 * Money is represented as signed integer thousandths of VND (BigInt).  This
 * avoids floating-point drift for amounts such as 91,763.1 or 149,781,532.5.
 */
export const AUGUST_MONTH = "2026-08" as const;
export const CASH_ACCOUNT = "store_cash" as const;
export const FUND_ACCOUNTS = [
  "store_cash",
  "vuong_personal_custody",
  "cho_personal_custody",
  "baba_corporate_bank",
] as const;

export type FundAccount = (typeof FUND_ACCOUNTS)[number];
export type SheetAccount = FundAccount | "card_clearing";
export type MoneyVnd = string;
export type SourceConfidence = "verified" | "candidate" | "unlinked";

export interface SheetCell {
  cell: string; // G/H/I/J/K + actual row number
  businessDate: string; // YYYY-MM-DD, 03:00 business-day cutoff ALREADY applied
  account: SheetAccount;
  signedAmountVnd: MoneyVnd;
}

export interface SourceLink {
  cell: string;
  confidence: SourceConfidence;
  classification: string;
  transactionIds: readonly string[];
  evidenceReference?: string; // verified bank statement, supplier invoice, or immutable source ID
  reason: string;
}

export interface ExistingTransaction {
  id: string;
  type: string;
  sourceType: string;
  status: "confirmed";
  recognitionMonth: string | null;
}

export interface ExistingMovement {
  id: string;
  transactionId: string;
  businessDate: string;
  account: FundAccount;
  signedAmountVnd: MoneyVnd;
}

export type AdjustmentKind =
  | "transfer"                 // pair: one out, one in; no P&L
  | "relocate-payment"         // negate an existing movement; rebook day/account
  | "restore-outflow"          // recognize an already-accounted cost's CASH payment only
  | "restore-inflow"           // recognize an existing sale/income's CASH receipt only
  | "remove-technical";        // negate one specific legacy balance adjustment

export interface AdjustmentEffect {
  businessDate: string;
  account: FundAccount;
  signedAmountVnd: MoneyVnd;
}

export interface RebuildAdjustment {
  id: string; // unique stable id for a proposed action
  kind: AdjustmentKind;
  evidence: "verified" | "provisional" | "blocked";
  rationale: string;
  sheetCells: readonly string[];
  originalMovementId?: string; // mandatory for relocate and technical reversal
  sourceTransactionId?: string; // mandatory for restore-outflow/inflow
  effects: readonly AdjustmentEffect[];
}

export interface ProtectedSignature {
  name: string; // e.g. payable_allocations, inventory_logs, audit_history
  beforeCount: number;
  afterCount: number;
  beforeFingerprint: string;
  afterFingerprint: string;
}

export interface FutureMonth {
  month: "2026-09" | "2026-10";
  currentClosingVnd: Readonly<Record<FundAccount, MoneyVnd>>;
  sheetClosingVnd: Readonly<Record<FundAccount, MoneyVnd>>;
}

export interface RebuildContract {
  expectedSheetCells: number;      // 505 in the actual August production run
  expectedSourceRows?: number;     // 427 in the actual August production run
  sourceRows?: number;
  expectedCardTotalVnd?: MoneyVnd; // 225925720 in the actual August run
  requiredProtectionSets: readonly string[];
  expectedTechnicalMovementIds: readonly string[];
}

export interface RebuildInput {
  contract: RebuildContract;
  sheetCells: readonly SheetCell[];
  sourceLinks: readonly SourceLink[];
  openingVnd: Readonly<Record<FundAccount, MoneyVnd>>;
  sheetClosingVnd: Readonly<Record<FundAccount, MoneyVnd>>;
  currentClosingVnd?: Readonly<Record<FundAccount, MoneyVnd>>;
  transactions: readonly ExistingTransaction[];
  currentMovements: readonly ExistingMovement[]; // confirmed August movements, EXCLUDING opening
  proposedAdjustments: readonly RebuildAdjustment[];
  protections: readonly ProtectedSignature[];
  futureMonths: readonly FutureMonth[];
}

export interface DailyReconciliation {
  date: string;
  account: FundAccount;
  sheetVnd: string;
  beforeVnd: string;
  proposedVnd: string;
  differenceVnd: string;
  matches: boolean;
}

export interface ClosingReconciliation {
  month: string;
  account: FundAccount;
  sheetClosingVnd: string;
  currentClosingVnd: string;
  projectedClosingVnd: string;
  differenceVnd: string;
  matches: boolean;
}

export interface RebuildPreview {
  decision: "GO_FOR_SEPARATE_APPROVAL" | "BLOCKED";
  blockers: readonly string[];
  daily: readonly DailyReconciliation[]; // ALWAYS 124 day/account records
  closing: readonly ClosingReconciliation[]; // 4 per included month
  totals: {
    sheetCellCount: number;
    verifiedSourceLinks: number;
    pendingSourceLinks: number;
    dailyBeforeMatches: number;
    dailyProposedMatches: number;
    dailyRemaining: number;
    augustDifferenceVnd: string;
    sheetCardVnd: string;
  };
}

const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MONTH_DAYS = Array.from({ length: 31 }, (_unused, i) => `${AUGUST_MONTH}-${String(i + 1).padStart(2, "0")}`);
const SHEET_COLUMN: Readonly<Record<SheetAccount, string>> = {
  store_cash: "G",
  vuong_personal_custody: "H",
  cho_personal_custody: "I",
  card_clearing: "J",
  baba_corporate_bank: "K",
};

// Strict string parser.  No Number-based rounding, no scientific notation,
// no commas, and at most three digits of VND subunits.
export function parseVndMilli(amount: MoneyVnd): bigint {
  if (typeof amount !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(amount)) {
    throw new Error(`INVALID_VND: ${String(amount)}`);
  }
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction = ""] = unsigned.split(".");
  const base = BigInt(whole) * BigInt(1000) + BigInt(fraction.padEnd(3, "0") || "0");
  return negative ? -base : base;
}

export function formatVndMilli(value: bigint): string {
  const minus = value < BigInt(0) ? "-" : "";
  const absolute = value < BigInt(0) ? -value : value;
  const fractional = absolute % BigInt(1000);
  if (fractional === BigInt(0)) return `${minus}${absolute / BigInt(1000)}`;
  return `${minus}${absolute / BigInt(1000)}.${String(fractional).padStart(3, "0").replace(/0+$/, "")}`;
}

function checkDate(date: string): boolean {
  if (!DATE.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function aggregateKey(date: string, account: FundAccount) {
  return `${date}|${account}`;
}

function getValue(record: Readonly<Record<FundAccount, MoneyVnd>>, account: FundAccount): bigint {
  return parseVndMilli(record[account]);
}

function mapAdd(map: Map<string, bigint>, key: string, value: bigint): void {
  map.set(key, (map.get(key) ?? BigInt(0)) + value);
}

function assertValidId(id: string, type: string): void {
  if (!id || !id.trim()) throw new Error(`INVALID_${type}_ID`);
}

function evaluateAction(
  action: RebuildAdjustment,
  txById: ReadonlyMap<string, ExistingTransaction>,
  movementById: ReadonlyMap<string, ExistingMovement>,
  sourceCells: ReadonlySet<string>,
  usedMovementIds: Set<string>,
  blockers: string[],
): boolean {
  let valid = true;
  const block = (code: string) => { blockers.push(`${action.id}: ${code}`); valid = false; };
  for (const cell of action.sheetCells) {
    if (!sourceCells.has(cell)) block(`UNKNOWN_SHEET_CELL:${cell}`);
  }
  if (!action.rationale.trim()) block("REASON_REQUIRED");
  if (action.evidence !== "verified") block(`UNVERIFIED_EVIDENCE:${action.evidence}`);
  const effects = action.effects;
  const sum = effects.reduce((amount, e) => amount + parseVndMilli(e.signedAmountVnd), BigInt(0));
  if (!effects.length) block("EMPTY_EFFECTS");
  for (const e of effects) {
    if (!MONTH_DAYS.includes(e.businessDate)) block(`OUTSIDE_AUGUST:${e.businessDate}`);
    if (!FUND_ACCOUNTS.includes(e.account)) block(`INVALID_ACCOUNT:${e.account}`);
    if (parseVndMilli(e.signedAmountVnd) === BigInt(0)) block("ZERO_EFFECT");
  }
  const original = action.originalMovementId ? movementById.get(action.originalMovementId) : undefined;
  if (action.originalMovementId) {
    if (usedMovementIds.has(action.originalMovementId)) block(`DUPLICATE_MOVEMENT_REVERSAL:${action.originalMovementId}`);
    usedMovementIds.add(action.originalMovementId);
  }
  if (action.kind === "transfer") {
    if (effects.length !== 2 || sum !== BigInt(0) || effects[0]?.businessDate !== effects[1]?.businessDate ||
      effects[0]?.account === effects[1]?.account || action.originalMovementId || action.sourceTransactionId ||
      action.sheetCells.length < 2) block("INVALID_TRANSFER_PAIR");
  } else if (action.kind === "relocate-payment") {
    if (!original || effects.length !== 2 || sum !== BigInt(0)) block("INVALID_RELOCATE_SOURCE");
    else if (effects[0]?.businessDate !== original.businessDate ||
      effects[0]?.account !== original.account ||
      parseVndMilli(effects[0].signedAmountVnd) !== -parseVndMilli(original.signedAmountVnd) ||
      parseVndMilli(effects[1].signedAmountVnd) !== parseVndMilli(original.signedAmountVnd)) {
      block("RELOCATION_DOES_NOT_REVERSE_ORIGINAL");
    }
  } else if (action.kind === "remove-technical") {
    const t = original && txById.get(original.transactionId);
    if (!original || effects.length !== 1 || !t || t.type !== "balance_adjustment" ||
      !["ledger_correction", "manual"].includes(t.sourceType) ||
      effects[0]?.businessDate !== original.businessDate || effects[0]?.account !== original.account ||
      parseVndMilli(effects[0].signedAmountVnd) !== -parseVndMilli(original.signedAmountVnd)) {
      block("INVALID_TECHNICAL_REVERSAL");
    }
  } else if (action.kind === "restore-outflow" || action.kind === "restore-inflow") {
    const tx = action.sourceTransactionId && txById.get(action.sourceTransactionId);
    const alreadyPaid = action.sourceTransactionId && [...movementById.values()].some(m => m.transactionId === action.sourceTransactionId);
    const supportedSource = tx && (action.kind === "restore-outflow" ?
      ["expense", "expense_recognition"].includes(tx.type) :
      ["sales", "income"].includes(tx.type));
    if (effects.length !== 1 || !supportedSource || alreadyPaid || action.originalMovementId) block("INVALID_RESTORATION_SOURCE");
    if (action.kind === "restore-outflow" && sum >= BigInt(0)) block("OUTFLOW_MUST_BE_NEGATIVE");
    if (action.kind === "restore-inflow" && sum <= BigInt(0)) block("INFLOW_MUST_BE_POSITIVE");
  } else {
    block("UNKNOWN_ACTION_KIND");
  }
  return valid;
}

/**
 * This is intentionally a pure in-memory, immutable preview; it MUST NEVER
 * be used as the operation that writes to the live database.
 */
export function previewAugustRebuild(input: RebuildInput): RebuildPreview {
  const blockers: string[] = [];
  const block = (message: string) => { blockers.push(message); };
  if (input.sheetCells.length !== input.contract.expectedSheetCells) block("SHEET_CELL_COUNT_CHANGED");
  if (input.contract.expectedSourceRows != null && input.contract.sourceRows !== input.contract.expectedSourceRows) block("SHEET_ROW_COUNT_CHANGED");
  const expectedCells = new Set<string>();
  const sourceDaily = new Map<string, bigint>();
  let cardTotal = BigInt(0);
  for (const cell of input.sheetCells) {
    if (!cell.cell || expectedCells.has(cell.cell)) block(`DUPLICATE_OR_MISSING_SHEET_CELL:${cell.cell}`);
    expectedCells.add(cell.cell);
    if (!MONTH_DAYS.includes(cell.businessDate)) block(`INVALID_SHEET_DAY:${cell.cell}`);
    if (!FUND_ACCOUNTS.includes(cell.account as FundAccount) && cell.account !== "card_clearing") block(`INVALID_SHEET_ACCOUNT:${cell.cell}`);
    if (!new RegExp(`^${SHEET_COLUMN[cell.account]}(?:[4-9]|[1-9]\\d+)$`).test(cell.cell) || Number(cell.cell.slice(1)) > 438) block(`BAD_SHEET_COLUMN:${cell.cell}`);
    const signed = parseVndMilli(cell.signedAmountVnd);
    if (cell.account === "card_clearing") cardTotal += signed;
    else mapAdd(sourceDaily, aggregateKey(cell.businessDate, cell.account), signed);
  }
  if (input.contract.expectedCardTotalVnd && cardTotal !== parseVndMilli(input.contract.expectedCardTotalVnd)) block("CARD_TOTAL_CHANGED");
  const links = new Map<string, SourceLink>();
  let verified = 0;
  for (const link of input.sourceLinks) {
    if (!expectedCells.has(link.cell)) block(`LINK_UNKNOWN_CELL:${link.cell}`);
    if (links.has(link.cell)) block(`DUPLICATE_SHEET_LINK:${link.cell}`);
    if (!link.classification.trim() || !link.reason.trim()) block(`INCOMPLETE_SHEET_LINK:${link.cell}`);
    if (link.confidence === "verified") {
      verified++;
      if (link.transactionIds.length === 0 && !["external-evidence", "sheet-internal-transfer"].includes(link.classification)) {
        block(`VERIFIED_LINK_WITHOUT_SOURCE:${link.cell}`);
      }
      if (!link.evidenceReference?.trim()) block(`VERIFIED_LINK_WITHOUT_EVIDENCE:${link.cell}`);
    } else block(`UNVERIFIED_SHEET_LINK:${link.cell}:${link.confidence}`);
    links.set(link.cell, link);
  }
  for (const cell of expectedCells) if (!links.has(cell)) block(`SHEET_LINK_MISSING:${cell}`);

  const txById = new Map<string, ExistingTransaction>();
  for (const t of input.transactions) {
    assertValidId(t.id, "TRANSACTION");
    if (txById.has(t.id)) block(`DUPLICATE_TRANSACTION:${t.id}`);
    if (t.status !== "confirmed") block(`UNCONFIRMED_TRANSACTION:${t.id}`);
    txById.set(t.id, t);
  }
  for (const link of input.sourceLinks) {
    for (const id of link.transactionIds) {
      if (!txById.has(id)) block(`SOURCE_LINK_TX_NOT_FOUND:${link.cell}:${id}`);
    }
  }
  const movementById = new Map<string, ExistingMovement>();
  const beforeDaily = new Map<string, bigint>();
  for (const m of input.currentMovements) {
    assertValidId(m.id, "MOVEMENT");
    if (movementById.has(m.id)) block(`DUPLICATE_MOVEMENT:${m.id}`);
    movementById.set(m.id, m);
    if (!MONTH_DAYS.includes(m.businessDate)) block(`INVALID_MOVEMENT_DAY:${m.id}`);
    if (!txById.has(m.transactionId)) block(`MISSING_TX_FOR_MOVEMENT:${m.id}`);
    mapAdd(beforeDaily, aggregateKey(m.businessDate, m.account), parseVndMilli(m.signedAmountVnd));
  }

  const afterDaily = new Map(beforeDaily);
  const actionIds = new Set<string>();
  const usedMovementIds = new Set<string>();
  const removedTechnicalIds = new Set<string>();
  for (const action of input.proposedAdjustments) {
    assertValidId(action.id, "ACTION");
    if (actionIds.has(action.id)) block(`DUPLICATE_ACTION:${action.id}`);
    actionIds.add(action.id);
    const valid = evaluateAction(action, txById, movementById, expectedCells, usedMovementIds, blockers);
    if (!valid) continue; // Invalid actions NEVER contribute to the preview.
    if (action.kind === "remove-technical" && action.originalMovementId) removedTechnicalIds.add(action.originalMovementId);
    for (const effect of action.effects) {
      mapAdd(afterDaily, aggregateKey(effect.businessDate, effect.account), parseVndMilli(effect.signedAmountVnd));
    }
  }
  for (const id of input.contract.expectedTechnicalMovementIds) {
    if (!removedTechnicalIds.has(id)) block(`LEGACY_ADJUSTMENT_NOT_REPLACED:${id}`);
  }
  if (removedTechnicalIds.size !== input.contract.expectedTechnicalMovementIds.length) block("UNEXPECTED_TECHNICAL_REVERSAL");
  const signNames = new Set<string>();
  for (const signature of input.protections) {
    if (signNames.has(signature.name)) block(`DUPLICATE_PROTECTION:${signature.name}`);
    signNames.add(signature.name);
    if (!signature.beforeFingerprint || !signature.afterFingerprint || signature.beforeCount !== signature.afterCount ||
        signature.beforeFingerprint !== signature.afterFingerprint) {
      block(`PROTECTED_DATA_CHANGED:${signature.name}`);
    }
  }
  for (const name of input.contract.requiredProtectionSets) {
    if (!signNames.has(name)) block(`PROTECTION_NOT_PROVIDED:${name}`);
  }
  const dayRecords: DailyReconciliation[] = [];
  const accountDelta = new Map<FundAccount, bigint>();
  let beforeMatches = 0;
  let afterMatches = 0;
  for (const day of MONTH_DAYS) {
    for (const account of FUND_ACCOUNTS) {
      const key = aggregateKey(day, account);
      const sheet = sourceDaily.get(key) ?? BigInt(0);
      const before = beforeDaily.get(key) ?? BigInt(0);
      const after = afterDaily.get(key) ?? BigInt(0);
      const matches = sheet === after;
      if (sheet === before) beforeMatches++;
      if (matches) afterMatches++;
      dayRecords.push({ date: day, account,
        sheetVnd: formatVndMilli(sheet), beforeVnd: formatVndMilli(before),
        proposedVnd: formatVndMilli(after),differenceVnd:formatVndMilli(after-sheet),matches });
      mapAdd(accountDelta, account, after-before);
    }
  }
  const closing: ClosingReconciliation[] = [];
  const addMonth = (
    month: string,
    appAmount: Readonly<Record<FundAccount, MoneyVnd>>,
    sheetAmount: Readonly<Record<FundAccount, MoneyVnd>>,
  ) => {
    for (const account of FUND_ACCOUNTS) {
      const current = getValue(appAmount, account);
      const expected = getValue(sheetAmount, account);
      const projected = current + (accountDelta.get(account) ?? BigInt(0));
      const difference = projected - expected;
      closing.push({month,account,sheetClosingVnd:formatVndMilli(expected),
        currentClosingVnd:formatVndMilli(current),projectedClosingVnd:formatVndMilli(projected),
        differenceVnd:formatVndMilli(difference),matches:difference===BigInt(0)});
      if (difference!==BigInt(0)) block(`MONTH_CLOSE_DIFFERENCE:${month}:${account}:${formatVndMilli(difference)}`);
    }
  };
  const augustCurrent = {} as Record<FundAccount, MoneyVnd>;
  for (const account of FUND_ACCOUNTS) {
    let fromSheet = getValue(input.openingVnd, account);
    let fromCurrent = fromSheet;
    for (const day of MONTH_DAYS) {
      fromSheet += sourceDaily.get(aggregateKey(day,account)) ?? BigInt(0);
      fromCurrent += beforeDaily.get(aggregateKey(day,account)) ?? BigInt(0);
    }
    if (fromSheet !== getValue(input.sheetClosingVnd,account)) block(`SHEET_OPENING_CLOSING_MISMATCH:${account}`);
    if (input.currentClosingVnd && fromCurrent !== getValue(input.currentClosingVnd,account)) {
      block(`APP_SNAPSHOT_STALE:${account}`);
    }
    augustCurrent[account] = formatVndMilli(fromCurrent);
  }
  addMonth(AUGUST_MONTH, augustCurrent, input.sheetClosingVnd);
  const seenMonths = new Set<string>();
  for (const future of input.futureMonths) {
    if (seenMonths.has(future.month)) block(`DUPLICATE_FUTURE_MONTH:${future.month}`);
    seenMonths.add(future.month);
    addMonth(future.month, future.currentClosingVnd, future.sheetClosingVnd);
  }
  for (const day of dayRecords) if (!day.matches) block(`DAILY_MISMATCH:${day.date}:${day.account}:${day.differenceVnd}`);
  const augustDifference = closing.filter(v=>v.month===AUGUST_MONTH).reduce((sum,row)=>sum+parseVndMilli(row.differenceVnd),BigInt(0));
  return {
    decision:blockers.length===0?"GO_FOR_SEPARATE_APPROVAL":"BLOCKED",
    blockers, daily:dayRecords, closing,
    totals: {sheetCellCount:input.sheetCells.length,verifiedSourceLinks:verified,
      pendingSourceLinks:input.sheetCells.length-verified,
      dailyBeforeMatches:beforeMatches,dailyProposedMatches:afterMatches,
      dailyRemaining:124-afterMatches,augustDifferenceVnd:formatVndMilli(augustDifference),
      sheetCardVnd:formatVndMilli(cardTotal)}
  };
}
