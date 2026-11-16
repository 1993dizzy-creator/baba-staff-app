# /tables 결제완료 최초 관측 기반 자동 일반 전환

판정: **로컬 개발 GO / 운영 적용·활성화는 별도 승인 전 NO-GO**.

기준 로컬 main `384e1ae6d1831775742d220b791b6a5cc3970772`, 작업 브랜치 `codex/tables-auto-normal-20261116`. 구현·격리 DB 검증·Codex Worktree 커밋까지의 산출물이다. main 통합, Push, 배포, 운영 DB 조회/변경, Migration 적용, 기능 활성화, CUKCUK 호출을 하지 않았다.

## 정식 Migration과 해시

- 신규 정식 파일: `C:\workspace\baba-wt-codex\supabase\migrations\20261116095122_tables_auto_normal_v1.sql`
- Supabase CLI **3.1.0**의 `migration new tables_auto_normal_v1`로 생성했다.
- UTF-8 파일 SHA-256: **`8c7e1e4974e7a5440c4507d2e46c276373e681885f9512d847dbde4828a50ee8`**. 현재 LF 원문과 CRLF→LF 정규화 해시는 같다. Git에서 체크아웃한 파일을 비교할 때는 줄바꿈을 LF로 정규화한다.
- 기존 운영 적용 완료 `20261115103656_tables_cleaning_v1.sql`은 수정·재적용하지 않았다. 기준 main과 파일 diff가 없으며 기존 정규화 SHA-256 `8222d4db4c0a470391f54de59c760fda68e9909782271d070f0752a7b862e931`을 유지한다.
- 승인 후 main에 통합할 정식 위치: `C:\workspace\baba-staff-app\supabase\migrations\20261116095122_tables_auto_normal_v1.sql`. 현재 이 경로에 복사하거나 main을 수정하지 않았다.

## 최초 관측 저장 경로

`/api/cron/pos-open-orders-sync`의 기존 수집·DB commit 성공 → `next/server`의 `after(observeVerifiedPayments)` 등록 → 응답 완료 후 별도 서버 관측 → `tables_auto_context_v1` 읽기 → 기존 `buildTableOverview` 전체 판정에서 paid인 테이블과 독립 DB 증거가 일치하는 대상만 `tables_observe_payments_v1` 호출 → `table_operations_private.payment_observations`에 INSERT한다.

[Next.js after 공식 계약](https://nextjs.org/docs/app/api-reference/functions/after)에 따라 관측은 응답 후 실행한다. 수집 commit 트랜잭션에 관측 INSERT를 붙이지 않았다. 등록 실패와 실행 실패는 고정 진단만 남기고 이미 완료된 수집 결과를 바꾸지 않는다. busy/fresh/disabled/outside-hours/failed 수집에는 새 관측을 등록하지 않는다. 실패한 관측은 다음 성공 수집에서 재시도한다.

- 저장 시각은 DB `clock_timestamp()` 기본값이다. 클라이언트 시각이나 영수증 `ref_date`·`status_changed_at`·`synced_at`을 시작시각으로 받지 않는다. 영수증 시각은 기존 영업일·연결 검증에만 사용한다.
- 식별은 scope, 영업일, 실제 테이블 UUID, 영수증 ID, 업무 fingerprint, 주문 세대, 자동 기능 세대이다. UNIQUE와 `ON CONFLICT DO NOTHING`으로 같은 증거의 중복 실행은 최초 시각을 바꾸지 않는다.
- 관측 RPC는 scope advisory → receipts SHARE → lines SHARE → 자동 config FOR SHARE 순서로 재검증한다. 전달된 중앙 스냅샷·영수증 proof의 완전 일치와 DB의 최신 적격 증거를 다시 확인한다. lock_timeout은 각 경합에 150ms이며 앱 관측 RPC 요청 timeout은 2초다.
- `first_verified_at`과 수동 `cleaning_events`는 별도 테이블이다. 자동 일반 전환은 cleaning 이벤트, 직원 ID, 영수증·주문·매출 원장 변경을 생성하지 않는다.
- 신규 auto AFTER hook 3개가 주문 세대 및 영수증·메뉴 변경의 무효화 증거만 추가한다. 반복 메타데이터 갱신과 동일 주문의 수집 재삽입은 시각을 바꾸지 않는다. 금액·취소·재발행·메뉴 변경 후 원상복구, 영수증의 영업일·지점·source 이동 후 복원도 이전 관측을 되살리지 않는다. 최신 결제가 취소되면 이전 영수증 타이머로 되돌아가지 않는다.
- 일반 `/api/tables`와 상세 GET에는 INSERT가 없다. STABLE MVCC 읽기이며 POS SHARE/row/advisory 잠금을 보유하지 않는다. 유효 시각과 만료 여부는 DB의 같은 statement snapshot에서 읽는다.

## 화면과 우선순위

유효 관측이 있으면 `first_verified_at + 30분` 미만은 파란 완료, 정확히 30분부터 일반이다. 실제 화면은 기존 60초 조회의 다음 성공 응답에서 갱신된다. 따라서 DB의 정확한 만료 경계와 화면 갱신 사이에는 정상적으로 최대 한 조회 간격이 있을 수 있다.

현재 유효 진행 주문은 사용 중, 불확실한 수집/연결은 미확인 보호를 우선한다. 기존 수동 청소완료가 유효하면 즉시 일반이며 자동 만료가 수동 기록을 덮어쓰지 않는다. 일반은 실제 공실 확정이 아니다.

30분 전 수동 버튼을 유지하고 자동 일반 전환 뒤에는 숨긴다. 상세창에는 최초 확인 시각·일반 전환 예정시각 또는 `30분 경과 · 일반 전환`을 KO/VI로 표시한다. 기존 결제 이력, 27개 테이블 identity·배치·상태 색상은 유지한다. 상세 API의 `timer.enabled=true`는 저장된 서버 관측이 있는 경우에만 제공하며, 영수증 시각으로 deadline을 만들지 않는다.

설치 이전 결제도 활성화 후 첫 관측 INSERT 시각부터 시작한다. 이전 영업일에는 생성하지 않는다. 관측을 저장하지 못한 경우 과거 시각을 추정하거나 자동 일반 상태를 만들지 않고 기존 결제 증거 표시를 유지한다. 다음 성공 관측이 실제 타이머 시작이다.

## 독립 스위치와 재활성화 계약

- 기존 수동 앱 스위치: `BABA_TABLE_CLEANING_ENABLED` (유지).
- 신규 자동 앱 스위치: `BABA_TABLE_AUTO_NORMAL_ENABLED=true`.
- 신규 자동 앱 활성화 키: `BABA_TABLE_AUTO_NORMAL_ACTIVATION=<DB가 발급한 UUID>`.
- 기존 `POS_OPEN_ORDERS_READ_ENABLED=true` 조건을 유지한다. 자동 config는 별도 `table_operations_private.auto_config`이며 기본 **OFF**이다. 설치가 수동 config의 ON 상태를 바꾸지 않는다.
- 자동 기능은 수동 앱/DB 스위치 OFF에서도 작동할 수 있다. 수동 세대 변경은 자동 timer의 identity를 바꾸지 않는다. 자동 기능 비활성/오류/활성화 키 불일치 시 기존 수동 context RPC로 복귀한다.
- **자동 앱 OFF→ON은 stop.sql → start.sql → 새 활성화 키 배포 순서로 수행한다. 앱 boolean만 OFF 후 동일 키로 다시 ON하는 방식은 재활성화 절차가 아니다.** DB는 환경변수의 과거 변경을 알 수 없으므로 이 키 교체 절차가 앱 재활성화 경계이다. 자동 DB OFF/ON 및 config 재생성은 sequence 세대와 UUID를 새로 발급한다. 이전 키의 앱은 오래된 timer를 읽거나 새 관측을 저장할 수 없다.
- auto hook 중 하나라도 비활성화되어 있으면 자동 context는 비활성으로 응답한다. 수동 hook/함수는 대체하거나 수정하지 않았다.

## 검증 결과

| 범위 | 결과 / 근거 |
|---|---|
| Node/PGlite·인증/API·POS 수집·매출 KPI·재고 장부 projection·전표·테이블 회귀 | 최종 유효 증거 조합 **366 PASS**, 미해결 실패 0. 원래 묶음 363 PASS에 아래 legacy 비교 2개와 추가 메뉴 무효화 1개를 반영. 변경 영향 범위의 재검증은 교체 사용하며 중복 가산하지 않음 |
| 최종 정식 Migration + 자동 DB/서버 통합 | **25/25 PASS**, `auto-final.log` |
| Native PostgreSQL 17.6 Windows x64, 최종 신규 Migration | **12/12 PASS**, `native-auto-final.log` |
| 기존 수동 청소완료 Native 동시성·P0 안전성 | **20/20 PASS**, `native-final.log`의 수동 6 + P0 14. 자동 부분의 이전 12개 결과는 최종 12개로 교체 |
| 최종 상세 API·수동 서버 영향 검사 | **19/19 PASS**, `detail-final.log` (위 회귀와 중복되는 증거) |
| KO/VI × 320/390/1280px 실제 TSX/CSS 브라우저 | **6/6 PASS**, `browser-final.log`, `browser-results.json`, 상태 전후 PNG |
| TypeScript noEmit, 변경 TS/TSX/MJS ESLint `--max-warnings 0`, git diff check | PASS |

전체 Next production Build는 실행하지 않았다. 실제 사용자 운영 트래픽·운영 PostgreSQL·배포 환경 E2E는 미검증이다. 테스트에 운영 자격 증명이나 실제 CUKCUK를 제공하지 않았다.

`regression.log`에서 기존 extensionless import 테스트 1개가 Node strip-types의 모듈 해석 단계에서 실행되지 않았다. 원본 테스트를 수정하지 않고 Worktree `.local`의 TypeScript CommonJS 변환으로 해당 2개를 실행하여 `sync-compare.log`의 **2/2 PASS**로 해소했다. 실행되지 않은 최초 결과를 PASS로 세지 않았다.

필수 시나리오 대응:

1. DB 29:59/30:00/30:01과 실제 서버 투영 판정.
2. 최초 INSERT 1회, 동시 관측·재시도·중복 실행.
3. 반복 메타데이터 수집·동일 주문 재삽입 시 최초 시각 불변.
4. 수동 청소완료와 관측 동시 실행, 자동 만료가 수동 이벤트를 만들지 않음.
5. 새 유효 진행 주문은 expired/manual 상태보다 우선.
6. 새 영수증만 새로운 주기, 최신 취소 시 이전 timer 복귀 금지.
7. 취소·재발행·금액·메뉴 수정/복원, 영업일·지점·source 이동/복원.
8. #8885의 BAR8/BAR9/BAR11·영수증 테이블 2 모두 자동 적격 판정 차단.
9. 수집 오류·10분 초과 지연·미래시각·collecting lease·중복 연결·읽기-쓰기 사이 변경 거부.
10. 03:00 영업일 전환과 이전 영업일 관측 거부.
11. 자동 DB OFF/ON·config 재생성·이전 activation key 거부, 수동 OFF 독립성.
12. 실제 PostgreSQL 중복/쓰기/config 경합·RLS·anon/authenticated 차단·service INVOKER·직접 데이터 접근 차단. 설치 전후 기존 함수 정의 hash 불변.
13. KO/VI 모바일/PC, 60초 폴링 후 버튼 숨김·이력 유지·실제 수동 저장·27개 identity·가로 넘침 없음.

증거는 `C:\workspace\baba-wt-codex\.local\tables-auto-normal\`에 보관한다. 임시 native DB는 기존 소유권 검증 cleanup 절차로 정리했고 서버 로그·메트릭은 보존했다.

## 기존 수집기 영향과 한계

기존 수집기 core/commit·CUKCUK 전송·매출/KPI·재고·장부 코드를 수정하지 않았다. 변경은 Cron route의 성공 후 작업 등록과 별도 DB 관측·무효화 객체이다. 추가 CUKCUK 호출·Cron은 없다. 기존 함수 정의는 격리 DB 설치 전후 모두 동일했다.

최종 Native 합성 계측: 500개 영수증 / 2,500개 라인 관측 RPC 약 **362.4ms**, GET 트랜잭션을 열어 둔 상태의 POS 메타데이터 writer 약 **4.4ms**, 잠금 경합 관측 실패 약 **154~168ms**, 감사 테이블을 막은 상태의 ON 메타데이터/OFF 쓰기 묶음 약 **6.7ms**, 교착 0건.

응답 후 작업은 수집 응답·commit 실패와 독립적이지만, 관측 저장 중에는 짧은 POS SHARE/advisory 잠금과 CPU/IO 비용이 있다. 새 auto 무효화 hook도 유의미한 POS 변경 트랜잭션 안에서 실행된다. 이를 운영에서 비용 0 또는 절대 무지연이라고 보장하지 않는다. OFF fast path는 config 조회 뒤 감사 테이블/해시 작업 없이 반환한다. 장기 데이터 규모와 운영 부하/P99는 미검증이므로 별도 승인 후 적용·Postflight·관찰이 필요하다. PostgreSQL 함수의 statement_timeout 설정을 실행시간의 절대 상한으로 주장하지 않으며, 실제 경합 제한과 앱 요청 timeout을 구분한다.

## 운영 적용·중지·복구 게이트

1. 이 보고서와 최종 SHA를 기준으로 main 통합/Push/앱 배포 승인을 별도 받는다. 자동 앱 스위치는 OFF/키 미설정으로 배포 가능하다. 기존 수동 스위치와 POS/KPI/재고/장부 스위치는 유지한다.
2. 운영 DB 변경 승인은 별도로 받는다. 대상은 신규 auto config/sequence/관측/무효화 테이블, 신규 private/public 함수, auto AFTER hook 3개이며 기존 업무 데이터 DML은 없다. 기존 P0 Migration을 재실행하거나 Repair하지 않는다.
3. 적용 직전 `tables-auto-normal-v1-preflight.sql`을 읽기 전용 실행한다. 6개 pass가 모두 true이며 기존 Migration 등록·새 객체/이력 부재·수동 ON·index와 SHA 일치를 확인한다. existing_function_hashes를 보존한다. 이력 또는 부분 객체가 있으면 NO-GO, 덮어쓰기·repair 대신 별도 후속 검토이다.
4. 승인된 기존 Migration 절차로 정식 파일과 이력을 한 트랜잭션으로 적용한다. 신규 hook 설치 DDL lock_timeout 5초이며 오류·timeout은 완료가 아니다.
5. 자동 OFF 상태에서 `tables-auto-normal-v1-postflight.sql`의 9개 pass와 Preflight 기존 함수 hash를 비교한다. 신규 함수 key만 증가하며 기존 값은 같아야 한다. 수동 청소완료·수집 정상 여부도 확인한다. 운영에서는 아직 실행하지 않았다.
6. 별도 활성화 승인 후 `tables-auto-normal-v1-start.sql`을 실행한다. 정확히 1행과 새 generation/activation_key가 반환되어야 한다. 반환 키를 앱의 `BABA_TABLE_AUTO_NORMAL_ACTIVATION`에 설정하고 자동 앱 스위치를 ON 한다. 환경변수 변경/배포 승인 범위는 기존 규칙대로 별도 확인한다. 다음 성공 수집 후 최초 관측에서 30분을 시작하며 기존 자료를 역산·일괄 backfill하지 않는다.
7. 일반 중지/앱 롤백: 자동 앱 스위치 OFF → 승인된 `tables-auto-normal-v1-stop.sql`로 자동 DB OFF. 수동 기능은 유지한다. schema·관측·감사·sequence·이력은 삭제하지 않는다.
8. 자동 hook 자체 장애 때만 별도 승인 후 `tables-auto-normal-v1-emergency-disable.sql`을 사용한다. 세 신규 hook만 끄며 수동/중앙수집/재고/장부 hook을 건드리지 않는다. DDL timeout은 중지 성공이 아니다.
9. 원인 해결 후 자동 OFF에서 `tables-auto-normal-v1-recover.sql`과 Postflight를 수행한다. 재활성화는 start로 새 세대/키를 발급하는 6단계를 다시 따른다. 예전 키 재사용 금지.

위 6개 운영 SQL은 최종 정식 Migration으로 구성한 Native 격리 DB에서 실행 검증했다. 이 문서 자체는 운영 실행 승인이 아니다.

## 변경 파일 전체 Windows 경로

```text
C:\workspace\baba-wt-codex\supabase\migrations\20261116095122_tables_auto_normal_v1.sql
C:\workspace\baba-wt-codex\app\api\cron\pos-open-orders-sync\route.ts
C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx
C:\workspace\baba-wt-codex\lib\sales\table-auto-normal.ts
C:\workspace\baba-wt-codex\lib\sales\table-payment-observer-server.ts
C:\workspace\baba-wt-codex\lib\sales\table-cleaning-server.ts
C:\workspace\baba-wt-codex\lib\sales\table-overview-server.ts
C:\workspace\baba-wt-codex\lib\sales\table-overview.ts
C:\workspace\baba-wt-codex\lib\sales\table-detail-server.ts
C:\workspace\baba-wt-codex\lib\sales\table-detail.ts
C:\workspace\baba-wt-codex\lib\text\tables.ts
C:\workspace\baba-wt-codex\tests\tables-auto-normal-db.test.mjs
C:\workspace\baba-wt-codex\tests\tables-auto-normal-native.test.mjs
C:\workspace\baba-wt-codex\tests\tables-auto-normal-server.test.mjs
C:\workspace\baba-wt-codex\tests\helpers\tables-auto-normal-fixture.mjs
C:\workspace\baba-wt-codex\tests\helpers\tables-cleaning-service-fixture.mjs
C:\workspace\baba-wt-codex\tests\pos-open-orders-cron-route.test.mjs
C:\workspace\baba-wt-codex\docs\sql\tables-auto-normal-v1-preflight.sql
C:\workspace\baba-wt-codex\docs\sql\tables-auto-normal-v1-postflight.sql
C:\workspace\baba-wt-codex\docs\sql\tables-auto-normal-v1-start.sql
C:\workspace\baba-wt-codex\docs\sql\tables-auto-normal-v1-stop.sql
C:\workspace\baba-wt-codex\docs\sql\tables-auto-normal-v1-emergency-disable.sql
C:\workspace\baba-wt-codex\docs\sql\tables-auto-normal-v1-recover.sql
C:\workspace\baba-wt-codex\docs\reports\tables-auto-normal-20261116.md
```
