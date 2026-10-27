# 인계서 — 8·9월 장부 C1~C3 정정 및 카드 귀속 독립 검증

> 작성: 2026-10-27T11:36:30.581Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: 8·9월 장부 C1~C3 정정 및 카드 귀속 독립 검증
- 작업 ID: 20261027-aug-sep-ledger-corrections-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261027-aug-sep-ledger-corrections-01
- HEAD SHA: 31c45e5eaccd030b6333fb1f36fa9d580fe13f8d
- 기준: main · merge-base 8576e3a02e2bc1458adcc85ec2a2643e5db953bd
- 작업 커밋 1개:
  - 31c45e5 feat: prepare atomic August September ledger corrections and source verification
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/reports/20261027-aug-sep-reclose-implementation.md` | 추가 | +130 −0 | 커밋됨 |
| `scripts/ledger/aug-sep-reclose-calculate.mjs` | 추가 | +70 −0 | 커밋됨 |
| `scripts/ledger/aug-sep-reclose-evidence.json` | 추가 | +4519 −0 | 커밋됨 |
| `scripts/ledger/aug-sep-reclose-snapshot.sql` | 추가 | +46 −0 | 커밋됨 |
| `supabase/migrations/20261027112354_aug_sep_reclose_corrections.sql` | 추가 | +166 −0 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-db.test.mjs` | 추가 | +210 −0 | 커밋됨 |

기능 요약:
- 신규 Migration은 정정 함수를 설치한다. 8월 C1+R1 및 9월 C2·C3+R1을 월별 원자 처리하며 closed 잠금·원천 drift·중복 source key·감사·권한·R1 실제 금액을 검사한다. 원거래·movement·선납·준비금·마감 행을 변경하지 않는다.
- 원천 거래 1,987건과 정산 라인·정규화 감사 기록을 로컬 evidence로 보존하고 독립 계산 스크립트 및 PGlite 검증을 추가했다. 8월 예상 이익 267,236,765.578₫, 9월 70,507,820.4₫이며 카드 귀속 변경에 따른 8월 이익 증가 605,391.905₫을 확인했다.
- 읽기 전용 변경 전·후 snapshot SQL과 적용 순서·경합·실패 복구·승인 조건 보고서를 작성했다. 7월 귀속 비용 82,596.578₫의 공식 보존처는 미확정이다.

## 4. 검증 결과
- 검증 상태 지문: f8dcf6c0360c6b57
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-27T11:35:48.246Z, .tmp-baba/verify/2026-10-27T11-35-48-246Z-31c45e5e-7a22d8cc-ac72-4cae-b035-17e393dbbacb.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 테스트가 참조하지 않는 변경 파일: scripts/ledger/aug-sep-reclose-snapshot.sql
- 운영 DB 적용·운영 검증은 수행하지 않는다(AGENTS.md 수동 절차 대상).

수동 확인(브라우저·실행 확인 등): 운영 읽기 전용 도구로 원거래·movement·급여·카드 #22(입금 거래 #1233)·정규화 감사·마감 rev3·함수 정의/해시 및 신규 Migration 버전/함수 부재를 확인했다. snapshot SQL도 읽기 전용 실행으로 구문과 참조를 확인했으나 자동 테스트 참조는 없다. 브라우저 확인은 하지 않았다. 관련 테스트 31개 전부 통과(신규 5개), ESLint 통과, TypeScript 기준선 오류 40건·신규 0건. Build는 앱 코드/설정 변경이 없어 미실행했다.

## 5. DB·Migration
- Migration 변경: supabase/migrations/20261027112354_aug_sep_reclose_corrections.sql
- 기타 SQL 변경: scripts/ledger/aug-sep-reclose-snapshot.sql
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)
- 사용자 승인·SQL Editor 적용 상태: 미적용. 로컬 작성·검증·커밋만 승인됐으며 운영 실행 승인은 없다.

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 로컬 구현·검증 완료. 운영 준비 완료 판정은 보류: 7월 closure가 없어 7월 귀속 카드 비용 82,596.578₫의 공식 손익 반영처를 확인해야 한다. 이번 정정에서 7월/8월 정책을 바꾸지 않았다.
- 실제 앱의 전체 preflight·summary 생성·마감 UI, 운영 Advisor, 네이티브 다중 세션 경합은 미검증이다. PGlite의 close preflight는 stub, 미납금·준비금·카드 보호 테이블은 sentinel fixture이며 전체 운영 스키마를 대체하지 않는다. source/payment/movement와 신규 함수는 실제 값·본문으로 검증했다.
- Git 통합·push·운영 배포 승인 없음. 구현 및 인계서 커밋을 작업 브랜치에 보존하고 종료 전환·브랜치 삭제는 보류한다. 다른 Worktree는 변경하지 않았다.

## 8. 후속 작업
- 사용자가 7월 비용 보존처/정책을 확정하고 유지보수 writer 중지·재개방·R1 계획 생성·정정·재마감·10월 동기화 및 신규 DDL 적용을 별도 승인해야 한다. 승인된 SQL은 사용자가 SQL Editor에서 직접 실행한다. 실제 plan/actor ID·fresh snapshot·전체 blockers는 적용 전에 확정한다.
- 적용 완료 통지 후 연결된 도구로 신규 버전 20261027112354만 실제 SQL/함수/권한과 대조해 검증하고, 누락된 해당 이력만 안전하게 등록한다. Advisor·전체 잔액·원본 snapshot history·감사와 새 손익을 다시 확인한 뒤 Git 통합·push·Production 배포를 각각 승인받는다.
- 상세 파일 목록·독립 계산·10단계 순서 및 rollback 한계: [구현 보고서](../reports/20261027-aug-sep-reclose-implementation.md).

