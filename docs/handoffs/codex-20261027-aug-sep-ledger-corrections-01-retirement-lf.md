# 인계서 — M-stage unapplied migration retirement and LF policy

> 작성: 2026-10-27T18:57:52.020Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: M-stage unapplied migration retirement and LF policy
- 작업 ID: 20261027-aug-sep-ledger-corrections-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261027-aug-sep-ledger-corrections-01
- HEAD SHA: 1b1d1fd174bfd8853ac6bda1fa267db9492e8a31
- 기준: main · merge-base 18bfe728c2e076bc97dd24a4377eb398be45dc5a
- 작업 커밋 3개:
  - 1b1d1fd chore(ledger): archive unapplied lock patch and enforce SQL LF
  - 4f4188a docs: hand off reproduced SQL Editor line-ending failure for independent Claude review
  - 7e6c4c5 fix: normalize SQL Editor patch and history line endings with an unapplied replacement
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `.gitattributes` | 수정 | +2 −1 | 커밋됨 |
| `docs/handoffs/codex-20261027-aug-sep-ledger-corrections-01-line-endings-fix.md` | 추가 | +77 −0 | 커밋됨 |
| `docs/history/migrations-retired/20261027160650_fix_aug_sep_reclose_lock_order.sql` | 수정 | - | 커밋됨 |
| `docs/history/migrations-retired/README.md` | 추가 | +22 −0 | 커밋됨 |
| `docs/reports/20261028-ledger-m-line-endings-fix.md` | 추가 | +104 −0 | 커밋됨 |
| `docs/reports/20261028-ledger-m-retirement-lf.md` | 추가 | +74 −0 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 수정 | +8 −1 | 커밋됨 |
| `scripts/agent/lib/migration-retirement.mjs` | 추가 | +32 −0 | 커밋됨 |
| `scripts/ledger/m-stage-bundles.mjs` | 수정 | +16 −6 | 커밋됨 |
| `scripts/ledger/m-stage-install.sql` | 수정 | +14 −8 | 커밋됨 |
| `scripts/ledger/m-stage-register.sql` | 수정 | +23 −10 | 커밋됨 |
| `supabase/migrations/20261027175537_reclose_patch_line_endings.sql` | 추가 | +73 −0 | 커밋됨 |
| `tests/helpers/ledger-aug-sep-reclose-native-fixture.mjs` | 수정 | +1 −1 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-db.test.mjs` | 수정 | +1 −1 | 커밋됨 |
| `tests/ledger-aug-sep-reclose-postgres.test.mjs` | 수정 | +1 −1 | 커밋됨 |
| `tests/ledger-m-atomic-install-postgres.test.mjs` | 수정 | +12 −1 | 커밋됨 |
| `tests/ledger-m-line-endings-postgres.test.mjs` | 추가 | +125 −0 | 커밋됨 |
| `tests/ledger-m-retired-migration.test.mjs` | 추가 | +82 −0 | 커밋됨 |

기능 요약:
- 이번 작업의 코드 커밋은 `1b1d1fd174bfd8853ac6bda1fa267db9492e8a31`이다. 위 표는 merge-base 이후의 이전 줄바꿈 수정도 포함한다. 원본 main은 `b73f252cf7c088d02070de8d44f57577182c77c8`이며 main/Claude Worktree는 읽기 전용으로 clean을 확인했다.
- 사용자 승인 권장안 A에 따라 실패한 미적용 160650을 `git mv`로 아카이브했다. R100, 이전/이후 blob `2a6d8344ffe15562ed351935da98cef1303b15fb`, raw SHA-256 `185d0b8aec5757c7f569d426a9cdee2153e7f7362abc22fde758244adf05ce6e`로 바이트가 같다. 원본 내용과 이력은 보존했다. README에 미적용·미등록, 175537 대체 사유, 재실행/거짓 이력 등록 금지를 기록했다.
- 활성 SQL 일반 LF 규칙을 추가하고 기존 개별 `-text` 예외는 `!eol`로 상속을 해제하여 이전 실효 속성을 보존했다. 다른 경로의 속성은 유지하고 기존 Migration 전체 재정규화는 하지 않았다.
- 검증 도구는 이 정확한 승인 이동만 기준 blob/바이트/경로/README 조건으로 인정한다. 다른 Migration 수정·삭제·이동은 계속 차단한다. 별도 DB 이력 확인이나 사용자 승인을 대체하지 않는다. 신규 6건의 양성/음성 대조와 기존 도구 테스트로 검증했다.
- legacy 실패 재현 입력만 아카이브 경로로 바꿨다. 이번 커밋은 활성 Migration 본문, 설치/등록 번들, 회계 금액과 계획을 변경하지 않았다. 상세 해시·절차는 [검증 보고서](../reports/20261028-ledger-m-retirement-lf.md)에 있다.

## 4. 검증 결과
- 검증 상태 지문: 83acbc83575b36d1
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-27T18:57:40.339Z, .tmp-baba/verify/2026-10-27T18-57-40-339Z-1b1d1fd1-8bdce5ef-8ae2-46fe-ac48-e72da6751e47.json)
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

수동 확인(브라우저·실행 확인 등): Git 이동 전후 raw SHA/blob/내용, R100, 활성 파일시스템과 index 목록(199개, 160650 없음), Git 속성, 번들 생성 결과와 원문 해시, 다른 Worktree clean을 읽기 전용으로 확인했다. 브라우저 확인은 없다.

- 최종 커밋 상태에서 관련 테스트 13개 파일 **145 PASS / 0 FAIL / 0 SKIP**. 장부 90건(기존 84 + 신규 6), 도구 55건이다. ESLint 신규 오류/경고 0, TypeScript 기준선 기존 오류 40 / 신규 0, offline-local-fixture next build PASS다.
- 실제 PostgreSQL **17.6** 새 독립 DB에서 경합 22건, 원자적 설치/등록 12건, 줄바꿈 19건 PASS(각 집계에 최상위 1건 포함). PGlite 정정/R1/카드 12건, 월 재개방/마감 19건도 PASS다. 두 세션 이상 및 세 세션 겹침을 실행했고 Docker/서비스 설정은 변경하지 않았다.
- 기존 40P01 재현 순서는 00000으로 완료했고 교착 재발 0건이다. 실제 5초 timeout 3건은 **55P03**, 최종 실행 약 5020/5023/5013ms였다. 중간 정정/R1/감사 쓰기의 원자적 롤백, 재시도 중복 0, 원거래·자금 보존을 확인했다. 소유 테스트 클러스터는 정리됐으며 leftovers는 `[]`다.
- LF·CRLF·혼합·CR-only 및 부분 변환, 원본만 설치된 상태의 외부 비노출, commit 전 실패 시 두 DDL 롤백을 확인했다. 최종 본문 MD5 `beebd06ff35eb3eaf0a68dfde8494412`, postgres 소유/SECURITY DEFINER/search_path/5초 제한, PUBLIC·anon·authenticated EXECUTE 금지, service_role 허용을 확인했다.

## 5. DB·Migration
- Migration 변경: supabase/migrations/20261027175537_reclose_patch_line_endings.sql
- 기타 SQL 변경: docs/history/migrations-retired/20261027160650_fix_aug_sep_reclose_lock_order.sql, scripts/ledger/m-stage-install.sql, scripts/ledger/m-stage-register.sql
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)
- 사용자 승인·SQL Editor 적용 상태: 사용자가 제공한 실패 후 확인은 신규 함수/이력/정정 0건, 8·9월 closed revision 3 유지다. 운영 미적용 상태를 전제로 한 로컬 아카이브만 승인받았으며 운영 SQL은 보내지 않았다.
- 이번 커밋에서 기존 적용 Migration 본문 변경은 없다. 위 자동 목록의 활성 175537과 번들 변경은 이전 `7e6c4c5`의 미통합 작업이다. 이번에는 160650의 내용 불변 경로 이동만 수행했다.
- 신규 테스트 DB의 최종 history는 **112354/175537 두 버전만**이다. 각 name/statements와 LF 원문 SHA가 일치하고 160650은 없다. 설치/등록 파일과 생성기도 정확히 이 두 버전만 대상으로 한다. 160650 언급은 실행/등록이 아니라 충돌 차단 가드와 설명이다.
- 기존 비운영 환경 확인 범위: 연결 도구에는 알려진 운영 읽기 전용 connector만 있으며 별도 비운영 연결은 발견되지 않았다. 시작 시 PostgreSQL 프로세스/소유 보존 클러스터/접속 환경 변수 이름도 발견되지 않았다. **미연결 원격 환경의 이력은 미검증**이며 전체 부재로 단정하지 않는다. 테스트의 retired 충돌 행은 폐기되는 음성 대조다. 실제 환경에서 160650 이력이 발견되면 중단·보고하며 강제 repair하지 않는다.

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- Claude Code 독립 재검토 대기. 아직 Claude의 재검토가 완료됐다고 간주하지 않는다.
- 미연결 비운영 환경의 적용 이력 확인은 범위 밖이다. 해당 환경에서 160650의 실제 적용 이력이 발견되면 작업/설치를 중단해야 한다.
- 운영 Migration 설치·결과 확인·이력 등록, 장부 정정/재마감, main 통합·Push·배포는 모두 미실행이다.

## 8. 후속 작업
- Claude Code는 원본 blob/바이트 보존, SQL LF/기존 예외, 활성 목록에서 160650 제외, 좁은 검증 도구 예외와 음성 대조, PostgreSQL 17.6 결과 및 두 활성 버전만 실행/등록되는지를 독립 검토한다. 저장소 인계서로 전달하며 외부 메시지는 전송하지 않았다.
- 이후 별도 승인 시 사용자 수동 main 통합 정책을 따른다. 이번에 main 수정·통합, 원격 Push·배포는 하지 않았다.
- 운영 설치는 별도 사용자 승인 후 SQL Editor에서 `m-stage-install.sql` 전체를 한 세션/배치로 실행한다. 112354와 175537은 하나의 BEGIN/COMMIT에 포함돼야 하며 원본 단독 실행/커밋은 금지한다. 오류 시 해당 세션 ROLLBACK 후 중단한다.
- 사용자 설치 완료 통보 및 최종 결과 검증 후에만 별도 `m-stage-register.sql` 전체로 두 이력을 원자적으로 등록한다. 동일 등록은 no-op, 다른 원문/이름·retired 이력·권한 불일치는 차단한다. 강제 이력 등록·db push·include-all은 하지 않는다. 회계 정정·재개방/재마감·배포는 별도 승인 대상이다.
