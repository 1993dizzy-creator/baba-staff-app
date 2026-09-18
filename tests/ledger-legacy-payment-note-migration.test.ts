import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql=readFileSync("supabase/migrations/20260918120000_backfill_legacy_sheet_payment_notes.sql","utf8");

test("migration contains exactly the 20 verified sheet rows with correct payment notes",()=>{
  const pairs=[...sql.matchAll(/\((\d+), '(현금|법인|tk\(cho\)|tài khoản)'\)/g)].map(([,row,note])=>[Number(row),note] as const);
  assert.equal(pairs.length,40); // one guarded count and one UPDATE source
  const expected=new Map<number,string>([
    ...[6,11,26,55,85,137,240,267,283,333,358,395,420,421].map(row=>[row,"현금"] as const),
    ...[179,296].map(row=>[row,"법인"] as const),
    ...[198,309,342].map(row=>[row,"tk(cho)"] as const),
    [292,"tài khoản"],
  ]);
  assert.deepEqual(new Map(pairs),expected);
  assert.equal(new Set(pairs.map(([row])=>row)).size,20);
  assert.equal(expected.has(132),false); // prepaid rent has a real movement
});

test("migration changes only source_snapshot paymentNote and never creates movements",()=>{
  assert.match(sql,/set source_snapshot = t\.source_snapshot \|\| jsonb_build_object\('paymentNote', n\.payment_note\)/);
  for(const predicate of ["legacy_sheet_detail","(2026)BABA - Sổ dự án","8월","fundMovementApplied","paymentNote"])assert.ok(sql.includes(predicate));
  assert.match(sql,/target_count <> 20/);
  assert.doesNotMatch(sql,/\b(?:insert|update|delete|truncate)\s+(?:into\s+|from\s+)?(?:public\.)?ledger_movements\b/i);
  assert.doesNotMatch(sql,/\bset\s+(?:amount|recognition_month|business_date|type|economic_effect_sign)\s*=/i);
});
