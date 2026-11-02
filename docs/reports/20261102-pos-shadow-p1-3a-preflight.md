# POS P1-3A 운영 Shadow 도입 사전점검

기준 main: `ebe33d7ae1ab13ae9b65e2ccc879d952d139dd70`. 정본 [P1-2F](20261102-pos-signed-p1-2f-readiness.md)의 구현·PASS를 재사용한다. 이번에는 운영 읽기 전용 조사, Production 소스 대조, **새 검증 범위인 9개 Migration의 연속 설치·관찰 격리**만 추가했다. 기능 코드·Migration은 수정하지 않았다.

| 최종 판정 | 결과 |
|---|---|
| 현재 준비본으로 운영 Shadow 관찰 도입 | **BLOCKED** — Production 코드/보호 계약의 불일치, 설치 이력 차이, 외부 Writer 호환성 미확정 |
| 신형 엔진의 실제 재고 적용 | **BLOCKED** — 위 조건 외에 공급자/물리 시각/과거 편입 증거와 실제 수량 적용·reader 전환도 미완 |

공급자 완전성 미확인 자체가 모든 관찰을 금지하는 것은 아니다. 안전한 설치·코드 호환성을 먼저 확보하면 불완전성을 명시한 제한 관찰은 가능하다. 그 결과를 확정 정산으로 승격할 수는 없다. 이번에는 운영 Migration·Push·배포·Shadow 활성화·P0 제거·데이터 수정·수량 재계산을 하지 않았다.

## 1. 운영 증거와 우회 경로

2026-11-02 UTC에 BABA 운영 DB를 `supabase db query --remote --read-only`로 조회했다. 각 업무 조회 응답의 `transaction_read_only=on`을 확인했다. SELECT 외 업무 RPC는 호출하지 않았다. 재현 SQL은 `supabase/verification/20261102_pos_p1_3a_{metadata,history,item47}_readonly.sql`; 권한·트리거는 기존 `20261102_pos_p1_2f_catalog_readonly.sql`을 현재 상태로 다시 조회했다. 비밀 값·고객·결제 상세·담당자 이름은 수집하지 않았다.

Vercel의 deployments list/inspect 및 프로젝트 GET을 읽기 전용 조회했다. 프로젝트 응답은 즉시 필요한 Cron/배포 메타데이터만 추출해 저장했으며 환경변수 값은 출력·저장하지 않았다.

| 확인 사항 | 증거 / 판정 |
|---|---|
| 실제 Production | `baba-staff-app.vercel.app` alias가 있는 READY deployment의 SHA는 **`a403bc33d38c1dc33af41da5d9e12c52d5e0eb4c`**. 요청 기준 main과 다름 |
| DB 설치 | 최신 기록 `20261101180623`; P1 private schema 및 P1 신형 함수 없음 |
| P0/기존 guard | P0 boundary, 입고 정정 guard 2개, receipt updated_at trigger 모두 enabled O. 보존 조건 PASS |
| P1-1 사전조건 | 운영 reprocess 본문의 LF MD5 `2c1c389e352d91c7b3632fcc713c81bd`로 Migration의 예상 값과 일치 |
| 함수 권한 | 조사된 재고 Writer는 postgres 소유 definer, service 실행 가능, anon/authenticated 실행 불가 |
| 직접 수량 우회 | service_role은 BYPASSRLS + inventory INSERT/UPDATE/DELETE/TRUNCATE 권한 보유. 현재 공통 원장 trigger가 없어 직접 DML이 원장을 우회할 수 있음. anon/auth도 광범위 table grant가 있으나 행 DML은 RLS와 구분해야 함; TRUNCATE는 별도 위험 |
| owner 경계 | postgres/관리자·superuser의 직접 SQL/trigger 변경은 신뢰 경계. 공통 Writer가 이들을 완전히 차단한다고 보지 않음 |
| 추가 DB 경로 | supplier alias v1~v4는 기존 inventory 메타데이터 Writer. 사진은 직접 image/수정 메타데이터 UPDATE와 0차이 로그 INSERT. 신형 권한 적용 전 이 호환성 유지 필요 |
| 과거 미등록 출처 | 전체 로그 14,170건 중 `system` 135건, source/reason 없는 과거 로그 1,674건. 출처 명칭만으로 현재 실행 주체·물리 사건을 확정할 수 없음 |
| DB Cron | cron schema/job 테이블은 현재 카탈로그에 없음. `cron.database_name=postgres`, worker 설정/관측만으로 실제 작업을 추정하지 않음. 외부 배치·키 소유자는 여전히 미확인 |

**실제 Vercel Cron은 활성 상태로 10개 정의가 등록되어 있으며, 위 Production SHA의 vercel.json과 일치한다.**

| 경로 | UTC 일정 | 영향 |
|---|---|---|
| `/api/cron/sales-sync` / `sales-sync-final` | `*/5 10-18 * * *` / `0 20 * * *` | 기존 POS 수집→영수증/품목/결제 저장. Shadow 관찰로 호출 금지 |
| `/api/cron/sales-deductions` / `sales-deductions-final` | `*/15 10-18 * * *` / `5 20 * * *` | 구형 차감·재처리·취소 RPC. 설치 창에서 충돌 통제가 필요 |
| `/api/inventory/snapshot` | `0 20 * * *` | inventory를 읽어 snapshot batch/items 저장. 실물 실사나 수량 Writer가 아님 |
| ledger-meal-auto-post / ledger-meal-source-sync / ledger-reserve-schedule | `0 11` / `50 19` / `17 20`(매일) | 장부 작업. Shadow의 부작용과 기존 정상 배치의 변경을 구분해야 함 |
| sales-close-final / payroll-quyen-menu-incentive | `5 20` / `15 20`(매일) | 영업 마감/급여. Shadow 관찰 대상으로 실행하지 않음 |

Vercel 경로 조사 PASS는 외부 서버·수동 SQL·다른 서비스 키 보유자가 없다는 증명이 아니다. 기능 플래그의 운영 값을 읽거나 변경하지 않았다. 현재 Production 소스 자체에는 새 Shadow 경로가 없다.

## 2. 실제 단위·시각·취소/복구 대조

- 현재 품목 설정은 76개 단위/용량 조합이며 용량 미설정은 **409개**다. item **47 = 글렌피딕 15 / Glenfiddich 15**, 현재 `Chai`, `700 ml` 설정을 확인했다. 현재 설정만으로 10월 9일의 용량 epoch까지 증명하지는 못한다.
- 기존 inventory_logs에는 구조화된 실제 이동시각 `effective_at`이 없다. created_at은 DB 반영시각, business_date는 영업일이다. 날짜 차이는 지연·소급 등록뿐 아니라 영업일 경계일 수도 있으므로 차이 자체를 오류로 판정하지 않는다. note 존재도 검증된 물리 시각 증거로 승격하지 않는다.
- DB 영수증 7,343건 모두 ref_date가 있다. raw ModifiedDate가 있는 것은 7,294건이다. ModifiedDate의 존재·현재 저장된 원문만으로 단조 수정 순번, 과거 버전 순서, 삭제 완전성을 증명할 수 없다.
- 실행 흔적이 있는 차감/복구 **1,748건**, 이 중 복구 **49건/35개 영수증**을 대조했다. 모두 `reprocess_modified` 복구다. 같은 원차감에 대한 중복 실행 복구 대상 0, 원차감 연결 누락 0, 연결 감사 로그 누락 0. **관측된 중복 복구 위험 점검 PASS**이며 모든 미래 중복 방지를 운영 검증한 것은 아니다.
- 취소 영수증 148개, 취소 영수증의 활성 차감 0, 취소 영수증의 실행 복구 0이었다. 실물 반환을 입증하는 비POS 양수 이동의 영수증 연결도 0이다. 따라서 실제 판매취소 복구·실반품 운영 시나리오가 검증됐다고 할 수 없다. 연결 없음은 실반품이 없었다는 뜻도 아니다.
- 현재 단위 `Chai`로 연결되는 차감 293건·복구 3건에서 log delta와 원장 목표의 소수 정밀도 차이를 확인했다. 원문 보존·정밀도 차이 추적이 필요하며 자동 보정하지 않는다.

영수증 **8111**의 실제 이력:

| 사건 | DB 반영시각 UTC / 원본 기록 |
|---|---|
| 최초 잔술 차감 | 10/9 13:00:27, deduction 1559, 목표 0.0714병 / log 12861 delta -0.07병 |
| 실사 기록 | 10/11 11:12:18, log 13008, 0.20병 |
| 입고 기록 | 10/12 11:37:04, log 13104, +1병 |
| 지연 수정 재처리 | 10/12 12:00:27, revert 1660→1559(log 13108 +0.07), 새 차감 1658(log 13109 -1병) |

이는 기록의 존재·반영 순서를 확인한 것이며 실물 이동시각이나 현재 적정 수량을 새로 확정한 결과가 아니다. 특히 **8111은 revert가 있으므로 현재 F `adopt_receipt`의 일괄 과거 reversal 보호에 걸린다.** 나머지 34개도 동일하게 자동 편입할 수 없다. raw timeline/보류 관찰은 가능하지만 이들을 F signed 비교의 정상 편입 성공 사례로 제시하면 안 된다.

자동 확정에서 제외할 기준은 다음으로 확정한다: 미증명 단위/용량 epoch, 시각·시간대·실사 포함 관계 미확인, 당시 환산/정밀도 불명, 과거 복구의 물리 반환 의미 미확인, sourceComplete=false, 원본/현재 head 불일치, 수집 실패/부분 페이지/순서 역전/uncertain, 미등록 Writer 또는 감사 연결 누락. **제외는 판매 사실 삭제나 영구 재처리 금지가 아니라 보류·근거 보완 후 재평가**다. Shadow에는 보류 사유를 그대로 남긴다. 일일 DB snapshot은 실물 확인 기준점으로 사용하지 않는다.

## 3. 독립 대조가 증명하는 범위

공급자 계약은 P1-2F에서 확인한 [paging](https://graphapi.cukcuk.vn/document/api/sainvoices_paging.html) / [detail](https://graphapi.cukcuk.vn/document/api/sainvoices_detail.html) 증거를 재사용한다. 실제 POS API를 이번에 호출하지 않았다. 원본 순번·snapshot·삭제 완전성은 계속 미확인이다.

독립 자료의 scope/branch/영업일/시간 구간/cutoff가 같고 전체 ID·내용 hash·금액·취소 상태가 같다면 **해당 cutoff/영업일 자료와의 대조 일치**를 증명할 수 있다. 건수·총액만 같은 수정, 추가/누락, 취소 역전은 별도로 검사해야 한다. 영업일별 누락 ID는 기존 최근 7영업일 + 명시적 과거 gap 재수집 대상으로 반환할 수 있다.

일치해도 cutoff 뒤 늦은 수정·삭제, 문서 진정성, 문서 자체의 누락, 물리 이동시각, 공급자 버전 순서까지 증명하지는 못한다. 동일 수집 DB의 마감 합계/반복 스캔/캐시를 독립 원본으로 간주하지 않는다. 외부 문서와 export adapter가 아직 검증되지 않았으므로 결과는 `matched_provisional`, sourceComplete/automaticConfirmation=false를 유지한다. **이 제한은 관찰 정책 PASS, 실제 확정 근거는 BLOCKED**다.

## 4. Migration 의존성·Production 호환성

운영 이력은 140개, 로컬 SQL은 217개다. `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`을 읽기 전용 실행해 로컬 파일명 버전과 대조했다. 로컬 중 운영 이력에 없는 파일은 **80개 = 과거 71개 + 이번 9개**, 운영에만 있는 버전은 **3개(`20260917094840`, `20260924135025`, `20260928142712`)**다. 이력 불일치가 곧 객체 부재를 뜻하지 않는다. 실제 구형 POS 객체는 존재한다. **일반 db push / include-all / 과거 파일 재실행 / migration repair를 이번 설치 방식으로 사용하면 안 된다.** 이력은 변경하지 않았다.

P0는 이미 설치되어 있으므로 재실행하지 않는다. 향후 승인 대상 의존 순서는 아래 9개다. 순서는 로컬에서 실제 SQL 전체를 연속 설치해 확인했다.

| 순서 | Migration | 의존/설치 영향 |
|---|---|---|
| 1 | `20261102101859_pos_reprocess_failure_persistence_and_dedup.sql` | P0/원본 해시 필요. 재처리 함수 교체 + wrapper/중복 키. 구형 처리 동작도 바뀜 |
| 2 | `20261102103506_pos_shadow_sale_versions_and_jobs.sql` | 1/P0 필요. private 버전/작업 원장 |
| 3 | `20261102103822_pos_shadow_temporal_settlement.sql` | 2 필요. private 정산/비교 |
| 4 | `20261102110828_pos_shadow_writer_contract_and_order.sql` | 2/3 필요. 감사 원문 읽기 계약 |
| 5 | `20261102113150_pos_reliable_cukcuk_ingestion.sql` | 기존 POS schema 필요. 수집 원장/함수. 설치만으로 수집하지 않지만 commit/resolve는 실제 영수증·품목·결제를 쓰므로 관찰 호출 금지 |
| 6 | `20261102120035_inventory_writer_event_journal.sql` | 4 필요. **즉시 활성** 공통 trigger, 전역 잠금, 감사 불변/삭제 차단 |
| 7 | `20261102120303_inventory_writer_shadow_integration.sql` | 1/5/6 및 기존 Writer 필요. **즉시** RPC prelude/등록 fence. 6과의 중간 상태 노출 금지 |
| 8 | `20261102142849_pos_signed_projection_epochs_and_handoff.sql` | 7 필요. private epoch/해석 + 기존 4진입점 fence. handoff 행은 만들지 않음 |
| 9 | `20261102144000_pos_writer_least_privilege_and_day_reconciliation.sql` | 5/7/8 필요. **즉시** 직접 DML 권한 회수·직접 로그 guard + 대조 함수 |

**새로 확인한 Production 불일치:** 현재 배포의 DELETE는 POS deductions→mappings→inventory_logs 등을 별도 요청으로 삭제한다. 현재 main의 선제 `inventory_history_preservation_required` 보호가 아직 배포되지 않았다. 6/9를 먼저 설치하면 뒤쪽 감사 삭제가 거절되기 전에 앞쪽 POS 참조 삭제가 확정될 수 있다. 따라서 DB 선설치 후 나중에 앱을 바꾸는 순서는 안전하지 않다.

또한 main도 `INVENTORY_WRITER_MODE`가 journal이 아니면 이력이 없는 품목의 hard delete를 시도할 수 있지만 6은 이를 무조건 거절한다. Shadow 관찰 때문에 journal 모드까지 켜서 이 차이를 숨기지 않는다. 모든 hard delete를 첫 요청 전에 보존 정책 409로 반환하도록 최소 호환 보완이 필요하다. 미등록 외부 수량 DML, 새 잠금에 따른 40001/42501 처리도 운영 호환성 조건이다. 기존 코드가 P1-1 새 wrapper를 쓰도록 바뀌어야 중복 preview 방지 효과도 실제 경로에 적용된다.

최소 수정/해소 순서:

1. **P1-3B 호환 수정:** 플래그에 무관한 hard delete 선차단, 기존 main의 이력 보존 보호를 포함한 배포 묶음, 신규 DB 오류의 안전한 retry/409 계약을 확정한다. 새 기능/전체 Writer 재작성은 필요 없다.
2. **설치 실행 묶음 확정:** 과거 71개를 제외하고 위 9개만 대상으로 하는 명시적 적용 절차·각 대상 객체/권한·실패 시 중단/복구 절차를 검토한다. 파일별 BEGIN/COMMIT을 무시한 임의 합치기나 무검토 CLI push는 하지 않는다. 앱 보호를 먼저 갖추고 6→9 중간 상태와 Cron/수동 Writer 경합을 통제해야 한다.
3. **Shadow 대상 제한:** 우선 실제 unit/time 증거가 있고 revert 없는 표본만 선정한다. 8111/35개를 포함하려면 reprocess rollback과 경제 취소/실물 반환을 구별하고, reversal 쌍과 활성 차감을 대조하는 **관찰용 편입 정책**을 보완해야 한다. 현재 guard를 단순 제거하거나 원본 차감 이력을 고치지 않는다. exclusive handoff는 계속 금지한다.
4. **외부 소유권:** service key 사용 주체·직접 SQL/배치와 미등록 system 로그 경로의 소유자를 확인한다. 권한 회수 후 정상 업무를 막지 않는다는 증거가 필요하다. 공급자 완전성은 제한 관찰을 허용하되 실제 정산 적용의 차단 사유로 유지한다.

## 5. 관찰 부작용 검증·계획·다음 승인

새 검사 `tests/pos-shadow-installation-preflight-postgres.test.mjs` **1 PASS**. 기존 기능 PASS를 다시 돌리지 않고 기반 schema 구성만 재사용해 P1 9개 설치를 모두 보류한 뒤 지정 순서로 실행했다. 전체 fixture public 테이블(재고/판매/결제/장부 관련 포함)의 행을 설치 전후와 capture/claim/settle/compare/inspect 관찰 전후에 비교해 동일함을 확인했다. P0 본문 불변, handoff 0도 확인했다. 로컬 임시 DB는 삭제했고 증거는 `.qa-review/pg-native-logs/pg-native-test-cff6eb90-b11f-4291-a7ec-f0d86d837f25-Qp5at8`에 보존했다.

동시에, 플래그 없이 DELETE가 immutable 오류, 직접 수량 UPDATE가 42501로 바뀌는 것을 확인했다. **업무 행 backfill 없음/관찰 함수의 쓰기 격리는 PASS지만, 설치의 동작·잠금·권한 부작용 없음은 BLOCKED**다. 이는 실제 Production schema 전체 복제나 운영 부하 검증을 대신하지 않는다. P1-2F 22개 및 이전 유효 PASS를 범위에 맞게 재사용했고 Build/전체 TS/기존 테스트를 반복하지 않았다.

| 차단 조건별 판정 | Shadow 관찰 | 실제 수량 적용 |
|---|---|---|
| 관찰 경로의 업무 행 비변경 / P0 유지 | 로컬 PASS | 운영 전환 증거로 확대 불가 |
| 현재 Production 삭제/오류 처리 + 무조건 활성 DB fence | **BLOCKED** | **BLOCKED** |
| 이력 차이를 제외한 명시적 설치 묶음 / 외부 Writer 호환 | **BLOCKED** | **BLOCKED** |
| 불확실 단위·시각·미완전 원본을 보류하는 정책 | PASS(제한 표본 관찰) | 해당 데이터 **BLOCKED** |
| 8111 및 과거 revert 35개 F 자동 편입 | 해당 signed 비교 **BLOCKED**, 원문/보류 관찰 가능 | **BLOCKED** |
| 인증된 독립 마감 자료/공급자 순서·삭제 보장 | provisional 관찰 가능 | **BLOCKED** |
| signed 실재고 적용·reader 전환 구현/운영 검증 | 관찰 범위 밖 | **BLOCKED** |

차단 해소 후의 **관찰 계획**: 보호 코드와 설치 묶음 별도 검토 → 승인된 설치/배포 → 플래그는 계속 off 상태로 대상·권한·P0·Cron/정상 Writer 확인 → **관찰 활성화 별도 승인** → owner/master의 소수 표본 capture/status/읽기 비교부터 시작한다. reliable ingestion 활성화/commit/resolve, 기존 수집·차감·마감 Cron 수동 실행, exclusive handoff는 관찰 절차에 포함하지 않는다. 물리 근거 등록도 private 기록만 허용한다.

관찰 시 보류 사유·미등록 Writer·수량/정밀도 차이·재시도·잠금 지연을 기록하고 sourceComplete=false/automaticConfirmation=false를 유지한다. 기존 정상 Cron의 업무 변경을 Shadow 호출의 변경으로 오인하지 않도록 요청 범위/시각을 구분한다. P0/감사 불변 훼손, 관찰에 의한 업무 DML, handoff 발생, 새 Writer 오류·잠금 지연이 확인되면 관찰 호출을 중단한다. 공유 gate로 인한 잠금/부하는 실제 관찰에서 측정해야 한다.

**다음 승인 지점:** 먼저 위 최소 호환 보완과 대상 9개에 한정된 실행 묶음 검토. 그 결과가 준비된 뒤 **운영 Migration 적용**, **코드 Push/배포**, **Shadow 관찰 활성화**를 각각 승인받는다. 실제 수량 적용 및 P0 제거는 이 승인에 포함하지 않는다. 이번 단계는 승인 요청이나 활성화를 실행하지 않았다.
