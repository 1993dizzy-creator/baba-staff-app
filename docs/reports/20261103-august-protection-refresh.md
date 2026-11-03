# 8월 재구축 v3 — Phương 정정 후 보호 스냅샷 갱신 초안

운영 원천 5종을 **GET만으로 직접 재조회**했다. 2026-11-03 15:47:37~15:47:57 UTC에 각 원천을 두 번 수집했고 지문·건수가 모두 일치했다. 감사 최대 ID는 시작/종료 모두 **7062**였다. DB에서 `::text`로 변환한 값을 받아 v3와 동일한 순서·구분자·MD5로 계산했다. JSONB를 JavaScript로 재직렬화하거나 금액을 반올림해 지문을 만들지 않았다. 컬럼 text 변환은 [PostgREST 공식 문서](https://docs.postgrest.org/en/stable/references/api/tables_views.html#casting-columns)의 SELECT cast를 사용했다.

여러 API 요청은 단일 MVCC 스냅샷이 아니므로 **최신 운영 관측값을 담은 REVIEW-ONLY**이며 승인 완료 보호 스냅샷으로 취급하지 않는다. 권위 있는 동시점 확인용 SELECT-only SQL도 별도로 작성했다. 운영에서 실행한 것은 GET 조회뿐이며 SQL/RPC 실행·설치·DDL·DML은 없었다.

## 갱신한 5종

| name | beforeCount(새 재구축 실행 직전 보호 건수) | fingerprint |
|---|---:|---|
| payable_allocations | 289 | `e41b545e00c8241e072cda1db32d6d95` |
| pos_receipts | 112 | `067538e0b9a2dc754c8545a29ce9e448` |
| month_closure_history | 8 | `5334f637cea5c53ce11270ef91e6d43b` |
| ledger_audit_history | 6,879 | `74d14ed45805fb654e6ebe9a51d654e3` |
| inventory_logs | 2,016 | `dbe203a7f5ebfaa87ef68e48acde599b` |

필터·순서는 v3 정의를 그대로 따랐다. POS에는 confirmed 필터를 추가하지 않았다. 마감 이력은 8·9월 revision≤4만, 감사는 **전체 감사 원천 중 id≤7062**를 포함한다. 감사 6,879건을 최대 ID 7,062로 대체하면 안 된다. 재고는 8월 business_date 전체이며 수량·단가의 DB text 표현을 보존한다. 운영에 private 함수를 새로 설치하거나 호출하지 않았다.

## 변경 전후와 재구축 영향

- 감사 **#7062**에서 정정 키 `phuong-chain-20261103-2399-exception-v1`를 직접 확인했다. 저장된 before/after August summary는 **302건 / 69,215,076₫ / `2626e12bc4f115e8e97868a4037b4824` → 289건 / 46,053,076₫ / `e41b545e00c8241e072cda1db32d6d95`**다. 감소는 13건·23,162,000₫이며 #1641의 19,992,000과 #2399→#388의 3,170,000에 해당한다.
- 감사 #7062의 before/after 마감 이력 전체 8행도 동일했다. 현재 8·9월 closure는 모두 **reopened revision 4**다.
- POS·재고 등도 그대로라는 가정으로 기존 값을 복사하지 않고 이번 원천을 재수집했다. 이전에 승인한 전체 보호 스냅샷/manifest 파일은 저장소에서 찾지 못했으므로 POS·재고·감사 각각의 **기존 승인 지문 대비** 증감은 확정할 수 없다. 현금 이동·재고·지급요청 불변은 사용자 GPT postflight 인계를 재사용하며 이를 새로 전수 검증했다고 주장하지 않는다.
- 새 감사 #7062를 포함한 감사 prefix를 새 승인에 포함해야 한다. 이후 다른 감사 행이 추가돼도 v3의 현재 MAX(id)·건수·지문이 달라져 이번 초안은 stale이 된다. 실행 직전 최신 원천으로 확인하고 필요시 5종을 다시 갱신해야 한다.
- 배분 정정은 새 비용·현금 이동이 아니므로 보호 갱신을 이유로 기존 재구축의 events·금액·505개 시트 셀·124개 일별 계정값·잔액을 바꾸지 않는다. 다만 완전한 원본 manifest와 현재 자금 baseline이 일치하는지는 최종 조립 시 확인해야 한다.
- v3의 `APPROVED_PROTECTION_SNAPSHOT_STALE`, `LATER_PAYABLES_CHANGED`, 실행 전후 보호, `reverse_v1`의 `SOURCE_PROTECTION_DRIFT` 등은 전부 그대로 둔다. 앞으로의 재구축이 실제 적용되면 새 배분 지문을 run의 복구 기준으로 저장한다. 현재 초안 때문에 기존 runs/감사/이력을 갱신하지 않는다.

## 신규 산출물과 승인 차단

1. `scripts/ledger/evidence/20261103-august-protection-refresh/protected-snapshot-REVIEW-ONLY.json`: 5종 관측값, 조회 시간·방식·일관성 제한, #7062 전후 비교, closure와 미승인 상태를 기록했다. 원문 자격 증명이나 전체 감사 payload는 기록하지 않았다.
2. `scripts/ledger/evidence/20261103-august-protection-refresh/manifest-protection-REVIEW-ONLY.json`: **보호 항목만 채운 불완전 manifest 초안**이다. 원본 전체 manifest 경로·원본 승인·새 승인 hash는 NULL이다. 이를 apply 입력으로 사용하면 안 된다. 원본 전체 manifest 사본에 5종을 교체하고 나머지 필드를 보존하도록 명시했다. runId를 단독 변경해 기존 event key와의 계약을 깨지 않는다.
3. `scripts/ledger/august-protection-refresh-20261103-READONLY.sql`: 단일 REPEATABLE READ READ ONLY 트랜잭션에서 5종과 audit high-water, #7062, closure를 함께 확인하는 SELECT-only SQL이다. 운영에서 실행하지 않았다. 출력의 matchesPostflightPayable/closuresMatch/correctionAuditMatches가 모두 true여야 하며, 이번 관측값과 다르면 새 관측·검토가 필요하다.

최종 조립에는 **동시점 SQL 확인 결과 및 기존에 승인한 완전한 manifest/승인 기록**이 필요하다. 둘을 확보한 뒤 원본은 보존하고 새 버전에 `requiredProtectedFingerprints`를 반영한다. 전체 JSONB를 기준으로 새로운 `md5(manifest::jsonb::text)`를 독립 확인·승인해야 하며, 이전 승인 hash를 재사용하거나 실행 직전 현재 값을 자동 승인하지 않는다. 시트 원본이 그대로라면 기존 sheet 승인 증거는 보존할 수 있지만 전체 manifest 승인을 대체하지 않는다.

## 검증 범위

v3 SQL·plan/commit 코드·기존 계약 테스트는 변경하지 않았다. 해당 범위의 기존 PASS를 재사용하고 전체 테스트·TypeScript·Build는 재실행하지 않았다. 새 READONLY 수집문만 자격 증명 없는 합성 PGlite에서 실행해, 출력한 **5개 지문 모두가 수정하지 않은 v3 함수 결과와 동일**한 것을 확인했다. NULL·소수점 scale·JSONB·감사 최대 ID가 포함된 사례다. 운영 관측값 자체와 기존 재구축 전체 실행의 PASS로 확대하지 않는다.

**상태: 5종 운영 원천 재조사 완료 / 새 Snapshot 및 보호 갱신용 Manifest REVIEW-ONLY 초안 준비 / 동시점 확정 및 완전한 manifest 조립·새 승인 대기.** 재구축 실행·운영 DB 변경·Push·배포는 하지 않았다.
