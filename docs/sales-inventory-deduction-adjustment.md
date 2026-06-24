# 판매차감 후 영수증 수정 보정 설계

## 1. 현재 구조

### 최초 차감 흐름

1. 영수증 목록(`/admin/sales/receipts`)에서 preview 생성
2. `payment_status = 3` 영수증만 대상
3. Preview → Batch 저장 (`pos_inventory_deduction_batches`, `pos_inventory_deduction_receipts`, `pos_inventory_deductions`)
4. Apply RPC(`apply_sales_inventory_deduction_batch`) → `inventory` 차감 + `inventory_logs` 기록

### pos_inventory_deductions 저장 단위

차감 1건 = 1 deduction row. 다음 컬럼이 line-level 추적에 사용됨:

```
receipt_id              pos_sales_receipts.id (안정적 내부 ID)
receipt_line_id         pos_sales_receipt_lines.id (안정적 내부 ID)
inventory_item_id       차감된 재고 항목
mapping_id              사용된 매핑
recipe_id               사용된 레시피 (없으면 null)
quantity_sold           차감 당시 POS 판매 수량
deduct_quantity_total   실제 차감된 재고량
deduct_quantity_per_unit 단위당 차감량
status                  applied (완료)
applied_at              차감 시각
reversal_of_deduction_id 반전 링크 (컬럼 존재, 미활성화)
```

### 이미 차감 여부 판정 (현재)

`pos_inventory_deductions.invoice_ref_id` ↔ `pos_sales_receipts.ref_id` 매칭.  
receipt-level(영수증 단위)로 판정. line-level 비교 없음.

### applied_after_modified 상태

- 조건: `receipt.is_modified = true` AND `receipt.updated_at > deduction.applied_at`
- Preview에 표시됨 (`차감 후 수정` badge)
- **apply는 차단됨** (status !== "ready" 체크, RPC 중복 체크)

---

## 2. 문제

이미 차감 후 영수증이 수정되면 다음 네 가지 상황이 발생할 수 있다:

| 변경 유형 | 현재 처리 |
|---|---|
| 신규 line 추가 | 차단됨 (apply 불가) |
| 기존 line 수량 증가 | 차단됨 (apply 불가) |
| 기존 line 수량 감소 | 차단됨 (자동 복구 없음) |
| 기존 line 삭제 | 차단됨 (자동 복구 없음) |

단순히 `applied_after_modified`를 `ready`로 풀면 **기존 차감분이 통째로 중복 차감**된다.  
Apply RPC도 `applied.receipt_id = candidate.receipt_id` 조건으로 receipt 단위 중복을 차단한다.

---

## 3. 안전 원칙

1. **기존 applied row는 수정/삭제하지 않는다.** append-only 원장 방식 유지.
2. **standard apply와 delta apply는 반드시 분리한다.** 동일 경로에 섞지 않는다.
3. **수량 증가/신규 line만 자동 추가 차감 후보**로 허용한다.
4. **수량 감소/삭제는 자동 복구하지 않는다.** 보정 필요로 분리해 운영 확인을 거친다.
5. **line matching 기준은 `receipt_line_id` (내부 DB ID)**를 사용한다. CUKCUK `RefDetailID`는 재동기화 시 변경될 수 있어 신뢰하지 않는다.

---

## 4. Phase 1 — read-only diff 표시 (migration 없음)

### 목표

`applied_after_modified` 영수증에서 line별 변경 유형을 시각적으로 구분한다. Apply는 여전히 차단.

### 구현 위치

`lib/sales/inventory-deduction-preview.ts`

### diff 계산 방법

```
applied_key = (receipt_line_id, inventory_item_id, mapping_id, recipe_id)
```

1. `pos_inventory_deductions WHERE receipt_id = ? AND status = 'applied'` 조회
2. `appliedByKey = Map<applied_key, { quantity_sold, deduct_quantity_total }>`
3. 현재 preview line의 각 deduction을 비교:

| 비교 결과 | deltaKind | UI 표시 |
|---|---|---|
| applied_key 없음 | `new_line` | [신규] — 수동 차감 필요 |
| current qty > applied qty | `quantity_increased` | [수량 증가] delta 표시 |
| current qty == applied qty | `unchanged` | [이미 차감] |
| current qty < applied qty | `quantity_decreased` | [수량 감소] 재고 복구 확인 필요 |
| applied_key는 있으나 현재 line 없음 | `deleted` | [삭제됨] 재고 복구 확인 필요 |

### 변경 범위

- `preview.ts`: `PreviewLine`에 `deltaKind` 필드 추가, `applied_after_modified` 영수증 처리 분기
- `page.tsx`: line badge에 deltaKind 반영 (표시만)
- apply 로직: **변경 없음**

---

## 5. Phase 2 — delta_add 전용 apply

### 목표

`new_line`, `quantity_increased` 에 해당하는 line만 별도 경로로 차감한다.

### 신규 RPC: `apply_sales_inventory_deduction_delta_batch`

기존 RPC와 동일하되, 중복 체크를 line 단위로 변경:

```sql
-- 기존 (standard): receipt 단위 차단
or applied.receipt_id = candidate.receipt_id

-- 신규 (delta): 이 조건 제거. 대신 line 단위 정확한 중복만 차단:
-- (receipt_line_id, inventory_item_id, mapping_id, recipe_id) 조합이
-- 이미 applied 상태이면 차단
```

delta apply에서 `receipt_id` 단위 체크를 제거하되, line 단위 체크는 유지한다.

### 필요 DB 컬럼 후보

```sql
-- pos_inventory_deductions
delta_basis_deduction_id bigint null  -- 이 delta가 기반하는 원본 deduction.id
deduction_kind text not null default 'standard'
  check (deduction_kind in ('standard', 'delta_add', 'delta_revert'))

-- pos_inventory_deduction_batches
batch_type text not null default 'standard'
  check (batch_type in ('standard', 'delta'))
```

### apply 엔드포인트

별도 route (`/api/admin/sales/inventory-deductions/apply-delta`) 또는 기존 route에 `batch_type` 분기.  
**기존 standard apply route 로직은 변경하지 않는다.**

### 차감 대상

- `deltaKind = new_line` → 전체량 차감
- `deltaKind = quantity_increased` → delta량(`current - applied`)만 차감
- `deltaKind = unchanged`, `quantity_decreased`, `deleted` → 제외

---

## 6. Phase 3 — delta_revert / 재고 복구

### 목표

수량 감소/삭제로 인해 이미 차감된 재고를 되돌린다.

### 주의

자동 복구는 위험하다. 수량 감소가 오기입 수정인지 실제 반환인지 운영 판단이 필요하다.

### 설계 방향

- `deduction_kind = 'delta_revert'` row를 생성 (원본 deduction 참조: `reversal_of_deduction_id`)
- 별도 승인형 UI: 운영자가 항목별로 확인 후 복구
- 복구 금액 = `applied.deduct_quantity_total` 또는 감소분
- **기존 applied row는 절대 UPDATE/DELETE하지 않는다.** 복구 행을 새로 INSERT한다.

---

## 7. 필요한 DB 컬럼 후보 (Phase 2-3 대비)

```sql
-- pos_inventory_deductions 추가 후보
delta_basis_deduction_id bigint null
  references public.pos_inventory_deductions(id) on delete set null
deduction_kind text not null default 'standard'
  check (deduction_kind in ('standard', 'delta_add', 'delta_revert'))

-- pos_inventory_deduction_batches 추가 후보
batch_type text not null default 'standard'
  check (batch_type in ('standard', 'delta'))
```

기존 데이터와 완전 호환 (all nullable or default 'standard').

---

## 8. 절대 하지 말아야 할 위험한 수정

| 금지 수정 | 위험 이유 |
|---|---|
| `applied_after_modified`를 `ready`로 단순 변경 | 기존 차감분 통째로 중복 차감 |
| apply route의 `status === "ready"` 체크 제거 | 모든 중복 방지 무력화 |
| RPC의 `receipt_id` 중복 체크 제거 (standard batch에서) | 동일 영수증 다른 배치에서 중복 차감 가능 |
| 기존 applied deduction row UPDATE/DELETE | 회계 감사 추적 파괴 |
| standard apply와 delta apply를 한 경로에 혼합 | 검증 로직 복잡도 폭증, 오류 탐지 어려움 |
| `receipt_id` 전체 체크 없이 delta apply | 보정 범위를 초과한 항목이 apply될 수 있음 |

---

## 9. line matching 기준 (RefDetailID 불안정성 대응)

CUKCUK 재동기화 시 `RefDetailID`가 바뀔 수 있다.  
따라서 line matching 기준은 **`receipt_line_id` (pos_sales_receipt_lines.id, 내부 DB ID)** 를 사용한다.

```
diff key = (receipt_line_id, inventory_item_id, mapping_id, recipe_id)
```

RefDetailID가 바뀌어 새 line row가 생성되면, 기존 deduction과 매칭이 안 되어 `new_line`으로 분류된다.  
→ 최악의 경우 수동 처리 대상 증가 (false positive). 중복 차감(false negative)은 발생하지 않는다.

---

## 10. combo/recipe/direct/option 각각 가능 여부

| line type | diff key | 가능 여부 |
|---|---|---|
| direct | `(line_id, inv_id, mapping_id, null)` | ✅ |
| recipe | `(line_id, inv_id, mapping_id, recipe_id)` | ✅ |
| option_direct | `(line_id, inv_id, mapping_id, null)` | ✅ |
| option_recipe | `(line_id, inv_id, mapping_id, recipe_id)` | ✅ |
| combo_direct | `(line_id, inv_id, mapping_id, null)` | ✅ inv_id로 자식 구분 |
| combo_recipe | `(line_id, inv_id, mapping_id, recipe_id)` | ✅ |
| combo_incomplete_recipe | deduction 없음 | N/A |

---

## 11. 테스트 시나리오

### Phase 1 검증

| 시나리오 | 기대 diff 결과 |
|---|---|
| 차감 후 수정 없이 preview | 전체 `unchanged` |
| 차감 후 신규 line 추가 | 신규 line → `new_line` |
| 차감 후 기존 line 수량 증가 | 해당 line → `quantity_increased` |
| 차감 후 기존 line 수량 감소 | 해당 line → `quantity_decreased` |
| 차감 후 기존 line 삭제 | 해당 line → `deleted` |
| RefDetailID 변경 후 동기화 | 기존 line 매칭 실패 → `new_line` (보수적 처리) |
| combo line 일부 재료 수량 변경 | 해당 재료(inv_id)만 `quantity_increased` |

### Phase 2 추가 검증

| 시나리오 | 기대 결과 |
|---|---|
| delta apply → 신규 line 차감 | 신규 line만 차감, unchanged line 건드리지 않음 |
| delta apply 2회 시도 | 2번째 line-level 중복 체크로 409 차단 |
| `quantity_decreased` line을 delta apply 요청 | preview에서 excluded, apply 대상 안 됨 |
| standard apply와 delta apply 동시 시도 | 각각 별도 route, 서로 간섭 없음 |

---

## 12. 현재 코드 위치 참조

| 위치 | 역할 |
|---|---|
| `lib/sales/inventory-deduction-preview.ts` | `applied_after_modified` 상태 설정 로직 |
| `lib/sales/inventory-deduction-batches.ts` | `already_applied` → candidate 제외, `applied_after_modified` → blocked 저장 |
| `app/api/admin/sales/inventory-deductions/apply/route.ts` | `status === "ready"` 체크 — 변경 금지 |
| `supabase/migrations/202606150001_apply_sales_inventory_deduction_batch.sql` | RPC 중복 체크 로직 |
| `app/(protected)/admin/sales/receipts/page.tsx` | `applied_after_modified` → "차감 후 수정" badge |
