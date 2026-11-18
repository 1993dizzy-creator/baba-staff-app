# 인계서 — BABA M단계 R1 정정 잠금 순서 교착 수정

> 작성: 2026-10-27T16:18:45.817Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA M단계 R1 정정 잠금 순서 교착 수정
- 작업 ID: 20261027-aug-sep-ledger-corrections-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261027-aug-sep-ledger-corrections-01
- HEAD SHA: 36d2355b056d954df9da2bca178f163213e304ef
- 기준: main · merge-base 8e281d5feedaf5b816110d040098a373facd1381
- 작업 커밋 3개:
  - 36d2355 fix: acquire recurring plan and R1 locks before ledger transaction table
  - a9435a6 docs: hand off M-stage PostgreSQL verification and deadlock finding
  - 5eab47e test: verify ledger reclose concurrency on native PostgreSQL
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/handoffs/codex-20261027-ledger-m-native-postgres.md` | 추가 | +68 −0 | 커밋됨 |
| `docs/reports/20261027-ledger-m-lock-order-fix.md` | 추가 | +98 −0 | 커밋됨 |
| `docs/reports/20261027-ledger-m-native-postgres.md` | 추가 | +87 −0 | 커밋됨 |
| `supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql` | 추가 | +69 −0 | 커밋됨 |
| `tests/helpers/ledger-aug-sep-reclose-native-fixture.mjs` | 추가 | +87 −0 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-db.test.mjs` | 수정 | +1 −0 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-postgres.test.mjs` | 추가 | +288 −0 | 커밋됨 |

기능 요약:
- 정정 함수의 잠금을 기존 마감 순서 → 계획 prefix/계획 집합 고정·검증 → R1 월 prefix → 거래 테이블 순서로 고쳤다. 기존 R1 writer가 정기비용 prefix를 가진 채 거래 테이블을 기다리는 순환을 제거했다. 계획 변경과 close/reopen의 실제 RPC 경로도 분석·검증했다.
- 저장소 정책은 기존 Migration 파일 수정을 금지하므로 원본 20261027112354를 보존하고 후속 20261027160650을 추가했다. 적용 전/후 함수 본문 hash guard로 잠금 블록만 수정하며 예상치 못한 본문은 거부하고 재적용은 no-op다. 이력 재작성과 정책/검증기 우회 없음.
- C1~C3의 금액·분류·sign·source key·감사, R1 50M, 준비금 60M, 원거래·movement·손익 계산은 변경하지 않았다. 5초 timeout, 원자적 rollback, 중복 방지, owner·SECURITY DEFINER·search_path·권한도 보존했다.

## 4. 검증 결과
- 검증 상태 지문: 9f64eab90bed43d7
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-27T16:17:53.010Z, .tmp-baba/verify/2026-10-27T16-17-53-010Z-36d2355b-e82c7340-417d-48e0-8aaa-e2150b61ec77.json)
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
- 운영 전체 스키마/RLS, 실제 앱 preflight blockers·summary snapshot/UI, 운영 Advisor는 미검증이다. close preflight는 fixture stub, 부속 보호 테이블은 sentinel이다. 여러 RPC/임의 SQL을 외부에서 역순 조합한 장기 트랜잭션까지 교착이 불가능하다고 주장하지 않는다.

수동 확인(브라우저·실행 확인 등): 실제 PostgreSQL 17.6, 독립 DB별 A/B/observer와 추가 C 세션으로 구 15개 재실행 및 확장 22 PASS/0 FAIL/0 SKIP. 기존 40P01 스케줄은 00000 성공, 모든 DB의 통계 flush 후 deadlocks=0이었다. 최종 native UUID 8326536e-0160-4cda-97f6-b73556796435에서 table timeout 5,010ms, R1 감사 후 timeout 5,016ms, R1 prefix timeout 5,010ms 모두 55P03으로 구분됐다. 세 경우 모두 전체 rollback·재실행 중복 0·원거래/movement 보존을 확인했다. 계획 변경 선/후행·다른 prefix·계획 변경/정정/close 삼중 경합·여러 활성 계획의 조기 거부도 통과했다. Native 22 + 관련 기존 회귀 31 = 총 53 PASS, ESLint 통과, TypeScript 기존 40/신규 0. Build는 앱/설정 변경 없어 미실행. own cluster 정상 종료·데이터 정리 완료, .qa-review/pg-native-logs 증거 보존. 원본 Migration/계산 코드/evidence가 823af4e와 diff 0임을 확인했다. 브라우저·운영 SQL 확인 없음.

## 5. DB·Migration
- Migration 변경: supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)
- 사용자 승인·SQL Editor 적용 상태: 원본과 후속 모두 운영 미적용. 설치 보류 유지. 로컬 작성·검증만 수행했으며 운영 Supabase에는 SQL을 보내지 않았다.

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 기존 40P01 교착은 검증 스케줄에서 재발 0으로 해소됐다. 원본+후속 설치 조합은 기술 검증 PASS이며, 원본 단독 설치/정정 실행은 계속 보류한다. 상세 잠금 그래프·대기·timeout 구분·설치 조건은 [수정 보고서](../reports/20261027-ledger-m-lock-order-fix.md)에 기록했다.
- 운영 승인은 없으므로 유지보수 구간·진행 writer 배출·fresh snapshot·실제 preflight와 설치 후 검증을 아직 수행하지 않았다. 로컬 브랜치에 수정 및 인계서를 보존하고 승인 없는 통합/ready 전환/브랜치 삭제는 보류한다.

## 8. 후속 작업
- 사용자가 별도 승인하면 원본 20261027112354 → 후속 20261027160650을 같은 SQL Editor 트랜잭션으로 직접 설치한다. 후속 완료 전 회계 RPC를 호출하지 않는다. 완료 통지 뒤 최종 본문 hash beebd06ff35eb3eaf0a68dfde8494412 및 owner/인자/ACL/5초 설정을 확인한다.
- 실제 승인·실행 증거와 원본/후속 SQL을 대조해 해당 두 신규 버전만 history 존재/중복 여부를 확인·등록한다. 최종 함수는 후속 본문이므로 원본 등록을 위해 옛 함수를 재설치하지 않는다. 이후 운영 정정·재개방·재마감, main 통합·push·배포는 각각 별도 승인 대상이다.

