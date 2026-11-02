# P1-2D — CUKCUK 수집 완전성 및 재처리 신뢰성 구현

기준 SHA `8a655a5a5d1b981d9ee7df22001373d5bb6bc0ea`, 원본 main 직렬 작업. [P1-2C 정본](20261102-pos-shadow-p1-2c-readiness.md)의 공급자 계약 미확인과 부분 저장 문제를 대상으로 구현했다.

**로컬 구현·검증 PASS, 운영 자동 정산 전환 BLOCKED.** 새 수집 경로는 `POS_CUKCUK_RELIABLE_INGESTION=enabled`일 때만 기존 sync 진입점에서 선택한다. 설정을 추가하거나 활성화하지 않았다. Shadow 기본 비활성, P0 보호, 기존 엔진과 이전 감사 이력은 유지한다. 운영 DB 조회·수정, POS 로그인/API 호출, 운영 Migration 적용, Push·배포는 수행하지 않았다.

## 1. 실제 공급자 계약과 확인 한계

이번에 공식 [paging 문서](https://graphapi.cukcuk.vn/document/api/sainvoices_paging.html)와 [detail 문서](https://graphapi.cukcuk.vn/document/api/sainvoices_detail.html)를 확인했다. 실제 계정의 live 응답을 새로 수집한 것은 아니다. P1-2C의 저장된 운영 영수증 8111 표본 증거를 재사용했다.

| 항목 | 확인된 계약 / 구현 해석 |
|---|---|
| 목록 | POST `/api/v1/sainvoices/paging`, Page/Limit, 최대 100, BranchId, LastSyncDate, Data 배열, Total |
| 식별자 | Company 범위 + BranchId + RefId. RefNo는 표시 번호다. 저장된 표본에는 RefId/RefNo/OrderId/BranchId가 있었다. |
| 상세 | 공식 URL은 GET `/api/v1/sainvoices/detail/{refId}`. 기존 코드의 `/sainvoices/{refId}`와 다르다. 새 경로는 공식 URL을 사용한다. live 계정 호환은 미확인이다. |
| 상세 헤더 | 공식 상세 예시는 품목·결제 배열만 포함한다. 헤더가 없으면 각 자식의 RefID를 목록 ID와 대조한다. 자식도 없어서 ID를 입증할 수 없으면 완료하지 않는다. |
| 금액 | 공식 목록의 TotalAmount와 현재 저장 표본/파서의 FinalAmount 계열을 구분한다. 기존 금액·현금 거스름 처리 어댑터와 결제 RPC를 재사용한다. |
| 상태 | PaymentStatus 0~5, 3=수금 완료, 4=취소, 5=임시 취소. 현물 반환의 증거가 아니다. |
| 시각 | RefDate는 영수증 발생시각이다. 실물 출고시각으로 승격하지 않는다. 명시적 offset 없는 시각은 보류한다. 공식 예시에는 offset 없는 시각도 있다. |
| ModifiedDate | 기존 표본에 존재하지만 공식 문서에서 단조 수정 순번 계약은 확인되지 않았다. metadata로 보존하며 순서 결정에 사용하지 않는다. |
| 버전 / snapshot | 보장된 수정 sequence, 불변 event ID, 원자 snapshot token은 미확인이다. 로컬 generation과 snapshot ID는 작업 소유권·관측 식별자이며 원본 순번이 아니다. |
| 누락 보장 | LastSyncDate의 정확한 시간 기준·경계, 삭제/tombstone·취소 보존, Total과 페이지의 원자성, 과거 수정 포함 보장은 미확인이다. 문서 예시의 Data/Total 자체도 완전성 증거로 쓰지 않는다. |

공급자 계약을 확인하지 못한 사실을 로컬 해시나 두 번의 관측으로 대체하지 않았다. 서로 같은 두 조회는 관측 안정성의 증거다. 공급자 전체 거래의 누락 없음이나 실제 발생 순서를 증명하지 않는다.

## 2. 구현과 데이터 경계

주요 코드:

- [수집 검증](../../lib/pos/cukcuk/reliable-collection.ts): 전체 page-chain을 두 번 수집한다. 동일 Total, 페이지별 기대 행 수, 정규화한 RefID 유일성, 상세 identity, 품목 ID·수량, 결제 배열, count·amount·내용 SHA-256을 검증한다. 영업일 밖 행도 전체 목록 대조에 포함하고, 저장할 영업일 필터는 그 후 적용한다.
- [실행 조정](../../lib/pos/cukcuk/reliable-ingestion.ts): 외부 요청 전 소유권 획득 → 메모리에서 전체 검증 → 단일 commit RPC. HTTP 요청에는 15초 timeout을 적용한다. 페이지 실패·중복·불안정 시 부분 자료를 게시하지 않고 새 run의 전체 재조회가 재시도 조건이다. commit 응답 유실은 같은 인자로 한 번 재전송한다.
- [서버 연결](../../lib/pos/cukcuk/reliable-ingestion-server.ts): 기존 POS secret 검사 이후에만 실행한다. 저장된 영업시간 어댑터를 사용하며 설정 조회 오류의 임시 시간창은 확정하지 않는다. 원본 토큰·응답 본문을 오류에 출력하지 않는다.
- [후속 SQL](../../supabase/migrations/20261102113150_pos_reliable_cukcuk_ingestion.sql): 새 객체만 작성했다. 기존 적용 Migration이나 기존 RPC 정의·ACL·P0 트리거를 변경하지 않았다. 폐기 가능한 로컬 PostgreSQL에서 파일 SQL을 직접 검증했으며 Migration 이력에 적용하지 않았다.
- [예외 확인 API](../../app/api/admin/sales/ingestion/route.ts): owner/master 서버 인증과 기능 플래그를 요구한다. actor ID는 세션에서 가져온다. 증거와 기대 head/현재 canonical hash를 받아 CAS로 확인한다.

신규 `pos_ingest_private` 자료는 Data API에 직접 노출하지 않는다. 모든 테이블 RLS, private 스키마·테이블·시퀀스 접근 차단, public RPC의 anon/authenticated EXECUTE 제거, service_role RPC만 허용했다. 외부 HTTP 동안 DB 행 잠금을 유지하지 않는다.

| 객체 | 역할 / 변경 정책 |
|---|---|
| runs | UUID run, 별도 owner token, 로컬 generation, 10분 lease, collecting/committed/failed/expired. 실패 코드·재시도 조건·최초 완료 결과 보존 |
| snapshots | `(scope, 정규화 RefID, 내용 hash)` 유일 관측 버전. 최초 payload 유지, 덮어쓰기·삭제 없음 |
| observations | run별 관측 결과와 원본 시각/버전 후보 metadata. 같은 내용은 snapshot을 재사용하며 원본 순번으로 해석하지 않음 |
| heads | receipt별 승인된 관측과 기존 canonical 연결. Company/branch 충돌은 자동 병합하지 않음 |
| baselines | 기존 원장에 처음 연결할 때 영수증·품목·결제의 이전 canonical snapshot 보존 |
| resolutions | 예외 확인의 actor·증거·기대 head/hash·결과를 추가 기록. 응답 유실 재전송은 원래 결과 반환 |

영수증·품목·결제·재처리 자격·관측 이력·완료 run·기존 `pos_sales_sync_runs` 숫자 ID를 **같은 DB 트랜잭션**에 기록한다. 뒤 영수증이나 결제 저장이 실패하면 앞 영수증까지 모두 롤백한다. 실패 기록은 롤백 후 소유권을 확인하는 별도 RPC로 저장하며, 이미 committed인 run을 failed로 바꾸지 않는다. 이 실패 기록까지 DB 장애로 실패하면 lease 만료 후 새 전체 수집으로 회복한다.

기존 header·line ID, 수동 수정 보호, line exclusion, 수정 감사, 완료 차감 이력은 보존한다. 사라진 POS 품목은 기존 방식대로 exclusion 처리하며 삭제하지 않는다. 결제 저장은 기존 `reconcile_sales_receipt_payments_v1`을 같은 트랜잭션 안에서 호출하여 identity·금액·수동 결제 보호를 유지한다. 이 RPC의 기존 계약에 따른 결제 snapshot 교체는 남아 있으며, 교체 전 canonical과 원본 관측은 별도로 보존한다. 기존 판매·재고·입고 감사 이력을 정리하는 작업은 없다.

## 3. 멱등성·역전·예외 회복

1. CompanyCode의 SHA-256 + branch 범위로 같은 수집을 직렬화한다. 요청 전 얻은 lease가 만료되면 오래된 worker의 commit은 거부한다. DB 게시 잠금 순서는 scope → 정규화 RefID → head → 기존 receipt/child다. 서로 다른 Company가 같은 기존 RefID를 사용하는 경우도 별도 identity 잠금으로 충돌을 탐지한다.
2. 동일 내용 재수신은 같은 snapshot ID를 사용한다. canonical 자료가 이미 같으면 기록 시각·차감 자격을 갱신하지 않는다. 기존 차감 크론의 last_checked/pending/eligibility 변경은 새 판매 버전으로 취급하지 않는다.
3. 기존 영수증도 모든 header/품목/결제가 같으면 자동 연결만 한다. 부분 저장·다른 수량·다른 상태·수동 변경이 있으면 보류한다. 정상 자료까지 일괄 수동 확인으로 보내지 않는다.
4. 기존 내용이 바뀌었다면 ModifiedDate가 커도 작아도 신뢰할 원본 순번이 없으므로 `provider_order_unverified`로 보존한다. 예전 A가 B 뒤에 다시 도착해도 현재 B를 자동으로 덮어쓰지 않는다. 같은 B 보류를 반복 수신해도 snapshot이나 차감 batch를 반복 생성하지 않는다.
5. 판단 불가능한 변경은 원본 export/현재 POS 확인 등 별도 권위 있는 증거를 확보한 owner/master가 CAS 확인할 수 있다. 관리자 로컬 수정 영수증은 이 경로로 덮지 않는다. 동일 자료를 영구 차단하는 목록은 만들지 않았다.
6. 같은 내용 hash에서 어댑터가 다른 projection을 만들면 `ingest_projection_contract_changed`로 중단한다. 날짜 설정·파서 계약 변경을 원본의 새 수정 순번으로 위장하거나 최초 저장 payload로 조용히 되돌리지 않는다.

P1-1 prepare/apply wrapper와 실패 재시도·중복 미리보기 키는 변경하지 않았다. 확인된 변경만 기존 재처리 자격을 갱신하며, 이후 부족 재고 의존성 변화에 따른 재시도는 기존 P1-1 계약을 따른다. 이번 수집 엔진에는 재고 UPDATE/차감/입고 생성이 없다.

## 4. 완전성 증거와 과거 복구

| 필드 | 의미 |
|---|---|
| collectionComplete | 두 전체 page-chain의 ID/내용 hash·건수·금액이 일치하고 필수 상세 검증 완료 |
| projectionComplete | 이번 저장 대상과 현재 canonical이 일치하고, 이번 조회에서 빠진 기존 ID가 없음. 과거의 모든 보류가 해결됐다는 의미는 아님 |
| sourceComplete / source_complete | 공급자 snapshot/필터/삭제 계약이 미확인이므로 **항상 false** |
| shadowSourceComplete / automaticConfirmation | **항상 false**, 조회 안정성을 Shadow 확정 증거로 승격하지 않음 |

commit의 manifest에 Total·열거 건수·선택 건수·양쪽 page 수/금액/hash·전체 ID별 내용 hash와 금액을 남긴다. DB에서도 필수 manifest 값·entry 유일성·총액·선택 ID/hash를 검증한다. DB의 기존 영수증 중 조회에서 사라진 ID와 금액도 기록하며 자동 취소·삭제하지 않는다. 같은 건수의 다른 거래로 바뀐 경우도 ID 대조로 탐지한다. 원본 건수·금액을 DB의 필터 후 행 수와 잘못 비교하지 않는다.

기능 활성화 이후 기존 sync POST에 다음 입력을 사용할 수 있다. 현재 실제 실행한 것은 아니다.

```json
{"recover": true, "businessDate": "2026-11-02", "recentDays": 7, "gapDates": ["2026-10-09"], "limit": 100}
```

- 기본 최근 7개 영업일, 허용 1~14개, 추가 gapDates 최대 31개. 날짜 중복 제거 후 오래된 날부터 직렬 처리한다. 동일 영수증·동일 내용을 다시 수집해도 이미 게시한 사실을 재적용하지 않는다.
- 날짜마다 독립적으로 원자 확정한다. 중간 날짜 실패 시 이후 날짜를 진행하지 않는다. 앞 날짜 성공은 남으며 전체 sweep 완료 cursor를 올리지 않는다. 재실행은 모든 범위를 다시 검증해도 안전하다.
- `inspect:true` 조회와 `pos_ingest_inspect(scope,since)`로 run·보류 후보·누락 ID·마지막 실패/불완전 날짜를 확인한다. 기본 7일보다 오래된 장애 구간은 명시적 gapDates 또는 기간을 나눈 재수집으로 복구한다.
- **7일은 복구 보장 상한이 아니다.** 검증된 기존 checkpoint가 없으므로 장기 미수집·미발견 거래는 운영 기준일 이후 전체 기간 또는 공급자 export 대조가 필요하다. 관측에 한 번도 나타나지 않은 거래를 로컬 자료만으로 찾아냈다고 주장하지 않는다.
- recovery의 자동 스케줄·운영 실행은 활성화하지 않았다. 일반 요청의 단일 영업일 수집 계약을 유지하고, recovery는 명시적 요청으로 수행한다.

## 5. 변경 영향 검증

유효한 변경 범위 검증 **54 PASS / 0 FAIL / 0 SKIP**: 신규 수집 검증 최종 실행 **26**(native 상위 테스트 1 포함) + 앞서 같은 코드에서 완료한 수정 진입점의 금융/마감 회귀 **28**. 마지막에는 합성 수정 영수증 55회 사례만 추가되어 신규 파일 26건을 재실행했으며, 금융/마감 28건의 PASS는 재사용했다. P1-1 41, P1-2 24, P1-2C 15 PASS도 코드·검증 범위가 유지되는 부분에서 재사용하며 54건에 합산하지 않았다.

```powershell
$env:QA_POSTGRES_BIN=(Resolve-Path '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin').Path
node --experimental-strip-types --test tests/pos-reliable-ingestion.test.mjs tests/pos-sales-sync-payment-completeness.test.mjs
# 수정 영수증 55회 사례 추가 후 영향 파일만 최종 재검증
node --experimental-strip-types --test tests/pos-reliable-ingestion.test.mjs
```

| 검증 | 결과 |
|---|---|
| 다중 페이지, 영업일 밖 행 포함 Total, 두 번 count/amount/hash 대조 | PASS |
| 중간 페이지 실패·짧은 페이지·중복 응답·Total 변화 | PASS: 부분 게시 없음 |
| 잘못된 상세 ID·상세 배열 누락·offset 없는 시각·동일 건수 내용 변화 | PASS: 완료 거부 |
| 공식 형식의 헤더 없는 상세·자식 RefID 대조·TotalAmount | PASS |
| 영수증/품목 저장 후 결제 실패·뒤 영수증 실패 | PASS: 동일 run 전체 롤백, 후속 정상 재시도 회복 |
| 늦은 구버전·수정/취소 역전·명시적 CAS 확인 | PASS: 자동 역전 없음, 증거 확인 후 회복 |
| 글렌피딕 15 / 2601006796 합성 영수증 55회 반복 | PASS: 동일 최초 snapshot 1개. 별도 잔술 0.0714→병 1 수정 55회에서는 기존 1개 + 변경 후보 1개만 생성, 새 차감 batch 0. 보류 중 canonical·자격 불변, 증거 확인 후 수량 회복, 재고 0.03 불변 |
| 기존 차감 크론 bookkeeping 이후 동일 자료 재수신 | PASS: 새 버전·차감 자격 재개 없음 |
| 오래된 영업일 장애 후 전체 재수집·누락된 기존 ID 탐지 | PASS |
| 같은 범위 동시 worker·lease 만료 후 stale worker | PASS: 소유자 1개, stale commit 거부 |
| commit 응답 유실·같은 요청 replay·다른 payload·늦은 fail callback | PASS: 최초 결과 보존, 중복 게시 없음 |
| Company namespace 충돌·관리자 수정·기대 hash 충돌 | PASS: 자동 병합/덮어쓰기 없음 |
| 기존 원장 baseline·line exclusion·이전 ID 보존 | PASS |
| 기존 inventory/log/deduction/batch/수정 감사 및 P0/기존 RPC 정의·ACL 불변 | PASS |
| owner/master·기본 비활성·POS secret 선행 검사·SQL 비밀 정보 차단 | PASS |
| 실제 계정의 상세 URL/Total/시각·장기 장애 완전 복구 | 미확인: live 호출 안 함 |
| 신형 엔진 운영 자동 확정·전체 Writer 전환 | BLOCKED / 이번 범위 제외 |

native PostgreSQL 최종 증거: `.qa-review/pg-native-logs/pg-native-test-60251691-1bc2-4cfa-9854-d1eab9738b7c-OS1hRN`의 result/commands/server log. 앞선 금융/마감 회귀와 함께 실행한 증거는 `.qa-review/pg-native-logs/pg-native-test-a439748e-58a2-4e01-8810-d591cdfd4658-KtoAvu`다. native `outcome.passed=true`, 소유한 임시 DB 정리 완료. 운영 자격 증명·환경변수를 테스트에 주입하지 않았다.

변경 TS 5개 ESLint PASS, 해당 파일을 root로 한 좁은 의존 그래프 TypeScript semantic 진단 0개, git diff 공백 검사 PASS. 전체 Build/TypeScript/전체 테스트는 실행하지 않았다. 글렌피딕의 stock_check→입고→시간순 정산 수치 검증은 기존 P1-2/P1-2C PASS를 재사용했고 이번에는 수집·자격·중복 생성 경계만 재검증했다.

## 6. P1-2E 인터페이스와 전환 조건

| 인터페이스 | 다음 단계가 지켜야 할 조건 |
|---|---|
| `pos_ingest_claim` / `commit` / `fail` | 새로운 엔진만 선택한 동일 범위 lease와 원자 commit 사용. legacy 수집과 동시에 실행하지 않음 |
| `pos_ingest_inspect` | run별 manifest·보류 후보·retryDates를 확인. 실패 gap을 성공 cursor로 건너뛰지 않음 |
| `pos_ingest_resolve` / admin ingestion API | 검증된 actor, 현재 head + canonical hash + 근거. 관측 ID를 provider sequence로 전달하지 않음 |
| `pos_ingest_shadow_evidence(receiptId)` / admin `action:evidence` | observedVersion/contentHash와 sourceSequence=null, sourceComplete=false 반환. 미확인 입력을 확정하는 자동 연결 없음 |
| 기존 P1-1 재처리 wrapper | 현재 재고 의존성 키 및 최초 시도 감사 유지. 새 수집에서 불필요하게 eligibility를 다시 열지 않음 |

우선순위별 남은 차단 사유:

1. **P0 — 공급자 의미 검증:** 실제 계정의 공식 detail 응답·Total·시각 offset, LastSyncDate 기준·과거 수정/취소/삭제 보존, 페이지 snapshot/순서 보장 또는 검증 가능한 export/checkpoint를 확보해야 한다. 확인 전 자동 확정은 금지다.
2. **P0 — Writer 전환:** P1-2C의 전체 Writer, 실제 재고 이동시각, 취소와 실물 반환, 공통 item lock·중복 적용 fence를 P1-2E에서 연결해야 한다. 수집은 재고 부족을 이유로 판매 사실을 버리지 않지만 signed balance 정산 전환을 대신하지 않는다.
3. **P1 — 장기 복구:** 최근 7일 외에 첫 검증 기준일/전체 장애 구간을 확정하고 export와 대조해야 한다. 운영 수집량과 두 전체 scan의 요청 수·10분 lease·API 102/시간 초과에 대한 실측이 필요하다. 대량 자료가 lease를 넘으면 안전하게 실패하지만 아직 성능 SLA는 검증하지 않았다.
4. **P1 — 마감 계약:** 새 경로는 `ok`, businessDate, numeric syncRunId를 유지하지만 기존 `source_complete`는 false다. 이 상태로 기존 자동 마감을 활성화하면 마감은 차단된다. 금융 source 완전성 조건을 별도 검증한 뒤 호환 전환해야 한다.
5. **P1 — 초기 연결/예외:** 완전히 같은 기존 projection은 자동 연결한다. 부분 저장·원본 순서 불명·legacy line ID 누락·수동 수정·식별자 충돌은 별도 증거/정비가 필요하다. 증거 없이 과거 원장·차감을 일괄 재작성하지 않는다.

승인된 후속 전환 순서는 운영 설치 객체·스키마/권한/결제 RPC 계약 확인 → 별도 승인된 새 Migration 적용 → 기존 수집 in-flight 종료 → 소규모 수집 플래그 전환 → 제한된 복구/manifest 대조 → 실제 공급자·Writer 증거가 충족된 Shadow 운영 비교다. 플래그를 끄면 기존 경로로 돌아가며 신규 관측 이력은 남긴다. 두 수집 경로를 동시에 사용하지 않는다. P0 제거는 신형 엔진의 운영 검증 이후 별도 Migration 단계이며 이번 SQL에는 포함하지 않았다.
