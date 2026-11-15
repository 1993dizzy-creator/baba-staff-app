# 청소완료 Migration P0 운영 안전성 검토

판정: **GO 후보(로컬 검증 기준)**. 운영 적용·활성화 승인은 별도다. 운영 Postflight는 미실행이다. main 통합·Push·배포·운영 DDL/DML·Repair·스위치 변경·CUKCUK 호출은 하지 않았다. 30분 자동 전환은 범위 밖이다.

작업 브랜치 `codex/tables-cleaning-safety-p0-20261115`, 기준 main `cf23f68be3f1b0f06f3ca372139d33fdb0c4c77d`. 앱 배포 상태는 Owner 제공 정보이며 이번 작업에서 앱을 재배포하지 않았다.

## 적용 이력과 정식 산출물

- 운영 읽기 전용 조회: `2026-11-15T11:16:20.628763Z`. 대상 Migration 이력, private schema, RPC 두 개, cleaning 트리거가 모두 없음을 확인했다. 기존 미적용 Migration을 보완했다.
- 운영 Preflight: `2026-11-15 11:33:46.979731+00`, `transaction_read_only=on`, **8/8 PASS**. 이력·객체 충돌 없음, v3 read/commit·필수 컬럼·API 역할·`receipt_id` 선두 비부분 인덱스 존재 확인. 원래 v3 함수 해시도 결과 JSON에 보존했다.
- 실제 적용 직전 다시 확인한다. 그 사이 이력/부분 객체가 생기면 NO-GO이며 기존 파일 덮어쓰기나 Repair 대신 후속 Migration이 필요하다. SQL 자체에도 이력·v3·인덱스 방어 검사가 있다.
- 정식 SQL: `C:\workspace\baba-wt-codex\supabase\migrations\20261115103656_tables_cleaning_v1.sql`.
- UTF-8, CRLF→LF 정규화 SHA-256:
  - 이전: `76bcaa4ba0b40572e4cdf63900427f777e51180d3f9dbce821318d1345bf3a1d`
  - 최종: `8222d4db4c0a470391f54de59c760fda68e9909782271d070f0752a7b862e931`
- 변경 diff: `C:\workspace\baba-wt-codex\.local\tables-cleaning-p0\migration.diff`. 커밋의 해당 SQL diff와 동일하다.

## 위험 3건과 수정

| 위험 | 원인 | 보완 |
|---|---|---|
| P0-A OFF에서도 POS 트리거가 감사 테이블에 접근 | enabled 검사 없이 JSON 생성·조회·INSERT 수행 | 세 AFTER 함수의 첫 실행 분기에서 config만 확인하고 즉시 반환. OFF 구간에는 해시·감사 테이블 접근·INSERT 없음 |
| P0-B 일반 GET이 POS 쓰기/중앙 수집과 경합 | context가 scope advisory와 receipts/lines SHARE를 트랜잭션 종료까지 보유 | private context와 public GET wrapper를 STABLE MVCC 조회로 전환. 조회 경로의 advisory/SHARE/row lock 제거. 기준시각도 statement_timestamp로 고정 |
| P1-C 단순 반복 동기화가 청소를 해제 | 영수증·라인 전체 행 해시와 트리거의 전체 JSON 비교 | business JSON 공통 정규화 함수를 해시·트리거 양쪽에 적용. 관측 메타데이터만 제외하고 중요·미지 필드는 보존 |

DB config에는 독립 sequence 기반 `generation`을 추가했다. INSERT 또는 enabled 경계 전환마다 새 값이 배정되고 evidence key에 포함된다. OFF 동안의 변경을 추적하지 않아도 ON 복귀 시 과거 청소 기록 전체가 만료된다. config 행 재생성도 이전 세대를 재사용하지 않는다. 세대·감사 sequence를 재시작하거나 이력을 삭제하지 않는다.

STABLE 함수의 statement snapshot 근거는 [PostgreSQL 공식 문서](https://www.postgresql.org/docs/current/xfunc-volatility.html)를 확인했다. 쓰기 잠금의 충돌 관계는 [명시적 잠금 문서](https://www.postgresql.org/docs/current/explicit-locking.html)와 실제 다중 세션 검증을 함께 사용했다.

OFF→ON 후 실제 청소를 다시 확인해야 하는 테이블이 생길 수 있다. 과거 청소를 잘못 재사용하는 대신 새 확인을 요구하는 보수적 정책이다. 앱 스위치만 OFF이고 DB는 ON이면 DB 무효화는 계속 작동한다.

## 해시 필드 기준

- 영수증에서 제외: `synced_at`, `updated_at`, `status_changed_at`. 마지막 항목은 실제 결제시각이 아닌 관측 메타데이터다. 원본 컬럼은 수정하지 않으며 이력 API는 계속 읽을 수 있다. cleaning optimistic proof의 해당 관측 필드만 null로 고정한다.
- 라인에서 제외: DB 대체키 `id`, `synced_at`, `updated_at`. source detail/parent/item ID는 유지한다. business JSON 정렬로 DB 라인 순서·대체키 변화에 의한 불필요한 해시 변화를 피하고 중복 라인은 보존한다.
- raw JSON에서 재귀적으로 제외: 기존 `sales-receipt-sync-compare.ts`와 같은 다섯 종류 `ModifiedDate`, `ModifiedDateUTC`, `UpdatedDate`, `LastModifiedDate`, `LastUpdatedDate`(대소문자·공백·밑줄·하이픈 정규화).
- 보존: payment_status, is_canceled, receipt id/ref no, OrderId, TableName, branch/source, 영업일, RefDate, 결제·총액·세금·할인·수령/반환금액, 메뉴·수량·단가·금액·옵션·source ID 및 raw 합산결제 배열. 미지 필드도 삭제하지 않는다.
- unknown 업무 필드/고객 정보 변경, source detail 재발행·실제 DELETE/INSERT는 보수적으로 무효화될 수 있다. 일반적인 동일 내용 UPDATE와 관측 메타데이터 갱신은 무효화하지 않는다.

## 쓰기 원자성과 보안 감사

- confirm은 여전히 scope advisory → receipts SHARE → lines SHARE 순서로 phantom/수정/신규 주문을 차단하고 최신 snapshot·receipt proof·직원·영업일·키를 재검사한다. 단순 잠금 삭제가 아니다.
- OFF 요청은 이 공유 잠금 이전에 거부한다. ON 저장은 private config 행 FOR SHARE로 OFF 전환과 직렬화한다. 저장보다 먼저/나중에 시작한 영수증·라인·수집기·config 변경을 모두 다중 세션으로 검증했다.
- 각 잠금의 lock_timeout은 3초다. 실제 경합에서 SQLSTATE `55P03`, 저장 0건, 잠금 해제 후 재시도 성공을 확인했다. 기존 앱 코드에서 503/실패 안내로 처리되며 성공을 흉내 내지 않는다. 전체 작업 시간이 항상 3초라는 뜻은 아니다.
- private DEFINER entry/trigger와 public INVOKER wrapper 구조, 빈 search_path, RLS 및 service_role 전용 RPC 유지. API 역할의 직접 테이블/sequence 접근과 PUBLIC/anon/authenticated EXECUTE 차단을 Postflight로 검사했다.
- 직원 신원은 서버의 서명 세션·실시간 직원 조회가 정한다. 클라이언트 직원 ID는 사용하지 않는다. service_role은 신뢰하는 서버 경계이며 비밀키를 가진 임의 호출자를 DB 세션 직원으로 인증하는 구조는 아니다.
- 신규 주문, 취소·재발행·새 결제, 기존 영수증 변경 후 복구, 메뉴 변경 후 복구가 과거 청소를 되살리지 않는다. 두 직원의 동시 요청은 기록 1건이며 위조/미존재 직원·테이블·영수증·다른 직원 request 재사용도 거부한다.
- BAR8/BAR9/BAR11·#8885 증거는 기존 v3와 raw 업무 증거를 보존하며 합산 관계를 물리적 청소 적격성으로 해석하지 않는다. 03:00 경계와 실제 27개 UUID/name/branch 카탈로그 해시를 검증했다.
- 기존 v3 함수 원문 해시와 비어 있지 않은 합성 영수증/라인 데이터 해시가 Migration 적용 전후 동일했다. 매출 KPI·재고·장부 코드/데이터를 변경하는 SQL은 추가하지 않았다.

## RED → GREEN 및 성능

PostgreSQL **17.6, Windows x64**, loopback 격리 DB. 생산 자격 증명을 테스트에 제공하지 않았다.

- 수정 전: 신규 핵심 5개 시나리오 모두 RED(부모 포함 TAP 6 실패). OFF 감사 테이블 잠금으로 POS timeout, GET SHARE 경합, 메타데이터 해시 변화, OFF→ON 키 재사용을 재현했다.
- 수정 후: 신규 Native 13개 + 기존 Native 5개 시나리오 PASS(부모 포함 TAP **20/20**). Node/PGlite/인증·API·기존 테이블 회귀 **90/90**, TypeScript noEmit, 변경 테스트 ESLint `--max-warnings 0`, diff check PASS.
- 감사 테이블을 ACCESS EXCLUSIVE로 잠근 상태에서 OFF POS 쓰기 묶음 약 **8.8ms**. ON 메타데이터 쓰기도 감사 테이블 접근 없이 통과했다.
- GET 트랜잭션을 유지한 상태의 POS 쓰기·수집기 advisory 획득 묶음 약 **5.1ms**. 미커밋 POS 쓰기 중 GET 약 **8.8ms**.
- 메타데이터 UPDATE 200회 약 **22.4ms**, 청소 상태 유지.
- POST 경합 timeout 약 **3008ms**, 저장 없음.
- 500개 영수증 / 2,496개 라인, GET 5회 **357~370ms**, 동시 writer 약 **3.7ms**, 교착 0건. 이는 제한된 합성 부하이며 운영 P99/SLA 검증이 아니다.

증거: Worktree `.local\tables-cleaning-p0\`의 `red.log`, `green-full20.log`, `green-final.log`, `node-tests.log`, `green-metrics.json`, `manifest.json`, `migration.diff`. Native 로그는 같은 폴더의 `.qa-review\pg-native-logs\`에 남기고 소유권 검증된 격리 DB 데이터만 정리했다. 운영 읽기 증거는 [별도 JSON](tables-cleaning-p0-preflight-20261115.json)에 추적 보관했다.

## Owner 적용·중지·복구 순서

1. 앱 `BABA_TABLE_CLEANING_ENABLED` OFF, 운영 DB 대상 및 미적용 상태를 다시 확인하고 [Preflight](../sql/tables-cleaning-v1-preflight.sql)를 읽기 전용 실행한다. 8개 모두 true와 이 SQL SHA 일치가 조건이다. 충돌/이력이 있으면 중단하고 후속 Migration을 검토한다.
2. 별도 승인 후 기존 정식 Migration 절차로 적용·이력 등록한다. 파일은 한 트랜잭션이며 DDL lock_timeout 5초다. 기존 POS 테이블에 AFTER hook 설치 시 DDL 잠금이 필요하므로 운영 혼잡도를 고려한다. timeout/오류는 롤백이며 완료로 보고하지 않는다.
3. 앱·DB OFF 상태에서 [Postflight](../sql/tables-cleaning-v1-postflight.sql) 13개 검사와 `v3_function_hashes`의 적용 전 값 비교를 수행한다. Postflight는 격리 DB에서 검증했으며 운영에서는 아직 실행하지 않았다.
4. 별도 기능 활성화 승인 후 DB enabled=true(새 generation), 그 다음 앱 스위치를 ON 한다. `POS_OPEN_ORDERS_READ_ENABLED`, Cron, 매출/재고/장부 스위치는 변경하지 않는다.
5. 일반 중지: 앱 전용 스위치 OFF → [stop.sql](../sql/tables-cleaning-v1-stop.sql)로 DB OFF. config 잠금 경합 시 3초 timeout이므로 결과를 확인한다. POS/중앙 수집은 계속한다.
6. OFF fast path 자체 장애 때만 별도 승인된 [emergency-disable.sql](../sql/tables-cleaning-v1-emergency-disable.sql)로 청소 AFTER hook 3개만 중지한다. ALL 트리거나 v3/재고/장부 hook을 끄지 않는다. DDL timeout은 중지 성공이 아니다.
7. 원인 해결 후 OFF 상태에서 [recover.sql](../sql/tables-cleaning-v1-recover.sql)로 해당 hook을 복원하고 Postflight를 수행한다. 감사 기록·generation sequence·Migration 이력은 보존한다. 재활성화는 4단계와 같은 별도 승인이다.

이 중지·비상 중지·복구 SQL은 격리 Native DB에서 실행 검증했으며 운영에서는 실행하지 않았다.

## 남은 운영 경계

- 읽기에도 일반 AccessShare/catalog 잠금과 CPU/IO 비용은 남는다. DDL AccessExclusive와는 경합할 수 있다. OFF 경로도 config 조회 한 번은 필요하다.
- 저장 임계 구간의 SHARE 잠금은 phantom 보호상 유지되며 잠시 POS 쓰기를 기다리게 할 수 있다. POS가 먼저 쓰는 중이면 확인 저장이 실패할 수 있고 UI는 재시도를 요구한다.
- 대형 raw JSON·장기 데이터 규모와 실제 운영 트래픽의 지연은 격리 합성 부하 수치만으로 보장하지 않는다. Preflight의 receipt_id 인덱스 조건을 삭제하지 않는다.
- 운영 적용 후 Postflight/승인 전에는 기능을 활성화하지 않는다. 운영 적용·배포·활성화는 이번 작업 완료 범위에 포함하지 않았다.

## 변경 파일 전체 경로

```text
C:\workspace\baba-wt-codex\supabase\migrations\20261115103656_tables_cleaning_v1.sql
C:\workspace\baba-wt-codex\docs\sql\tables-cleaning-v1-preflight.sql
C:\workspace\baba-wt-codex\docs\sql\tables-cleaning-v1-postflight.sql
C:\workspace\baba-wt-codex\docs\sql\tables-cleaning-v1-stop.sql
C:\workspace\baba-wt-codex\docs\sql\tables-cleaning-v1-emergency-disable.sql
C:\workspace\baba-wt-codex\docs\sql\tables-cleaning-v1-recover.sql
C:\workspace\baba-wt-codex\docs\reports\tables-cleaning-p0-20261115.md
C:\workspace\baba-wt-codex\docs\reports\tables-cleaning-p0-preflight-20261115.json
C:\workspace\baba-wt-codex\tests\tables-cleaning-safety-native.test.mjs
C:\workspace\baba-wt-codex\tests\tables-cleaning-db.test.mjs
C:\workspace\baba-wt-codex\tests\tables-cleaning-server.test.mjs
C:\workspace\baba-wt-codex\tests\helpers\tables-cleaning-fixture.mjs
C:\workspace\baba-wt-codex\tests\helpers\tables-cleaning-service-fixture.mjs
```
