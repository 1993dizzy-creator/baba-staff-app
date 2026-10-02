import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const dir = "supabase/migrations";
const fileName = "20261002062405_fix_preflight_inactive_recurring_plans.sql";
const files = readdirSync(dir).filter(name => name.endsWith(".sql")).sort();
const raw = readFileSync(`${dir}/${fileName}`);
const migration = raw.toString("utf8");
const lf = (text: string) => text.replace(/\r\n/g, "\n");
const read = (name: string) => lf(readFileSync(`${dir}/${name}`, "utf8"));
const count = (text: string, part: string) => text.split(part).length - 1;
const anchor = "from public.ledger_recurring_expense_plans p where p.effective_from<=p_month";
const patched = "from public.ledger_recurring_expense_plans p where p.is_active=true and p.effective_from<=p_month";

function replaceOnce(text: string, from: string, to: string, label: string) {
  assert.equal(count(text, from), 1, `${label}: anchor must appear exactly once`);
  return text.split(from).join(to);
}
const sqlLiteral = (src: string, name: string) => {
  const match = src.match(new RegExp(`${name} text := '((?:[^']|'')*)';`));
  assert.ok(match, name);
  return match[1].replaceAll("''", "'");
};
const dollarQuoted = (src: string, tag: string) => {
  const open = `$${tag}$`, start = src.indexOf(open), end = src.indexOf(open, start + open.length);
  assert.ok(start >= 0 && end > start, tag);
  return src.slice(start + open.length, end);
};

// Replays the repository chain of in-place preflight patches on top of the last
// full definition, producing what pg_get_functiondef returned before 20261002062405.
function previousDefinition() {
  const base = read("20260916080015_preserve_cancelled_recurring_expenses.sql");
  const start = base.indexOf("create or replace function public.ledger_close_preflight_v1");
  const bodyStart = base.indexOf("as $$", start) + "as $$".length;
  let body = base.slice(bodyStart, base.indexOf("end$$;", bodyStart) + "end".length);

  const verification = read("20260921170100_add_inventory_payment_verification.sql");
  const verificationPatch = verification.slice(verification.indexOf("v_oid := 'public.ledger_close_preflight_v1"));
  body = replaceOnce(body, "and p.status<>'cancelled';if v_amount>0 then v_warnings",
    "and p.status<>'cancelled' and coalesce(t.source_snapshot->>'paymentVerification','')<>'pending';if v_amount>0 then v_warnings", "verification");
  body = replaceOnce(body, " v_token:=md5(", dollarQuoted(verificationPatch, "check"), "verification hash");

  const cardFee = read("20260927173019_add_card_fee_month_closures.sql");
  const cardFeePatch = cardFee.slice(cardFee.indexOf("do $card_fee_preflight$"), cardFee.indexOf("$card_fee_preflight$;"));
  const [declare, overallocated, unmatched, cardState] = ["v_declare", "v_overallocated", "v_unmatched", "v_card_state"].map(name => sqlLiteral(cardFeePatch, name));
  const replacements = [...cardFeePatch.matchAll(/replace\(v_definition, v_\w+,(?: v_\w+ \|\|)?\s*'((?:[^']|'')*)'\);/g)].map(match => match[1].replaceAll("''", "'"));
  assert.equal(replacements.length, 4);
  body = replaceOnce(body, declare, declare + replacements[0], "card declare");
  body = replaceOnce(body, overallocated, replacements[1], "card overallocated");
  body = replaceOnce(body, unmatched, unmatched + replacements[2], "card fee");
  body = replaceOnce(body, cardState, replacements[3], "card hash");

  const autoFee = read("20261001193526_auto_finalize_closed_month_card_fees.sql");
  const autoFeePatch = autoFee.slice(autoFee.indexOf("do $preflight$"));
  body = replaceOnce(body, dollarQuoted(autoFeePatch, "anchor"), dollarQuoted(autoFeePatch, "replacement"), "fee pending");
  body = replaceOnce(body, " v_token:=md5(", dollarQuoted(autoFeePatch, "checks"), "card integrity");

  return "CREATE OR REPLACE FUNCTION public.ledger_close_preflight_v1(p_month date, p_actor_user_id bigint)\n" +
    " RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n" +
    `AS $function$${body}$function$\n`;
}

test("file is the exact Production statements[1] of migration 20261002062405", () => {
  assert.equal(raw.length, 13_019);
  assert.equal(createHash("md5").update(raw).digest("hex"), "0dc8b3f69b4caf2b4e36b035d967fc18");
  assert.ok(!files.some(name => name.startsWith("20261002120000")), "the superseded local migration stays deleted");
});

test("the only difference from the previous live definition is p.is_active=true in RECURRING_NOT_SYNCED", () => {
  const previous = previousDefinition();
  assert.equal(count(previous, anchor), 1);
  assert.equal(count(lf(migration), patched), 1);
  assert.equal(lf(migration), previous.replace(anchor, patched));
});

test("every other preflight contract is still present", () => {
  for (const code of [
    "CURRENT_MONTH", "ALREADY_CLOSED", "PENDING_CANDIDATES", "PAYROLL_NOT_COMPLETED", "RECURRING_NOT_SYNCED",
    "CANDIDATE_LINK_BROKEN", "TRANSFER_UNBALANCED", "REQUIRED_MOVEMENT_MISSING", "PAYABLE_OVERALLOCATED",
    "CARD_OVERALLOCATED", "DUPLICATE_ACTIVE_SOURCE", "CARD_UNMATCHED", "CARD_FEE_PENDING", "PAYABLE_OUTSTANDING",
    "BALANCE_ADJUSTMENT", "RESERVE_SHORTFALL", "CONFIRMED_SOURCE_DRIFT", "PAYMENT_VERIFICATION_UNRESOLVED",
    "PAYMENT_VERIFICATION_LATER_PAID", "CARD_CLEARING_NEGATIVE", "CARD_ALLOCATION_MISMATCH",
    "CARD_FEE_ALLOCATION_MISMATCH", "cardFeeState", "preflightHash",
  ]) assert.ok(migration.includes(`'${code}'`), code);
  assert.ok(!migration.includes("CARD_FEE_NOT_CONFIRMED"));
  assert.match(migration, /public\.ledger_card_sale_consumed_v1\(t\.id\)>t\.amount/);
  // Cancelled audit-history rows (8월 id 1/1062/1065) still satisfy the recurring check.
  assert.ok(migration.includes("t.status in('confirmed','cancelled')"));
});

test("no data change, seed, backfill or delete", () => {
  assert.equal(count(migration, "CREATE OR REPLACE FUNCTION"), 1);
  assert.doesNotMatch(migration, /\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b|\btruncate\b/i);
});
