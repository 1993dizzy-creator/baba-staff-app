import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { parsePartnerInput } from "../lib/partners/policy.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/202608230003_add_business_partner_default_fund_account.sql");
const ledgerMigration = read("supabase/migrations/202608210001_create_ledger_v1_foundation.sql");
const oldPartnerMigration = read("supabase/migrations/202608220001_create_business_partner_master.sql");
const settlementMigration = read("supabase/migrations/202608230001_add_business_partner_settlement_policy.sql");
const partnerServer = read("lib/partners/server.ts");
const collectionApi = read("app/api/admin/partners/route.ts");
const detailApi = read("app/api/admin/partners/[id]/route.ts");
const aliasApi = read("app/api/admin/partners/aliases/[id]/route.ts");
const partnerForm = read("components/PartnerForm.tsx");
const settlementFields = read("components/PartnerSettlementFields.tsx");
const candidateForm = read("components/CandidatePartnerReviewForm.tsx");
const registrationPage = read("app/(protected)/admin/partners/page.tsx");
const detailPage = read("app/(protected)/admin/partners/[id]/page.tsx");
const candidatePage = read("app/(protected)/admin/partners/candidates/[id]/page.tsx");

const base = { name: "Fresh Foods", partnerType: "food", paymentMode: "immediate", settlementMode: null, settlementRule: null, defaultPaymentTermDays: null, defaultFundAccountId: null, phone: null, contactName: null, memo: null, isActive: true, ledgerPartyId: null };
const parse = (changes: Record<string, unknown>) => parsePartnerInput({ ...base, ...changes });

test("default_fund_account_id reuses ledger_fund_accounts as the single source of truth", () => {
  assert.match(migration, /add column default_fund_account_id bigint null\s*\n\s*references public\.ledger_fund_accounts\(id\) on delete restrict/);
  assert.doesNotMatch(migration, /create type|create table public\.[a-z_]*payment_account/i);
  assert.match(ledgerMigration, /create table public\.ledger_fund_accounts/);
});

test("parser allows null and positive safe integers only", () => {
  assert.equal(parse({})?.defaultFundAccountId, null);
  assert.equal(parse({ defaultFundAccountId: null })?.defaultFundAccountId, null);
  assert.equal(parse({ defaultFundAccountId: 2 })?.defaultFundAccountId, 2);
  assert.equal(parse({ defaultFundAccountId: "2" })?.defaultFundAccountId, 2);
  assert.equal(parse({ defaultFundAccountId: 0 }), null);
  assert.equal(parse({ defaultFundAccountId: -1 }), null);
  assert.equal(parse({ defaultFundAccountId: 1.5 }), null);
});

test("field is independent of immediate/postpaid canonicalization", () => {
  assert.deepEqual(parse({ paymentMode: "postpaid", defaultFundAccountId: 3 }), { ...base, paymentMode: "postpaid", settlementMode: "ad_hoc", defaultFundAccountId: 3 });
  assert.deepEqual(parse({ paymentMode: "immediate", defaultFundAccountId: 3 }), { ...base, defaultFundAccountId: 3 });
});

test("DB-side eligibility excludes card_clearing and inactive accounts, not just active partner UI options", () => {
  assert.match(migration, /create function public\.business_partner_fund_account_is_eligible_v1/);
  assert.match(migration, /is_active = true and type <> 'card_clearing'/);
  assert.match(migration, /p_fund_account_id is null or exists/);
});

test("server only offers active, non-card-clearing fund accounts and includes them via the existing Promise.all", () => {
  assert.match(partnerServer, /from\("ledger_fund_accounts"\)\.select\("id,type,display_name,is_active,is_business_fund,sort_order"\)\.eq\("is_active", true\)\.eq\("is_business_fund", true\)\.neq\("type", "card_clearing"\)/);
  assert.match(partnerServer, /fundAccounts: \(fundAccountResult\.data \?\? \[\]\)\.map/);
  assert.doesNotMatch(partnerServer, /for \([^)]*\)[\s\S]{0,200}await supabaseServer/);
});

test("V3 RPCs add default_fund_account_id while V1/V2 signatures stay untouched", () => {
  assert.match(oldPartnerMigration, /create function public\.business_partner_create_v1/);
  assert.match(settlementMigration, /create function public\.business_partner_create_v2/);
  assert.doesNotMatch(migration, /create (or replace )?function public\.business_partner_(create|update)_v1\(/);
  assert.doesNotMatch(migration, /create (or replace )?function public\.business_partner_(create|update)_v2\(/);
  for (const name of ["business_partner_create_v3", "business_partner_update_v3", "business_partner_review_supplier_alias_v3"]) {
    assert.match(migration, new RegExp(`create function public\\.${name}`));
  }
  assert.match(migration, /p_default_fund_account_id bigint,/g);
});

test("V3 RPCs keep the same security pattern as V1/V2: owner, security definer, search_path, restricted execute", () => {
  assert.equal((migration.match(/security definer/g) ?? []).length, 4);
  assert.equal((migration.match(/owner to postgres/g) ?? []).length, 4);
  assert.equal((migration.match(/revoke all on function/g) ?? []).length, 4);
  assert.equal((migration.match(/grant execute on function/g) ?? []).length, 4);
  assert.match(migration, /from public, anon, authenticated/g);
  assert.match(migration, /to service_role/g);
});

test("create/update v3 reject an ineligible fund account before writing", () => {
  const createBody = migration.slice(migration.indexOf("create function public.business_partner_create_v3"), migration.indexOf("create function public.business_partner_update_v3"));
  const updateBody = migration.slice(migration.indexOf("create function public.business_partner_update_v3"), migration.indexOf("create function public.business_partner_review_supplier_alias_v3"));
  for (const body of [createBody, updateBody]) {
    assert.match(body, /if not public\.business_partner_fund_account_is_eligible_v1\(p_default_fund_account_id\) then/);
    assert.match(body, /return jsonb_build_object\('status', 'invalid_fund_account'\);/);
  }
  assert.match(createBody, /default_fund_account_id, phone, contact_name, memo, is_active/);
  assert.match(updateBody, /default_fund_account_id = p_default_fund_account_id,/);
});

test("candidate create_partner action validates the fund account only for the create_partner branch", () => {
  const reviewBody = migration.slice(migration.indexOf("create function public.business_partner_review_supplier_alias_v3"));
  const createPartnerBranch = reviewBody.slice(reviewBody.indexOf("if p_action = 'create_partner' then"), reviewBody.indexOf("elsif p_action = 'link_existing'"));
  assert.match(createPartnerBranch, /business_partner_fund_account_is_eligible_v1\(p_default_fund_account_id\)/);
  assert.match(createPartnerBranch, /invalid_fund_account/);
});

test("app mutations call V3 and forward the fund account field", () => {
  assert.match(collectionApi, /business_partner_create_v3/);
  assert.match(detailApi, /business_partner_update_v3/);
  assert.match(aliasApi, /business_partner_review_supplier_alias_v3/);
  for (const source of [collectionApi, detailApi, aliasApi]) assert.match(source, /p_default_fund_account_id/);
});

test("API reads expose fundAccounts alongside partners and ledgerParties without N+1 fetches", () => {
  assert.match(collectionApi, /partnerJson\(\{ ok: true, \.\.\.partnerData, supplierAliases \}\)/);
  assert.match(detailApi, /fundAccounts: data\.fundAccounts/);
  assert.match(aliasApi, /fundAccounts: partnerData\.fundAccounts/);
});

test("PartnerForm and CandidatePartnerReviewForm both render the shared fund account select with a nullable default", () => {
  assert.match(settlementFields, /fundAccounts: FundAccount\[\]/);
  assert.match(settlementFields, /t\.defaultFundAccount/);
  assert.match(settlementFields, /t\.noFundAccount/);
  assert.match(settlementFields, /value\.defaultFundAccountId \?\? ""/);
  assert.match(settlementFields, /defaultFundAccountId: event\.target\.value \? Number\(event\.target\.value\) : null/);
  assert.match(partnerForm, /fundAccounts={fundAccounts}/);
  assert.match(candidateForm, /fundAccounts={fundAccounts}/);
  assert.match(partnerForm, /defaultFundAccountId: null/);
});

test("registration, detail and candidate pages all load and thread fundAccounts through to the shared form", () => {
  assert.match(registrationPage, /setFundAccounts\(body\.fundAccounts\)/);
  assert.match(registrationPage, /fundAccounts={fundAccounts}/);
  assert.match(detailPage, /setFundAccounts\(body\.fundAccounts\)/);
  assert.match(detailPage, /fundAccounts={fundAccounts}/);
  assert.match(candidatePage, /setFundAccounts\(body\.fundAccounts\)/);
  assert.match(candidatePage, /fundAccounts={fundAccounts}/);
});

test("Korean and Vietnamese labels exist for the default fund account field, unset choice is not a forced value", () => {
  const text = read("lib/partners/text.ts");
  assert.match(text, /defaultFundAccount: "기본 결제수단"/);
  assert.match(text, /noFundAccount: "미지정"/);
  assert.match(text, /defaultFundAccount: "Phương thức thanh toán mặc định"/);
  assert.match(text, /noFundAccount: "Chưa chọn"/);
});
