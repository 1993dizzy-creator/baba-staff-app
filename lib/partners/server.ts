import "server-only";

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { getDominantInventoryCategoryGroup } from "@/lib/inventory/category-groups";
import { PARTNER_MANAGER_ROLES } from "@/lib/partners/policy";
import { supabaseServer } from "@/lib/supabase/server";

const normalizeSupplierName = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function partnerJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

export async function requirePartnerManager() {
  const auth = await requireRole(PARTNER_MANAGER_ROLES);
  return auth.ok ? { actor: auth.actor, response: null } : {
    actor: null,
    response: partnerJson({ ok: false, code: auth.code }, auth.status),
  };
}

export async function loadPartnerData(partnerId?: number) {
  let partnerQuery = supabaseServer
    .from("business_partners")
    .select("id,name,partner_type,payment_mode,settlement_mode,settlement_rule,default_payment_term_days,default_fund_account_id,partner_subtype_id,display_tag,phone,contact_name,memo,is_active,created_at,updated_at")
    .order("is_active", { ascending: false })
    .order("name");
  if (partnerId !== undefined) partnerQuery = partnerQuery.eq("id", partnerId);

  const [partnerResult, mappingResult, ledgerResult, inventoryResult, fundAccountResult, subtypeResult] = await Promise.all([
    partnerQuery,
    supabaseServer.from("business_partner_ledger_parties").select("business_partner_id,ledger_party_id"),
    supabaseServer.from("ledger_parties").select("id,name,is_active").order("name"),
    supabaseServer.from("inventory").select("supplier_partner_id,is_active,part,category,category_vi").not("supplier_partner_id", "is", null),
    supabaseServer.from("ledger_fund_accounts").select("id,code,type,display_name,is_active,is_business_fund,sort_order").eq("is_active", true).eq("is_business_fund", true).neq("type", "card_clearing").order("sort_order"),
    supabaseServer.from("business_partner_subtypes").select("id,code,partner_type,name_ko,name_vi,sort_order,is_active").order("partner_type").order("sort_order"),
  ]);
  if (partnerResult.error || mappingResult.error || ledgerResult.error || inventoryResult.error || fundAccountResult.error || subtypeResult.error) {
    throw partnerResult.error ?? mappingResult.error ?? ledgerResult.error ?? inventoryResult.error ?? fundAccountResult.error ?? subtypeResult.error;
  }
  const ledgerById = new Map((ledgerResult.data ?? []).map(row => [Number(row.id), row]));
  const mappingByPartner = new Map((mappingResult.data ?? []).map(row => [Number(row.business_partner_id), Number(row.ledger_party_id)]));
  const inventoryCounts = new Map<number, { total: number; active: number; activeItems: Array<{ part: string | null; category: string | null; categoryVi: string | null }> }>();
  for (const row of inventoryResult.data ?? []) {
    const id = Number(row.supplier_partner_id);
    const count = inventoryCounts.get(id) ?? { total: 0, active: 0, activeItems: [] };
    count.total += 1;
    if (row.is_active !== false) {
      count.active += 1;
      count.activeItems.push({ part: row.part, category: row.category, categoryVi: row.category_vi });
    }
    inventoryCounts.set(id, count);
  }
  // Same fetch as the dropdown options (loadPartnerData already avoids N+1 by fetching
  // ledger_fund_accounts once); used here only to resolve id -> code for the info-row
  // payment summary, so no extra query is added.
  const fundAccountCodeById = new Map((fundAccountResult.data ?? []).map(row => [Number(row.id), row.code as string]));
  const partnerSubtypes = (subtypeResult.data ?? []).map(row => ({
    id: Number(row.id),
    code: row.code as string,
    partnerType: row.partner_type,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    sortOrder: Number(row.sort_order),
    isActive: row.is_active,
  }));
  const subtypeById = new Map(partnerSubtypes.map(subtype => [subtype.id, subtype]));
  const partners = (partnerResult.data ?? []).map(row => {
    const ledgerPartyId = mappingByPartner.get(Number(row.id)) ?? null;
    const defaultFundAccountId = row.default_fund_account_id === null ? null : Number(row.default_fund_account_id);
    const partnerSubtypeId = row.partner_subtype_id === null ? null : Number(row.partner_subtype_id);
    const partnerSubtype = partnerSubtypeId === null ? null : subtypeById.get(partnerSubtypeId) ?? null;
    return {
      id: Number(row.id),
      name: row.name,
      partnerType: row.partner_type,
      paymentMode: row.payment_mode,
      settlementMode: row.settlement_mode,
      settlementRule: row.settlement_rule,
      defaultPaymentTermDays: row.default_payment_term_days,
      defaultFundAccountId,
      defaultFundAccountCode: defaultFundAccountId === null ? null : fundAccountCodeById.get(defaultFundAccountId) ?? null,
      partnerSubtypeId,
      partnerSubtypeCode: partnerSubtype?.code ?? null,
      partnerSubtype,
      displayTag: row.display_tag,
      phone: row.phone,
      contactName: row.contact_name,
      memo: row.memo,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ledgerPartyId,
      inventoryCount: inventoryCounts.get(Number(row.id))?.total ?? 0,
      activeInventoryCount: inventoryCounts.get(Number(row.id))?.active ?? 0,
      dominantInventoryGroup: getDominantInventoryCategoryGroup(inventoryCounts.get(Number(row.id))?.activeItems ?? []),
      ledgerParty: ledgerPartyId === null ? null : ledgerById.get(ledgerPartyId) ?? null,
    };
  });
  return {
    partners,
    ledgerParties: (ledgerResult.data ?? []).map(row => ({ id: Number(row.id), name: row.name, isActive: row.is_active })),
    fundAccounts: (fundAccountResult.data ?? []).map(row => ({ id: Number(row.id), code: row.code, displayName: row.display_name, type: row.type })),
    partnerSubtypes,
  };
}

export async function loadSupplierAliases() {
  const [aliasResult, inventoryResult] = await Promise.all([
    supabaseServer.from("business_partner_supplier_aliases").select("id,supplier_name,status,business_partner_id,first_seen_at,last_seen_at,reviewed_at").order("last_seen_at", { ascending: false }),
    supabaseServer.from("inventory").select("supplier,is_active,part,category,category_vi").not("supplier", "is", null),
  ]);
  if (aliasResult.error || inventoryResult.error) throw aliasResult.error ?? inventoryResult.error;
  const counts = new Map<string, { total: number; active: number; activeItems: Array<{ part: string | null; category: string | null; categoryVi: string | null }> }>();
  for (const row of inventoryResult.data ?? []) {
    const key = normalizeSupplierName(row.supplier);
    if (!key) continue;
    const current = counts.get(key) ?? { total: 0, active: 0, activeItems: [] };
    current.total += 1;
    if (row.is_active !== false) {
      current.active += 1;
      current.activeItems.push({ part: row.part, category: row.category, categoryVi: row.category_vi });
    }
    counts.set(key, current);
  }
  return (aliasResult.data ?? []).map(row => {
    const usage = counts.get(normalizeSupplierName(row.supplier_name)) ?? { total: 0, active: 0, activeItems: [] };
    return {
      id: Number(row.id), supplierName: row.supplier_name, status: row.status,
      businessPartnerId: row.business_partner_id === null ? null : Number(row.business_partner_id),
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, reviewedAt: row.reviewed_at,
      inventoryCount: usage.total, activeInventoryCount: usage.active,
      dominantInventoryGroup: getDominantInventoryCategoryGroup(usage.activeItems),
    };
  });
}

export async function loadSupplierAliasInventory(supplierName: string) {
  const { data, error } = await supabaseServer.from("inventory")
    .select("id,supplier,item_name,item_name_vi,part,category,category_vi,is_active")
    .not("supplier", "is", null)
    .order("is_active", { ascending: false })
    .order("item_name_vi");
  if (error) throw error;
  const normalizedName = normalizeSupplierName(supplierName);
  return (data ?? [])
    .filter(row => normalizeSupplierName(row.supplier) === normalizedName)
    .map(row => ({
      id: Number(row.id),
      supplier: row.supplier,
      itemName: row.item_name,
      itemNameVi: row.item_name_vi,
      part: row.part,
      category: row.category,
      categoryVi: row.category_vi,
      isActive: row.is_active,
    }));
}

export async function loadLinkedPartnerInventory(partnerId: number) {
  const { data, error } = await supabaseServer.from("inventory")
    .select("id,item_name,item_name_vi,part,category,category_vi,purchase_price,is_active,supplier")
    .eq("supplier_partner_id", partnerId).order("is_active", { ascending: false }).order("item_name_vi");
  if (error) throw error;
  return (data ?? []).map(row => ({
    id: Number(row.id), itemName: row.item_name, itemNameVi: row.item_name_vi, part: row.part,
    category: row.category, categoryVi: row.category_vi, purchasePrice: row.purchase_price,
    isActive: row.is_active, rawSupplier: row.supplier,
  }));
}
