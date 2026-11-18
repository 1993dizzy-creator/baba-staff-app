# 인계서 — BABA M단계 SQL Editor 줄바꿈 설치 실패 수정 및 Claude 독립 검토 인계

> 작성: 2026-10-27T18:11:45.040Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA M단계 SQL Editor 줄바꿈 설치 실패 수정 및 Claude 독립 검토 인계
- 작업 ID: 20261027-aug-sep-ledger-corrections-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261027-aug-sep-ledger-corrections-01
- HEAD SHA: 7e6c4c551109eae2c7a38e956da2b8a4a8a3fc1f
- 기준: main · merge-base 18bfe728c2e076bc97dd24a4377eb398be45dc5a
- 작업 커밋 1개:
  - 7e6c4c5 fix: normalize SQL Editor patch and history line endings with an unapplied replacement
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/reports/20261028-ledger-m-line-endings-fix.md` | 추가 | +104 −0 | 커밋됨 |
| `scripts/ledger/m-stage-bundles.mjs` | 수정 | +16 −6 | 커밋됨 |
| `scripts/ledger/m-stage-install.sql` | 수정 | +14 −8 | 커밋됨 |
| `scripts/ledger/m-stage-register.sql` | 수정 | +23 −10 | 커밋됨 |
| `supabase/migrations/20261027175537_reclose_patch_line_endings.sql` | 추가 | +73 −0 | 커밋됨 |
| `tests/helpers/ledger-aug-sep-reclose-native-fixture.mjs` | 수정 | +1 −1 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-db.test.mjs` | 수정 | +1 −1 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-postgres.test.mjs` | 수정 | +1 −1 | 커밋됨 |
| `tests/ledger-m-atomic-install-postgres.test.mjs` | 수정 | +12 −1 | 커밋됨 |
| `tests/ledger-m-line-endings-postgres.test.mjs` | 추가 | +125 −0 | 커밋됨 |

기능 요약:
- 실패한 후속 DO는 pg_get_functiondef만 LF로 정규화하고 v_old/v_new의 CRLF는 보존했다. 원본 본문 MD5 가드는 통과하지만 strpos가 0이 되어 운영과 동일한 P0001/inline_code_block line 59가 실제 PostgreSQL 17.6에서 재현됐다. 양쪽을 같은 규칙으로 정규화하면 검색 위치 1333을 얻었다.
- 정의·검색·대체 문자열에 CRLF→LF 후 남은 CR→LF 규칙을 적용한 대체 Migration 20261027175537을 추가했다. 원본 20261027112354와 실패한 미적용 20261027160650은 원문/버전/이력 보존했다. 기준선 Migration 수정 금지 정책과 Git 이력 불변성을 유지했다.
- 활성 설치/등록 대상을 20261027112354 + 20261027175537로 교체하고 SQL 및 source hash를 재생성했다. 160650은 실행/등록 대상에서 제외한다. 이력이 있으면 임의 수정 대신 중단한다. DB에 저장하는 statements도 동일 LF 정규화로 원문과 hash를 일치시킨다.

## 4. 검증 결과
- 검증 상태 지문: e776ceaa7919254e
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-27T18:11:20.967Z, .tmp-baba/verify/2026-10-27T18-11-20-967Z-7e6c4c55-b724ad04-64de-4663-8d85-ce4d3ba25ca7.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 예 | passed |

미검증 항목:
- Build는 offline-local-fixture 환경의 검증이다. 운영 환경·인증·DB 연결은 미검증이며 이 .next 산출물을 배포하지 않는다.
- 운영 DB 적용·운영 검증은 수행하지 않는다(AGENTS.md 수동 절차 대상).

수동 확인(브라우저·실행 확인 등): Native EOL 19, atomic 12, 기존 교착 22 및 관련 회귀 31로 총 84 PASS/0 FAIL/0 SKIP. 수정 전 CRLF·혼합·LF 원본/CRLF 후속에서 동일 P0001 line 59 재현, 수정 후 LF·CRLF·혼합·CR-only·인용 블록만 변경 모두 설치/등록 성공. 6개 EOL rollback 조건에서 함수/이력 0·장부 상태/원거래/movement/감사 동일. 최종 함수 MD5 beebd06ff35eb3eaf0a68dfde8494412, owner postgres/SECURITY DEFINER/search_path/권한/5초 설정 유지. 40P01 재발 0, 55P03 timeout은 기존 테스트에서 구분했다. ESLint 및 offline Build 통과, TypeScript 기존 40/신규 0. 원본·retired Migration 및 금융 evidence/계산 코드가 b73f252 대비 diff 0임을 확인했다. 원본 main의 현재 설치 SQL/160650 파일은 LF였지만 실제 붙여넣은 원문 바이트는 없으므로 운영 입력 자체가 CRLF였다고 단정하지 않는다. 브라우저·운영 SQL 확인 없음.

## 5. DB·Migration
- Migration 변경: supabase/migrations/20261027175537_reclose_patch_line_endings.sql
- 기타 SQL 변경: scripts/ledger/m-stage-install.sql, scripts/ledger/m-stage-register.sql
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)
- 사용자 승인·SQL Editor 적용 상태: 실패 후 함수/이력/정정 0, 8·9월 closed/revision 3 유지라는 사용자 제공 확인 결과를 전제로 했다. Codex는 운영에 접속하거나 조회/적용하지 않았다. 수정본 운영 설치는 미실행, Claude 독립 검토 및 별도 사용자 승인 대기다.

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- Claude Code 독립 검토는 아직 수행되지 않았다. 이 보고서와 SHA를 전달해 raw EOL 실패 재현, 대칭 정규화, 대체 버전/retired 파일 처리, 생성 SQL/hash/저장 statements 및 전체 경합 회귀를 독립 확인해야 한다. 다른 에이전트에게 메시지를 보내거나 다른 Worktree를 변경하지 않았다.
- 운영 원문 바이트·실제 schema/RLS/preflight/summary/UI/Advisor는 미검증. 이 수정은 EOL만 정규화하며 임의 서식/들여쓰기/리터럴 변경까지 허용하도록 본문 가드를 완화하지 않았다.
- 실패한 160650을 포함한 전체 폴더 자동 순차 적용/db push/reset/repair는 금지한다. 이전 b73f252 설치/등록본·통합 receipt를 재사용하지 않는다. main 통합·push·배포·운영 SQL 승인 없음. 브랜치와 증거를 보존하고 종료 전환/삭제는 보류한다.

## 8. 후속 작업
- 다음 담당 Claude Code: [원인·재현·정책·검토 체크리스트](../reports/20261028-ledger-m-line-endings-fix.md), 코드 SHA 7e6c4c551109eae2c7a38e956da2b8a4a8a3fc1f를 기준으로 독립 검토한다. 검토 의견이 나오기 전 운영 재실행하지 않는다. 검토 시 활성 버전 변경(160650 보존/제외, 175537 대체)을 명시적으로 확인한다.
- 통과 후 사용자의 별도 승인된 raw SQL 파일만 SQL Editor에서 한 트랜잭션으로 실행한다. 원본 112354 → 대체 175537 → 최종 함수/권한 검증 → COMMIT이며 오류는 ROLLBACK한다. 적용 완료 통지/검증 뒤 두 실제 실행 버전만 정확한 source로 등록한다. 실패한 160650을 적용한 것처럼 이력에 넣지 않는다.
- 설치 LF SHA-256 b7634d83769b9d7d5e6bce53fa644fd2512468c2235624f7db57ff58debfa7e1, 등록 LF SHA-256 4265d1af78adffac59d37e21464248186739d93be4fb78c14f1a6fda8b98d6e7. 상세 Migration 원문 hash는 보고서 표와 비교한다. Git 통합·push·배포·정정·재마감은 계속 별도 승인 대상이다.

