# BABA 관리자 APP 레거시 정리 1·2단계 (2026-11-16)

작업원장: Notion "BABA 관리자 APP 레거시 정리 — 10월 특별급여 페이지·일회성 기능 포함".
기준 HEAD `eab869a7`(로컬 main). 운영 DB DDL/DML·Migration 적용/Repair·Push·Vercel 배포·환경변수 삭제는 실행하지 않았다.
실제 직원별 금액·지급계획 JSON은 공개 저장소에 기록하지 않는다(검증 스크립트는 Git 제외 `.local/`).

## 1단계 — 10월 특별 급여 정산 정리

### 일반 급여 상세 표시 보강 (`/admin/payroll/[runId]`)
- `GET /api/admin/payroll/runs/[runId]`: 기존 응답(run·employees·audit·mealAllowanceEligibleUserIds)은 그대로 두고
  `allocations`(분할 지급), `residuals`(배치 반올림 잔차), `fundAccounts`(출금계좌 이름)를 읽기 전용으로 추가.
  테이블이 없는 구 환경(42P01/PGRST205)은 빈 목록, 그 밖의 조회 오류는 500으로 닫힘.
- `lib/payroll/payment-outflows.ts`: DB 프로젝터 `ledger_project_payroll_payment_group_v1`과 같은 규칙으로
  지급일·출금계좌별 출금을 묶는다(활성 allocation 우선, 없으면 지급 기록 1건, 잔차는 직원 미배분 별도 라인).
  금액을 재계산·보정하지 않으며 분할 합계 ≠ 실지급액·직원 합계 ≠ 배치 저장 합계는 경고로만 표시.
- 화면(KO/VI): "지급일·계좌별 출금" 카드(그룹·잔차 사유·직원 실지급 합계·반올림 잔차·전체 출금 합계),
  직원 행 "분할 N건" 배지, 상세의 "지급일 · 출금계좌" 라인(패널티 반환 표기·메모), 접힌 "감사 이력 N건".
- 운영 배치 4 읽기 전용 대조: 11/10 매장 현금 7,345,000 · 11/10 BABA 법인계좌 157,682,323(잔차 +1 포함) ·
  11/14 매장 현금 3,000,000 · 전체 출금 168,027,323 = 배치 실지급 168,027,322 + 잔차 1.
  자동 장부 거래 5008/5009/5010 금액과 일치. 감사 로그 20건(시작 1·직원 지급 17·완료 1·특별 정산 1).

### 일회성 코드 제거 (REMOVE — 완료)
| 대상 | 처리 |
|---|---|
| `app/api/admin/payroll/special-settlements/2026-10/route.ts` (GET 미리보기/POST 확정) | 삭제 |
| `lib/payroll/special-settlement-2026-10-server.ts` (서버 전용 JSON 로더) | 삭제 |
| `lib/payroll/special-settlement-2026-10.ts` (계획 파서·미리보기, `NOTHING_TO_SETTLE`) | 삭제 |
| `tests/payroll-2026-10-special-settlement-api.test.mjs`, `...-plan.test.ts` | 삭제(대상 코드 제거) |
| `app/(protected)/admin/payroll/special-settlement-2026-10/page.tsx` | 권한 확인 후 2026-10 배치 상세로 서버 redirect (배치 없으면 2026-10 급여관리) |
| `app/api/admin/payroll/payments/route.ts` 10월 전용 import | 독립 상수로 교체, 코드 `PAYROLL_SPECIAL_SETTLEMENT_COMPLETED`(KO/VI 안내) |

`tests/payroll-2026-10-special-settlement-db.test.mjs` → `tests/payroll-split-allocation-migration-db.test.mjs`:
적용 완료 Migration `20261116163616`의 공통 분할 지급 기능 회귀 증거로 유지(계획 헬퍼 2개만 테스트 안에 인라인).

### 3단계로 이월 (Owner 대시보드 작업)
- Vercel Production `BABA_PAYROLL_SETTLEMENT_2026_10_PLAN_JSON`: 이번 코드 배포·일반 상세 E2E 확인 후 삭제 + 재배포.
  이 커밋 이후 코드는 해당 변수를 읽지 않는다. `.local/` 비공개 계획·회계사 자료는 감사용으로 보존.

## 2단계 — 레거시 후보 분류

근거: 작업 트리 정적 참조 검색(app·components·lib, 테스트 별도), `vercel.json` cron, 운영 DB 읽기 전용 카탈로그
(함수 의존·트리거, 테이블 행 수). 운영 DB는 `track_functions=none`이라 함수 호출 이력이 없어 "미호출" 증명이 불가 →
DB 객체는 이번 단계에서 KEEP 또는 DEFER만 둔다(삭제는 전용 Migration + 별도 승인).

### 절대 보호 (KEEP)
- 8·9·10월 배치 1/3/4 및 직원 지급 53건, 배치 4 allocation 2건·residual 1건, `payroll_special_settlement_requests` 1건,
  급여·장부 거래와 감사 로그(배치 4의 20건 포함), 근태·계약·레벨 정책 이력, 적용 완료한 모든 Migration 파일·이력.
- 분할 지급 공통 객체: `payroll_employee_payment_allocations`, `payroll_payment_group_residuals`,
  `ledger_project_payroll_payment_group_v1`, `payroll_cancel_employee_payment_v1/v2/v3`(v3→v2→v1 체인),
  `payroll_refresh_payment_tax_totals_v1`, `payroll_pay_employee_v1/v2/v3` 체인, `ledger_sync_payroll_*`.
- 기존 redirect 페이지: `/admin/ledger/payables`, `/admin/partners/info`, `/sales`(과거 북마크 보호).
- 외부 호출 경로: `/api/integrations/zalo-bot`(웹훅), `vercel.json` cron 12개 전부(각 route 존재 확인).

### DEFER (근거 부족·외부 의존 가능 — 삭제 금지, 후속 확인)
| 후보 | 상태 | 필요한 확인 |
|---|---|---|
| `payroll_settle_2026_10_v1`, `payroll_settle_2026_10_final_state_v1` | 앱 호출 없음(이번 제거), service_role 전용, 배치 존재 시 `BATCH_EXISTS`로 거부 | 감사 보존 기간 결정 후 REVOKE/DROP 전용 Migration — 2026-11-17 LEGACY-CLEANUP-P1: 정식 Migration `20261117055003_retire_payroll_2026_10_settle_rpcs.sql` 로컬 작성·격리 검증 완료, **운영 미적용**(Owner 별도 승인 필요). 데이터·감사 기록·공통 분할지급 함수는 유지 |
| 앱·함수 미참조 구버전 RPC: `business_partner_create/update/review_supplier_alias_v1~v3`, `employee_create_with_proration_v1`, `payroll_correct_latest_unused_contract_v2/v3`, `payroll_create_contract_version_v4/v5`, `ledger_create_reserve_plan_v1`, `ledger_update_reserve_plan_v1`, `ledger_sync_inventory_candidates_v1`·`_core_v1`, `ledger_resolve_inventory_purchase_correction_v1` | 상위 버전으로 대체 | 배포 중인 구버전 클라이언트 없음 확인 + Supabase API 로그 기간 확인 후 일괄 DROP Migration |
| `pos_shadow_*`, `pos_signed_*`, `inventory_writer_*`(attest/compare/inspect/shadow_drain) | 앱 코드 미호출, POS 수집·섀도 운영 도구용 | POS 에이전트/운영 스크립트 사용 여부 |
| `reservation_*`(create/list/update/inbox_* 등), `/api/tables/reservations/inbox*` | 정적 문자열 참조 없음, `ReservationInbox`·`server-api`가 동적 경로 사용 가능 | 예약 기능 담당 확인 |
| `/api/admin/sales/ingestion`, `/api/admin/sales/inventory-shadow*` | 화면 참조 없음, 테스트·운영 점검용 | 운영 점검 절차 사용 여부 |
| `/admin/pos/items` (2026-07 정적 화면, 링크 없음) | 메뉴 미노출 | 담당자 사용 여부 |
| 모듈 `components/payroll/PayrollSourceReadinessPanel.tsx`, `lib/ledger/bep-core.ts`, `lib/ledger/august-rebuild-commit.ts`, `lib/employee/attendance-disable-block.ts`, `lib/pos/cukcuk/tables-read-server.ts` | 앱 import 없음(테스트만) — 일부는 11월 최근 작업 | 진행 중 작업 여부 확인 후 REMOVE |
| `lib/ledger/*.test.*` 6개 | `tests/` 밖 위치 | 테스트 위치 정리(별도 작업) |
| 행 0건 테이블 `ledger_owner_settlement_policy_lines`, `ledger_recurring_expense_payments`, `payroll_first_month_policies` | 함수에서 사용 | 기능 폐기 결정 시에만 |
| `legacy_pos_*_archive`, `*_audit_logs`, `ledger_month_closure_history` | 보존 자료 | 삭제 금지(감사) |
| `ledger_aug_sep_reclose_corrections_v1` | 일회성 재마감 정정 | 감사 증거, 보존 기간 결정 전 유지 |

### REMOVE
- 이번 커밋에서 실행한 것은 1단계 표의 10월 일회성 코드뿐이다. 그 밖의 소스 REMOVE는 위 DEFER 확인 후 별도 승인으로 진행한다.
