# /tables 영업 전 결제 이력 오류 안내 수정

## 기준과 작업 범위

- 시작 Worktree: `C:\workspace\baba-wt-codex`, `codex/tables-detail-refresh-20261117`, HEAD `be39411e17159b7eaccf1bc27f03aa3d5e516a4a`. 미커밋 변경 없음.
- 시작 로컬 main: `3b44ccac1e4115275027caa6653c3701b77ade9e`. 직전 상세 최적화 병합 및 별도 legacy 정리 병합이 포함되어 있었고 미커밋 변경은 없었다.
- 원격 main 읽기 전용 확인: `9efb9630de6511674aac7572f56772eaec8403f8`.
- 직전 최적화 커밋을 보존하고 그 위에서 `codex/tables-detail-error-guidance-20261117` 브랜치를 생성했다. 기존 main·다른 브랜치·급여 작업은 수정하지 않았다.
- 실행 범위: 원인 코드 조사 → 격리 재현 → 최소 수정 → 검증 → Worktree 로컬 커밋. main 병합·Push·배포·운영 DB·Migration·Cron 변경 없음.

## 원인 코드와 조사 한계

기존 상세 effect의 catch는 원인과 관계없이 `detailResult.failed=true`만 저장했다. API route도 모든 예외를 HTTP 503 / `TABLE_DETAIL_UNAVAILABLE` 하나로 반환했다. 이후 UI의 정확한 분기인 `detailFailed ? t.historyUnavailableShort`가 항상 KO `결제 이력 조회 실패` / VI `Chưa tải được lịch sử`를 노란 `compactWarning`에 표시했다.

`be39411e`는 영업 전 헤더·중앙 문구를 실패와 독립적으로 유지하므로, 영업 전 정상 대기 중 상세 GET 503을 주입하면 중앙의 `현재 영업전입니다.`와 노란 `결제 이력 조회 실패`가 동시에 나타났다. 상세 API는 주문 snapshot·영수증·영수증 메뉴·청소 capability 등을 읽기 때문에, 상세 실패만으로 결제 이력 조회 실패라고 확정할 수 없다.

이는 **로컬 코드 분기와 격리 재현으로 확인한 안내 오류의 원인**이다. 당시 Production `/api/tables/[id]/detail`의 실제 응답 상태·실패 단계·배포 SHA는 이번 작업에서 확인하지 않았다. 일부 Supabase 요청 HTTP 200만으로 전체 상세 GET의 성공/실패 또는 DB 장애 원인을 단정하지 않는다. 운영 API/DB 조회나 운영 로그 수집은 수행하지 않았다.

## 변경 내용

1. 서버의 기존 조회·검증 실패를 `context`, `snapshot`, `receipts`, `lines` 단계로 구분한다. 예외 메시지를 전달하지 않고 허용된 고정 stage와 고정 code만 API 503에 포함한다. 알 수 없는 실패는 일반 `detail`로 처리한다. HTTP 인증/권한/404, 성공 응답, no-store 정책은 유지한다.
2. 클라이언트는 HTTP 상태, 안전한 stage/code를 detail result에 저장한다. timeout·잘못된 JSON/상세 응답·이전 snapshot 응답도 각각 고정된 진단으로 식별한다. 서버의 임의 code/message나 응답 원문은 화면에 출력하지 않는다. stage가 없는 기존 API 503도 일반 상세 실패로 처리한다.
3. 정상 영업 전 대기이며 선택 테이블에 주문/결제 상태가 없고 보유한 상세 이력·합산/미확인 증거가 없으면 노란 결제 이력 오류 대신 중립적인 `role=status` 보조 안내를 표시한다. 실제 실패는 `data-code`, `data-stage`, `data-status`로 식별할 수 있다. 조회 실패를 이력 0건으로 확정하거나 집계값을 수정하지 않는다.
4. 관련 영수증을 읽은 뒤에만 실행되는 `lines` 단계가 실패하면, 이전 상세가 없는 경우에도 경고를 유지한다. 보유한 latest/current/previous 결제 이력이나 합산 관계가 있으면 일반 실패도 경고로 유지하고 기존 자료를 보존한다. 실제 수집 장애·결제 불확실성·청소 오류 역시 숨기지 않는다.
5. KO/VI 안내를 조회 단계에 맞게 추가했다. 일반 실패 예시는 KO `상세 정보를 확인하지 못했습니다. 새로고침해 주세요.`, VI `Chưa xác minh được thông tin chi tiết. Hãy làm mới.`이다. 영업 전 헤더와 시계 이모지가 포함된 중앙 문구는 유지한다. 상세 헤더의 기존 새로고침 버튼으로 복구할 수 있다.
6. 기존 증거 기반 상세 조회 key, effect 의존성, 60초 목록 타이머, abort/역순 응답 보호, 보유 상세/DOM 유지, 최신 snapshot을 요구하는 청소 조건은 변경하지 않았다. 새로운 폴링·조회·외부 API·의존 패키지를 추가하지 않았다.

## 8가지 상황 재현 및 결과

| 상황 | 수정 전 | 수정 후 |
| --- | --- | --- |
| 11:53 정상 영업 전, 주문·결제 자료 없음 | 중앙 영업 전 안내 | 동일. 실패가 없으므로 오류 보조 안내/노란 배너 없음 |
| 상세 조회 성공, 이력 0건 | 정상 empty 결과 | 오류 없음. 관련 영수증이 없으므로 메뉴 조회도 실행하지 않음 |
| 일반 상세 503 / timeout | 결제 이력 실패로 일괄 표현 | 영업 전 문구 유지 + 일반 상세 미확인/지연 보조 안내. 0건으로 단정하지 않음 |
| 주문 snapshot 조회 실패 | 결제 이력 실패로 일괄 표현 | `snapshot` 고정 진단과 주문 상태 미확인 안내 |
| 영수증 조회 실패 | 결제 이력 실패로 일괄 표현 | `receipts` 고정 진단과 결제 자료 미확인 안내. 기존 이력이 있으면 경고 유지 |
| 영수증 메뉴 조회 실패 | 결제 이력 실패로 일괄 표현 | `lines` 고정 진단과 결제 메뉴 미확인 경고. 이미 관련 영수증을 읽은 단계이므로 경고를 중립화하지 않음 |
| 검증된 이력 보유 후 후속 실패 | 보유 자료 + 결제 이력 실패 문구 | 보유 유효/취소/재발행/합산 자료와 경고 유지. 일반 실패를 결제 이력 실패로 잘못 특정하지 않음 |
| 영업 중 실제 수집 장애 | 기존 장애 안내 | 기존 목록/상태 진단과 단계별 상세 경고 유지. 영업 전/빈자리/정상 상태로 조작하지 않음 |

서버/API 격리 테스트는 정상 empty·유효 이력, context 예외, snapshot 오류/네트워크 예외, receipts 오류/네트워크 예외, lines 오류, 알 수 없는 예외를 주입했다. 내부 DB/SQL·토큰·사용자 정보를 가정한 문자열이 응답에 포함되지 않음을 확인했다. 실제 서버 조회 수·선택 열·필터·페이지 처리는 바꾸지 않았다.

## 상세 GET 호출 횟수와 기존 최적화 보호

| 조건 | 수정 전 `be39411e` | 수정 후 |
| --- | ---: | ---: |
| 최초 진입 + 60초 × 5회 목록 GET | 6회 | 6회 |
| 같은 구간의 상세 GET, 실질 증거 동일 | 1회 | 1회 |
| 503 후 60초 × 5회, 동일 증거 | 기존 최적화 유지 | 상세 GET 0회 추가 |
| 지연 응답 중 60초 × 5회, 동일 증거 | 기존 최적화 유지 | 상세 GET 0회 추가 |
| 실제 메뉴/주문 증거 변경 | 필요한 재조회 | 상세 GET 1회 추가 |

변경 전/후 bundle을 각각 실제 React 페이지로 실행하고 KO/VI × 320/360/390/430/1280px 10개 조합에서 호출 횟수를 측정했다. 목록/상세 통신은 격리된 테스트 응답만 사용했다. 타임아웃은 테스트에서 AbortSignal.timeout의 시간만 단축하고 실제 fetch 중단 경로를 검증했으며, 제품의 20초 timeout은 변경하지 않았다.

503·지연·역순 상세 응답, NEW 영수증 이후 도착한 OLD 응답 무시, 명시적 새로고침 복구를 확인했다. 메뉴 및 결제 이력 펼침·포커스·dialog 스크롤 유지, 최신 snapshot 미확인 청소 버튼 비활성화, 명시적 새로고침 후 청소 POST 1회 및 idle 전환을 확인했다. 15:59 → 16:00, 17:30, 00:59 → 01:00, 02:59 → 03:00 전환도 기존 목록 타이머로 반영됐다.

## 검증 결과

- 관련 회귀: **217건, 214 PASS / 0 FAIL / 3 SKIP**. tables 전체 및 store-settings business-time/adapter, admin-sales-business-time, pos-business-day-source 포함.
- 마지막 메뉴 단계 경고 조건 보강 후 영향을 받는 API/상세/UI **49건을 다시 실행해 49 PASS / 0 FAIL / 0 SKIP**. 변경되지 않은 검증 범위는 기존 PASS를 재사용했다.
- SKIP 3건은 기존 `QA_POSTGRES_BIN` 미설정에 따른 native PostgreSQL 자동 관찰·청소 동시성·P0 안전성 테스트다. 기존 PGlite 기반 DB·청소·결제·취소/재발행/합산·30분 전환 회귀는 실행하여 통과했다.
- 브라우저: KO/VI 320/360/390/430/1280px에서 정상 empty, 일반 503, context/snapshot/receipts/lines 단계, 실제 timeout, invalid JSON, 보유/미확인 이력, 정상 복구, 실패 상태 5회 목록 갱신, 실제 영업 중 장애 확인 PASS. 모바일은 touch 입력을 사용했다.
- 가로 overflow 없음 및 기존 중앙 정렬 확인. KO 1280px·VI 320px의 503 보조 안내를 캡처로 육안 확인했다.
- TypeScript `npx.cmd tsc --noEmit --incremental false` PASS.
- ESLint 변경 TS/TSX/MJS 7개 파일 명시 검사 PASS. 전체 저장소 lint PASS를 주장하지 않는다.
- Production Build: `.local/tables-detail-error-guidance/full-build`의 현재 소스 복제본에서 실제 .env/운영 자격 증명 없이 fake build 전용 설정으로 `next build --webpack`, child exit 0. 배포 없음.
- `git diff --check` PASS. 보고서 UTF-8 strict decode, 한글 주요 문구 및 U+FFFD 없음 검사 PASS.

검증 스크립트·로그·브라우저 호출 실측 JSON·캡처는 `C:\workspace\baba-wt-codex\.local\tables-detail-error-guidance\`에 보관하며 Git에서 제외한다. 실서비스에 직접 요청하여 장애 원인을 확정한 결과는 아니다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\app\api\tables\[id]\detail\route.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail-refresh.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail-server.ts`
- `C:\workspace\baba-wt-codex\lib\text\tables.ts`
- `C:\workspace\baba-wt-codex\tests\tables-detail.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-detail-error-guidance-20261117.md`
