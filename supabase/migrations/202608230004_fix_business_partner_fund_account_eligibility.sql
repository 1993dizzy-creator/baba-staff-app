-- Postflight fix: business_partner_fund_account_is_eligible_v1 checked
-- is_active and type <> 'card_clearing' but omitted
-- ledger_fund_accounts.is_business_fund = true. Current production data
-- (store_cash, baba_corporate_bank, cho_personal_custody all
-- is_business_fund=true; card_clearing already excluded by type) is
-- unaffected, but a future active, non-business, non-card_clearing fund
-- account would have been wrongly accepted by business_partner_create_v3 /
-- business_partner_update_v3 / business_partner_review_supplier_alias_v3,
-- which all call this helper by name. CREATE OR REPLACE keeps the function
-- name/signature/OID stable, so those V3 RPCs pick up the fix without any
-- change to their own bodies.

create or replace function public.business_partner_fund_account_is_eligible_v1(
  p_fund_account_id bigint
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_fund_account_id is null or exists (
    select 1 from public.ledger_fund_accounts
    where id = p_fund_account_id
      and is_active = true
      and is_business_fund = true
      and type <> 'card_clearing'
  );
$$;

alter function public.business_partner_fund_account_is_eligible_v1(bigint) owner to postgres;
revoke all on function public.business_partner_fund_account_is_eligible_v1(bigint) from public, anon, authenticated;
grant execute on function public.business_partner_fund_account_is_eligible_v1(bigint) to service_role;

comment on function public.business_partner_fund_account_is_eligible_v1(bigint) is
  'Eligible = NULL, or an active, is_business_fund, non-card_clearing Ledger fund account. Used by business_partner_create_v3/update_v3/review_supplier_alias_v3 (called by name, so this fix applies to all three without touching their bodies) to validate default_fund_account_id before writing.';
