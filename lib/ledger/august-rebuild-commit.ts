/**
 * Operator-only serialization of an ALREADY VERIFIED August 2026 rebuild plan.
 *
 * No database access, no SQL execution, no DML, no dependence on a Supabase key.
 * This file NEVER turns an unverified cash difference into an expense or income.
 * The isolated PostgreSQL RPC must check all invariants again under a lock.
 */
import { createHash } from "node:crypto";
import {
  AUGUST_MONTH,
  FUND_ACCOUNTS,
  formatVndMilli,
  parseVndMilli,
  previewAugustRebuild,
  type FundAccount,
  type RebuildInput,
  type RebuildAdjustment,
  type SourceLink,
} from "./august-rebuild-plan.ts";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TECH_ID = /^[1-9]\d*$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const CELL = /^[GHIJK](?:[4-9]|[1-9]\d{1,2})$/;
const ACCOUNT_IDS: Readonly<Record<FundAccount, number>> = {
  store_cash: 1,
  baba_corporate_bank: 2,
  cho_personal_custody: 3,
  vuong_personal_custody: 5,
};

export interface SqlMovement {
  accountId: number;
  amount: string;
}

export interface SqlEvent {
  key: string;
  adjustmentId: string;
  kind: RebuildAdjustment["kind"];
  sourceTransactionId: string | null;
  originalMovementId: string | null;
  businessDate: string;
  occurredAt: string;
  type: "correction" | "transfer";
  amount: string;
  movements: readonly SqlMovement[];
  sheetCells: readonly string[];
  evidenceReference: string;
  reason: string;
}

export interface AugustApplyManifest {
  month: typeof AUGUST_MONTH;
  runId: string;
  status: "READY_FOR_ISOLATED_DB_TEST_ONLY";
  sourceRows: 427;
  cellCount: 505;
  cardTotal: string;
  moneyScale: 3;
  sheetCellDigest: string;
  effectDigest: string;
  expectedDaily: readonly {
    businessDate: string;
    accountId: number;
    signedAmount: string;
  }[];
  expectedOpening: Readonly<Record<FundAccount, string>>;
  expectedClosing: Readonly<Record<FundAccount, string>>;
  expectedCurrentClosing: Readonly<Record<FundAccount, string>>;
  expectedFollowup: readonly {
    month: "2026-09" | "2026-10";
    current: Readonly<Record<FundAccount, string>>;
    target: Readonly<Record<FundAccount, string>>;
  }[];
  requiredProtectedFingerprints: readonly {
    name: string;
    beforeCount: number;
    fingerprint: string;
  }[];
  requiredTechnicalMovementIds: readonly string[];
  events: readonly SqlEvent[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function normalizeFunds(values: Readonly<Record<FundAccount, string>>): Record<FundAccount, string> {
  const result = {} as Record<FundAccount, string>;
  for (const account of FUND_ACCOUNTS) result[account] = formatVndMilli(parseVndMilli(values[account]));
  return result;
}

function eventTime(day: string) {
  // 03:00 in Vietnam is the beginning of BABA's logical business day.
  return `${day}T03:00:00+07:00`;
}

function actionSource(action: RebuildAdjustment, links: ReadonlyMap<string, SourceLink>): string {
  const proof = action.sheetCells.map(cell => {
    if (!CELL.test(cell)) throw new Error(`BAD_SOURCE_CELL:${cell}`);
    const link = links.get(cell);
    if (!link || link.confidence !== "verified" || !link.evidenceReference?.trim()) {
      throw new Error(`SOURCE_NOT_VERIFIED:${action.id}:${cell}`);
    }
    return `${cell}:${link.evidenceReference.trim()}`;
  });
  if (!proof.length && action.kind !== "remove-technical") throw new Error(`ACTION_HAS_NO_SOURCE_CELLS:${action.id}`);
  // Technical corrections have no matching source cell; their original movement ID is the source.
  return proof.join(" | ") || `original-ledger-movement:${action.originalMovementId}`;
}

function buildEvents(input: RebuildInput, runId: string): SqlEvent[] {
  const links = new Map(input.sourceLinks.map(link => [link.cell, link]));
  const movements = new Map(input.currentMovements.map(movement => [movement.id, movement]));
  const events: SqlEvent[] = [];

  for (const action of input.proposedAdjustments) {
    if (!ID.test(action.id)) throw new Error(`BAD_ACTION_ID:${action.id}`);
    const source = actionSource(action, links);
    const originalMovement = action.originalMovementId ? movements.get(action.originalMovementId) : undefined;
    const originalTxId = originalMovement?.transactionId ?? action.sourceTransactionId ?? null;
    if (originalTxId !== null && !TECH_ID.test(originalTxId)) {
      // Production IDs are positive database BIGINT. Synthetic unit tests must use numeric ids here too.
      throw new Error(`ORIGINAL_TRANSACTION_ID_NOT_NUMERIC:${action.id}`);
    }
    if (action.kind === "transfer") {
      if (action.effects.length !== 2) throw new Error(`INVALID_TRANSFER:${action.id}`);
      const amount = parseVndMilli(action.effects[0].signedAmountVnd);
      const total = action.effects.reduce((sum,e) => sum+parseVndMilli(e.signedAmountVnd),BigInt(0));
      if (total!==BigInt(0) || amount === BigInt(0)) throw new Error(`INVALID_TRANSFER_BALANCE:${action.id}`);
      events.push({
        key:`aug-rebuild:${runId}:${action.id}:1`,
        adjustmentId:action.id,kind:action.kind,sourceTransactionId:null,originalMovementId:null,
        businessDate:action.effects[0].businessDate,occurredAt:eventTime(action.effects[0].businessDate),
        type:"transfer",amount:formatVndMilli(amount < BigInt(0) ? -amount : amount),
        movements:action.effects.map(e=>({accountId:ACCOUNT_IDS[e.account],amount:formatVndMilli(parseVndMilli(e.signedAmountVnd))})),
        sheetCells:[...action.sheetCells],evidenceReference:source,reason:action.rationale,
      });
      continue;
    }
    for (let i=0;i<action.effects.length;i++) {
      const effect=action.effects[i];
      const amount=formatVndMilli(parseVndMilli(effect.signedAmountVnd));
      events.push({
        key:`aug-rebuild:${runId}:${action.id}:${i+1}`,
        adjustmentId:action.id,kind:action.kind,sourceTransactionId:originalTxId,
        originalMovementId:action.originalMovementId??null,
        businessDate:effect.businessDate,occurredAt:eventTime(effect.businessDate),
        // 0-economic-correction, one movement per event so the
        // production UNIQUE(transaction_id,fund_account_id) is always obeyed.
        type:"correction",amount:"0",
        movements:[{accountId:ACCOUNT_IDS[effect.account],amount}],
        sheetCells:[...action.sheetCells],evidenceReference:source,reason:action.rationale,
      });
    }
  }
  return events;
}

/**
 * Serialize a plan only after all 505 cells and 124 day/account buckets pass,
 * no pending evidence remains, and every protection snapshot is supplied.
 * This does not provide DB write authorization.
 */
export function createAugustApplyManifest(input: RebuildInput, runId: string): AugustApplyManifest {
  if (!RUN_ID.test(runId)) throw new Error("INVALID_RUN_ID");
  if (input.contract.expectedSheetCells !== 505 || input.contract.expectedSourceRows !== 427 ||
    input.contract.sourceRows !== 427 || input.contract.expectedCardTotalVnd !== "225925720") {
    throw new Error("NOT_AUGUST_PRODUCTION_CONTRACT");
  }
  if (input.futureMonths.length !== 2 ||
    !input.futureMonths.some(x=>x.month==="2026-09") ||
    !input.futureMonths.some(x=>x.month==="2026-10")) {
    throw new Error("FOLLOWUP_MONTHS_NOT_COMPLETE");
  }
  const previous = previewAugustRebuild(input);
  if (previous.decision !== "GO_FOR_SEPARATE_APPROVAL" || previous.totals.dailyProposedMatches !== 124 ||
      previous.totals.verifiedSourceLinks !== 505 || previous.closing.length !== 12 ||
      !previous.closing.every(x=>x.matches)) {
    throw new Error(`PREVIEW_BLOCKED:${previous.blockers.slice(0,12).join("|")}`);
  }
  const expectedTechnicalIds = [...input.contract.expectedTechnicalMovementIds];
  if (expectedTechnicalIds.length !== 8 || new Set(expectedTechnicalIds).size !== 8 ||
      expectedTechnicalIds.some(id=>!TECH_ID.test(id))) {
    throw new Error("TECHNICAL_EIGHT_IDS_REQUIRED");
  }
  if (new Set(input.proposedAdjustments.map(x=>x.id)).size !== input.proposedAdjustments.length) {
    throw new Error("DUPLICATE_OPERATION_ID");
  }
  const requiredProtected = ["payable_allocations","pos_receipts","month_closure_history","ledger_audit_history","inventory_logs"];
  const active = new Map(input.protections.map(x=>[x.name,x]));
  for (const name of requiredProtected) {
    const row = active.get(name);
    if (!row || row.beforeCount !== row.afterCount || row.beforeFingerprint !== row.afterFingerprint || !row.beforeFingerprint.trim()) {
      throw new Error(`PROTECTION_NOT_VERIFIED:${name}`);
    }
  }
  const events=buildEvents(input,runId);
  const sourceByKey = new Map<string,SqlEvent>();
  for (const event of events) {
    if (sourceByKey.has(event.key)) throw new Error(`EVENT_ID_COLLISION:${event.key}`);
    sourceByKey.set(event.key,event);
    if (!event.reason.trim() || !event.evidenceReference.trim()) throw new Error(`MISSING_PROOF:${event.key}`);
    if (!event.movements.length || event.movements.some(m=>parseVndMilli(m.amount)===BigInt(0))) {
      throw new Error(`INVALID_MOVEMENT:${event.key}`);
    }
  }

  const sheetCells = input.sheetCells
    .map(x=>({cell:x.cell,businessDate:x.businessDate,account:x.account,amount:formatVndMilli(parseVndMilli(x.signedAmountVnd))}))
    .sort((a,b)=>a.cell.localeCompare(b.cell));
  const daily = previous.daily.map(x=>({businessDate:x.date,accountId:ACCOUNT_IDS[x.account],signedAmount:x.sheetVnd}));
  const augustClosing = {} as Record<FundAccount,string>;
  for (const account of FUND_ACCOUNTS) {
    const closed=previous.closing.find(x=>x.month===AUGUST_MONTH&&x.account===account);
    if (!closed) throw new Error(`MISSING_CLOSING:${account}`);
    augustClosing[account]=closed.currentClosingVnd;
  }

  return {
    month:AUGUST_MONTH,runId,status:"READY_FOR_ISOLATED_DB_TEST_ONLY",
    sourceRows:427,cellCount:505,cardTotal:previous.totals.sheetCardVnd,moneyScale:3,
    sheetCellDigest:fingerprint(sheetCells),effectDigest:fingerprint(events),
    expectedDaily:daily,expectedOpening:normalizeFunds(input.openingVnd),
    expectedClosing:normalizeFunds(input.sheetClosingVnd),
    expectedCurrentClosing:normalizeFunds(augustClosing),
    expectedFollowup:input.futureMonths.map(x=>({month:x.month,current:normalizeFunds(x.currentClosingVnd),target:normalizeFunds(x.sheetClosingVnd)})),
    requiredProtectedFingerprints:requiredProtected.map(name=>({name,beforeCount:active.get(name)!.beforeCount,fingerprint:active.get(name)!.beforeFingerprint})),
    requiredTechnicalMovementIds:expectedTechnicalIds,
    events,
  };
}
