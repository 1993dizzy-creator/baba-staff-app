> **상태: 폐기(superseded), 2026-10-22.** 2026-10-21 개발한 POS 결제예정 관리자 복구 V1·V2의 개발 기록입니다. 현재 운영 기능이 아니며, 코드와 DB에서 제거하기로 결정했습니다. 제거 이유와 현재 상태는 [V1·V2 제거 보고서](reports/20261022-pos-admin-resolution-v1-v2-retirement.md)를 기준으로 합니다. 아래 본문은 과거 기록으로만 보존합니다(일부 문서는 작성 당시 인코딩 손상으로 한글이 `?`로 남아 있습니다).

# 차감 guard 추가 검증 — 2026-10-21

운영 미적용. 기능 플래그 OFF 유지. 운영 SQL·Git·배포를 실행하지 않았다. 기존 292건 및 앞선 guard 테스트는 반복하지 않고 이번 위험에 한정했다.

## 변경 범위

미적용 3차 SQL `20261021133856_pos_resolution_deduction_insert_guard.sql`만 보완했다. 1·2차 SQL은 변경하지 않았다. 이전 3차 SQL은 `.qa-review/pos-resolution/guard-followup/migration-before.sql`에 보존했다.

- 차감 trigger를 모든 UPDATE와 DELETE로 확대했다. status, 수량, inventory_item_id, mapping_id, inventory_log_id도 보호한다. OLD와 NEW의 모든 연결을 검사한다. 보호 영수증의 UPDATE는 기존 비공개 transaction/receipt inventory capability가 있어야 한다. DELETE는 그 capability 안에서도 거부한다. 정상 엔진은 삭제 대신 기존 상태 변경·역분개를 계속 사용한다.
- 실제 우회 경로인 `app/api/inventory/items/route.ts`의 POS 참조 삭제 분기도 보호 차감 행을 삭제할 수 없다. 재고 로그의 ON DELETE SET NULL도 보호 행을 우회 변경하지 못한다. 해당 삭제 요청은 실패하며 이력을 보존한다.
- mapping/log 부모의 OLD·NEW·역분개 연결을 정렬해 KEY SHARE NOWAIT로 선점한다. receipt 잠금을 잡은 뒤 FK 부모를 기다리는 역순 대기를 만들지 않는다. 기존 batch/inventory/line 및 provenance 잠금은 유지했다. 공통 테이블 잠금은 추가하지 않았다.
- 초기 후보 저장·재처리 서비스가 PostgreSQL 오류 code를 보존한다. 55P03은 재조회 가능한 stale_preview로 전달하며 적용 건수는 0이다. 직접 apply/reprocess API는 필요한 경우 409와 retryable/requiresRefresh, Retry-After를 반환한다. 오래된 후보를 자동 재실행하지 않는다.

실패한 후보 저장의 batch 시도는 failed로 남을 수 있다. 이것은 영수증의 영구 실패가 아니다. 새 preview와 새 batch로 재시도하며 성공 이력과 구분한다. 기존 unified UI는 결과 후 preview를 새로 조회한다. 크론은 stale_preview를 terminal=false로 처리하여 auto_eligible_at을 유지하고, last_checked_at 기준 15분 이후 다시 후보로 조회한다(`sales-deduction-cron-shared.ts`). 이 크론 계약은 코드로 확인했으며 전체 스케줄러를 실제 시간으로 실행하지는 않았다. 관리자 확정 영수증의 별도 보류는 계속 유지한다.

## 실제 PostgreSQL 결과

`node --experimental-strip-types --test tests/pos-resolution-guard-followup-postgres.test.mjs`

**하위 8 + 부모 1 = 9건 통과, 실패/skip 0.** 격리 native PostgreSQL을 사용했으며 종료 시 서버를 정지했다.

1. 수정 전 SQL에서 비식별자 UPDATE와 DELETE 우회를 재현하고, 수정 후 42501 거부 및 재고/로그/차감 불변을 확인했다. 로그 삭제 cascade도 차단했다.
2. 실제 initial → reprocess → 취소 rollback의 상태 변경·역분개 성공. 승인 capability 내부 DELETE 오류 주입 시 재고·로그·차감·보류·승인 전체 롤백.
3. mapping/log 실제 FK를 추가하고 각 부모 FOR UPDATE 경합을 5회씩 실행했다. 총 10회 NOWAIT 반환은 약 2.47–4.39ms, 관측 데드락 0. receipt 잠금을 선점하지 않음을 별도 연결에서 확인했다. 일반 비키 매핑 UPDATE는 호환됐다.
4. catalog writer → 승인 → 보호 INSERT 역순 경합에서 55P03 반환 후 writer 롤백, 승인 완료. 데드락 0.
5. 실제 초기 batch 저장 TS 서비스를 격리 DB에 연결했다. 55P03 code 보존, 실패 후 로그 0, 새 preview/batch로 재시도해 재고 100→99, 로그 1건.
6. 실제 재처리 TS 서비스의 후보 저장 및 엔진 RPC 단계 각각에 실제 FK 잠금을 주입했다. RPC 실패 시 stale_preview/적용 0, 재고 99와 로그 1 유지. 새 preview로 성공해 재고 98, 로그 총 3건(원차감·역분개·새 차감).
7. 직접 API의 409 재조회 계약 및 unified 실행의 stale_preview/shouldRefreshPreview를 검증했다. API 인증·preview 입력은 harness이며 운영 인증 전체 회귀를 반복한 것은 아니다.
8. 확대된 guard와 mapping/log FK 설치 후 기존 실제 케그 교체 RPC 성공(재고 100→99). 케그 함수는 변경하지 않았다.

변경한 TS/API 6개 파일 ESLint 진단 0. 전체 TypeScript 검사는 기존 오류 40건과 파일/코드/메시지가 동일하며 신규 오류 0이다. 기존 오류 때문에 tsc 종료 코드는 1이다. 이번 변경에서 build·전체 292건·브라우저 회귀는 반복하지 않았다.

증거: `.qa-review/pos-resolution/guard-followup/`의 `postgres.log`, `followup-evidence.json`, `static-checks.json`, `final-summary.json`. 테스트의 PostgREST transport는 실제 SQL과 SQLSTATE를 사용하지만 preview·매핑 입력은 결정적 fixture이며 운영 규모를 재현하지 않는다.

이번 검증의 정지된 임시 클러스터 디렉터리 2개는 `.qa-review/pos-resolution/pg17-guard-followup-1792591963397`, `pg17-guard-followup-1792592052464`에 보존했다. 기존 정리 정책을 우회하거나 삭제를 재시도하지 않았다.

## 운영 적용 차단 조건

**NO-GO 유지.** 확인된 로컬 UPDATE/DELETE 공백과 두 FK 역순 대기는 위 범위에서 차단했다. 운영에는 아직 적용하지 않았다.

- 운영 함수 원문 전체와 SHA-256/계약 대조는 별도 미완료다. 저장소 기반 격리 결과를 운영 원문 일치 검증으로 간주하지 않는다.
- 운영 규모 POS sync·승인·매핑 변경·케그의 혼합 부하에서 지연, 55P03 재시도율 및 요청 실패율은 미검증이다. 위 밀리초 수치는 로컬 단일 경합 수치다.
- 적용은 별도 사용자 승인 후 SQL Editor에서 1차→2차→3차 순서로 수행한다. 재고 guard는 앱 플래그 OFF에서도 적용되므로 재시도 계약을 포함한 코드 배포 순서를 함께 승인해야 한다. 승인 전 운영 적용·배포·플래그 활성화는 금지한다.
