# 인계서 — BABA M단계 원자적 설치 및 수동 FF 통합 준비

> 작성: 2026-10-27T16:38:26.152Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA M단계 원자적 설치 및 수동 FF 통합 준비
- 작업 ID: 20261027-aug-sep-ledger-corrections-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261027-aug-sep-ledger-corrections-01
- HEAD SHA: 336560599ca36f1041752c8ee16aed603a53b702
- 기준: main · merge-base 8e281d5feedaf5b816110d040098a373facd1381
- 작업 커밋 5개:
  - 3365605 feat: prepare atomic M-stage installation and exact two-version history registration
  - 020ecc8 docs: hand off verified R1 reclose deadlock fix
  - 36d2355 fix: acquire recurring plan and R1 locks before ledger transaction table
  - a9435a6 docs: hand off M-stage PostgreSQL verification and deadlock finding
  - 5eab47e test: verify ledger reclose concurrency on native PostgreSQL
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/handoffs/codex-20261027-ledger-m-lock-order-fix.md` | 추가 | +74 −0 | 커밋됨 |
| `docs/handoffs/codex-20261027-ledger-m-native-postgres.md` | 추가 | +68 −0 | 커밋됨 |
| `docs/reports/20261027-ledger-m-integration-atomic-install.md` | 추가 | +74 −0 | 커밋됨 |
| `docs/reports/20261027-ledger-m-lock-order-fix.md` | 추가 | +98 −0 | 커밋됨 |
| `docs/reports/20261027-ledger-m-native-postgres.md` | 추가 | +87 −0 | 커밋됨 |
| `scripts/ledger/m-stage-bundles.mjs` | 추가 | +103 −0 | 커밋됨 |
| `scripts/ledger/m-stage-install.sql` | 추가 | +282 −0 | 커밋됨 |
| `scripts/ledger/m-stage-register.sql` | 추가 | +285 −0 | 커밋됨 |
| `supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql` | 추가 | +69 −0 | 커밋됨 |
| `tests/helpers/ledger-aug-sep-reclose-native-fixture.mjs` | 추가 | +87 −0 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-db.test.mjs` | 수정 | +1 −0 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-postgres.test.mjs` | 추가 | +288 −0 | 커밋됨 |
| `tests/ledger-m-atomic-install-postgres.test.mjs` | 추가 | +133 −0 | 커밋됨 |

기능 요약:
- 원본/잠금 수정 Migration을 변경 없이 한 트랜잭션으로 설치하는 검토용 m-stage-install.sql과, 적용 완료 확인·최종 함수 검증 후 두 버전의 승인 SQL을 정확히 등록하는 m-stage-register.sql을 추가했다. 생성기는 DB 연결 없이 두 원본 파일에서 검토본을 만든다.
- 원본 함수가 미커밋 상태에서 다른 세션에 노출되지 않음, 두 DDL rollback, 동시 설치/등록 직렬화, 두 번째 이력 충돌/실패 시 첫 등록도 rollback, 동일 재등록 no-op와 무관한 이력 보존을 실제 PostgreSQL 17.6에서 검증했다.
- main 823af4e와 Codex는 공통 조상 8e281d5에서 분기됐다. 5eab47e/a9435a6/36d2355/020ecc8을 포함한 원래 이력을 보존한다. 독립 통합 저장소에서 main을 조상으로 포함하는 두 부모 후보를 만들고 실제 main은 수동 승인 전 이동하지 않는다.

## 4. 검증 결과
- 검증 상태 지문: 7f2a2f81fbb12192
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-27T16:37:36.087Z, .tmp-baba/verify/2026-10-27T16-37-36-087Z-33656059-89d82191-e323-4e66-8f00-a322dc4eca17.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 운영 DB 적용·운영 검증은 수행하지 않는다(AGENTS.md 수동 절차 대상).

수동 확인(브라우저·실행 확인 등): 소스 코드 SHA 3365605에서 총 64 PASS/0 FAIL/0 SKIP(native 교착 22, native 원자적 설치 11, 관련 기존 회귀 31), ESLint 통과, TypeScript 기존 40/신규 0. 원본과 수정 Migration은 020ecc8 대비 내용 보존. 직접 원자적 설치 실행 UUID afd32c1e-2735-4d5c-80f3-3c3ba479ffa7 로그 보존·자체 클러스터 정리 완료. 통합 후보의 exact SHA/parents/tree 및 통합 코드의 재검증·offline Build 실제 결과는 .tmp-baba/m-stage-integration/latest.json과 그 immutable run JSON에 기록해 최종 응답으로 전달한다. 이 소스 인계서의 Build not-run과 통합 후보의 별도 Build 검증을 구분한다. 브라우저·운영 SQL 확인 없음.

## 5. DB·Migration
- Migration 변경: supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql
- 기타 SQL 변경: scripts/ledger/m-stage-install.sql, scripts/ledger/m-stage-register.sql
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)
- 사용자 승인·SQL Editor 적용 상태: 운영 미적용. 설치/이력 등록 SQL은 검토 및 독립 로컬 시험만 수행했다. 운영 Supabase에는 SQL을 보내지 않았다.

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 실제 main 이동·push·배포·운영 설치·이력 등록·정정·재개방·재마감 승인은 없다. 통합 후보의 기술 검증과 자동 게이트의 스키마 별도 검토/사용자 수동 FF 승인을 구분하며 게이트를 수정하거나 우회 승인으로 표시하지 않는다.
- 운영 전체 스키마/RLS·actual preflight/summary·UI·Advisor는 미검증이다. history는 표준 version/name/statements local 모델로 검증했고 운영의 해당 두 버전/컬럼은 승인 후 확인한다. 별도 7월 정리 원칙은 유지한다.

## 8. 후속 작업
- 최종 통합 receipt의 main/source/merge SHA와 검증 digest를 사용자가 검토한다. 기준 main이 바뀌면 이전 후보는 무효다. 승인 후 사용자 터미널에서 후보 저장소의 검증 SHA를 local review ref로 fetch해 ancestry를 확인하고 main을 ff-only로 이동한다. 에이전트는 원본 main을 변경하지 않는다.
- 별도 운영 승인 후 사용자가 m-stage-install.sql 전체를 한 트랜잭션으로 실행한다. 최종 patched 함수와 권한 검증·적용 완료 통지 뒤 m-stage-register.sql 전체를 별도 트랜잭션으로 실행한다. 두 버전만 동일 내용 1행씩 등록하며 원본 단독 설치나 부분 COMMIT·자동 history repair는 금지한다.
- [통합 및 원자적 설치 보고서](../reports/20261027-ledger-m-integration-atomic-install.md)에 절차·산출물·테스트와 수동 승인 경계를 기록했다.

