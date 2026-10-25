# 인계서 — BABA P0-2 independent verification fixes D1 D2 D3 R1

> 작성: 2026-10-25T12:33:14.606Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: BABA P0-2 independent verification fixes D1 D2 D3 R1
- 작업 ID: 20261025-p0-2-baba-integrate-01
- 담당 AI: Codex
- Worktree: baba-wt-codex

## 2. Git 상태
- 작업 브랜치: codex/20261025-p0-2-baba-integrate-01
- HEAD SHA: d7511791659ee3427b8030b5fc79b8495f406732
- 기준: main · merge-base d2f74cc33252b3e40db1657b93c636c40f4fb572
- 작업 커밋 4개:
  - d751179 fix: restrict index overrides to internal verification snapshots
  - 0c6c846 fix: harden integration hooks test evidence and remote freshness
  - 10bdc30 docs: record P0-2 verification and remaining integration blockers
  - b340d44 feat: prepare BABA integration with evidence and SHA-bound approval gates
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `docs/agents/baba-agent-workflow.md` | 수정 | +4 −0 | 커밋됨 |
| `docs/agents/baba-integrate.md` | 추가 | +146 −0 | 커밋됨 |
| `docs/handoffs/codex-20261025-p0-2-baba-integrate-01.md` | 추가 | +95 −0 | 커밋됨 |
| `scripts/agent/baba-handoff.mjs` | 수정 | +2 −2 | 커밋됨 |
| `scripts/agent/baba-integrate.mjs` | 추가 | +276 −0 | 커밋됨 |
| `scripts/agent/baba-start.mjs` | 수정 | +5 −9 | 커밋됨 |
| `scripts/agent/baba-verify.mjs` | 수정 | +29 −9 | 커밋됨 |
| `scripts/agent/lib/baseline.mjs` | 수정 | +4 −3 | 커밋됨 |
| `scripts/agent/lib/common.mjs` | 수정 | +82 −4 | 커밋됨 |
| `scripts/agent/lib/remote-main.mjs` | 추가 | +28 −0 | 커밋됨 |
| `scripts/agent/lib/verify-evidence.mjs` | 추가 | +79 −0 | 커밋됨 |
| `tests/agent-workflow-build-env.test.mjs` | 수정 | +2 −2 | 커밋됨 |
| `tests/agent-workflow-integrate.test.mjs` | 추가 | +400 −0 | 커밋됨 |
| `tests/agent-workflow-safety.test.mjs` | 수정 | +4 −3 | 커밋됨 |
| `tests/agent-workflow-start.test.mjs` | 수정 | +20 −2 | 커밋됨 |
| `tests/agent-workflow-tools.test.mjs` | 수정 | +2 −2 | 커밋됨 |

기능 요약:
- 사용자 지정 기준 main `d2f74cc33252b3e40db1657b93c636c40f4fb572`, 수정 전 HEAD `10bdc30634c5d0537afa35571c8424bd236c240e`에서 기존 P0-2 작업을 재개했다. 원래 Handoff `docs/handoffs/codex-20261025-p0-2-baba-integrate-01.md`는 수정하지 않았다. 이 후속 인계서는 별도 경로로 보존한다.
- 이번 후속 수정 파일은 9개다: `docs/agents/baba-integrate.md`, `scripts/agent/baba-integrate.mjs`, `scripts/agent/baba-start.mjs`, `scripts/agent/baba-verify.mjs`, `scripts/agent/lib/baseline.mjs`, `scripts/agent/lib/common.mjs`, `scripts/agent/lib/remote-main.mjs`, `scripts/agent/lib/verify-evidence.mjs`, `tests/agent-workflow-integrate.test.mjs`. 위 자동 표는 main 이후 전체 P0-2 변경을 포함한다.
- D1: 공통 `assertNoGitHooks`/`guardedGit`으로 start의 fetch/switch, Verify baseline index 쓰기, prepare의 fetch/switch/merge를 보호했다. post-index-change를 포함한 shared 기본 Hook 디렉터리와 core.hooksPath를 함께 검사한다. Git 2.55 config Hook 키를 effective `--includes` 설정에서 검사하며 command 값은 실행하거나 로그에 출력하지 않는다. 조건부 includeIf, 알 수 없는 Git 환경변수, 설정/디렉터리 조사 실패는 차단한다.
- D1 후속: 외부 GIT_INDEX_FILE은 Worktree 내부를 가리켜도 거부한다. baseline helper가 명시한 내부 전용 index에만 예외를 부여한다. 공유 Hook 삭제나 원본 Git 설정 변경은 없다. core.hooksPath 설정만으로 안전하다고 가정하지 않는다.
- D2: Verify 시작 시 후보 HEAD와 base SHA를 고정하고, 종료 시 HEAD/base/코드 지문이 바뀌면 VERIFY_INPUT_CHANGED로 실패한다. archive의 baseSha, merge-base, 실제 변경 경로와 main 계보, testSelection의 explicit/allTests/executed 및 실제 실행 결과를 대조한다. prepare는 후보의 명시적 테스트를 포함한 실행 목록 전체를 재사용하고 새 main 변경의 관련 테스트도 추가한다. 0건·누락·미검증·불충분한 범위는 차단한다.
- D3: 원격 origin의 실제 refs/heads/main을 조회하며 origin/main 캐시만으로 판정하지 않는다. prepare 시작/종료와 merge 요청 진입 시 조회하고 SHA 변경은 재검증 사유다. 원격 선행·분기·조회 실패·관계 불명확은 차단한다. 로컬 선행은 원격 SHA의 조상 관계와 독립 승인 증거가 필요하나, 현재 독립 인증 경로가 없으므로 LOCAL_AHEAD_APPROVAL_UNVERIFIABLE로 차단한다. 조회의 대화형 인증 요청도 비활성화했다.
- R1: approvedBy=user 문자열/시각/digest를 에이전트가 동일 권한으로 만들 수 있어 사용자 출처로 인정하지 않는다. 원본 main 병합 실행 코드를 제거했다. merge 요청은 정상/위조 영수증 모두 LOCAL_MAIN_EXECUTION_DISABLED 또는 더 이른 안전 차단으로 끝나며, 실행을 켜는 CLI 플래그가 없다. 사용자 직접 확인·실행 또는 다른 계정/서비스의 보호된 키·실행 주체를 이용하는 인증 경로는 설계안만 문서화했다.
- R2: config/include/Hook, link, Git 상태가 검사 직후 외부 프로세스에 의해 바뀌는 TOCTOU는 해결되지 않았다. 반복 검사와 종료 상태 확인을 원자적 격리로 표현하지 않는다. 독립 실행 계정, 보호된 설정·키, 불변 검증 환경, expected-old SHA를 이용한 원자적 ref 처리 방향을 기록했다.

## 4. 검증 결과
- 검증 상태 지문: e68cf6a1d04592f3
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-25T12:33:02.367Z, .tmp-baba/verify/2026-10-25T12-33-02-367Z-d7511791-8be28ddd-e8a7-4c80-92c6-4c1cb0db1860.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 예 | passed |

미검증 항목:
- tests/agent-workflow-integrate.test.mjs: skip 1건 (실행 통과로 간주하지 않음)
- Build는 offline-local-fixture 환경의 검증이다. 운영 환경·인증·DB 연결은 미검증이며 이 .next 산출물을 배포하지 않는다.

수동 확인(브라우저·실행 확인 등):
- 실제 설치 Git: `2.55.0.windows.2`. [Git 2.55 Hook 문서](https://git-scm.com/docs/git-hook/2.55.0)를 확인했다. fixture의 파일/config post-index-change Hook이 protected 경로에서는 실행되지 않았고, 같은 격리 fixture의 의도적인 raw Git 양성 대조에서 marker가 생성되는 것을 확인했다. 양성 대조까지 모두 Codex `.tmp-baba` 내부의 독립 Git 저장소에서만 실행했다.
- D1: 파일 Hook, config Hook + 빈 core.hooksPath, include, 현재/미래 branch includeIf, GIT_CONFIG_COUNT/GIT_CONFIG_GLOBAL/GIT_CONFIG_PARAMETERS/GIT_DIR/GIT_INDEX_FILE, malformed config 차단을 실제 회귀로 실행했다.
- D2: 후보와 main 각각은 통과하지만 조합에서만 실패하는 기존 명시적 테스트를 prepare가 재실행하여 신규 통합 오류로 차단했다. archive의 변경 목록/base SHA/test 목록 변조 및 실행 도중 main 변경도 차단했다. source/API/SQL 차단 fixture는 범위 증거를 갖추도록 read-only resource 검사를 추가했으며 SQL을 운영에 실행하지 않았다.
- D3/R1: equal, local-ahead, remote-ahead, diverged, unavailable, stale origin/main 캐시, prepare 이후 새 main, 승인 누락/위조 사용자 영수증을 격리 fixture로 확인했다. 순차 작업 fixture의 main 진행은 사용자 직접 실행을 흉내 낸 로컬 fixture 동작이며 원본 main 작업이 아니다. 기존 승인 병합 성공 기대는 R1의 실행 비활성화 정책에 맞춰 수정했다.
- 전체 최종 실행: `baba-verify --base main --all-tests --build --json`, 코드 SHA `d7511791659ee3427b8030b5fc79b8495f406732`. 431개 파일, 4,277건 / PASS 4,175 / FAIL 59 / SKIP 43. 원본 판정은 **FAIL**이며 성공으로 변경하지 않았다. wrapper `.tmp-baba/p0-2-review-fixes/final-full-suite-v2-1792930798877.json`, archive `.tmp-baba/verify/2026-10-25T12-27-51-512Z-d7511791-8eac9b16-a81b-4f2f-8bef-6ac9a6584421.json`을 보존했다.
- Claude 실제 기준선은 `C:/workspace/baba-wt-claude/.tmp-baba/claude-review/verify-all.json`, HEAD 10bdc306, 4,268건 / PASS 4,166 / FAIL 59 / SKIP 43이다. 해당 원본 JSON의 SHA-256과 파일별 이전/현재 개수, 실패 이름·진단의 경로 정규화 비교, source 변경 여부를 `.tmp-baba/p0-2-review-fixes/file-comparison-1792931318873.json`에 기록했다. 기존 23개 파일의 59건이 동일하게 재현됐으며, 이번 변경으로 남은 신규 실패는 0건이다. 추가 9개 회귀는 모두 통과했다. 기존 실패를 통합 허용으로 바꾸지 않았다.
- P1은 별도 기존 결함이다. `tests/inventory-display-category-sync-db.test.mjs` 17건과 `tests/payroll-part-time-early-extra-work-db.test.mjs` 8건은 raw Verify에서 new로 분류되지만, escaped Windows root/baseline 경로를 분석용으로 정규화하면 기존 main·Claude 진단과 일치한다. 실패 자체는 여전히 남아 있다. TAP parser와 raw verdict는 수정하지 않았으며 비교 스크립트도 분석 결과를 통합 승인으로 사용하지 않는다.
- 최종 관련 실행: `baba-verify --base main --build --json`. 5개 agent-workflow 파일 72건 / PASS 71 / FAIL 0 / SKIP 1. baba-start 24건, D1/D2/D3/R1을 포함한 integrate 27건 중 PASS 26/SKIP 1, 나머지 21건 PASS. ESLint 신규 오류·경고 0, TypeScript는 실제 merge-base snapshot과 동일한 기존 40건·신규 0, Build exit 0. 이 관련 범위의 PASS_WITH_PREEXISTING은 전체 59건 실패를 대체하지 않는다.
- 최종 관련 wrapper `.tmp-baba/p0-2-review-fixes/final-related-v2-1792931179311.json`, 자동 기재된 Verify archive 및 `.tmp-baba/p0-2-review-fixes/final-gate-1792931593601.json`에서 지문 일치를 확인했다. strict 통합 증거 검사는 정확히 VERIFY_TEST_INCOMPLETE를 반환했다. 일반 symlink SKIP 1건을 junction/hardlink PASS로 대체하지 않았다.
- 실제 작업 루트의 merge 요청은 exit 2 / LOCAL_MAIN_EXECUTION_DISABLED였다. 실제 원격 main과 로컬 main은 모두 d2f74cc…로 equal, branch refs와 원본 main·Claude 상태는 불변이다. `.tmp-baba/p0-2-review-fixes/root-safety-v2-1792931337976.json`과 해당 integration archive를 보존했다. 인계 커밋 뒤 --handoff로 이 후속 인계서를 지정하는 실제 inspect/prepare 결과도 `.tmp-baba/p0-2-review-fixes/`에 연결한다.
- 이전 실행들은 덮어쓰지 않았다. 수정 중이던 과거 관련 실행은 입력 지문 변경을 감지하여 FAIL이 되었고 최종 증거에서 제외했다. 현재 기록의 전체/관련 실행은 모두 d751179의 고정된 코드에서 완료됐다.
- 실제 브라우저/Production/운영 DB는 검증하지 않았다. Build는 기존 offline-local-fixture, 테스트는 자격 증명 제거와 Node 오프라인 가드를 사용한다. 네이티브 프로그램 전체의 OS 격리를 보장한다고 주장하지 않는다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- main 병합 불가. 일반 Windows symlink 1건이 여전히 미검증으로 VERIFY_TEST_INCOMPLETE를 유지한다. 전체 59건 실패 및 43건 skip도 자동 통과시키지 않는다.
- R1의 독립 사용자 인증/실행 서비스는 미구현이며 도구의 원본 main 실행은 비활성화다. 로컬 main 선행 승인의 독립 인증도 불가능하여 차단한다. 승인 JSON을 추가하는 것만으로 해결되지 않는다.
- R2 TOCTOU는 미해결이다. P1 Windows TAP 경로 정규화 문제와 기존 사업 영역 실패·TypeScript 오류는 별도 기존 결함이며 이번 변경에서 고치지 않았다.
- Claude의 수정본 재검증은 아직 수행하지 않았다. 원본 main, GitHub push, Production, 운영 DB/Migration 변경은 모두 0건이다. 세 Worktree·기존 Git 이력·기존 Handoff·테스트 로그를 보존했다.

## 8. 후속 작업
- Claude가 수정본을 읽기 전용으로 검토하거나 자기 격리 fixture에 반영하여 Git 2.55 파일/config Hook 및 includeIf/env, 내부 index 예외, 후보/main 조합에서만 실패하는 명시 테스트, 변경 범위·SHA 변조, 실제 remote equal/ahead/diverged/unavailable/캐시 stale, 정상·위조 승인 파일의 실행 비활성화를 재검증한다. 이 세션에서 Claude Worktree를 수정하지 않는다.
- Native Windows symlink 실행 환경과 기존 전체 실패·skip/P1 문제를 별도 해결·검증해야 한다. 기존 실패를 승인 또는 지문 일치만으로 허용하지 않는다.
- 기존 P0-2 Handoff는 역사 기록으로 유지한다. 현재 후보 검사에는 `--handoff docs/handoffs/codex-20261025-p0-2-baba-integrate-01-review-fixes.md`를 명시한다. 이 인계서 커밋 뒤에도 code HEAD는 위 자동 SHA를 뜻하며 Handoff 파일만 추가된다.
- R1 독립 인증 및 보호된 실행 경로, R2 개선은 별도 설계/작업이다. 현재 사용자 지시에 따라 main 병합·push·Production·운영 DB/Migration은 실행하지 않는다. 운영 SQL Editor → GPT 운영 검증 → 조건부 해당 신규 history → 배포 SOP를 유지한다.

