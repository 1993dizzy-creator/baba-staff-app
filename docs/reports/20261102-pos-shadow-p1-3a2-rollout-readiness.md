# POS P1-3A2 — 제한 Shadow 도입 준비

기준 main `2dac772e02334033c4ac35a16c479bbb0e0cc020`. [P1-3A 정본](20261102-pos-shadow-p1-3a-preflight.md)의 운영 조사·기존 PASS를 재사용한다. 구현 커밋: `a34390efd6c4272bfd54f0c5babd320d4faec8a0`, `f9ca360f9eb90017a985f2e24dd444c6081c5ed8`(모든 원본의 pilot 완전성 주장 보류). Migration 9개 원문/P0/과거 업무 이력은 변경하지 않았다.

## 1. 독립 판정

다음은 **코드·절차의 준비 판정**이다. 운영 설치·배포·활성화가 완료됐다는 뜻이 아니다.

| 항목 | 판정 | 허용 범위/전제 |
|---|---|---|
| 앱 코드 선배포 | **GO** | Shadow/reliable ingestion/journal 플래그 off 확인 후. 기존 RPC 기반 저장 유지. 미설치 P1-1 수정 재처리는 명시적 보류되므로 이 일시 제한을 배포 승인에 포함 |
| 지정 Migration 설치 준비 | **GO** | 명시적 9개만, 앱 보호 선배포 후 쓰기 유지보수 창, A 4개 체크포인트 + B 5개 원자 설치, postflight 및 정상 신규 적용 기록. 운영 실행은 별도 승인 |
| 운영 Shadow 관찰 | **GO — 제한 pilot 준비** | 위 배포·설치·postflight 완료 뒤 별도 활성화 승인. raw/보류 관찰 우선, 공급자·외부 Writer 완전성은 false. 과거 복구 건 signed 편입 제외 |
| 실제 재고 엔진 전환 | **BLOCKED** | 공급자/물리 시각/과거 편입/전체 Writer 근거와 실재고 적용·reader 전환 미완. P0 유지 |

전체 signed 비교의 정확성·완전성 또는 임의 외부 배치의 정상 실행을 보장하는 GO가 아니다. sourceComplete=false인 비교는 확정 정산이 아니다. 유지보수 시 쓰기 통제·승인된 직접 DML 제한을 수용할 수 없다면 **해당 설치/관찰 실행은 BLOCKED**로 되돌아간다.

## 2. 해결한 코드 차단 조건

### 삭제·오류·선배포 호환

- `app/api/inventory/items/route.ts`의 hard DELETE는 인증/권한/ID 검증 직후 **항상 409**를 반환한다. 관련 이력 유무나 journal 플래그와 무관하며 DB/Storage 호출을 시작하지 않는다. 기존 순차 purge/사진 삭제 코드를 제거해 부분 삭제 가능성을 없앴다. 응답은 `inventory_history_preservation_required`, retryable=false, nextAction=deactivate_item이다.
- 정상 PATCH의 기존 RPC 경로는 journal off에서 유지한다. 새 DB의 40001/55P03은 409 + 새로고침 후 재시도, 42501은 관리자 계약 검토 전 재시도 금지, 미설치 RPC는 503 + 설치/cache 확인 조건으로 응답한다. SQL 상세는 응답에 노출하지 않는다.
- P1-1 RPC 미설치(`PGRST202`/`42883`)에서 수정 재처리는 `needs_check / pos_reprocess_migration_required`다. batch/preview/복구를 클라이언트가 대신 생성하지 않는다. 최초 차감·기존 취소 경로를 새 함수로 바꾸지 않았다. 설치 후 다음 최신 preview에서 정상 경로를 다시 시도할 수 있다. 미설치 기간을 무기한 방치하는 배포는 승인 대상이 아니다.
- 응답 유실(08000/08006/PGRST000)은 outcomeUnknown으로 구분한다. 실패를 미반영으로 단정하거나 legacy 요청을 자동 재전송하지 않고 결과/감사를 확인한 후 새로고침하도록 한다. 기존 journal dispatcher의 같은 요청 ID 기반 제한적 전송 재시도 계약은 변경하지 않았다.
- 세 기능 플래그의 운영 값을 변경하지 않았다. 선배포 승인 시 `POS_INVENTORY_SHADOW_MODE != shadow`, `POS_CUKCUK_RELIABLE_INGESTION != enabled`, `INVENTORY_WRITER_MODE != journal`을 명시적으로 확인한다.

### 과거 이력·외부 Writer 관찰 정책

새 정책은 기존 원장을 고치지 않는 **관찰 분류**다. `/api/admin/sales/inventory-shadow/writers`의 `observation_policy`는 owner/master + Shadow 플래그 뒤에서만 읽는다.

| 분류 | 기준/처리 |
|---|---|
| signed_candidate | 실행 감사 연결이 있고 과거 revert가 없는 후보. 단위/물리 시각 근거·기존 F의 baseline/CAS 검증은 여전히 필요. 후보라는 이유로 자동 확정하지 않음 |
| raw_only | 연결된 수정 재처리 revert 또는 경제 취소 복구. 원문/보류 관찰만 허용, signed baseline 등록은 409로 선차단 |
| uncertain | 원차감/감사 연결 누락, 중복 reversal, 미확인 workflow, 미실행 reversal 시도, 조회 실패/상한 도달. signed 편입 제외 |

이력 조회는 receipt별 최대 1,000행에서 보수적으로 보류하고, workflow 조회는 100 ID씩 제한한다. 읽기 실패도 uncertain으로 반환한다. 조회를 완전한 원장으로 가장하지 않는다.

모든 분류에 provider_completeness_unverified / external_writer_coverage_unverified / unit_and_physical_time_evidence_required를 남긴다. sourceComplete / writerCoverageComplete / automaticConfirmation은 항상 false다. CUKCUK 외 원본도 포함해 pilot capture의 sourceSequence는 null이며 호출자 주장으로 이를 승격하지 않는다. raw capture는 이 정책과 사유를 기존 `pos_inventory_shadow.observations.payload.evidence`에 저장한다. 편입 가능한 F baseline도 proof envelope에 정책을 보존한다. 별도 정책 테이블이나 추가 Migration은 만들지 않았다.

**8111 및 기존 35개 revert 영수증은 raw_only(자료 불완전 시 uncertain)**다. 구형 복구를 실반품으로 추정하지 않고 기존 F의 보호도 해제하지 않는다. 그 거래를 새 signed 소비에 재편입하거나 현재 재고에서 다시 차감하지 않는다. 단순 취소와 실반환은 여전히 별도다. 과거 편입을 해결했다고 주장하는 대신 관찰 제외를 명확히 구현했다.

외부 경로는 P1-3A의 활성 Vercel Cron 10개·기존 RPC·supplier alias·사진·service_role 조사 결과를 재사용한다. system 135건/출처 불명 1,674건 및 외부 SQL/키 소유권은 **미증명 상태**다. 다음 정책으로 제한 관찰에서 격리한다.

- 등록 RPC와 실제 감사 연결만 해석 대상으로 삼고, 단위/시각 미확인 이벤트는 pending/held로 둔다. 누락 이벤트가 없다고 가정하지 않는다.
- service_role의 미등록 직접 수량 DML은 기존 E/F의 DB fence/권한으로 원자 거절한다. 권한을 다시 열거나 직접 복구 SQL을 실행하지 않는다. 새 앱은 명확한 검토 응답을 제공한다. 미확인 외부 클라이언트까지 이 응답을 처리한다고 주장하지 않는다.
- owner/superuser 직접 SQL은 신뢰 경계다. 외부 Writer가 필요한 정상 업무로 확인되면 관찰의 완전성을 올리지 말고 pilot/설치 진행을 멈춰 계약을 검토한다. 실제 엔진 전환은 계속 BLOCKED다.
- 설치 자체의 잠금·권한 변경은 의도된 별도 승인 대상이다. Shadow 관찰 제외만으로 설치의 부작용이 없어진다고 보지 않는다.

## 3. 지정 9개 설치/복구 계획

[고정 manifest](../../supabase/verification/20261102_pos_p1_3a2_installation_manifest.json)는 파일명·순서·UTF-8 LF SHA256을 기록한다. 원문은 실행 시 그대로 사용한다. checksum 계산의 LF 정규화는 파일 재작성이나 SQL 변환이 아니다. 기존 71개 미기록 파일/운영 전용 3개 버전은 실행·수정·repair 대상이 아니다. 일반 db push, include-all, migration up 일괄 실행은 금지한다.

| 순서 | 파일 timestamp / 이름 | 트랜잭션 |
|---|---|---|
| 1 | `20261102101859_pos_reprocess_failure_persistence_and_dedup.sql` | A1: 파일 자체 BEGIN/COMMIT |
| 2 | `20261102103506_pos_shadow_sale_versions_and_jobs.sql` | A2: 파일 자체 |
| 3 | `20261102103822_pos_shadow_temporal_settlement.sql` | A3: 파일 자체 |
| 4 | `20261102110828_pos_shadow_writer_contract_and_order.sql` | A4: 파일 자체 |
| 5 | `20261102113150_pos_reliable_cukcuk_ingestion.sql` | B: 이하 5개 한 외부 트랜잭션 |
| 6 | `20261102120035_inventory_writer_event_journal.sql` | B |
| 7 | `20261102120303_inventory_writer_shadow_integration.sql` | B |
| 8 | `20261102142849_pos_signed_projection_epochs_and_handoff.sql` | B |
| 9 | `20261102144000_pos_writer_least_privilege_and_day_reconciliation.sql` | B |

실행 전 현재 운영 메타데이터를 확인했다: transaction_read_only=on, 최신 이력 `20261101180623`, P1 wrapper 미설치. schema_migrations는 version 필수, name/statements 등은 nullable이다. P0/함수 원본 해시/권한·Cron·운영 단위·이력 대조는 P1-3A 증거를 재사용한다. 적용 직전 상태가 다르면 이 계획을 자동 실행하지 않는다.

승인 후 실행 순서:

1. 새 앱을 세 플래그 off로 선배포하고 hard DELETE가 무쓰기 409인지 확인한다. modified 재처리의 일시 보류를 고지한다. 현재 Production 구버전으로 되돌린 상태에서 B를 설치하면 안 된다.
2. 대상 DB·manifest checksum·P0·기존 함수 해시·운영 이력과 누락/추가 버전을 확인한다. 정상 수량 저장·관련 Cron·수동/외부 Writer를 유지보수 창에서 통제하고 기존 트랜잭션을 drain한다. 실행 주체가 확인되지 않거나 쓰기 통제가 불가능하면 중단한다.
3. A1~A4를 각각 원문 실행한다. **완료한 파일만** 정상 신규 적용 기록(version/name)을 append한다. 과거 이력 UPDATE/DELETE, 빈 과거 파일, repair, 성공 DDL 재실행은 하지 않는다.
4. B는 원문 5개 + 아래 postflight + 정상 신규 이력 5개 INSERT를 **같은 세션·한 트랜잭션**으로 실행한다. 어떤 SQL/검사/기록 충돌이라도 전체 B를 rollback한다. 6~9 사이 상태를 운영에 노출하지 않는다.
5. COMMIT 후 적용 기록 9개·원문 checksum·postflight를 읽기로 재확인한다. PostgREST cache 준비도 확인한다. 필요한 `NOTIFY pgrst, 'reload schema'`는 설치 승인 범위에 포함해 수행하고, cache 오류를 stock writer 재전송으로 해결하지 않는다. 기존 Writer 정상 경로 확인 후 유지보수 창을 종료한다. Shadow는 계속 off다.

### 실행 형태와 신규 적용 기록

다음은 **미실행 승인 검토용**이다. 자격 증명은 명령 문자열/로그에 쓰지 않고 사전에 승인한 connection service를 사용한다. 이 환경에는 psql 클라이언트가 없으므로 psql 명령 자체는 실행하지 않았다. 아래와 동등한 서버 트랜잭션을 native PostgreSQL driver로 검증했다.

- A 각 파일: `psql "service=baba-approved-maintenance" -X -v ON_ERROR_STOP=1 -f <해당 원문 파일> -c "INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('<해당 신규 버전>','<해당 파일의 이름>');"`
- B 한 세션: `psql "service=baba-approved-maintenance" -X -v ON_ERROR_STOP=1 -1 -f <원문5> -f <원문6> -f <원문7> -f <원문8> -f <원문9> -f supabase/verification/20261102_pos_p1_3a2_postflight_readonly.sql -c "<아래 신규 5개 INSERT>"`

```sql
-- B가 실제로 성공한 동일 트랜잭션에서만 기록할 정상 신규 적용 이력.
INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES
 ('20261102113150','pos_reliable_cukcuk_ingestion'),
 ('20261102120035','inventory_writer_event_journal'),
 ('20261102120303','inventory_writer_shadow_integration'),
 ('20261102142849','pos_signed_projection_epochs_and_handoff'),
 ('20261102144000','pos_writer_least_privilege_and_day_reconciliation');
```

A의 정상 신규 기록은 표의 1~4 버전/이름과 일대일 대응한다. 위 INSERT는 과거 이력을 맞추는 보정이 아니라 **방금 실행한 신규 9개의 정상 완료 기록**으로만 허용한다. 기록 없는 객체를 발견했다고 임의 소급 기입하지 않는다. 별도 운영 승인에는 DDL/권한 변경과 이 신규 기록 범위(기존 140개 변경 없음)를 함께 명시해야 한다.

[psql 공식 문서](https://www.postgresql.org/docs/current/app-psql.html)의 반복 -f / -1 / ON_ERROR_STOP 계약을 확인했다. 파일 자체 BEGIN/COMMIT이 있는 A에 -1을 씌우지 않는다. [PostgREST cache 문서](https://docs.postgrest.org/en/stable/references/schema_cache.html)의 reload 계약도 확인했다.

### 실패/응답 유실

- A 파일 내부 오류: 해당 트랜잭션 rollback, 이전 성공 checkpoint 유지. 원인 해결 후 **첫 미완료 파일부터** 재개한다.
- B 파일·postflight·신규 기록 오류: B 전체 rollback, A4 상태 복원. B 원문 처음부터 재개한다. DROP/역 Migration으로 이력이나 새 감사 데이터를 없애지 않는다.
- COMMIT 응답 유실: 실패라고 가정하지 않는다. 객체/함수 본문·신규 기록·manifest를 대조해 성공을 확인하면 재실행하지 않는다. A의 DDL COMMIT과 정상 이력 append 사이에서 끊겨 객체만 있거나 증거가 모호하면 **STOP/BLOCKED**로 유지한다. 자동 replay/repair/소급 이력 기록은 금지하고 실행 증거를 보존해 별도 검토한다.
- 이 작업은 full 운영 schema 복제/운영 부하 검증이 아니다. native 설치 fixture에 실제 13개 Writer 본문을 함께 등록했으며 금융 경로는 선언용 row type을 보완했다. 금융 계산을 새로 실행한 것으로 보고하지 않고 기존 금융 PASS를 재사용한다.

## 4. postflight·관찰 순수성·검증

[postflight SQL](../../supabase/verification/20261102_pos_p1_3a2_postflight_readonly.sql)은 P0 enabled, Writer 13개/본문 successor 일치, 직접 수량/생성/감사삭제 권한 차단, 사진 metadata 허용, private RLS·schema 권한, handoff 0, 자동 확정 승격 0을 검사한다. false이면 SQL 오류로 B를 abort한다. 원장/업무 데이터를 수정하지 않는 SELECT다. 검사 권한은 설치 운영자이며 service_role에 private schema 사용 권한을 추가하지 않는다.

변경 범위 검증 **10 tests PASS**:

- 신규 predeploy 2개: 모든 DELETE 조합의 DB/Storage 무호출, 인증/권한, 기존 RPC 저장, 40001/55P03/42501/미설치/응답 유실 응답과 자동 재전송 없음.
- rollout/policy 4개: 후보·raw_only·uncertain 분류, 이력 조회 실패/상한, 비활성 시 무조회, 과거 8111 signed 선차단, P1 미설치 보류·설치 후 경로 재개.
- 변경된 기존 capture/API 2개만 재검증 + 비CUKCUK 원본 주장 보류 신규 1개: 새 정책 증거 연결, actor/권한/default off 유지, 모든 원본에서 sourceSequence=null 보장. 무관한 기존 PASS는 반복하지 않음.
- 신규 native recovery 1개: A 파일마다 DDL 실패 rollback, B 각 단계 실패의 전체 rollback, postflight 실패 rollback, 성공 재개/신규 9개 기록과 기존 기록 보존, 정상 postflight 확인. **관찰 capture/claim/settle/drain/compare 후 모든 fixture public 업무 행(재고/판매/결제/장부 관련 포함)이 같고, 정책 사유는 private observation에 저장됨**을 확인.

6개 변경 TS의 ESLint PASS, 의존 포함 제한 TypeScript semantic 진단 0. 전체 Build/전체 TS/기존 22개 검증은 반복하지 않았다. 9개 Migration 파일의 기준 대비 diff 없음, manifest digest 검증 PASS. native 최종 증거: `.qa-review/pg-native-logs/pg-native-test-8694d79b-9309-41be-b098-cd5bf66d016c-Jhja4V`; 임시 DB 종료/삭제, 로그 보존. 테스트에 운영/POS 자격 증명을 제공하지 않았다.

관찰 진입은 여전히 owner/master의 명시적 HTTP 요청뿐이며 자동 수집/차감 Cron hook은 추가하지 않았다. 활성화 자체와 해당 관찰 요청은 업무 Writer를 호출하지 않는다. 설치에 따른 의도된 trigger/권한/잠금 변경과 기존 정상 Cron의 업무 변경을 Shadow 활성화의 효과와 구분한다.

## 5. 제한 pilot와 다음 승인

1. 설치·배포 postflight 후 **별도 Shadow 활성화 승인**. reliable ingestion/journal 전환·exclusive handoff는 함께 켜지 않는다.
2. 첫 표본은 기존 **8111의 observation_policy → raw capture → status/보류 확인**으로 제한한다. sourceSequence=null, sourceComplete=false, timeBasis=unknown. F adopt/정산 확정·실재고 복구·재처리를 호출하지 않는다. 35개 이력도 같은 분류로 관찰한다. signed 후보는 단위/시각 증거가 있는 별도 표본으로만 후속 선정한다.
3. 요청 동시성 1, 수동 run/drain은 limit=1부터 관찰한다. P0/업무 행 변경/새 42501·40001·잠금 지연과 보류 사유를 구분해 기록한다. 수집/차감/장부 Cron을 pilot 목적으로 수동 실행하지 않는다. 과거 backfill·데이터 보정도 없다.
4. 업무 DML을 유발하는 관찰 호출, P0 훼손, handoff 발생, 원문 감사 변경, 필요한 정상 Writer의 미등록/오류가 확인되면 pilot 중단. 새 데이터 삭제로 되돌리지 않는다. 공급자·외부 Writer 완전성은 계속 false다.

남은 실제 전환 BLOCKED는 공급자 완전성/문서 진정성, 물리 시각·당시 단위 epoch, 과거 복구의 안전한 signed 편입, 외부 소유권·전체 Writer 보장, signed 실재고 적용/reader 전환이다. 제한 raw pilot GO를 이 항목의 PASS로 확대하지 않는다.

**다음 승인 지점:** (1) 이 코드의 Push/Production 선배포와 플래그 off·수정 재처리 일시 보류, (2) 유지보수 창 및 지정 9개 원문/권한 변경·정상 신규 적용 기록·cache reload의 운영 실행, (3) postflight 결과 확인 후 위 제한 Shadow pilot 활성화. 각각 별도이며 현재 어느 것도 실행하지 않았다. P0 제거·실제 재고 엔진 전환 승인은 포함하지 않는다.
