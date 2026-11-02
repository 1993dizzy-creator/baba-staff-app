# POS P1-2F 구현 및 운영 전환 판정

기준: 원본 main `69708d85b62b642dbe5d065f48c57ca662bbabce`. 기존 정본은 [P1-2E](20261102-pos-writer-p1-2e-implementation.md), 수집 계약은 [P1-2D](20261102-pos-reliable-ingestion-p1-2d.md)를 유지한다. 이 문서는 새 구현과 실제 확인 결과만 추가한다.

**판정: 로컬 구현·영향 범위 검증 PASS. 운영 자동 정산 전환은 BLOCKED.** 로컬 Shadow 관찰 인터페이스는 구현했다. 현재 운영에는 P1 함수가 없으므로 운영 Shadow 관찰도 별도 Migration/배포 승인 이후 가능하다. Shadow 기본 비활성, 공급자 완전성 false, P0 보호를 유지했다. 운영 조회는 읽기 전용으로만 수행했으며 운영 DDL/DML·재계산·Migration 적용·Push·배포는 하지 않았다.

## 1. 실제 구현

### 판매 복구 경로와 Shadow 관찰 분리

`20261102142849_pos_signed_projection_epochs_and_handoff.sql`:

- 기존 Writer 이벤트·감사 연결을 재사용하고, 단위 epoch, 이벤트 해석 개정, 영수증 기준/판매 해석 버전, 전환 기록과 비교 결과를 append-only로 추가한다. 기존 판매차감·로그·입고 원문은 변경하지 않는다.
- `pos_signed_adopt_receipt`는 현재 적용된 차감 ID·품목·수량·단위의 정확한 대응과 영수증 updated_at을 확인해 기준을 등록한다. **이 등록만으로 기존 엔진을 차단하지 않는다.** 이후 판매 해석은 이전 목표를 대체하므로 기준 판매와 신규 버전을 합산하지 않는다.
- 별도 `pos_signed_enable_handoff`는 원장 기준 스냅샷이 여전히 같은지 재확인하고 영수증별 **exclusive hold**를 기록한다. 이 함수는 HTTP action으로 제공하지 않는다. Migration은 전환 행을 만들지 않는다. 현재 단계에서 운영 호출하면 안 된다. 이 hold는 신형 수량 적용 활성화 기능이 아니다.
- hold 영수증에는 최초 배치 차감, prepare 재처리, 직접 재처리, 취소 복구의 4개 진입점을 모두 차단한다. 혼합 배치는 전부 hold해 부분 구형 반영을 피한다. 원본 상태·오류·후속 판단 사유를 기록하고 같은 요청은 재사용한다. 55회 prepare 호출에도 새 preview batch/복구 로그/수량 변화가 없다.
- 이전 RPC OID·ACL·기본 인자는 보존한다. P1-2E의 immutable 함수 계약은 수정하지 않고 successor body를 따로 저장한다. 공통 dispatcher·수량 guard·inspect가 successor를 확인하며 실제 본문 drift는 계속 차단한다.
- 단순 취소 버전은 기존 물리 소비 목표를 유지한다. 실물 반환은 별도 `physical_return` Writer 이벤트로 해석한다. 과거 legacy revert가 있는 영수증은 물품 반환 여부를 추정하지 않고 `SIGNED_HISTORIC_REVERSAL_REQUIRES_PHYSICAL_RECONCILIATION`으로 기준 편입을 보류한다.
- 미전환 영수증의 기존 부족 실패→입고→재처리 성공→취소·중복 취소 결과를 F 설치 전후 실제 RPC로 비교해 동일함을 확인했다. 실패 영수증 전체를 영구 제외하는 조건은 추가하지 않았다.

### 단위·이동시각·signed balance

- 품목별 기준 차원은 `ml / g / each`, 단위 환산은 양의 정수 분자/분모로 명시한다. 700ml 병이나 50ml 잔을 전 품목에 기본 적용하지 않는다. 설정 근거와 owner/master 확인이 필요하다.
- `numeric` 계산은 반올림 없이 정확히 계산한다. 12자리 이내 정확한 표현이 불가능한 비율은 거절한다. 기존 2자리 재고를 고쳐서 맞추지 않는다. 합성 0.0714병은 700ml 계약에서 **49.98ml**로 보존하며 50ml로 반올림하지 않는다.
- epoch는 시간순으로만 추가하며 이미 해석한 이벤트/목표를 소급해서 다른 용량으로 해석하는 변경은 거절한다. 새 용량 epoch에는 새로운 확인 실사 기준이 있어야 비교를 재개한다. 기준 차원 변경도 거절한다.
- 기존 Writer log의 source hash·실제 수량 변경/감사 연결을 검증한 후 `effective_at` 해석을 개정한다. 저장시각을 물리 이동시각으로 대입하지 않는다. 시간대 없는 날짜·미래 시각·미확인 단위는 거절한다.
- 케그 edit-start 이벤트는 기존 교체 log ID, before/after 시작시각과 연결해 해석 개정을 추가할 수 있다. 기존 움직임·케그 감사 이력은 재작성하지 않는다. 미해결 timing 이벤트는 pending으로 남는다.
- 계산은 마지막 확인 실사 + 이후 물리 이동 - 이후 영수증별 최신 물리 소비 목표다. 실사 이전/같은 시각 거래는 기준에 흡수한다. 동일 시각 실사 선택은 source log ID로 결정한다. 이는 실제 물리 선후를 증명하지 않으므로 자동 확정은 계속 false다.
- `bookQuantity`는 음수도 그대로 보존하고 `shortage`는 부족 규모를 별도로 표시한다. 실제 `inventory.quantity`는 비교 RPC에서 변경하지 않는다. 운영 수량도 같은 기준 단위로 환산해 `differenceToOperating`을 보여준다. 모든 비교 결과는 `sourceComplete=false`, `automaticConfirmation=false`다.
- 기존 공통 gate → 영수증/품목 잠금 → CAS 계약을 유지한다. 전역 gate의 운영 처리량·대기 SLA는 여전히 측정이 필요하다.

### 권한과 영업일 대조

`20261102144000_pos_writer_least_privilege_and_day_reconciliation.sql`:

- 등록 RPC가 postgres 소유·security definer이며 본문이 계약과 일치하는지 먼저 확인한다.
- inventory의 직접 INSERT/UPDATE/DELETE/TRUNCATE와 남아 있는 column INSERT/UPDATE 권한을 제거한다. 알려진 사진 경로에 필요한 image/수정 메타데이터 UPDATE만 service_role에 남긴다. 등록 재고 RPC의 service_role 실행 권한은 유지한다.
- 로그 UPDATE/DELETE/TRUNCATE를 제거한다. 직접 service 로그 INSERT는 사진·other·동일 전후 수량·차이 0·판매/입고정정 참조 없음으로 제한한다. 사진 로그를 실사·판매·입고·반환으로 위조할 수 없다. 기존 postgres 소유 RPC의 정상 감사 INSERT는 유지한다.
- P1-2D의 committed run·snapshot·observation·head를 재사용해 독립 영업일 자료와 ID/내용 hash/금액/취소 상태를 비교한다. 전체 건수·합계만 같은 수정·취소 역전도 탐지한다.
- 외부 자료는 scope/branch/영업일/시간 구간/cutoff/문서 SHA256/자료 종류/근거와 전체 항목을 요구한다. 수집 시작이 외부 cutoff 이후이고 해당 영업일 수집이 완결되어야 한다. 현재 head가 달라졌거나 uncertain/admin-protected 관측이면 보류한다.
- 누락·추가·내용 변경 ID와 복구 영업일을 기록한다. P1-2D의 최근 7영업일 및 명시적 과거 gap 재수집 경로를 그대로 사용한다. 수집 run 잠금은 D와 같은 **scope → run row** 순서다.
- 결과가 같아도 `matched_provisional`이다. 제출 문서의 진정성이나 공급자 수정 순서를 코드가 독자적으로 증명할 수 없기 때문에 sourceComplete/자동 확정을 올리지 않는다. 총액만 있는 export나 다른 형식의 미정규화 hash는 확정 근거가 아니다. 실제 외부 export adapter/운영 마감 자료는 아직 공급받지 않았다.

## 2. 전체 Writer 및 운영 우회 조사

P1-2C/E Writer 목록은 유지한다. 이번에는 동일 목록을 운영 카탈로그와 대조했다.

| Writer | 기존 공통 경로/이번 F 처리 |
|---|---|
| POS 최초 차감 | `apply_sales_inventory_deduction_batch`; hold 포함 배치 원자 보류 |
| POS 재처리 준비/실행 | `prepare_and_apply_sales_inventory_reprocess`, `reprocess_modified_sales_inventory_deduction_receipt`; hold면 복구·preview 이전에 route |
| POS 취소 복구 | `rollback_canceled_sales_inventory_deduction_receipt`; hold면 수량 복구 차단 |
| 빠른 저장·실사·일반 수정·관리자 저장 | `inventory_update_with_audit_v1`; 기존 gate/CAS/audit 유지, 개별 단위·시각 해석 가능 |
| 신규 재고·초기 입고 | `inventory_create_with_receipt_v1`; 동일 계약 유지 |
| 입고·입고정정 | 일반 저장 및 `inventory_apply_purchase_correction_v1/v2/v3`, `inventory_apply_purchase_receipt_edit_v1`; 로그 원문 보존, 소급 effective_at 개정 지원 |
| 케그 교체·관리 | `inventory_apply_keg_change`, `replace_inventory_keg` 4/5인자; 용량 epoch·시작시각 개정 지원 |
| 실제 물품 반환 | 일반 감사 Writer의 별도 `physical_return` 사건; 취소 복구와 합치지 않음 |
| 사진 | 직접 metadata UPDATE/0차이 로그 INSERT 유지, 수량·기준점 위조 차단 |
| 거래처 alias 검토 | 운영 `business_partner_review_supplier_alias_v1/v2/v3/v4`가 inventory 메타데이터 UPDATE. 기존 definer/ACL 유지 |
| 크론/자동 보정 | 저장소의 sales-deductions/final은 기존 POS RPC 사용. inventory snapshot은 수량 Writer가 아님. 미등록 직접 수량 배치는 공통 DB fence/권한으로 거절하도록 준비 |
| SQL Editor·DB owner·외부 서비스 | 아래 신뢰 경계/미확인 사항 유지 |

운영 조회 시점: **2026-11-02 14:48 UTC**. CLI `db query --remote --read-only`로 실행했고 DB 응답의 `transaction_read_only=on`을 두 번 확인했다. 재현 SQL은 `supabase/verification/20261102_pos_p1_2f_{catalog,policy_units}_readonly.sql` 두 파일이다. 판매·실재고 수량/영수증/감사 행은 읽거나 변경하지 않았고 단위 설정은 익명 집계만 조회했다.

| 운영 확인 | 결과 |
|---|---|
| 설치된 신형 함수 | P1 ingest/shadow/writer/prepare/signed 함수 없음. 로컬 구현을 운영 설치로 간주하지 않음 |
| P0 | `inventory_logs_pos_stock_check_boundary` enabled O. 입고 정정 guard 2개·영수증 updated_at trigger도 확인 |
| 재고/로그 수량 타입 | inventory.quantity와 로그 prev/new/change 모두 numeric(10,2) |
| 단위 설정 | 76개 설정 조합, 용량 미설정 409개. 병/잔/케그 일괄 환산 불가 |
| RLS | inventory/logs enabled, not forced, 정책 없음. anon/authenticated 행 DML은 RLS로 제한되나 table TRUNCATE 권한은 별도 위험 |
| 직접 DML | anon/authenticated/service_role에 광범위 table DML grant 존재. service_role은 BYPASSRLS여서 직접 수량 우회 가능 |
| 기존 수량 RPC | 조사된 함수는 postgres 소유 security definer, service 실행 가능, anon/authenticated 실행 불가 |
| 관리자 신뢰 경계 | postgres는 owner/BYPASSRLS, supabase_admin은 superuser. 이들의 DDL·trigger disable·raw SQL까지 권한 Migration으로 금지했다고 주장하지 않음 |
| 접속/스케줄 | PostgREST authenticator 및 pg_cron/pg_net worker 관측. 이 DB에서 cron.job은 보이지 않음. 외부 작업이 없다는 증거가 아님 |

읽기 전용 카탈로그 함수 분류는 본문 정적 검색에 기반한다. 동적 SQL·다른 DB의 cron·외부 서비스 키 보유자·SQL Editor 실제 사용 주체까지 완전하게 식별한 결과는 아니다. 운영 역할/키 소유권과 실제 배치 계약이 확인되기 전 권한 Migration의 운영 호환성을 확정하지 않는다. 저장소 vercel.json의 snapshot, sales-sync/final, sales-deductions/final 일정은 확인했으나 운영 배포와 동일한지는 별도 확인이 필요하다.

## 3. 공급자 계약 증거와 보류 정책

[CUKCUK paging 공식 문서](https://graphapi.cukcuk.vn/document/api/sainvoices_paging.html)는 Page/Limit(최대 100), Total, RefId/RefDate/상태 등을 설명한다. [detail 공식 문서](https://graphapi.cukcuk.vn/document/api/sainvoices_detail.html)는 RefID/RefDetailID와 품목·결제를 설명한다. 두 문서를 이번 단계에서 다시 열어 확인했다. 실제 POS 자격 증명으로 테스트 API를 호출하지 않았다.

이 문서에서 단조 수정 순번, 고정 snapshot token, 삭제 이벤트 스트림, 페이지 변경 중 완전성 보장, LastSyncDate의 수정/삭제 포함 범위를 입증하지 못했다. 이는 공급자 전체 계약에 보장이 없다는 단정이 아니다. 날짜 필드는 관측 메타데이터이며 원본 순번으로 사용하지 않는다. 두 번 같은 목록을 받아도 공급자 snapshot으로 승격하지 않는다. 공식 예시에 시간대 없는 RefDate도 있어 점포 시간대 계약 없이는 거래시각을 확정할 수 없다.

불완전/순서 불확실 관측은 기존 P1-2D의 보류 상태를 유지한다. 독립 영업일 자료 대조가 일치하면 관찰 증거는 강화되지만, 자료 진정성·동일 cutoff·늦은 수정/삭제 처리 정책·실제 이동시각을 확인하기 전 자동 정산 완료로 확정하지 않는다. 불일치는 삭제/취소를 추정하지 않고 해당 영업일 재수집 대상으로 반환한다.

## 4. 인터페이스와 Shadow 비교 결과

owner/master의 `/api/admin/sales/inventory-shadow/writers`는 기존 `POS_INVENTORY_SHADOW_MODE=shadow`일 때만 `signed_compare`, `define_epoch`, `revise_event`, `adopt_receipt`, `observe_sale`, `reconcile_day`를 추가 허용한다. actor는 인증 사용자로 고정한다. live mode와 enable_handoff action은 거절한다. 계약 위반 SQL 상세/원본 payload를 API 오류로 노출하지 않는다. 자동화 없는 관리자 증거 등록/관찰용 인터페이스이며 공급자 확정이나 실재고 적용 경로가 아니다.

| 합성 비교 시점(700ml/병, 50ml/잔 계약) | signed 결과 |
|---|---|
| 10/9 수정 판매 → 10/11 실사 2병 → 10/12 지연 입고 3병 | 실사 이전 판매는 흡수, book 3500ml |
| 실사 후 판매 1병 → 2병 수정 | 2800 → 2100ml; 기존 목표와 새 목표 중복 합산 없음 |
| 잔술 1잔으로 수정 | 3450ml |
| 판매 8병, 이후 입고 4병 | book -2100/부족 2100 → book 700/부족 0 |
| 결제취소, 이후 실물 1병 반환 | 취소 후 700 유지 → 반환 후 1400ml |
| 앞의 3병 입고를 실사 이전 이동으로 증거 개정 | 실사 기준에 흡수되어 book -700ml; 이전 로그 불변 |
| 30L 케그 2개 → 20L 용량 epoch | 새 실사 전 held; 2개 확인 후 40000ml; 교체 1개 후 20000ml |
| 동일 입력 반복/55회 재처리 | 비교 결과 동일, 새 차감·복구·preview 없음 |

위 수량·증거는 전부 합성이다. 운영 글렌피딕 원장을 재계산하거나 정정한 결과가 아니다. 불확실 물리 사건은 pending에 남기며 모든 결과는 provisional이다.

## 5. 검증·커밋·잔여 차단 조건

검증: **22 tests PASS**(Node 집계의 상위 테스트 포함).

- `tests/pos-signed-handoff-postgres.test.mjs`: 13 PASS. 실제 legacy RPC 전후 비교, 55회 회귀, 단위 정밀도, 실사 전후, 부족/입고, 취소/반환, 시각 소급 개정, 케그·timing, 다중 세션 CAS, 원문 불변, OID/ACL 및 drift 검증.
- `tests/pos-signed-permissions-reconciliation-postgres.test.mjs`: 6 PASS. 실제 role 전환으로 직접 DML/위조 거절·기존 RPC/사진 허용, 영업일 대조 불일치, uncertain/실패 수집 보류, 수집 scope 잠금과 동시 실행 검증.
- `tests/inventory-writer-app.test.mjs`: 3 PASS. HTTP 인증/기본 off/actor 고정/허용 action/별도 handoff 거절/기존 Writer 계약.
- 변경 API ESLint PASS. 해당 API를 root로 한 의존 포함 TypeScript semantic 진단 0. 처음 임시 검사 옵션의 TS5074는 incremental=false로 수정 후 확인했다.
- 전체 Build/전체 TypeScript/무관한 전체 테스트는 실행하지 않았다. P1-1의 미전환 실패 영속화와 P1-2/C/D/E에서 변하지 않은 수집·회계·Writer 상세 경로 PASS를 범위에 맞게 재사용하며 새 엔진 전체 PASS로 확대하지 않는다.

최종 native 증거: `.qa-review/pg-native-logs/pg-native-test-07edb754-9ac2-4b18-8ad0-8e7451f9396d-UIVmsS`(13), `pg-native-test-2fd050d7-f7ff-4238-a163-ac9adb253a93-MuQtiV`(6). 로컬 임시 DB는 종료·삭제했고 로그는 보존했다. 테스트에 운영 DB/POS 자격 증명을 제공하지 않았다. 로컬 증거 파일은 Git 대상이 아니다.

구현 커밋: `224033c2e0ef100eb526270721e5a49447957ff4`(단위/시각/전환 초기 구현), `c2e06e0e53b0b630171b6d41430abf7196f6dda8`(관찰/hold 분리 보완, 권한·영업일 대조·API·최종 검증). 최종 보고서 커밋 SHA는 완료 응답에서 보고한다.

| 우선순위 | 해결된 구현 / 남은 운영 조건 | 판정 |
|---|---|---|
| P0 | 명시적 영수증 전환 시 구형 최초차감/재처리/취소 복구와 중복 반영 차단 | 로컬 PASS. 운영 행 없음 |
| P0 | 공급자 순서·snapshot·삭제·cutoff 보장 또는 인증된 독립 영업일 마감 자료 | BLOCKED. 공식 문서만으로 입증 못함. 독립 대조 구현 완료, 실제 자료/adapter 미검증 |
| P0 | 용량/단위·이동시각·실사 포함 관계 | 해석 계약/거절/개정 구현 PASS. 운영 409개 용량 누락 및 실제 증거 보완 필요 |
| P0 | 과거 legacy 취소·revert의 물리 반환 여부 | 예외 탐지 PASS. 이미 복구된 이력을 자동 정정하지 않음; 검증된 대사/편입 절차 미완 |
| P0 | 정상 계정/모든 외부 배치 소유권·원격 cron·직접 DML 계약 | 읽기 전용 설치 조사와 로컬 권한 검증 PASS. 운영 외부 Writer 목록·호환성 확정 BLOCKED |
| P0 | 신형 signed 결과의 실제 수량 적용/기존 reader 전환 | 이번 Migration은 관찰/명시적 hold만 제공. 자동 적용·일괄 backfill·구형 해제 없음. 별도 구현/검증 단계 필요 |
| P1 | 공통 gate의 운영 처리량, 장시간 잠금/재시도 SLA | 로컬 직렬화 PASS, 운영 부하 관찰 미확인 |
| P1 | 운영 설치/배포/관찰 | 현재 미설치. 별도 승인 후 기존 P1 의존 Migration 순서·원격 함수 drift·사진/관리자 정상 흐름 preflight 필요 |

안전한 다음 순서는 외부 근거와 Writer 소유권 확보 → 설치 차이/권한 preflight → 별도 승인된 Migration·배포 → **handoff 없이** 제한적 Shadow 증거 등록/비교·대조 관찰 → 부족/불일치·대기 SLA 확인 → 실재고 적용/reader 전환 별도 구현·검증이다. P0 제거 Migration은 작성하지 않았으며 신형 엔진의 운영 검증 뒤 별도 승인 단계로 남긴다.
