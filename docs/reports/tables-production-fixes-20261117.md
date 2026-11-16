# /tables 운영 오류 4건 수정 결과 — 2026-11-17

## 작업 범위와 기준

- 브랜치: `codex/tables-production-fixes-20261117`
- 기준: `f348f6a56a7a8aec5c668630d263a12041eafdbb`. 시작 시 main·origin/main·Codex Worktree HEAD 일치, 미커밋 변경 없음. `git fetch origin main` 후 독립 브랜치 생성.
- 산출물: 아래 소스·회귀 테스트·본 보고서의 Worktree 로컬 커밋. 최종 SHA는 Git 커밋과 완료 보고에 기록한다.
- main 병합, Push, 배포, 운영 DB 조회/쓰기, 실제 청소 재시도, Migration·Cron 변경, CUKCUK 호출은 수행하지 않았다.

## 1. 부분 미확인과 사용 중 집계

**확인된 원인:** 기존 상태 투영은 검증된 진행 주문이 있는 테이블을 먼저 occupied로 처리하므로, 해당 테이블 자체는 초록색으로 유지한다. 그러나 정확한 전체 수량의 확정 조건에 `unknown === 0`과 `!unlocatedOrder`가 함께 있어 부분 미확인이 생기면 상단 사용 중 수량 전체가 null이었다.

**수정:** 기존 `summary.occupied`의 정확한 수량 계약은 유지하고 `occupiedConfirmed`·`occupiedPartial`을 추가했다. 정상 수집·정상 목록·충돌 없음 조건에서만 확인된 occupied 수를 별도로 제공한다. 부분 미확인이면 `3+`와 접근성/보조 안내로 최소 수량임을 알린다. 자동 전환 증거 검토 단계에서 추가로 unknown이 발생한 경우에도 부분 표시를 반영한다.

**전후 검증:** 정상 진행 테이블 3개 + 테이블 연결 미확인 결제 전이 주문을 주입하면 이전에는 전체 사용 중 null, 이후에는 정확한 수량은 여전히 null이며 확인된 최소 3개를 표시한다. 테이블이 명확한 정상 진행 주문은 4개로 확정한다. 결제 증거가 정상화되면 정확한 3개와 완료 영수증 1건으로 돌아온다.

원본 테이블이 불명확한 주문은 어느 물리 테이블에도 새로 배정하지 않는다. 영향을 받을 수 있는 다른 일반/완료 테이블을 임의로 정상화하지 않는다. 전체 수집 실패·오래된/미래 스냅샷·중복 주문 충돌에서는 최소 수량도 null이며 미확인 안전장치를 유지한다. 중앙 수집기·매출 확정 로직 변경 없음.

## 2. 청소 저장 실패

**과거 BAR11의 실제 실패 지점은 미확정이다.** Owner 제공 사실은 수동 청소 ON, BAR11 검증 키 존재, 저장 이력 0건, 청소 확정 RPC 호출 로그 미발견이다. 당시 HTTP 상태·응답 본문이 없고 Vercel 로그 접근도 불가하므로 이를 409·503 또는 Origin 문제로 단정하지 않는다. 이번 작업에서는 운영 재시도를 하지 않았다.

**확인된 코드 문제:** 클라이언트가 실패를 동일 문구로 묶고 증거를 재조회하지 않았다. UUID 생성이 try 밖에 있었으며, 서버는 RPC 저장 성공 이후 상태 재조회가 실패해도 저장 실패처럼 응답했다.

**수정:**

- 기존 엄격한 Origin 비교, 인증·역할, 기능 스위치, 요청 형식, 최신 영수증/증거 키 비교 및 RPC 검증을 유지했다. 검증 우회 없음.
- 실패 응답에 고정 `code`, `stage`를 부여하고 HTTP 상태를 유지한다. 단계는 origin / authentication / authorization / feature / request / context / evidence / confirm_rpc로 구분한다. 로그에는 고정 단계·코드·상태만 기록하며 사용자·토큰·영수증 payload·DB 오류 원문을 기록하지 않는다.
- 409 증거 만료, 503 서버/컨텍스트/RPC 장애, 403 차단, 잘못된 요청, 네트워크 실패를 구분하는 KO/VI 안내를 적용했다. 503 HTML 응답도 네트워크 실패와 구별한다.
- 실패 시 청소 증거를 즉시 비활성화하고 목록 GET 1회 → 선택 상세 GET으로 재확인한다. POST 자동 재시도 없음. 같은 증거의 수동 재시도는 같은 requestId를 유지하고 중복 클릭을 막는다.
- RPC가 저장을 확정한 뒤 재조회만 실패하면 `200`, `saved:true`, `overview:null`, `refreshRequired:true`로 구분한다. 저장된 사실은 알리되 idle을 합성하지 않으며 최신 GET 복구를 기다린다.
- 저장 중 새 주문이 발생하면 기존 서버 재검증 및 상태 우선순위가 그대로 적용된다.

**격리 검증:** 실제 기존 Migration을 설치한 PGlite PostgreSQL fixture와 API harness에서 Origin/인증/권한/입력/기능 차단, 컨텍스트 실패, 증거 만료 409, RPC 40001→409, RPC 장애→503, 저장 성공 후 조회 실패를 각각 재현했다. 저장 전 차단 시 이벤트 0건, 저장 확정 후 조회 실패 시 1건, 동일 요청 재시도 시 계속 1건, 신규 주문 발생 시 occupied 우선임을 검증했다. 브라우저에서도 409·503 HTML·network·403 각각 GET 1회/상세 1회, POST 추가 실행 없음과 요청 ID 재사용을 확인했다.

## 3. 상세 자동 갱신의 내용 소실

**확인된 원인:** `selected.id + overview.serverNow`가 바뀌면 이전 상세 데이터를 무효화하는 구조였고, 목록의 60초 갱신마다 상세가 사라졌다가 새 응답으로 다시 생성됐다.

**수정:** 표시 데이터의 보존 기준을 동일 테이블·동일 영업일로 분리하고, 요청 키는 최신 증거 판단에만 사용한다. 갱신 중/일시 실패 시 이력과 기존 DOM을 유지하며, 새 유효 응답이 오면 교체한다. 현재 주문·상태는 최신 목록과 비교해 신규 진행 주문이 즉시 우선하도록 한다. 더 최신 상세 스냅샷을 오래된 응답으로 덮어쓰지 않는다. 결제 증거가 바뀌면 오래된 최근 결제를 새 결제처럼 표시하지 않고 이력으로 보존한다.

- 선택 테이블 또는 영업일 변경 시 다른 범위의 이력을 재사용하지 않는다.
- 상세 갱신 중/실패/오래된 응답에서는 청소 버튼의 최신 증거 사용을 금지한다.
- 목록 조회 자체가 실패하면 보유한 이력은 남기되 타일·현재 주문·집계는 미확인으로 표시한다. 회복 요청이 진행 중이라는 이유만으로 이전 초록색 상태를 정상으로 되돌리지 않는다.
- 기존 60초/가시성 갱신 주기는 유지한다. 선택 상세는 갱신당 1회이며 추가 타이머/수집기/API 경로 없음.

**격리 브라우저 검증:** 60초 상세 응답을 지연시키고 메뉴·결제 이력을 펼친 상태에서 DOM 식별자, 펼침 상태, 포커스, 스크롤 값 유지 및 목록/상세 호출 각 1회를 확인했다. 상세 503 후 보유 정보 유지, 다음 주기 복구도 확인했다. 테이블·03:00 영업일 변경 및 신규 진행 주문 우선은 단위/기존 영업일 회귀에서 검증했다.

## 4. 자동 전환 배너

활성 결제 상태의 `결제완료 최초 확인 … · 일반 전환 …` 배너 렌더링만 제거했다. KO/VI 모두 적용한다. 최초 관측 기록, 30분 만료 판정, 수동 청소, 완료 상태/고정 주문 소요시간, 영수증 이력, 완료가 실제 공실 확정이 아니라는 안내를 유지한다. 이미 만료된 상태의 기존 일반 전환 안내는 유지한다. DB 함수·관측 저장 경로 수정 없음.

## 변경 파일 — 전체 Windows 경로

1. `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
2. `C:\workspace\baba-wt-codex\app\api\tables\[id]\clean\route.ts`
3. `C:\workspace\baba-wt-codex\lib\sales\table-overview.ts`
4. `C:\workspace\baba-wt-codex\lib\sales\table-auto-normal.ts`
5. `C:\workspace\baba-wt-codex\lib\sales\table-cleaning-server.ts`
6. `C:\workspace\baba-wt-codex\lib\sales\table-cleaning-feedback.ts`
7. `C:\workspace\baba-wt-codex\lib\sales\table-detail-refresh.ts`
8. `C:\workspace\baba-wt-codex\lib\text\tables.ts`
9. `C:\workspace\baba-wt-codex\tests\tables-production-fixes.test.mjs`
10. `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
11. `C:\workspace\baba-wt-codex\tests\tables-state-normalization.test.mjs`
12. `C:\workspace\baba-wt-codex\tests\helpers\tables-cleaning-service-fixture.mjs`
13. `C:\workspace\baba-wt-codex\docs\reports\tables-production-fixes-20261117.md`

## 검증 결과

- 기존 208개 + 신규 11개, 총 219개 PASS / FAIL 0 / skip 0. POS 주문·일별 매출 KPI, 27개 테이블, 합산/취소/재발행, 03:00 경계, 청소 DB·권한·동시성, 30분 자동 전환 관련 회귀 포함.
- TypeScript `--noEmit --incremental false`: PASS。
- 변경 대상 ESLint: PASS.
- Production Build (`next build --webpack`): PASS. `.env` 복사 없이 앱 자격 증명을 제외한 환경과 더미 Supabase 설정으로 격리 실행.
- KO/VI × 320/360/390/430/1280px: 기존 화면 회귀 10조합과 신규 실패/갱신 시나리오 10조합 검증. 스크린샷·실행 로그는 `.local/tables-production-fixes/`에 보관.
- 기존 60px 타일·좁은 화면 BAR4열/그 외6열·PC3구역·차콜 헤더·색상 dot·빨간 결제시각·언어별 메뉴·결제 카드/이력·모달 조작 유지.

## 운영 영향 및 미검증

DB/스키마, Cron, 중앙 POS 수집, 회계 금액 계산 변경 없음. 기존 GET 자료의 투영과 클라이언트 표시/복구, 기존 청소 API 응답/진단만 수정했다. 신규 DB 읽기 경로는 추가하지 않았다. 청소 실패 직후 복구 GET만 추가되며 POST 자동 재전송은 없다.

Production 프록시 Origin 값, 인증 cookie, 실제 BAR11 청소 요청과 로그는 미검증이다. 새로운 진단은 Owner 승인 후 적용한 이후에 활용할 수 있으며 과거 원인을 증명하지 않는다. PGlite/브라우저는 격리 재현이며 Production E2E를 PASS로 취급하지 않았다.

로컬 수정 후보는 GO. 운영 적용·main 통합·Push·배포는 이번 작업에 포함하지 않는다.
