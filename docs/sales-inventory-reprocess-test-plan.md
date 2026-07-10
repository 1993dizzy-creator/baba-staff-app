# Sales inventory reprocess rollback test plan

Use a test database or an explicit rollback transaction. Do not run these
checks against production data without a restored snapshot.

## Preflight

1. Pick one already-applied receipt that is currently classified as
   `reprocess_modified` by
   `POST /api/admin/sales/inventory-deductions/unified-preview`.
2. Record:
   - `receiptId`
   - `currentFingerprint`
   - `inventoryAffectingHash`
   - `updatedAt`
   - active deduction ids from the unified preview response
3. Confirm the receipt is not canceled.

## Transaction rollback check

Run the API or RPC inside an environment where the outer test transaction can
be rolled back. For direct SQL validation, prepare a reprocess batch through
the server helper first, then call:

```sql
begin;

select public.reprocess_modified_sales_inventory_deduction_receipt(
  p_batch_receipt_id := :batch_receipt_id,
  p_actor_username := :actor_username,
  p_expected_receipt_updated_at := :receipt_updated_at,
  p_expected_receipt_content_fingerprint := :receipt_content_fingerprint,
  p_expected_inventory_affecting_hash := :inventory_affecting_hash
);

select item_id, prev_quantity, new_quantity, change_quantity
from public.inventory_logs
where related_batch_id = :batch_id
order by id;

select id, operation_type, status, reversal_of_deduction_id
from public.pos_inventory_deductions
where batch_id = :batch_id
order by id;

rollback;
```

## Expected cases

- Quantity decrease: old deductions are inserted as positive `revert` logs,
  then current deductions are inserted as negative sale logs.
- Quantity increase with insufficient final stock: RPC returns
  `insufficient_stock_after_reversal`; no inventory changes persist.
- Product or recipe change: old inventory items are restored and current
  preview inventory items are deducted.
- Rollback-only: active deductions are restored, no current deduction rows are
  applied, and `rollbackOnly` is `true`.
- Duplicate same fingerprint: second call returns `already_processed` and does
  not create additional inventory movement.
- Canceled receipt: returns a needs-check/not-supported result before inventory
  movement.

## Unified execute dry validation

Use `POST /api/admin/sales/inventory-deductions/unified-preview` first and copy
only the validation tokens returned for each receipt:

- `receiptId`
- `operationType`
- `currentFingerprint`
- `inventoryAffectingHash`
- `updatedAt`

Then call `POST /api/admin/sales/inventory-deductions/unified-execute` against a
test database or rollback-capable environment:

```json
{
  "actorUsername": "owner",
  "items": [
    {
      "receiptId": 123,
      "expectedOperationType": "reprocess_modified",
      "expectedFingerprint": "preview-fingerprint",
      "expectedInventoryAffectingHash": "preview-inventory-hash",
      "expectedReceiptUpdatedAt": "preview-updated-at"
    }
  ]
}
```

Expected behavior:

- Receipts are processed sequentially, not in parallel.
- One stale or failed receipt does not roll back other receipts.
- If a receipt changes after preview, the result is `stale_preview`.
- If the operation type changes after preview, the result is `stale_preview`
  with `operation_changed`.
- Duplicate receipt ids in one request are rejected.
- More than 30 receipts in one request are rejected.
