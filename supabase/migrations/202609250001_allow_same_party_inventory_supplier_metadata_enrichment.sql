-- A confirmed Inventory purchase can acquire an explicit Business Partner link
-- after the Ledger expense and payable were created. The partner id remains an
-- economic field globally: it may select a genuinely different Ledger party.
-- This narrow projection exception applies only when every other economic
-- source value (including the supplier string) is unchanged and the current
-- partner bridge resolves to the party already recorded on the transaction.
-- In that case the new id is identity metadata enrichment, so the immutable
-- transaction/payable/payment history is left untouched and only drift audit
-- evidence advances.
do $same_party_inventory_supplier_metadata$
declare
  v_oid regprocedure := 'public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure;
  v_definition text;
  v_guard text := $guard$if inventory_ledger_private.economics(v_candidate.source_snapshot) = inventory_ledger_private.economics(v_snapshot) then$guard$;
  v_replacement text := $replacement$if inventory_ledger_private.economics(v_candidate.source_snapshot) = inventory_ledger_private.economics(v_snapshot)
           or (
             -- Same supplier identity metadata enrichment: partner linkage is
             -- newly added to a previously unlinked snapshot, is the only
             -- economic-key change, and resolves to the existing party. An
             -- existing partner id may never change or be cleared via this path.
             v_candidate.source_snapshot->>'purchase_supplier_partner_id' is null
             and v_log.purchase_supplier_partner_id is not null
             and v_candidate.source_snapshot->'purchase_supplier_partner_id'
               is distinct from v_snapshot->'purchase_supplier_partner_id'
             and (inventory_ledger_private.economics(v_candidate.source_snapshot) - 'purchase_supplier_partner_id')
               = (inventory_ledger_private.economics(v_snapshot) - 'purchase_supplier_partner_id')
             and v_candidate.source_snapshot->'supplier' is not distinct from v_snapshot->'supplier'
             and exists (
               select 1
               from public.business_partner_ledger_parties bridge
               join public.business_partners partner
                 on partner.id = bridge.business_partner_id
                and partner.is_active = true
               where bridge.business_partner_id = v_log.purchase_supplier_partner_id
                 and bridge.ledger_party_id = v_tx.party_id
             )
           ) then$replacement$;
begin
  v_definition := pg_get_functiondef(v_oid);
  if position(v_guard in v_definition) = 0
     or position('same supplier identity metadata enrichment' in lower(v_definition)) > 0 then
    raise exception 'INVENTORY_SAME_PARTY_METADATA_CONTRACT_MISMATCH';
  end if;

  v_definition := replace(v_definition, v_guard, v_replacement);
  execute v_definition;
end;
$same_party_inventory_supplier_metadata$;

alter function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) owner to postgres;
revoke all on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint)
  to service_role;
