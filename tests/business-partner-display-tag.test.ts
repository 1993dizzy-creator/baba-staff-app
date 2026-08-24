import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { parseDisplayTag } from "../lib/partners/policy.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const sha256 = (path: string) => createHash("sha256").update(read(path)).digest("hex");
const migration = read("supabase/migrations/202608240001_add_business_partner_display_tag.sql");
const oldPartnerMigration = read("supabase/migrations/202608220001_create_business_partner_master.sql");
const tagRoute = read("app/api/admin/partners/[id]/tag/route.ts");
const detailApi = read("app/api/admin/partners/[id]/route.ts");
const collectionApi = read("app/api/admin/partners/route.ts");
const partnerServer = read("lib/partners/server.ts");
const partnerDetail = read("app/(protected)/admin/partners/[id]/page.tsx");

test("previously applied migrations 002/003/004 remain byte-for-byte unchanged", () => {
  assert.equal(sha256("supabase/migrations/202608230002_add_supplier_alias_candidate_archive.sql"), "755a20caf4090ee8d67690e9f1827647bf8ac186ccf072b52595f820ffe76c9b");
  assert.equal(sha256("supabase/migrations/202608230003_add_business_partner_default_fund_account.sql"), "bd4f41eff8f1decd3c6e37a65cafd833e69a7683bd2bb649a3bee750cae6d598");
  assert.equal(sha256("supabase/migrations/202608230004_fix_business_partner_fund_account_eligibility.sql"), "ccc6ea8e2086102f63fe5a39d66fd3febed541920e9306b8bbb20744cc1e9e2d");
});

// 25/26/27/28
test("parseDisplayTag: nullable, <=30 chars, blank -> null, >30 chars rejected", () => {
  assert.equal(parseDisplayTag(null), null);
  assert.equal(parseDisplayTag(undefined), null);
  assert.equal(parseDisplayTag(""), null);
  assert.equal(parseDisplayTag("   "), null);
  assert.equal(parseDisplayTag("공식 공급처"), "공식 공급처");
  assert.equal(parseDisplayTag("  공식 공급처  "), "공식 공급처");
  assert.equal(parseDisplayTag("a".repeat(30)), "a".repeat(30));
  assert.equal(parseDisplayTag("a".repeat(31)), undefined);
  assert.equal(parseDisplayTag(42), undefined);
});

test("display_tag column is additive, nullable, and DB-checked between 1 and 30 trimmed chars", () => {
  assert.match(migration, /alter table public\.business_partners\s*\n\s*add column display_tag text null;/);
  assert.match(migration, /add constraint business_partners_display_tag_length check \(\s*\n\s*display_tag is null or length\(btrim\(display_tag\)\) between 1 and 30\s*\n\s*\);/);
  const schemaChange = migration.slice(0, migration.indexOf("create function public.business_partner_update_display_tag_v1"));
  assert.doesNotMatch(schemaChange, /update public\.business_partners|insert into public\.business_partners/i);
});

// 29: owner/master only
test("business_partner_update_display_tag_v1 only allows owner/master, mirrors the established security pattern", () => {
  assert.match(migration, /create function public\.business_partner_update_display_tag_v1/);
  assert.match(migration, /coalesce\(v_role, ''\) not in \('owner', 'master'\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = pg_catalog, public/);
  assert.match(migration, /alter function public\.business_partner_update_display_tag_v1\(bigint, text, bigint\) owner to postgres/);
  assert.match(migration, /revoke all on function public\.business_partner_update_display_tag_v1\(bigint, text, bigint\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.business_partner_update_display_tag_v1\(bigint, text, bigint\) to service_role/);
});

test("the RPC trims blank to NULL server-side too, and only touches display_tag/updated_at", () => {
  const body = migration.slice(migration.indexOf("create function public.business_partner_update_display_tag_v1"), migration.indexOf("alter function public.business_partner_update_display_tag_v1"));
  assert.match(body, /v_tag text := nullif\(btrim\(p_display_tag\), ''\)/);
  const updateStatement = body.slice(body.indexOf("update public.business_partners set"), body.indexOf("where id = p_partner_id;") + "where id = p_partner_id;".length);
  assert.match(updateStatement, /display_tag = v_tag,/);
  assert.match(updateStatement, /updated_at = now\(\)/);
  assert.doesNotMatch(updateStatement, /payment_mode|settlement_mode|settlement_rule|default_fund_account_id|phone|contact_name|memo|is_active\s*=|name\s*=/);
});

// 30: audit reuses action='updated', no new enum value
test("tag mutation reuses the existing action='updated' audit contract; no new audit action enum value", () => {
  assert.match(migration, /action, before_snapshot, after_snapshot\s*\n\s*\) values \(\s*\n\s*p_partner_id, p_actor_user_id, 'updated', v_before,/);
  assert.doesNotMatch(migration, /action in \(|add constraint business_partner_audit_logs_action_check/);
  assert.match(oldPartnerMigration, /action in \('created','updated','ledger_party_linked','ledger_party_unlinked'\)/);
});

// 18: existing V1/V2/V3 create/update RPC signatures are not touched by this migration
test("this migration does not touch business_partner_create/update_v1/v2/v3 signatures", () => {
  assert.doesNotMatch(migration, /create (or replace )?function public\.business_partner_(create|update)_v[123]\(/);
});

// 19: dedicated API route
test("PATCH /api/admin/partners/[id]/tag exists as its own route, requires the key, validates length, and never calls business_partner_update_v3", () => {
  assert.match(tagRoute, /export async function PATCH/);
  assert.match(tagRoute, /supabaseServer\.rpc\("business_partner_update_display_tag_v1"/);
  assert.doesNotMatch(tagRoute, /supabaseServer\.rpc\("business_partner_update_v3"/);
  assert.equal((tagRoute.match(/\.rpc\(/g) ?? []).length, 1);
  assert.match(tagRoute, /hasOwnProperty\.call\(body, "displayTag"\)/);
  assert.match(tagRoute, /parseDisplayTag/);
  assert.match(tagRoute, /requirePartnerManager/);
});

// 31: GET list/detail expose displayTag
test("GET list and scoped detail loaders both expose displayTag", () => {
  assert.match(partnerServer, /displayTag: row\.display_tag,/);
  assert.match(partnerServer, /select\("id,name,partner_type,payment_mode,settlement_mode,settlement_rule,default_payment_term_days,default_fund_account_id,partner_subtype_id,display_tag,phone,contact_name,memo,is_active,created_at,updated_at"\)/);
  assert.match(collectionApi, /partnerJson\(\{ ok: true, \.\.\.partnerData, supplierAliases \}\)/);
  assert.match(detailApi, /partner: data\.partner/);
  assert.match(detailApi, /loadPartnerDetailData\(id\)/);
});

// 32: tag update never touches other Partner fields (also proven client-side: separate endpoint/state)
test("saving a tag never calls the main partner update endpoint or PartnerForm's onSubmit", () => {
  assert.match(partnerDetail, /fetch\(`\/api\/admin\/partners\/\$\{params\.id\}\/tag`, \{ method: "PATCH"/);
  assert.doesNotMatch(partnerDetail, /saveTag[\s\S]{0,400}update\(/);
  assert.match(partnerDetail, /never through the main partner update above/);
});

// 33: existing partners default to NULL (no backfill/DML)
test("no backfill DML; existing business_partners rows stay NULL by simply adding a nullable column", () => {
  assert.match(migration, /add column display_tag text null;/);
  assert.doesNotMatch(migration, /update public\.business_partners set display_tag/);
});
