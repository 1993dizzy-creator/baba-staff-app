import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node loads the TypeScript policy directly in tests.
import { parsePartnerInput } from "../lib/partners/policy.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/202608220001_create_business_partner_master.sql");
const collectionApi = read("app/api/admin/partners/route.ts");
const detailApi = read("app/api/admin/partners/[id]/route.ts");
const layout = read("app/(protected)/admin/partners/layout.tsx");
const admin = read("app/(protected)/admin/page.tsx");

const base = { name: "Fresh Foods", partnerType: "food", paymentMode: "immediate", settlementMode: null, settlementRule: null, defaultPaymentTermDays: null, phone: "090", contactName: "Lan", memo: "", isActive: true, ledgerPartyId: null };

test("partner input supports a strict immediate policy", () => {
  assert.deepEqual(parsePartnerInput(base), { ...base, phone: "090", contactName: "Lan", memo: null });
  assert.equal(parsePartnerInput({ ...base, defaultPaymentTermDays: 30 }), null);
  assert.equal(parsePartnerInput({ ...base, settlementMode: "scheduled", settlementRule: "monthly_twice" }), null);
});

test("postpaid policy combinations are explicit", () => {
  assert.equal(parsePartnerInput({ ...base, paymentMode: "postpaid" }), null);
  assert.equal(parsePartnerInput({ ...base, paymentMode: "postpaid", settlementMode: "ad_hoc" })?.settlementMode, "ad_hoc");
  assert.equal(parsePartnerInput({ ...base, paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "net_days", defaultPaymentTermDays: 30 })?.defaultPaymentTermDays, 30);
  assert.equal(parsePartnerInput({ ...base, paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "monthly_once" })?.defaultPaymentTermDays, null);
  assert.equal(parsePartnerInput({ ...base, paymentMode: "postpaid", settlementMode: "scheduled", settlementRule: "monthly_twice" })?.defaultPaymentTermDays, null);
});

test("V1 supports update deactivate and reactivate without DELETE", () => {
  assert.match(detailApi, /export async function PATCH/);
  assert.match(detailApi, /p_is_active: input\.isActive/);
  assert.doesNotMatch(collectionApi + detailApi, /export async function DELETE/);
  assert.match(migration, /business_partner_update_v1/);
});

test("duplicate names are case-insensitive and return conflict", () => {
  assert.match(migration, /unique index business_partners_name_unique[\s\S]*lower\(btrim\(name\)\)/);
  assert.match(collectionApi, /duplicate_name" \|\| result\.status === "ledger_party_already_linked" \? 409/);
  assert.match(detailApi, /duplicate_name" \|\| result\.status === "ledger_party_already_linked" \? 409/);
});

test("owner and master guard both pages and APIs", () => {
  assert.match(layout, /requireRole\(PARTNER_MANAGER_ROLES\)/);
  assert.match(collectionApi, /requirePartnerManager\(\)/);
  assert.match(detailApi, /requirePartnerManager\(\)/);
  assert.match(migration, /not in \('owner', 'master'\)/);
});

test("browser CRUD is denied and service role only executes atomic RPCs", () => {
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated, service_role/);
  assert.doesNotMatch(migration, /grant (insert|update|delete) on table[\s\S]*to service_role/i);
  assert.match(migration, /grant execute on function public\.business_partner_create_v1[\s\S]*to service_role/);
  assert.match(migration, /set search_path = pg_catalog, public/);
});

test("Ledger IDs and inventory supplier strings remain untouched", () => {
  assert.match(migration, /business_partner_ledger_parties/);
  assert.match(migration, /ledger_party_id bigint not null unique references public\.ledger_parties\(id\) on delete restrict/);
  assert.doesNotMatch(migration, /alter table public\.ledger_parties/);
  assert.doesNotMatch(migration, /alter table public\.inventory/);
  assert.doesNotMatch(migration, /update public\.inventory/);
});

test("admin menu places partners immediately after ledger", () => {
  assert.ok(admin.indexOf('href: "/admin/ledger"') < admin.indexOf('href: "/admin/partners"'));
  assert.ok(admin.indexOf('href: "/admin/partners"') < admin.indexOf('href: "/admin/pos/mappings"'));
});
