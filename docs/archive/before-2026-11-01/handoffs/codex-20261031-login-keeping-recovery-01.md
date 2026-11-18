# 인계서 — login recovery and keeping selection

> 작성: 2026-10-31T08:41:26.795Z · baba-handoff · 기준 정책 docs/agents/baba-agent-workflow.md

## 1. 작업 정보
- 작업명: login recovery and keeping selection
- 작업 ID: 20261031-login-keeping-recovery-01
- 담당 AI: Codex
- Worktree: baba-wt-codex
- 실제 경로: `C:\workspace\baba-wt-codex` (등록된 Codex 전용 Worktree, 격리·병렬 모드)
- baba-start: STARTED, `.tmp-baba/start/tasks/20261031-login-keeping-recovery-01.json`

## 2. Git 상태
- 작업 브랜치: codex/20261031-login-keeping-recovery-01
- HEAD SHA: a3602defd459b6acfb95f06a8a3b6f4a2085ae44
- 기준: 75d7897e7d2456dc44063227086a7536e38905d2 · merge-base 75d7897e7d2456dc44063227086a7536e38905d2
- 작업 커밋 2개:
  - a3602def fix: cancel pending exact-name keeping searches after selection
  - 92ca627d fix: recover login failures and keep selected products closed
- 미커밋 변경: 없음

## 3. 변경 파일과 기능
| 파일 | 상태 | 변경량 | 커밋 |
| --- | --- | --- | --- |
| `app/login/page.tsx` | 수정 | +32 −20 | 커밋됨 |
| `components/bar/keeping/KeepingProductAutocomplete.tsx` | 수정 | +14 −4 | 커밋됨 |
| `tests/login-keeping-browser.mjs` | 추가 | +50 −0 | 커밋됨 |
| `tests/login-keeping-recovery.test.mjs` | 추가 | +124 −0 | 커밋됨 |

기능 요약:
- 로그인: 통신·JSON·비정상 응답 예외를 처리하고 finally에서 로딩을 해제한다. KO/VI 재시도 안내를 제공한다. 기존 인증 실패 메시지, 사용자 저장, 관리자 `/admin`·직원 `/inventory` 및 안전한 근태 복귀 경로는 유지한다.
- 보관상품: 선택 완료와 직접 입력을 ref로 구분한다. 선택 시 요청 번호를 무효화하고 목록·로딩을 정리한다. 선택된 표시명으로 재검색하지 않으며 예약 타이머와 늦은 성공·실패 응답이 목록·로딩을 복원하지 못하게 한다. 직접 입력 시 선택 해제와 검색을 재개한다.
- 테스트: 실제 두 컴포넌트를 TypeScript로 변환해 React DOM에 렌더링하는 loopback 브라우저 fixture와, abort를 무시하는 응답·정확 이름 debounce 경합을 주입하는 직접 회귀 테스트를 추가했다. 공통 설정·패키지·lockfile·API·인증 정책·상품 데이터는 변경하지 않았다.

## 4. 검증 결과
- 검증 상태 지문: 02e8f053565fe7ad
- baba-verify 판정: **PASS_WITH_PREEXISTING** (2026-10-31T08:40:59.076Z, .tmp-baba/verify/2026-10-31T08-40-59-076Z-a3602def-e13d9bfa-dec1-4ff9-8f88-20eb0fc4b651.json)
- 현재 상태와 일치: 예

| 검사 | 실제 실행 | 결과 |
| --- | --- | --- |
| 변경 파일 검사 | 예 | passed |
| 회귀 테스트 | 예 | passed |
| ESLint (변경 파일) | 예 | passed |
| TypeScript (tsc --noEmit) | 예 | passed-with-preexisting |
| Production Build (next build) | 아니오 | not-run |

미검증 항목:
- 브라우저 화면 동작(UI)은 이 스크립트가 확인하지 않는다. 필요 시 별도 실행 확인 결과를 인계서에 기록한다.

수동 확인(브라우저·실행 확인 등): 사람이 수행한 수동 조작은 없음. 아래 자동 브라우저·직접 실행 검증을 수행했다.

- 수정 전: 실제 로그인 컴포넌트에서 fetch 거부 후 버튼이 비활성으로 남는 타임아웃과 비정상 JSON 응답 후 `disabled: true`를 확인했다. 실제 자동완성에서 부분 검색 후 표시명이 다른 상품을 선택하면 `aria-expanded: true`로 다시 열리는 것을 확인했다.
- 수정 전 기준 SHA의 자동완성 소스를 동일 경합 테스트에 주입했을 때, 정확 이름 선택 후 늦은 응답으로 목록이 열려 `true !== false`로 실패했다. 재현용 파일은 ignored `.tmp-baba/keeping-original-repro.test.mjs`에 보존했다.
- 수정 후 로그인: KO/VI 각각 네트워크 실패, JSON 파싱 실패, null·잘못된 객체·성공 응답의 user 누락, 정상 인증 실패 메시지, 각 오류 직후 같은 화면에서 재시도 성공, 관리자·직원 이동 및 근태 복귀를 확인했다. 사용자 ID 저장도 확인했다.
- 수정 후 상품: KO/VI × 마우스·터치·키보드(기존 option 포커스 후 Enter) × 부분·정확 검색·debounce 중 선택·반대 언어 대체명·코드 대체명, 상품 ID·이름 유지, 선택 후 포커스 시 닫힘, 직접 입력 시 선택 해제·검색 재개를 확인했다. 늦은 성공·실패와 정확 이름 검색의 미실행 타이머는 직접 경합 테스트로 검증했다.
- Playwright의 headless Chrome을 새로 실행했다. 실제 React DOM과 대상 소스를 사용했고, Next의 언어·router·이미지 문맥과 통신은 fixture로 대체했다. 이 Worktree에서만 임의 loopback 포트와 메모리 번들을 사용했으며 원본 3000·다른 개발 서버·운영 API·DB는 사용하지 않았다. 전체 Next 앱의 실제 인증·이동 완료까지 검증한 것은 아니다.
- 최종 실행: `PLAYWRIGHT_MODULE_PATH`에 기존 로컬 Playwright 경로를 지정하고 `node scripts/agent/baba-verify.mjs --base 75d7897e7d2456dc44063227086a7536e38905d2 --tests tests/login-keeping-recovery.test.mjs`. 오프라인 가드 및 자격 증명 제거 환경에서 관련 테스트 3개 파일(근태 세션 전환, bar 이미지 정책, 신규 회귀)이 통과했다. 신규 회귀의 브라우저 테스트 2개와 직접 경합 테스트 1개는 모두 실행됐으며 skip은 없다.
- 변경 파일 검사·ESLint 통과, 신규 오류·경고 0. `next typegen` 및 TypeScript 비교 결과 기존 오류 40, 신규 0. 예: 기존 테스트의 `.ts` import에 대한 TS5097. 범위 밖 기존 오류는 수정하지 않았다.
- Build는 페이지 추가·삭제, 설정·의존성·layout·CSS 변경 또는 병합 준비가 없어 규칙상 필수가 아니며 실행하지 않았다. 운영 인증·DB·실기기 터치·전체 앱 통합 검증은 미실행이다. 브라우저 터치는 Chrome의 터치 입력 에뮬레이션이다.

## 5. DB·Migration
- Migration 변경: 없음
- 기타 SQL 변경: 없음
- 에이전트의 운영 DB 변경·Migration 적용: 없음 (정책상 금지 — AGENTS.md 수동 적용 절차)

## 6. Push·병합·배포
- Git push: push 안 됨
- main 병합: 미병합
- Vercel 배포: 에이전트 미실시 (사용자 승인 후 별도 진행)

## 7. 미완료 사항
- 요청한 두 결함의 구현·회귀 검증은 완료했다. 기존 TypeScript 오류 40개는 별도 작업 대상이다. 위 미실행 항목을 PASS로 간주하지 않는다.
- main 통합·push·PR·배포는 미실시이며 이 요청의 범위 밖이다. 미통합 기능 커밋을 보존하기 위해 작업 브랜치를 유지하고 ready 전환·브랜치 삭제·main 아카이브는 수행하지 않는다(종료 정리 보류).

## 8. 후속 작업
- 사용자가 통합 순서를 정하고 별도 승인한 뒤 통합 담당자가 최신 main 기준 충돌 검사·후보 검증을 수행한다. 현재 main 기준 변경은 위 코드·테스트 4파일과 이 인계서뿐이다.
- 작업 시작·범위 갱신 Preflight에서 다른 Worktree와 예정 파일 겹침은 없었다. 최종 확인 시 원본 main은 기준 SHA 그대로이며 `scripts/ledger/receipt12848-supplier-preflight.sql` 미추적 1건을 보존했다. Claude 및 detached Worktree도 수정하지 않았다. 현재 장부·식대 작업과 직접 파일 충돌은 없지만 이후 두 화면·관련 테스트 또는 공통 의존성이 변경되면 재검증이 필요하다.
- 종료 읽기 전용 `baba-status --branches --no-color` 조회는 main 작업 경로에서 수행했다. 원본 DIRTY, 기존 추가 detached Worktree·다른 미통합 브랜치 경고는 이번 작업과 별개이며 정리하지 않았다. 원격 main은 시작 시와 상태 조회 시 확인했으며 로컬 main보다 3커밋 뒤에 있었다. 원격 이력을 기준으로 이번 변경을 확대 집계하지 않도록 명시적 작업 기준 SHA를 사용했다.

