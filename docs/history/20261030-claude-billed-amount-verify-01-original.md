# 인계서 — 실청구금액 v1 독립 검증·최소 수정

> 작성: 2026-10-30T09:06:09.763Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: 실청구금액 v1 독립 검증·최소 수정
- 작업 ID: 20261030-billed-amount-verify-01
- 담당 AI: Claude Code
- Worktree: baba-wt-claude

## 2. Git 상태
- 작업 브랜치: claude/20261030-billed-amount-verify-01
- HEAD SHA: 0d420e493a9a41001d1e84ea40dd6b8c476a3ecf
- 기준: origin/main · merge-base 0bcedb60223cfe7397d0f521c23f65eedcc1dfe6
- 작업 커밋 2개:
  - 0d420e4 fix(inventory): 실청구금액 v1 review fixes — totals, layout, registration safety
  - 4985942 feat(inventory): 품목별 실청구금액 v1 — billed amount on every receipt, Ledger books it
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `app/(protected)/inventory/snapshots/page.tsx` | 수정 | +55 −9 | 커밋됨 |
| `app/api/inventory/items/route.ts` | 수정 | +44 −6 | 커밋됨 |
| `app/api/inventory/logs/route.ts` | 수정 | +7 −1 | 커밋됨 |
| `app/api/inventory/monthly/route.ts` | 수정 | +16 −6 | 커밋됨 |
| `app/api/inventory/snapshot/name-sync/route.ts` | 수정 | +1 −1 | 커밋됨 |
| `components/inventory/BilledAmountField.tsx` | 추가 | +102 −0 | 커밋됨 |
| `components/inventory/InventoryItemEditor.tsx` | 수정 | +34 −0 | 커밋됨 |
| `components/inventory/InventoryPageContent.tsx` | 수정 | +56 −1 | 커밋됨 |
| `docs/reports/20261030-inventory-billed-amount-migration-review.md` | 추가 | +54 −0 | 커밋됨 |
| `lib/inventory/billed-amount.ts` | 추가 | +78 −0 | 커밋됨 |
| `lib/inventory/daily-effective-purchases.ts` | 수정 | +5 −1 | 커밋됨 |
| `lib/inventory/monthly-effective-purchases.ts` | 수정 | +9 −0 | 커밋됨 |
| `lib/inventory/purchase-cases.ts` | 수정 | +10 −1 | 커밋됨 |
| `lib/inventory/reasons.ts` | 수정 | +4 −0 | 커밋됨 |
| `lib/inventory/snapshot-name-sync.ts` | 수정 | +5 −2 | 커밋됨 |
| `lib/ledger/purchase-case-loader.ts` | 수정 | +1 −1 | 커밋됨 |
| `supabase/migrations/20261030150000_inventory_purchase_billed_amount.sql` | 추가 | +643 −0 | 커밋됨 |
| `tests/helpers/inventory-billed-amount-fixture.mjs` | 추가 | +10 −0 | 커밋됨 |
| `tests/inventory-billed-amount-browser.test.mjs` | 추가 | +145 −0 | 커밋됨 |
| `tests/inventory-billed-amount-db.test.mjs` | 추가 | +283 −0 | 커밋됨 |
| `tests/inventory-billed-amount-postgres.test.mjs` | 추가 | +53 −0 | 커밋됨 |
| `tests/inventory-billed-amount.test.ts` | 추가 | +141 −0 | 커밋됨 |
| `tests/inventory-items-final-validation.test.mjs` | 수정 | +34 −0 | 커밋됨 |
| `tests/inventory-ledger-projection-api.test.mjs` | 수정 | +24 −4 | 커밋됨 |
| `tests/inventory-receipt-edit-browser.test.mjs` | 수정 | +6 −6 | 커밋됨 |

기능 요약:
- 4985942(원본 main에서 작성): 신규등록·빠른저장·품목 수정 입고·입고 수정에 실청구금액(자동계산/직접 입력/자동계산 복원) 표시, 장부·미지급금이 유효 실청구금액을 기장하도록 하는 신규 Migration(운영 미적용).
- 0d420e4(이 Worktree, 독립 검증 후 승인된 최소 수정 3건):
  - 화면: 입고 카드의 실청구금액을 상태 줄 칩 하나로 정리, 입고 수정 입력·수정 이력에 data-testid 추가, 신규등록 실청구금액 칸을 수량 바로 아래로 이동.
  - 합계: 일자별 목록 행·총 합계, 입고 카드 합계, 월간현황 품목·거래처 매입액을 유효 실청구금액(수동값 우선, 자동은 수량×단가) 기준으로 통일. 정정 이력을 합친 입고당 1행 기준이라 중복 합산 없음. 스냅샷 추정금액은 변경하지 않음.
  - 신규 품목 등록: numeric(10,2) 반올림 후 0 이하인 구매입고 수량은 품목 INSERT 전에 거부, 입고 로그가 거부되면 방금 만든 품목을 삭제해 품목만 남는 부분 성공 방지. 입고 없는 일반 등록(기존재고)은 그대로.
  - 테스트: 기존 입고 수정 브라우저 테스트의 nth() 선택자를 data-testid로 교체(검증 항목 동일), 실청구금액 브라우저 QA, 일·월 합계 단위 테스트, 등록 롤백 테스트, projector 실패 후 재시도·월 동기화 중복 기장 없음 DB 테스트 추가.

## 4. 검증 결과
- 검증 상태 지문: d28a58aa80befc5b
- baba-verify 판정: **FAIL** (2026-10-30T09:06:08.627Z, .tmp-baba/verify/2026-10-30T09-06-08-627Z-0d420e49-de5ca2d4-fb93-4bc6-94c8-c5ffbbeffd37.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | failed-unclassified |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 예 | passed |

미검증 항목:
- tests/inventory-billed-amount-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/inventory-billed-amount-postgres.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/inventory-cancelled-purchases-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/inventory-photo-sync-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/inventory-purchase-cases-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/inventory-quick-save-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/inventory-receipt-edit-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/inventory-snapshots-browser.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- tests/keg-safety-p0-browser.test.mjs: skip 2건 (실행 통과로 간주하지 않음)
- 테스트가 참조하지 않는 변경 파일: components/inventory/BilledAmountField.tsx (도메인 테스트 후보 74개: --tests로 지정 가능)
- Build는 offline-local-fixture 환경의 검증이다. 운영 환경·인증·DB 연결은 미검증이며 이 .next 산출물을 배포하지 않는다.
- 브라우저 화면 동작(UI)은 이 스크립트가 확인하지 않는다. 필요 시 별도 실행 확인 결과를 인계서에 기록한다.
- 운영 DB 적용·운영 검증은 수행하지 않는다(AGENTS.md 수동 절차 대상).

수동 확인(브라우저·실행 확인 등):
- 오프라인 빌드(127.0.0.1:3002, /api 전부 가로챔)에서 위 미검증 목록의 브라우저 9개 파일과 PostgreSQL 3개 파일을 별도 실행(Playwright-core 1.48.2 + 설치된 Chrome, QA_POSTGRES_BIN 지정).
  - 통과: inventory-billed-amount-browser(KO/VI × 360·390·PC 6/6, 오렌지 303,450→303,000·차액 −450, 카드 합계·일자별 총 합계 303,000), receipt-edit-browser, quick-save-browser, cancelled-purchases-browser, photo-sync-browser, billed-amount-postgres·receipt-edit-postgres·safe-correction-postgres.
  - 실패 4개(purchase-cases-browser, purchase-details-browser, snapshots-browser, keg-safety-p0-browser)는 기준 커밋 0bcedb6 오프라인 빌드(3012)에서도 같은 위치로 실패하는 기존 실패. snapshots-browser는 캐럿 검증 블록(169~170행)에서 실행마다 실패 지점이 달라지는 불안정 테스트.
  - skip 2개(keg-safety P0 warm benchmark 1건은 해당 테스트 자체 skip).
- 비브라우저 재고·장부 회귀 822개: 통과 789, 실패 31(모두 작업 전 기준 실패), skip 2(payable-payment-idempotency-db, purchase-settlement-concurrency — 외부 PostgreSQL 포트 필요, 미실행).

## 5. DB·Migration
- Migration 변경: supabase/migrations/20261030150000_inventory_purchase_billed_amount.sql
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)
- 사용자 승인·SQL Editor 적용 상태: 미적용 (2026-10-30 운영 읽기 조회: billed 컬럼 없음, 최신 이력 20261029220000)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- baba-verify 판정 FAIL은 verify 환경에서 skip되는 브라우저·PostgreSQL 9개 파일 때문이며, 위 수동 실행으로 신규 실패 0을 확인했다. verify 자체 판정은 바뀌지 않는다.
- 미실행: payable-payment-idempotency-db, purchase-settlement-concurrency(외부 PostgreSQL 포트 필요, 이번 변경 경로 아님).
- 운영 환경·인증·DB 연결은 미검증(오프라인 빌드).

## 8. 후속 작업
- 원본 main 통합: 0d420e4는 4985942 위의 fast-forward 1커밋이며, 원본 main은 현재 4985942이고 미커밋 변경 없음. 통합은 사용자 승인 후 진행.
- 운영 Migration 적용(SQL Editor) → GPT postflight·이력 등록 → 앱 배포 순서. 앱을 먼저 배포하면 입고 저장이 실패하므로 DB 먼저.
- GitHub push·Vercel 배포: 사용자 승인 대상.

