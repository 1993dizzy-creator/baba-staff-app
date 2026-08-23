import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { parsePartnerInput } from "../lib/partners/policy.ts";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { formatPartnerPaymentPolicy } from "../lib/partners/text.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const sha256 = (path: string) => createHash("sha256").update(read(path)).digest("hex");
const migration = read("supabase/migrations/202608230001_add_business_partner_settlement_policy.sql");
const oldPartnerMigration = read("supabase/migrations/202608220001_create_business_partner_master.sql");
const oldCandidateMigration = read("supabase/migrations/202608220002_add_inventory_supplier_candidates.sql");
const oldAliasMigration = read("supabase/migrations/202608220003_fix_supplier_alias_ignore_behavior.sql");
const settlementConstraint = migration.slice(
  migration.indexOf("add constraint business_partners_settlement_policy"),
  migration.indexOf("comment on column public.business_partners.settlement_mode"),
);
const collectionApi = read("app/api/admin/partners/route.ts");
const detailApi = read("app/api/admin/partners/[id]/route.ts");
const aliasApi = read("app/api/admin/partners/aliases/[id]/route.ts");
const partnerForm = read("components/PartnerForm.tsx");
const candidateForm = read("components/CandidatePartnerReviewForm.tsx");
const settlementFields = read("components/PartnerSettlementFields.tsx");
const partnerServer = read("lib/partners/server.ts");
const infoPage = read("app/(protected)/admin/partners/info/page.tsx");

const base = { name: "Fresh Foods", partnerType: "food", paymentMode: "immediate", settlementMode: null, settlementRule: null, defaultPaymentTermDays: null, phone: null, contactName: null, memo: null, isActive: true, ledgerPartyId: null };
const parse = (changes: Record<string, unknown>) => parsePartnerInput({ ...base, ...changes });

test("immediate accepts only empty settlement fields", () => {
  assert.ok(parse({}));
  assert.equal(parse({ settlementMode: "ad_hoc" }), null);
  assert.equal(parse({ settlementRule: "monthly_twice" }), null);
  assert.equal(parse({ defaultPaymentTermDays: 30 }), null);
});

test("postpaid ad hoc accepts no rule or term", () => {
  assert.ok(parse({ paymentMode: "postpaid", settlementMode: "ad_hoc" }));
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "ad_hoc", settlementRule: "net_days", defaultPaymentTermDays: 30 }), null);
});

test("scheduled net days validates the integer range", () => {
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days" }), null);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days", defaultPaymentTermDays: -1 }), null);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days", defaultPaymentTermDays: 3651 }), null);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days", defaultPaymentTermDays: 1.5 }), null);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days", defaultPaymentTermDays: 0 })?.defaultPaymentTermDays, 0);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days", defaultPaymentTermDays: 3650 })?.defaultPaymentTermDays, 3650);
});

test("monthly rules reject stale term values", () => {
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "monthly_once" })?.defaultPaymentTermDays, null);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "monthly_twice" })?.defaultPaymentTermDays, null);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "monthly_twice", defaultPaymentTermDays: 30 }), null);
  assert.equal(parse({ paymentMode: "postpaid", settlementMode: "scheduled" }), null);
});

test("legacy postpaid remains a database read state but is rejected for new mutations", () => {
  const legacyBranch = settlementConstraint.match(/payment_mode = 'postpaid'\s+and settlement_mode is null[\s\S]*?\n    \)/)?.[0] ?? "";
  assert.match(legacyBranch, /settlement_rule is null/);
  assert.match(legacyBranch, /default_payment_term_days between 0 and 3650/);
  assert.doesNotMatch(legacyBranch, /default_payment_term_days is not null/);
  assert.equal(parse({ paymentMode: "postpaid", defaultPaymentTermDays: 30 }), null);
  assert.equal(formatPartnerPaymentPolicy({ paymentMode: "postpaid", settlementMode: null, settlementRule: null, defaultPaymentTermDays: 30 }, "ko"), "후불 · 정책 미설정");
  assert.equal(formatPartnerPaymentPolicy({ paymentMode: "postpaid", settlementMode: null, settlementRule: null, defaultPaymentTermDays: 30 }, "vi"), "Trả sau · Chưa đặt chính sách");
});

test("monthly frequency labels never invent cutoff dates", () => {
  assert.equal(formatPartnerPaymentPolicy({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "monthly_once", defaultPaymentTermDays: null }, "ko"), "후불 · 월 1회 정산");
  assert.equal(formatPartnerPaymentPolicy({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "monthly_twice", defaultPaymentTermDays: null }, "ko"), "후불 · 월 2회 정산");
  assert.equal(formatPartnerPaymentPolicy({ paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days", defaultPaymentTermDays: 30 }, "ko"), "후불 · Net 30");
  assert.doesNotMatch(migration + settlementFields, /settlement_cutoff|15일|말일|1~15|16~말일/);
});

test("migration preserves existing data and models exact valid combinations", () => {
  const schemaChange = migration.slice(0, migration.indexOf("create function public.business_partner_create_v2"));
  assert.doesNotMatch(schemaChange, /update public\.business_partners|insert into public\.business_partners/i);
  for (const token of ["ad_hoc", "scheduled", "net_days", "monthly_once", "monthly_twice"]) assert.match(migration, new RegExp(token));
  assert.match(migration, /drop constraint business_partners_payment_term_policy/);
  assert.match(migration, /comment on column public\.business_partners\.settlement_rule[\s\S]*does not define fixed cutoff dates or historical Ledger periods/);
});

test("database constraint rejects null net days and keeps monthly terms null", () => {
  const netDaysBranch = settlementConstraint.match(/settlement_rule = 'net_days'[\s\S]*?\n    \)/)?.[0] ?? "";
  const monthlyBranch = settlementConstraint.match(/settlement_rule in \('monthly_once', 'monthly_twice'\)[\s\S]*?\n    \)/)?.[0] ?? "";
  assert.match(netDaysBranch, /default_payment_term_days is not null\s+and default_payment_term_days between 0 and 3650/);
  assert.match(monthlyBranch, /default_payment_term_days is null/);
});

test("previous partner migrations remain byte-for-byte unchanged", () => {
  assert.equal(sha256("supabase/migrations/202608220001_create_business_partner_master.sql"), "fb894247d95313b3bf1dc8a64f0235860740d71b421228c1d6eec680480a754c");
  assert.equal(sha256("supabase/migrations/202608220002_add_inventory_supplier_candidates.sql"), "b0c2763eca694c5b50a84f923380c4a697a41c56720faff160195bb3cd96c8ac");
  assert.equal(sha256("supabase/migrations/202608220003_fix_supplier_alias_ignore_behavior.sql"), "4c07d19209b844e30c8525e3a76724efdd8801bf1d5ef3d28f87fcded36ea444");
  assert.match(oldCandidateMigration, /business_partner_review_supplier_alias_v1/);
});

test("V1 functions stay in their original migrations and V2 names are unambiguous", () => {
  assert.match(oldPartnerMigration, /business_partner_create_v1/);
  assert.match(oldPartnerMigration, /business_partner_update_v1/);
  assert.match(oldAliasMigration, /business_partner_review_supplier_alias_v1/);
  assert.doesNotMatch(migration, /create (or replace )?function public\.business_partner_(create|update)_v1/);
  assert.doesNotMatch(migration, /create (or replace )?function public\.business_partner_review_supplier_alias_v1/);
  for (const name of ["business_partner_create_v2", "business_partner_update_v2", "business_partner_review_supplier_alias_v2"]) assert.match(migration, new RegExp(`create function public\\.${name}`));
});

test("V2 RPCs keep owner, security definer, search path and restricted execute grants", () => {
  assert.equal((migration.match(/security definer/g) ?? []).length, 3);
  assert.equal((migration.match(/set search_path = pg_catalog, public/g) ?? []).length, 3);
  assert.equal((migration.match(/owner to postgres/g) ?? []).length, 3);
  assert.equal((migration.match(/revoke all on function/g) ?? []).length, 3);
  assert.equal((migration.match(/grant execute on function/g) ?? []).length, 3);
  assert.match(migration, /from public, anon, authenticated/g);
  assert.match(migration, /to service_role/g);
});

test("V2 audits snapshot the complete partner row", () => {
  assert.match(migration, /after_snapshot[\s\S]*select to_jsonb\(p\) from public\.business_partners p/);
  assert.match(migration, /select to_jsonb\(p\) into v_before/);
  assert.match(migration, /settlement_mode = p_settlement_mode/);
  assert.match(migration, /settlement_rule = p_settlement_rule/);
});

test("all app mutations use V2 and API reads expose settlement fields", () => {
  assert.match(collectionApi, /business_partner_create_v2/);
  assert.match(detailApi, /business_partner_update_v2/);
  assert.match(aliasApi, /business_partner_review_supplier_alias_v2/);
  for (const source of [collectionApi, detailApi, aliasApi]) {
    assert.match(source, /p_settlement_mode/);
    assert.match(source, /p_settlement_rule/);
  }
  assert.match(partnerServer, /settlement_mode,settlement_rule/);
  assert.match(partnerServer, /settlementMode: row\.settlement_mode/);
});

test("both forms share policy UI and no longer inject 30", () => {
  assert.match(partnerForm, /PartnerSettlementFields/);
  assert.match(candidateForm, /PartnerSettlementFields/);
  assert.doesNotMatch(partnerForm + candidateForm + settlementFields, /\?\? 30|defaultPaymentTermDays: 30/);
  for (const label of ["수시정산", "정기정산", "N일 후 지급", "월 1회", "월 2회", "입고\/청구 후 N일"]) assert.match(read("lib/partners/text.ts"), new RegExp(label));
});

test("legacy edit warning and policy list formatter are wired", () => {
  assert.match(settlementFields, /value\.settlementMode === null[\s\S]*t\.legacySettlement/);
  assert.match(infoPage, /formatPartnerPaymentPolicy\(partner, lang\)/);
});
