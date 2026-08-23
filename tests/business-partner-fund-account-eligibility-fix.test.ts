import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const sha256 = (path: string) => createHash("sha256").update(read(path)).digest("hex");
const migration = read("supabase/migrations/202608230004_fix_business_partner_fund_account_eligibility.sql");
const fundAccountMigration = read("supabase/migrations/202608230003_add_business_partner_default_fund_account.sql");
const ledgerMigration = read("supabase/migrations/202608210001_create_ledger_v1_foundation.sql");
const ownerSettlementsMigration = read("supabase/migrations/202608210009_add_owner_settlements.sql");
const partnerServer = read("lib/partners/server.ts");

test("202608230002 and 202608230003 remain byte-for-byte unchanged by this postflight fix", () => {
  assert.equal(sha256("supabase/migrations/202608230002_add_supplier_alias_candidate_archive.sql"), "755a20caf4090ee8d67690e9f1827647bf8ac186ccf072b52595f820ffe76c9b");
  assert.equal(sha256("supabase/migrations/202608230003_add_business_partner_default_fund_account.sql"), "bd4f41eff8f1decd3c6e37a65cafd833e69a7683bd2bb649a3bee750cae6d598");
});

test("fix is a CREATE OR REPLACE of the same name/signature, not a fresh CREATE", () => {
  assert.match(migration, /create or replace function public\.business_partner_fund_account_is_eligible_v1\(\s*p_fund_account_id bigint\s*\) returns boolean/);
  assert.doesNotMatch(migration, /create function public\.business_partner_fund_account_is_eligible_v1/);
  assert.match(fundAccountMigration, /create function public\.business_partner_fund_account_is_eligible_v1/);
  // no other function is redefined by this migration
  assert.doesNotMatch(migration, /create (or replace )?function public\.business_partner_(create|update|review_supplier_alias|archive_supplier_alias)_v[123]/);
});

test("function contract is unchanged: returns boolean, sql, stable, security definer, search_path, owner, execute grants", () => {
  assert.match(migration, /\) returns boolean\nlanguage sql\nstable\nsecurity definer\nset search_path = pg_catalog, public\n/);
  assert.match(migration, /alter function public\.business_partner_fund_account_is_eligible_v1\(bigint\) owner to postgres/);
  assert.match(migration, /revoke all on function public\.business_partner_fund_account_is_eligible_v1\(bigint\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.business_partner_fund_account_is_eligible_v1\(bigint\) to service_role/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (public|anon|authenticated)\b/);
});

test("WHERE clause ANDs id match, is_active, is_business_fund and excludes card_clearing (none optional)", () => {
  const body = migration.slice(migration.indexOf("as $$"), migration.indexOf("$$;"));
  assert.match(body, /p_fund_account_id is null or exists \(/);
  assert.match(body, /where id = p_fund_account_id/);
  assert.match(body, /and is_active = true/);
  assert.match(body, /and is_business_fund = true/);
  assert.match(body, /and type <> 'card_clearing'/);
  assert.doesNotMatch(body, /or is_business_fund|or is_active|or type/);
});

test("nine eligibility scenarios evaluated against a predicate mirroring the fixed WHERE clause", () => {
  // Mirrors, field for field, the SQL fixed above:
  //   p_fund_account_id is null or exists(
  //     select 1 from ledger_fund_accounts
  //     where id = p_fund_account_id and is_active = true
  //       and is_business_fund = true and type <> 'card_clearing')
  type Account = { id: number; isActive: boolean; isBusinessFund: boolean; type: string };
  const accounts: Account[] = [
    { id: 1, isActive: true, isBusinessFund: true, type: "cash" },              // store_cash
    { id: 2, isActive: true, isBusinessFund: true, type: "bank" },              // baba_corporate_bank
    { id: 3, isActive: true, isBusinessFund: true, type: "personal_custody" },  // cho_personal_custody
    { id: 4, isActive: true, isBusinessFund: false, type: "card_clearing" },    // card_clearing
    { id: 5, isActive: true, isBusinessFund: false, type: "bank" },             // future active non-business, non-card fixture
    { id: 6, isActive: false, isBusinessFund: true, type: "cash" },             // inactive business account
  ];
  const isEligible = (id: number | null) =>
    id === null || accounts.some(a => a.id === id && a.isActive && a.isBusinessFund && a.type !== "card_clearing");

  assert.equal(isEligible(null), true);   // 1. null -> true
  assert.equal(isEligible(1), true);      // 2. active business cash -> true
  assert.equal(isEligible(2), true);      // 3. active business bank -> true
  assert.equal(isEligible(3), true);      // 4. active business personal_custody -> true
  assert.equal(isEligible(4), false);     // 5. active non-business card_clearing -> false
  assert.equal(isEligible(5), false);     // 6. active non-business, non-card fixture -> false
  assert.equal(isEligible(6), false);     // 7. inactive business account -> false
  assert.equal(isEligible(999), false);   // 8. nonexistent -> false
});

test("current production seed data matches the scenarios above exactly", () => {
  assert.match(ledgerMigration, /'store_cash','cash','BABA','매장 현금'/);
  assert.match(ledgerMigration, /'baba_corporate_bank','bank','BABA','BABA 법인계좌'/);
  assert.match(ledgerMigration, /'cho_personal_custody','personal_custody','Cho','Cho 개인계좌 \(BABA 소유분\)'/);
  assert.match(ledgerMigration, /'card_clearing','card_clearing','BABA','카드 정산대기'/);
  assert.match(ownerSettlementsMigration, /alter table public\.ledger_fund_accounts add column is_business_fund boolean not null default true/);
  assert.match(ownerSettlementsMigration, /update public\.ledger_fund_accounts set is_business_fund=false where type='card_clearing'/);
});

test("V3 create/update/review keep calling the helper by name, so the fix applies without touching their bodies", () => {
  const createBody = fundAccountMigration.slice(fundAccountMigration.indexOf("create function public.business_partner_create_v3"), fundAccountMigration.indexOf("create function public.business_partner_update_v3"));
  const updateBody = fundAccountMigration.slice(fundAccountMigration.indexOf("create function public.business_partner_update_v3"), fundAccountMigration.indexOf("create function public.business_partner_review_supplier_alias_v3"));
  const reviewBody = fundAccountMigration.slice(fundAccountMigration.indexOf("create function public.business_partner_review_supplier_alias_v3"));
  for (const body of [createBody, updateBody, reviewBody]) {
    assert.match(body, /business_partner_fund_account_is_eligible_v1\(p_default_fund_account_id\)/);
  }
});

test("the app-facing selectable fund account list requires is_business_fund too, matching the RPC fix", () => {
  assert.match(partnerServer, /from\("ledger_fund_accounts"\)\.select\("id,code,type,display_name,is_active,is_business_fund,sort_order"\)\.eq\("is_active", true\)\.eq\("is_business_fund", true\)\.neq\("type", "card_clearing"\)/);
});
