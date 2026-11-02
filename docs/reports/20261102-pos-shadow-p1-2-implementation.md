# P1-2 시간순 재고 정산 — Shadow 구현 결과

기준 SHA: `208ddbe11368607cf3e82b46805897dd0efb8c3f`. 원본 main 직렬 작업. [설계 정본](20261102-pos-delayed-inventory-design.md)과 [P1-1 결과](20261102-pos-reprocess-p1-1-implementation.md)는 변경하지 않았다. 운영 DB 조회·변경, 운영 Migration 적용·이력 변경, Push·배포·자동 복구를 수행하지 않았다.

## 구현 범위

- 판매 원장: `pos_inventory_shadow` private 스키마의 streams/observations/versions/plans. source·branch·ref ID로 중복 영수증을 통합 식별하고, 단조 증가 source sequence와 로컬 version_no를 분리했다. 최초 판매·수정·취소, A→B→A, 역순 수신·동일 순번 충돌을 구분한다. 판매 수량 스냅샷과 재고 영향량·기존 legacy 차감 ID를 보존한다.
- 원자적 수집: 버전·계획·작업을 같은 트랜잭션으로 저장한다. 미완료 source snapshot은 관측만 기록하고 버전/순번을 소비하지 않는다. 같은 관측 재수신은 기존 결과를 반환한다. 기존 행의 volatile sync 시각만 달라져서 새 버전이 생기지 않도록 의미 스냅샷을 사용한다.
- 대기열: jobs/attempts/attempt_events. SKIP LOCKED claim, 30초 lease, generation/token 검사, 만료 회수, 영수증 버전 순서 처리, SQLSTATE별 backoff를 구현했다. `55P03/40P01/40001/08xxx`는 최대 1시간 간격으로 재시도하고, 판단 불가 오류는 증거/엔진 변경을 기다린다. 잠금 대기 중 lease가 만료돼도 완료를 저장하지 않는다.
- 시간순 정산: settlements/item_effects. `최신 검증 실사 C + 실사 이후 물리 이동 - 최신 버전별 실사 이후 소비`로 signed book을 계산한다. 실사 이전/동일 시각 효과는 현재 수량에서 제외하고 경제적 차이만 기록한다. 이후 수정은 직전 정산과의 차액만 계산한다. 품목마다 다른 실사 기준점을 사용한다.
- 취소/반환: 취소는 경제 수량을 0으로 바꾸되 이미 발생한 물리 소비를 자동 복구하지 않는다. 실제 반환은 기존 양수 재고 로그에 연결한 physical_return 이동으로 따로 기록한다. 실사 구간을 가로지르는 추가 판매를 한 줄 전체의 시각 변경으로 추정하지 않고, 증거가 있는 분리 이벤트로 해결하는 경로를 구현했다.
- 부족 추적: 음수 book도 Shadow 정산을 완료한다. signed book, available, shortage, 원인, 경계 로그, 버전 및 이동 근거를 별도 감사 행에 남긴다. available=0 표시가 음수 book을 지우지 않는다. 후속 입고/실사는 비교 잔액만 재계산하고 완료 판매를 재실행하지 않는다.
- P1-1 재사용: 기존 P1-1 요청 키·최초 결과·실패 이력을 비교 결과의 `p1Evidence`에 연결한다. Shadow에서 P1-1 stock writer를 호출하거나 후보를 추가 생성하지 않는다. 기존 실패/완료 차감·원장·로그는 그대로 유지한다.
- 보호: 새 감사 테이블 UPDATE/DELETE 금지, private 테이블 RLS 및 직접 접근 revoke, public RPC는 service_role만 허용한다. 기존 P0·최초/재처리/취소 RPC의 정의·OID·ACL은 유지한다. 신형 SQL에는 운영 재고 UPDATE/로그 INSERT 경로가 없다.

## 실행 인터페이스

서버 구현: [inventory-shadow.ts](../../lib/sales/inventory-shadow.ts), 관리자 진입점: [inventory-shadow/route.ts](../../app/api/admin/sales/inventory-shadow/route.ts).

`POST /api/admin/sales/inventory-shadow`는 owner/master 세션과 `POS_INVENTORY_SHADOW_MODE=shadow`일 때만 동작한다. 기본 비활성이고 `mode=live`를 거부한다. 기존 POS sync/cron에는 자동 hook이나 스케줄을 추가하지 않았다. 외부 POS 호출도 하지 않는다.

| action | 역할 |
|---|---|
| capture | receiptId, observationKey, sourceSequence, sourceComplete, proof/timeBasis, effectiveAt 또는 효과별 effectiveTimes로 닫힌 source 관측 기록. 기존 미리보기로 수량·매핑을 구성하고 DB 스냅샷 키와 timestamp를 재검증 |
| run | 최대 50개 작업 claim/Shadow 정산. 외부 조회는 재고 잠금 밖에서 수행 |
| status | jobId로 최종 상태, 실패 사유, 다음 조건, 시도별 결과 조회. lease token은 반환하지 않음 |
| movement | 기존 logId에 count/purchase/physical_return/adjustment의 실제 effectiveAt과 근거 연결. 기존 로그나 재고를 변경/생성하지 않음 |
| compare | itemId의 최신 실사·이동·정산으로 잔액 비교를 다시 기록. 같은 결과는 중복 저장하지 않음 |
| resolve_timing / resolve_plan | 판단 불가 시각 또는 구간별 물리 이벤트를 새 증거 행으로 보완. 기존 버전·시도 보존. 분리 계획은 품목별 총 수요를 바꿀 수 없음 |
| retry | 해당 품목/버전의 실사·이동·계획·정산 근거가 실제 바뀐 경우만 같은 job을 다시 대기열에 넣음. 무관한 품목 정산은 재시도 조건이 아님 |
| confirm_coverage | 실사 기준점에 대한 source feed 완전성 증거 추가. 미확인 상태는 projectionComplete=false로 표시 |

sourceSequence는 검증된 upstream 순번이며 receipt.updated_at이나 서버 시각으로 만들어 넣으면 안 된다. source 순서를 모르면 원본 관측과 source_order_unknown을 보존한다. ref_date만으로 수정의 물리적 의미를 추정하지 않는다. DB 수집이 여러 요청으로 나뉘는 기존 sync에서는 sourceComplete를 자동으로 true로 설정하지 않는다. Keg/manual/불완전 매핑 등 미지원 계획은 자동 0차감으로 완료하지 않고 예외로 표시한다.

## Shadow 비교 결과

합성 데이터로 실제 기존 최초 차감 RPC를 실행하고, 기존 재처리 RPC도 명시적 로컬 ROLLBACK 안에서 호출해 비교했다. 운영 데이터 복제/운영 결과 재조회는 아니다.

| 시나리오 | 기존 계산/행동 | Shadow 결과 |
|---|---|---|
| 글렌피딕 15: 10/9 잔술 0.0714→병 1 정정, 10/11 실사 0.20, 10/12 입고 +1, 지연 재처리 | 원시 차액 -0.9286, 계산 후 0.2714, 실제 RPC는 P0 검토 대기 | 경제 차액 -0.9286, 현재 수량 영향 0, book 1.20, shortage 0, 기존 감사 diff 0 |
| 실사 이후 1→2 판매 수정 | 기존 전량 복구/전량 차감 경로 | 새 버전 current delta -1만 계산 |
| 판매 2 취소 / 실제 2 반환 | 취소가 물리 복구와 혼동될 수 있음 | 취소 경제 +2·물리 0, 실제 반환 이벤트 +2를 별도로 book에 반영 |
| count 0.03 이후 판매 1, 이후 입고 +2 | 부족으로 차감 대기 가능 | book -0.97·shortage 0.97 상태로 정산 완료, 입고 후 1.03·shortage 0, 판매 정산 1회 유지 |
| 실사 전 입고를 실사 후 등록 | 현재 수량에 다시 가산할 위험 | economic/physical event는 보존하고 현재 book에는 중복 가산 0 |
| 동일 관측/동일 완료 토큰 55회 | P1-1 이전 55개 미적용 후보 문제 | 버전·job·settlement·유효 attempt 각 1개, 운영 후보 추가 0 |

## 검증과 증거

새 범위 **24 PASS / 0 FAIL / 0 SKIP**: 판매 버전/대기열 5, 시간순 정산 17, API/worker 2 (native 상위 테스트 각 1 포함). 변경 TS 파일 2개 ESLint 통과. 다음 검증을 수행했다.

- 실사 전/후/정확히 경계 시각, 품목 변경 시 서로 다른 실사 기준, 고정밀 0.0714 및 A→B→A 정산.
- 중복 영수증·55회 재수신, 두 worker claim/완료, 만료 token/잠금 대기 중 만료, SQL 오류 전체 rollback과 backoff 후 회복.
- 재고 부족·입고 지연·판매 취소·실물 반품·불명확 시각의 증거 보완·동일 버전 회복·무관한 변경에 재시도하지 않음.
- 실사가 먼저 commit된 경우와 worker가 먼저 commit된 경우의 실제 독립 세션 잠금. 미확인 실사/이동 근거는 추정하지 않음.
- 실제 서버 TS→로컬 DB RPC 연결, source lines 변경 중 freshness 차단, 기본 비활성·권한·live 모드 거부·SQL DETAIL 비노출.
- 기존 재고/판매/차감/로그 전체 JSON 스냅샷 불변, 기존 함수 catalog/본문 불변, 새 private 감사 접근·변경 거부.

최종 native 증거: `.qa-review/pg-native-logs/pg-native-test-3f7bf72b-46db-4117-a973-e64ec3b657c9-e0LfrD/` (정산 17), `pg-native-test-a43302ec-07d3-45b8-b5bf-c9821186917c-n9Hkxe/` (원장 5). 각 result.json의 통과·정상 종료·임시 데이터 정리를 확인했다. API/worker 2 PASS와 ESLint는 같은 코드의 유효 결과를 재사용했다. 마지막 변경인 불완전 source 관측의 버전 생성 방지만 해당 원장 범위로 재검증했다.

기존 P1-1 41 PASS와 변경하지 않은 P0 계약의 검증은 재사용했으며 새로 실행한 수에 합산하지 않았다. 전체 TypeScript·Build·전체 회귀·원격 advisors·실제 POS/HTTP 서비스 통합은 실행하지 않았다. 실패한 중간 개발 실행은 PASS 증거에 포함하지 않았다.

## 활성화 전 절차와 남은 위험

1. 새 SQL 두 파일 `20261102103506_pos_shadow_sale_versions_and_jobs.sql`, `20261102103822_pos_shadow_temporal_settlement.sql`을 **최종 HEAD 내용으로 함께 검토**한다. 이번 작업에서 만든 미적용 파일만 작성/보완했으며, 기존 적용 Migration은 변경하지 않았다. 별도 운영 승인 전에는 설치하지 않는다.
2. 승인 후에도 우선 Shadow만 설치·사용한다. 기본 비활성을 유지하고, 닫힌 POS source snapshot·upstream revision/순번·실제 거래시각·실사 시각/완전성 증거를 검증한 제한 범위에서만 opt-in한다. 현재 endpoint는 명시적 로컬/pilot 실행 경로이며 실시간 source 자동 수집 hook은 연결하지 않았다.
3. 운영 입력의 시간·매핑·수집 완전성을 증명하지 못한 결과는 projectionComplete=false 또는 needs_review다. 실제 데이터로 source ordering, 순번 reset/충돌, 실사 측정 구간과 지연 저장을 검증해야 한다. 부족한 과거 이력을 추정 생성하거나 기존 55/150개 후보를 자동 복구하지 않는다.
4. 이 단계의 signed book·부족은 private Shadow 값이다. 기존 재고 화면/입고/수정 RPC는 이 값을 사용하지 않는다. **운영 재고 writer 전환 코드는 활성화하지 않았으며 live 모드 자체가 없다.** 실제 활성화는 모든 재고 writer/reader의 signed balance·epoch/revision 계약, opening legacy 연결/잔차, 이중 writer fence, 회계 평가를 별도 Migration과 검증으로 마친 뒤 진행한다.
5. lease 30초, 최대 batch 50, 순차 버전 처리는 bounded pilot 기준이다. 현재 관련 ledger/log 조회 성능·보존 기간·재시도 알림/예산은 운영 규모에서 추가 검증한다. SQL 예상 외 오류는 시도 이력과 재시도 조건을 보존하며 운영 writer로 fallback하지 않는다.
6. P0 제거는 기존 설계 9절대로 운영 Shadow/canary·실제 실사 포함 검증 이후 별도 승인/후속 Migration이다. 지금 P0와 기존 경로는 유지했다. 이번 구현을 운영 자동 정산 전체의 PASS로 확대하지 않는다.

단계 커밋: `4ff46e3b`(판매 버전/대기열), 이 보고서를 포함한 후속 커밋(정산·Shadow API·비교 검증). 최종 SHA는 작업 완료 응답에 기록한다.
