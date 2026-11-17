# /tables 영업 전 안내 재발 및 상세 갱신 최적화

## 작업 범위와 기준

- 기준: `9efb9630de6511674aac7572f56772eaec8403f8`. 로컬 main과 GitHub `refs/heads/main`을 읽기 전용으로 확인했으며 같은 SHA였다.
- 브랜치: `codex/tables-detail-refresh-20261117`.
- 시작 시 두 작업 트리 모두 미커밋 변경 없음. 기존 Worktree 커밋 `bdfbac2b`를 보존하고 기준 SHA에서 새 독립 브랜치를 만들었다.
- 완료 범위: Codex Worktree 구현·격리 검증·로컬 커밋. main 병합·Push·배포·운영 DB 실행 없음.

## 정확한 재발 조건

기존 상세 effect의 의존성은 `[selected, data, failed, router]`였다. 60초 목록 GET이 새 `data` 객체를 저장할 때마다 상세 GET이 재실행되고, 요청 및 신선도 키는 `${selected.id}:${data.serverNow}`였다. 테이블 증거가 같아도 serverNow 변경만으로 다른 조회로 취급했다.

기존 `beforeOpening`은 서버의 영업 전 판정에 더해 `!failed`, catalog 정상, snapshot `waiting/ok`, unknown 0, occupiedPartial 없음, 미연결 자료 없음, 결제 검증 충돌 없음, 모든 테이블 idle·주문 없음 조건을 전부 요구했다. 따라서 한 테이블과 무관한 오류도 영업 전 표시를 해제할 수 있었다.

기존 `detailBeforeOpening`은 다시 `!detailFailed`, 청소 오류 없음, snapshot unavailable 아님, paymentChanged 아님, 상세 snapshot `waiting/ok`, 결제·합산 검증 경고 없음을 요구했다. 상세 GET 503 → `detailResult.failed=true` → `detailBeforeOpening=false` → 기존 헤더의 `snapshotStatus !== ok` 경로에서 `확인 필요` → 기존 compactWarning의 `snapshotStatus !== ok` 경로에서 `수집 확인 필요`가 표시되었다. HTTP는 성공해도 상세 snapshot이 unhealthy이면 같은 중앙 안내 해제가 발생했다.

즉 영업시간이 바뀐 것이 아니라 조회 오류/결제 검증 조건이 영업 전 표시 조건과 결합되어 첫 화면에서 두 번째 화면으로 바뀌었다. 격리 브라우저의 변경 전 bundle로 이 현상을 재현했다.

## 최종 구현

- 기존 서버 `calculateBusinessTimeContext`가 만든 `overview.beforeOpening`을 영업 전 시간 판정으로 사용한다. 목록 및 상세 서버는 같은 기존 운영시간 snapshot을 사용한다. 영업시간 설정·Cron 허용시간 계산은 변경하지 않았다.
- 정상 대기 문구 생략 조건은 `normalWaiting`으로 분리한다. 영업 전 헤더·중앙 안내는 상세 GET pending/503, 목록 조회 실패, snapshot 오류 때문에 사라지지 않는다. 실제 조회 실패·수집 오류·미확인 주문·결제 검증 진단은 별도로 유지한다. unknown 타일·미확인 집계를 idle/0/빈자리로 조작하지 않는다.
- 선택 테이블에 실제 주문·paid/occupied/reserved 상태·결제 시각이 있거나 상세에 주문이 있으면 중앙 안내로 주문 영역을 덮지 않는다. 유효/취소/재발행/합산 영수증 및 결제 이력 렌더링을 유지한다.
- 기존 `idleEmpty` 중앙 스타일에 `🕒`와 KO `현재 영업전입니다.`, VI `Hiện tại cửa hàng chưa mở cửa.`를 하나의 안내로 표시한다. 헤더의 `영업 전 / Chưa mở cửa`를 유지한다.
- 상세 조회 키에 영업일·선택 테이블·영업 전 경계·상태·주문 ID/시작/금액/메뉴·결제/합산 closure·영수증 증거·자동 전환 관찰값·조회 건강 상태를 포함한다. serverNow, snapshotAt 및 주문 collectedAt만 바뀌는 경우는 재조회 사유에서 제외한다. 다른 테이블의 증거만 바뀌어도 선택 테이블 상세를 다시 조회하지 않는다.
- 기존 영수증 목록 SELECT에 `final_amount,ref_no,status_changed_at` 세 기존 열만 포함하고, 청소 컨텍스트는 이미 읽은 영수증 version을 사용한다. 조회 횟수·범위·정렬·페이지 처리·DB 구조/권한·CUKCUK 호출은 추가하지 않았다. 명시적 필드만 표시용 증거에 사용하며 raw/customer/자격 증명은 포함하지 않는다.
- 최초 선택·선택 변경·관련 증거/영업일/영업 경계 변경·명시적 새로고침·청소 처리 후에 상세를 조회한다. 상세 헤더에 기존 버튼 스타일의 새로고침 버튼을 추가해 모달을 닫지 않고도 명시적으로 재조회할 수 있다. 기존 60초 목록 타이머와 화면 재활성화 갱신을 유지하며 새 타이머는 없다.
- 갱신 중 같은 영업일의 상세 객체와 기존 DOM 키를 유지한다. 최신 목록 주문이 우선하며 상세 조회 완료를 기다리지 않고 새 주문을 표시한다.
- 상세 요청 cleanup의 AbortController와 JSON 처리 후 aborted 검사를 유지한다. 목록에도 응답 직후 aborted 검사를 추가한다. 이전 snapshot의 상세는 적용하지 않으며, 같은 snapshot 시각이어도 영수증 증거/테이블 상태가 다르면 현재 결제·청소 증거로 인정하지 않는다.
- 청소 가능 여부는 request key 일치·pending/failed 아님·양쪽 snapshot 정상·주문/결제/상태 호환·snapshotAt 정확히 일치를 요구한다. 오래된 상세는 표시용 이력으로만 유지한다. 목록 snapshot만 새로 수집되면 기존 청소 버튼은 비활성화되며 명시적 새로고침으로 최신 증거를 조회할 수 있다. POST의 기존 서버/DB 재검증은 유지한다.

## 상세 GET 실측

실제 React 페이지를 격리 bundle로 실행하고 모든 요청을 테스트 서버로 차단/대체했다. 로컬 Chrome의 브라우저 시계를 전진시키며 11:53에 테이블 2 상세를 열고 기존 목록 타이머를 실행했다. Production/운영 자격 증명은 사용하지 않았다.

| 시나리오 | 목록 GET | 변경 전 상세 GET | 변경 후 상세 GET |
| --- | ---: | ---: | ---: |
| 최초 진입 + 60초 × 5회, serverNow만 변경 | 6 | 6 | 1 |
| 상세 503 후 60초 × 5회 | 5 추가 | 반복 재시도하는 기존 구조 | 0 추가 |
| 상세 응답 지연 중 60초 × 5회, 동일 증거 | 5 추가 | 기존 effect 재실행 구조 | 0 추가 |
| 실제 메뉴 변경 | 기존 목록 갱신 | 해당 없음 | 1 추가 |
| 결제예정 → 완료 / 취소 / 재발행 / 합산 증거 변경 | 각 목록 갱신 | 해당 없음 | 각 1 추가 |
| 서버가 검증한 30분 자동 일반 전환 | 기존 목록 갱신 | 해당 없음 | 1 추가 |

첫 행은 KO/VI × 320/360/390/430/1280px의 10개 조합 각각에서 같은 결과였다. 503 후 5회 유지 및 역순 목록/선택 변경 응답은 KO/VI × 390/1280px의 4개 조합에서 추가 검증했다. 지연 상세 응답보다 최신 명시적 조회가 먼저 도착하면 최신 영수증 NEW를 유지하고 이전 OLD 영수증을 적용하지 않는다. 지연 목록보다 새 occupied 목록이 먼저 도착해도 영업 전 상태로 되돌리지 않는다.

## 검증 결과와 한계

- 최종 관련 회귀: 212건, **209 PASS / 0 FAIL / 3 SKIP**. tables 전체, store-settings business-time/adapter, admin-sales-business-time, pos-business-day-source 포함.
- SKIP 3건은 기존 `QA_POSTGRES_BIN` 미설정에 따른 native PostgreSQL 자동 관찰·청소 동시성·P0 안전성 테스트다. 실행하지 않은 native 검사를 PASS로 보고하지 않는다. 기존 PGlite 기반 DB·청소·자동 전환·결제 검증은 실행하여 통과했다.
- SQL 격리 테스트에서 실제 fixture 영수증 금액/번호를 변경하고 기존 SELECT 열과 컨텍스트를 읽어 상세 식별자가 바뀌는지 확인했다. 테이블 상태·사용 중·완료 집계는 동일했다. 운영 DB는 사용하지 않았다.
- 브라우저: KO/VI·5개 폭에서 최초/5회 갱신 호출 비교, 상세 503·지연·역순 응답, 실제 수집 오류 진단, 검증된 영수증 유지 PASS.
- 모바일 320/360/390/430px는 터치 입력을 사용했다. 메뉴/결제 이력 펼침·dialog 스크롤·포커스를 동일 증거 갱신과 실제 메뉴 변경 전후에 확인했다. 중앙 안내와 헤더의 가로 넘침 없음, KO PC/VI 320px 캡처 육안 확인 PASS.
- 브라우저에서 15:59 → 16:00 신규 진행 주문, 17:30, 00:59 → 01:00, 02:59 → 03:00 영업일 변경을 확인했다. 기존 목록 갱신으로 자동 반영된다. 브라우저 시간대는 America/Los_Angeles로 두었다.
- KO/VI 390/1280px에서 결제예정 → 완료·취소·재발행·합산·서버 관찰에 따른 30분 전환 시 각각 상세 GET이 1회 발생하고 상태/영수증이 갱신됨을 추가 확인했다.
- 청소 버튼은 collection snapshot만 새로워진 경우 추가 상세 GET 없이 비활성화되었다. 명시적 새로고침 후 청소 POST 1회, idle 전환 및 필요한 상세 재조회 PASS. 실제 서버의 stale/context/RPC/결제·주문 변경 안전성은 기존 SQL 기반 회귀로 별도 검증했다.
- TypeScript `npx.cmd tsc --noEmit --incremental false` PASS.
- ESLint: 변경된 TS/TSX/MJS 10개 파일 명시 검사 PASS. 저장소 전체 lint PASS를 주장하지 않는다.
- Production Build: `.local/tables-detail-refresh/full-build-final`에 현재 소스를 복사하고 실제 .env/운영 자격 증명 없이 가짜 build 전용 설정으로 `next build --webpack` 실행, exit 0. 배포 없음.
- `git diff --check` PASS. 보고서 UTF-8 strict decode·한글 주요 문구·U+FFFD 없음 검사 PASS.

검증 로그·bundle·브라우저 스크립트·호출 측정 JSON·캡처는 `C:\workspace\baba-wt-codex\.local\tables-detail-refresh\`에 보관한다. 테스트 서버 응답 및 로컬 PGlite 데이터만 사용했으며, 실서비스 Production에서 직접 재현/부하 검증한 결과는 아니다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail-refresh.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-overview.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-overview-server.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail-server.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-cleaning-server.ts`
- `C:\workspace\baba-wt-codex\tests\tables-detail-refresh.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-production-fixes.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-api.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-detail-refresh-20261117.md`

기존 급여 파일, 매출 계산, Migration, Cron, CUKCUK API, 청소완료/30분 전환의 업무 규칙 및 운영 DB는 변경하지 않았다. 서버 수정은 표시용 증거 및 기존 운영시간 snapshot 전달에 한정된다.
