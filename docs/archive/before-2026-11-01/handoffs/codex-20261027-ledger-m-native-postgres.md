# 인계서 — BABA M단계 실제 PostgreSQL 경합·설치 잔여 검증

> 작성: 2026-10-27T13:42:46.278Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA M단계 실제 PostgreSQL 경합·설치 잔여 검증
- 작업 ID: 20261027-aug-sep-ledger-corrections-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261027-aug-sep-ledger-corrections-01
- HEAD SHA: 5eab47ea1b24d0e057853b298b53f596393f2b8f
- 기준: main · merge-base 8e281d5feedaf5b816110d040098a373facd1381
- 작업 커밋 1개:
  - 5eab47e test: verify ledger reclose concurrency on native PostgreSQL
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/reports/20261027-ledger-m-native-postgres.md` | 추가 | +87 −0 | 커밋됨 |
| `tests/helpers/ledger-aug-sep-reclose-native-fixture.mjs` | 추가 | +86 −0 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-postgres.test.mjs` | 추가 | +229 −0 | 커밋됨 |

기능 요약:
- 기존 PostgreSQL 17.6 바이너리로 독립 local-only 클러스터 및 시나리오별 DB를 만들고 실행 세션 A/B와 observer의 다른 backend PID로 실제 잠금 대기를 검증했다. Docker·서비스·시스템 설정은 변경하지 않았다. 새 fixture·테스트·보고서만 추가했고 대상 Migration은 823af4e와 동일하다.
- 같은 월 중복 방지, close/reopen 잠금, 일반 writer 충돌, 실제 5초 timeout 전·후 원자적 rollback, C3 실패 후 대기 세션 재실행, SECURITY DEFINER/owner/search_path/ACL 및 실제 역할 호출, 단일 버전 이력 등록 경합을 검증했다.
- 기존 R1 writer의 prefix advisory lock과 정정 함수의 table lock 역전으로 **40P01 교착이 실제 재현**됐다. 테스트가 교착과 rollback을 검증해 PASS한 것이며 무중단 운영 경합 안전성이 PASS라는 뜻은 아니다. 설치 자체는 PASS, 동시 writer 허용 운영 실행은 FAIL/보류다.

## 4. 검증 결과
- 검증 상태 지문: ef28b24f3e9ea8c2
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-27T13:42:29.352Z, .tmp-baba/verify/2026-10-27T13-42-29-352Z-5eab47ea-f5ca308c-7e43-4f24-a49c-f2ccbce2da73.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 실제 앱 전체 close preflight·summary snapshot·UI, 전체 운영 스키마/RLS·운영 PostgreSQL 버전·현재 history/Advisor는 미검증이다. 운영 Supabase에는 SELECT를 포함해 SQL을 보내지 않았다.
- close preflight는 stub이며 보호 부속 테이블은 sentinel fixture다. 원거래·movement는 기존 캡처, 핵심 함수 본문은 원본 Migration을 사용했다. 운영의 writer 중지 및 진행 중 트랜잭션 배출 여부는 운영 승인 시 확인해야 한다.

수동 확인(브라우저·실행 확인 등): Native suite 15 PASS(상위 1+세부 14), PGlite 5 PASS, skip 0, ESLint 통과, TypeScript 기존 40건/신규 0건. Production build는 앱/설정 변경이 없어 미실행. backend PID·pg_blocking_pids·wait_event·55P03 및 40P01·server log·비동기 통계 flush 후 deadlocks=1을 확인했다. final native UUID 00f5d3f5-4c72-4c1b-93d7-cd3b0de95888의 증거는 .qa-review/pg-native-logs에 보존되며 자체 테스트 데이터는 정상 종료 및 소유권 검증 후 정리됐다. 다른 Worktree status clean, 823af4e 대비 대상 Migration diff 0을 확인했다. 브라우저 확인 없음.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 운영 정정·재마감 승인 없음. R1 writer가 살아 있는 상태에서는 교착 가능하므로 실행 보류다. writer 중지 및 진행 중 트랜잭션 배출을 보장하거나 별도 후속 변경에서 잠금 순서를 통일한 뒤 다시 검증해야 한다. 이번에는 검증 범위에 따라 원본 Migration/R1을 수정하지 않았다.
- 7월 82,596.578₫은 823af4e의 7월 후속 정리 문서에 기록됐음을 확인했다. 8·9월에 임의 가산하지 않으며 이전의 문서 미확정 사유를 반복 차단하지 않는다.
- 기존 작업 브랜치에 로컬 커밋을 보존하고 통합·ready 전환·삭제는 보류한다. 운영 Supabase, 다른 Worktree 파일, Production은 변경하지 않았다.

## 8. 후속 작업
- 사용자가 운영 설치를 별도 승인하면 SQL Editor에서 신규 DDL만 한 트랜잭션으로 직접 실행한다. 완료 통지 후 함수 정의/인자/owner/ACL과 실제 실행 증거를 검증하고, 신규 버전 20261027112354만 누락 시 version advisory lock + ON CONFLICT + 내용 대조로 1행 등록한다. 함수 있음/이력 없음은 재설치하지 않고 검증부터 한다. 불일치는 해당 버전 범위에서 중단한다.
- 회계 실행·재개방·재마감·Git 통합·push·Production 배포는 각각 별도 승인 대상이다. [M단계 보고서](../reports/20261027-ledger-m-native-postgres.md)에 요청별 PASS/FAIL, 실제 교착 스케줄, 설치/이력 중복 방지 절차 및 재현 명령을 기록했다.

