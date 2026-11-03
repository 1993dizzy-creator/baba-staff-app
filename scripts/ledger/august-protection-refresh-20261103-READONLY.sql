-- REVIEW-ONLY evidence collection. No rebuild install/apply/reverse, DDL or DML.
-- Not executed against production by this task. Definitions copied from v3;
-- run this SELECT as a single consistent SQL snapshot before final approval.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='30s';
WITH audit_cut AS (
 SELECT coalesce(max(id),0) max_id FROM public.ledger_audit_logs
), aug_alloc AS (
 SELECT x.id,x.payable_id,x.payment_transaction_id,x.allocated_amount
 FROM public.ledger_payable_allocations x
 JOIN public.ledger_payables p ON p.id=x.payable_id
 JOIN public.ledger_transactions src ON src.id=p.expense_transaction_id
 JOIN public.ledger_transactions payment ON payment.id=x.payment_transaction_id
 WHERE src.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
   AND src.status='confirmed' AND payment.status='confirmed'
   AND payment.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31'
), protected AS (
 SELECT 1 ord,'payable_allocations' name,count(*) before_count,
   md5(coalesce(string_agg(id::text||':'||payable_id::text||':'||payment_transaction_id::text||':'||allocated_amount::text,'|' ORDER BY id),'')) fingerprint
 FROM aug_alloc
 UNION ALL
 SELECT 2,'pos_receipts',count(*),md5(coalesce(string_agg(
   id::text||':'||business_date::text||':'||status||':'||amount::text||':'||coalesce(source_key,''),'|' ORDER BY id),''))
 FROM public.ledger_transactions
 WHERE business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31' AND source_type='pos_sales_daily_payment'
 UNION ALL
 SELECT 3,'month_closure_history',count(*),md5(coalesce(string_agg(
   id::text||':'||revision::text||':'||coalesce(snapshot_hash,''),'|' ORDER BY month,id),''))
 FROM public.ledger_month_closure_history
 WHERE month IN(DATE '2026-08-01',DATE '2026-09-01') AND revision<=4
 UNION ALL
 SELECT 4,'ledger_audit_history',count(*),md5(coalesce(string_agg(
   id::text||':'||action||':'||coalesce(entity_type,'')||':'||coalesce(entity_id::text,'')||':'||coalesce(after_snapshot::text,''),'|' ORDER BY id),''))
 FROM public.ledger_audit_logs WHERE id<=(SELECT max_id FROM audit_cut)
 UNION ALL
 SELECT 5,'inventory_logs',count(*),md5(coalesce(string_agg(
   id::text||':'||coalesce(business_date::text,'')||':'||coalesce(item_id::text,'')||':'||
   coalesce(change_quantity::text,'')||':'||coalesce(new_purchase_price::text,''),'|' ORDER BY id),''))
 FROM public.inventory_logs WHERE business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
)
SELECT jsonb_build_object(
 'status','REVIEW_ONLY_ATOMIC_READ_CAPTURE_NOT_APPROVED',
 'capturedAt',transaction_timestamp(),
 'auditMaxId',(SELECT max_id FROM audit_cut),
 'requiredProtectedFingerprints',(SELECT jsonb_agg(jsonb_build_object('name',name,'beforeCount',before_count,'fingerprint',fingerprint) ORDER BY ord) FROM protected),
 'augustAllocatedAmount',(SELECT sum(allocated_amount) FROM aug_alloc),
 'matchesPostflightPayable',(SELECT before_count=289 AND fingerprint='e41b545e00c8241e072cda1db32d6d95' FROM protected WHERE name='payable_allocations')
   AND (SELECT sum(allocated_amount)=46053076 FROM aug_alloc),
 'closures',(SELECT jsonb_agg(jsonb_build_object('month',month,'status',status,'revision',revision) ORDER BY month)
   FROM public.ledger_month_closures WHERE month IN(DATE '2026-08-01',DATE '2026-09-01')),
 'closuresMatch',(SELECT count(*)=2 FROM public.ledger_month_closures WHERE month IN(DATE '2026-08-01',DATE '2026-09-01') AND status='reopened' AND revision=4),
 'correctionAudit',(SELECT jsonb_build_object('id',id,'action',action,'correctionKey',after_snapshot->>'correctionKey',
   'afterSnapshotTextMd5',md5(after_snapshot::text)) FROM public.ledger_audit_logs WHERE id=7062),
 'correctionAuditMatches',EXISTS(SELECT 1 FROM public.ledger_audit_logs WHERE id=7062 AND action='payable_allocation_chain_corrected'
   AND entity_type='transaction' AND entity_id=1641 AND after_snapshot->>'correctionKey'='phuong-chain-20261103-2399-exception-v1'),
 'approved',false
) AS protected_snapshot;
ROLLBACK;
