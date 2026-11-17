# POS 주문 수집 17:00 허용 및 테이블현황 공통 판정

## 작업 기준과 경계

- 지정 Worktree: `C:\workspace\baba-wt-codex`.
- 브랜치: `codex/pos-sync-1700-tables-stability-20261117`.
- 시작 당시 로컬/원격 main은 모두 `9b47db20a792d04b22af9217f6bad4b97a70cb4e`였다. 제공된 `5dc6b1fa` 이후 추가된 급여 RPC 정리 보호 커밋을 포함한 최신 main에서 새 브랜치를 만들었다.
- main·Codex·Claude Worktree 및 기존 브랜치를 확인했다. 시작 main/Codex에는 미커밋 변경이 없었으며 기존 Worktree 커밋과 병행 급여 작업을 보존했다.
- 완료 범위: 구현·격리 테스트·검증·Worktree 로컬 커밋. main 병합·Push·배포·운영 DB 변경·Migration 적용·Vercel Cron 설정·실제 환경변수/.env 변경 없음.

## 최종 원인

1. 내부 주문 수집 허용 시작이 17:30이라 기존 Vercel 17:02/17:07/17:12/17:17/17:22/17:27 호출을 건너뛰었다. 실제 첫 허용 스케줄은 17:32였다.
2. 일반 목록·청소 활성 목록·상세 조회가 각각 `isOpen && evaluateOpenOrdersCronWindow(now).allowed`를 전달했다. 매장 폐점 01:00과 중앙 수집 종료를 혼동해 폐점 후 구간까지 수집 미필요로 판정할 수 있었다.
3. builder의 `waiting`은 수집 비예상 시간에 기존 성공 유무/노후 상태와 무관하게 활성화될 수 있었다. UI는 별도로 `beforeOpening`, unknown 개수, snapshot 상태 등을 조합해 다른 정상 대기 조건을 만들었다.
4. 첫 성공 전 유예·첫 수집 지연·최근 실패·10분 초과·읽기 실패·주문/결제 증거 불일치를 일관되게 구분하지 못했다.

## 변경 내용

- 순수 Cron 정책의 내부 허용 시작만 **17:00**으로 변경했다. 기존 스케줄 `2-57/5 10-19 * * *`는 변경하지 않았다. 첫 허용 예정 실행 **17:02**, 마지막 **02:52**, 5분 간격, 02:54:59 마지막 진입 허용, 02:55 이후 skip을 검사했다. 허용 예정 호출은 113회에서 119회로 6회 늘어나는 로컬 코드 변경이며 운영에는 적용하지 않았다.
- 기존 150초 실행 예산·180초 Lease·route maxDuration 180과 기존 실패 기록/호출 보호를 유지했다. Cron route 수정은 설명 주석뿐이다. 결제 동기화 17:00~01:55와 03:00 최종 동기화 경로 및 `vercel.json`은 기준 SHA와 byte/text 비교로 미변경을 확인했다.
- 공통 `table-collection-policy.ts`가 기존 매장 운영시간 snapshot, 지정 영업일, 고정 중앙 수집시간을 분리한다. 일반/청소/상세 경로는 같은 `buildTableOverview` 판정을 사용하고 `collectionExpected` 중복 인자를 제거했다. 운영시간 설정을 추가로 조회하지 않는다.
- 기존 응답 필드·snapshotStatus 값 집합·nullable 집계 계약을 보존하고 표시용 `collection` metadata를 추가했다. phase는 영업 전 / 접수 전 / 첫 실행 전 / 첫 실행 진행 / 수집 구간 / 수집 구간 밖을, health는 정상 대기·검증 정상·무성공 지연·최근 수집 실패·읽기 실패·노후·증거 불일치·미확인·비활성화를 구분한다. 상세 응답과 청소 decorate 결과에도 같은 metadata를 전달한다.
- UI `normalWaiting`은 중복 시간 판정을 없애고 서버의 검증된 대기 판정을 사용한다. 16시대 중앙 KO `주문 접수 전입니다.` / VI `Chưa đến giờ nhận đơn.`을 시계 이모지와 표시한다. 17:00~17:02는 첫 수집 대기, 17:02~17:07은 수집 진행 대기를 표시한다.
- 첫 성공 전 열린 매장의 테이블은 **unknown**이고 사용 중/완료 집계는 **null**이다. 대기 안내는 빈자리 또는 주문 0건의 확정이 아니다. 첫 정상 성공 후에만 기존 검증된 상태/집계를 표시한다. 10분 정확히는 기존대로 허용하고 10분을 넘으면 stale로 구분한다.
- 정상 유예는 당일 첫 성공이 없고 명시적 실패·읽기 오류·현재 주문/결제 증거·테이블명 충돌 등이 없는 경우만 허용한다. 17:07부터 무성공 지연 경고를 표시한다. 명시적 실패·실제 읽기 실패는 유예와 무관하게 즉시 경고하고, 상세 모달에서도 정상 수집 안내로 덮지 않는다. 영업 전 기존 단순 조회 실패의 내부 진단/중앙 안내 정책은 유지했다.
- 01:00 이후에도 실제 Cron 시간으로 판단한다. 02:55 진입 제한 후에도 이미 검증된 잔여 주문·결제·청소 증거는 기존 신선도 범위에서 유지한다. 새 영업일은 이전 sync/주문을 현재 상태로 인증하지 않는다. 읽기 도중 03:00을 넘어 선택한 영업일과 서버 시간이 달라진 요청도 fail closed 처리한다.
- 일반 조회에서 영수증 읽기가 실패해도 이미 검증된 형식의 주문 자료는 미검증 이력으로 보존한다. green/paid 또는 현재 집계로 인증하지 않으며 청소 근거로도 사용하지 않는다. 기존 상세의 검증된 영수증/결제 이력 유지 로직을 보존했다.
- 상세 증거별 갱신 key, 목록 60초 타이머, 새로고침/모달 방식, 메뉴 펼침/스크롤/포커스, 최신 snapshot을 요구하는 청소 조건과 서버/DB 검증은 변경하지 않았다.

## 경계별 첫 성공 이전 결과

| 현지 시각 | 중앙 진입 허용 | 표시/판정 |
| --- | --- | --- |
| 16:00 / 16:59 | 아니오 | 주문 접수 전, unknown/null |
| 17:00 | 예 | 17:02 첫 실행 대기, unknown/null |
| 17:02 / 17:06 / 17:06:59.999 | 예 | 정상 수집 진행 대기, unknown/null |
| 17:07 | 예 | 첫 성공 없으면 지연 경고 |
| 01:00 / 02:52 / 02:54:59 | 예 | 영업 종료와 독립적으로 수집 판단, 정상 성공 자료/잔여 주문 유지 |
| 02:55 | 아니오 | 신규 수집 진입 금지, 기존 검증 자료는 신선도/영업일 기준으로 유지 |
| 03:00 | 아니오 | 새 영업일. 이전 영업일 자료를 현재 상태로 사용하지 않음 |

명시적 오류는 위 유예 전체에 우선한다. 휴무일도 중앙 수집 시작 전에 무성공 지연 경고를 만들지 않음을 별도 검사했다. 실제 주문·결제 자료가 있으면 정상 대기 문구로 감추지 않는다.

## 검증 결과

- 확장 회귀 **376건: 372 PASS / 0 FAIL / 4 SKIP**. tables, 중앙 주문 Core/Cron/DB/합산/복구/소실 진단, 운영시간 adapter, 매출 영업일, 결제 Cron 최종 경계 검사 포함.
- 휴무일 및 테이블명 충돌 보강 후 최종 영향 범위 정책/UI **53 PASS / 0 FAIL / 0 SKIP**. 동일 동작의 유효한 나머지 PASS는 재사용했다.
- SKIP 4건: `QA_POSTGRES_BIN` 미설정에 따른 기존 native PostgreSQL 합산 근거·자동 관찰·청소 동시성·청소 P0 검사. 실행하지 않은 native 검사는 PASS로 처리하지 않는다. PGlite 기반 관련 DB·결제·청소 회귀는 실행했다.
- 일반/청소 활성 실제 service 함수에 같은 격리 응답을 넣어 **11개 시간 × 6개 상태 = 66개 조합**의 health·snapshot·타일·집계 일치를 확인했다. 내부 영수증 version 표현 차이는 표시 증거 비교에서 제외하고 실제 상태/계약을 비교했다. 정상 empty/성공/최근 실패/진행 주문/유효 결제/읽기 실패를 포함한다.
- 첫 성공 없음, 첫 성공 전 명시적 실패, 지연, 정상 갱신, 10분 정확히/초과, 미래 timestamp, 읽기 실패, 주문/영수증 충돌, 중복 테이블명, 폐점 후 잔여 주문, 새 영업일 및 요청 중 03:00 교차, `N+` 부분 집계를 확인했다.
- KO/VI × 320/360/390/430/1280px에서 **110개 시간/모달 사례 PASS**. 정상 대기 중 경고 없음, 17:07 지연, 503·실제 AbortSignal timeout 경로 즉시 경고, 영업 종료 후 occupied, 실제 읽기/결제 충돌, `1+` 표시와 가로 넘침 없음을 확인했다. 브라우저 시간대는 America/Los_Angeles로 두었다.
- 실제 React bundle과 격리된 `/api/tables`/상세 응답으로 목록 GET 6회 / 동일 증거 상세 GET 1회를 확인했다. 첫 정상 주문에 상세 GET 1회 추가, 동일 주문의 collection timestamp만 갱신될 때 추가 GET 없음, 메뉴 펼침·포커스·스크롤 유지, snapshot이 새로워졌으나 상세 증거가 낡으면 청소 비활성화를 확인했다.
- 첫 성공 전 0건을 발행하지 않는 반면, 검증 성공한 empty snapshot의 기존 정상 0건 집계는 유지한다. 결제·이력·취소·재발행·합산·청소·30분 자동 일반 전환의 기존 회귀를 통과했다.
- TypeScript `tsc --noEmit --incremental false` PASS. 변경 TS/TSX/MJS 18개 파일 ESLint PASS. 전체 저장소 lint/Production Build PASS는 주장하지 않는다.
- `git diff --check`, 보고서 UTF-8 한글 검사 PASS. 환경 파일/운영 설정/수집 transport 및 budget·lease 핵심 소스 미변경 확인.

모든 테스트는 격리된 응답·mock transport·로컬 DB fixture만 사용했다. 운영 CUKCUK/Supabase 자격 증명은 제공하지 않았고 실제 운영 Cron/API/DB를 실행하지 않았다. 로그·스크립트·브라우저 캡처·측정 JSON은 `C:\workspace\baba-wt-codex\.local\pos-sync-1700\`에 보관한다.

## 미해결 및 운영 적용 전 확인사항

로컬 구현에서 미해결 실패는 없다. native PostgreSQL 검사 4건은 환경 조건상 미실행이다. 실제 Production 동작은 검증하지 않았으며 코드만 로컬 커밋했다.

Owner의 별도 통합/배포 승인 후 기존 Cron 설정과 환경변수를 유지한 상태에서 17:02 첫 호출의 성공 기록, 17:07 무성공/실패 표시, 01:00 이후 잔여 주문·청소, 02:52 마지막 정상 호출 및 03:00 전환을 운영 로그로 확인해야 한다. 이전보다 6회 늘어나는 허용 호출의 17시대 실행 시간/Lease 및 provider 오류 기록도 확인한다. 이 보고서는 운영 적용 승인을 대신하지 않는다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\lib\pos\cukcuk\open-orders-cron-policy.ts`
- `C:\workspace\baba-wt-codex\app\api\cron\pos-open-orders-sync\route.ts` (주석)
- `C:\workspace\baba-wt-codex\lib\sales\table-collection-policy.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-overview.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-overview-server.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-cleaning-server.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail-server.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail-refresh.ts`
- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\lib\text\tables.ts`
- `C:\workspace\baba-wt-codex\tests\tables-collection-policy.test.mjs`
- `C:\workspace\baba-wt-codex\tests\pos-open-orders-cron-route.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\tests\helpers\tables-before-opening-fixture.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-detail.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-paid-transition.test.mjs`
- `C:\workspace\baba-wt-codex\tests\pos-open-orders-merge-db.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\pos-sync-1700-tables-stability-20261117.md`
