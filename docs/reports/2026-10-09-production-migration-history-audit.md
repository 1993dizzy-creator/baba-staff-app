# BABA Production Migration 이력 대조 — 복구 중단

대상: 로컬 연결 프로젝트와 Supabase MCP의 BABA 프로젝트가 동일함을 확인했다. MCP의 프로젝트 및 Migration 목록 읽기 인증은 성공했다.

## 결과와 변경 범위

| 항목 | 변경 전 | 변경 후 |
|---|---:|---:|
| 로컬 SQL 파일 | 181 | 181 |
| Production 이력 행(MCP 전체 목록) | 114 | 114 |
| 로컬에만 있는 버전 | 70 | 70 |
| 원격에만 있는 버전 | 3 | 3 |
| 동일 버전의 이름 차이 | 2 | 2 |
| 이번에 복구한 이력 | 0 | 0 |

두 번 조회한 원격 Migration 목록은 버전·이름·순서까지 동일했다. 로컬 SQL 재실행, 인덱스 생성, 이력 INSERT/repair, 운영 데이터·회계·급여 수정, 기존 Migration 파일 수정, Git 명령, 배포는 수행하지 않았다.

## 중단 사유

CLI 2.81.3의 `supabase migration list --linked`는 `Access token not provided`로 실패했다. MCP 로그인과 CLI 로그인은 별도이며 CLI의 Production 인증이 확보되지 않았다. 사용자의 안전 조건에 따라 `migration repair --status applied`를 시도하지 않았다. 자격 증명을 찾아 읽거나 다른 경로로 이력 변경을 우회하지 않았다.

운영 함수·컬럼·인덱스·제약·권한 비교를 위한 SELECT 요청은 도구의 자동 승인 검토에서 거부되었다. 반환 사유는 `MCP tool call requires approval, but approval policy is never`였다. 해당 SQL은 실행되지 않았다. 승인 가능한 SQL 검증 경로가 없으므로 실제 적용이 확인된 버전은 **0건**이다. 이력 누락을 미적용 또는 적용 완료로 단정하지 않는다.

## 요청한 후보 3건

| 버전 | 원격 이력 | 로컬 SQL의 주요 대상 | 판정 |
|---|---|---|---|
| 20261001061230 | 없음 | 근태 override의 decision threshold/grace 컬럼, action 제약, 조퇴 context·resolve RPC, revoke/paid-source trigger 및 함수 권한 | 운영 정의·권한 검증 불가, repair 금지 |
| 20261009080243 | 없음 | 입고 경제적 변경 guard·projection·repair inspection/preview/resolve 함수 및 private/public 권한 | 운영 함수 본문·권한 검증 불가, repair 금지 |
| 20261009161017 | 없음 | inventory_logs_created_at_id_read_idx, `(created_at DESC NULLS LAST,id DESC)` B-tree | 운영 인덱스 정의·유효성 검증 불가, repair 금지 |

후보 3건 외에 **67개 로컬 버전**도 원격 목록에 없다. 아래 전체 목록은 이력 기준의 불일치이며 실제 SQL 미적용 목록이 아니다. 역사적인 초기 스키마 baseline, 다른 timestamp로 적용된 SQL 또는 후속 함수 교체가 있을 수 있으므로 일괄 applied 등록해서는 안 된다.

원격 `20260917094840`은 로컬 `20260917092710`과 이름이 같지만 본문 동일성은 검증하지 못했다. 원격 `20260928142712`와 로컬 `20260928210713`도 관련 split-payment 기능이나 동일 Migration이라는 증거는 없다. 버전 매핑이나 기존 파일 이름 변경을 수행하지 않았다.

## 증거 파일

- [로컬 전체 목록](/C:/workspace/baba-membership/.tmp/migration-history-local.json)
- [Production 변경 전 목록](/C:/workspace/baba-membership/.tmp/migration-history-remote-before.json)
- [Production 최종 재조회 목록](/C:/workspace/baba-membership/.tmp/migration-history-remote-after.json)
- [전체 대조 결과](/C:/workspace/baba-membership/.tmp/migration-history-comparison.json)
- CLI 실패 로그: `.tmp/migration-history-before-cli.log` — 자격 증명은 기록하지 않았다.

## 재개 조건과 남은 작업

사용자가 안전하게 CLI 인증을 설정하고 승인된 읽기 전용 SQL 검증 경로를 제공한 뒤 재개한다. 비밀번호·토큰을 채팅이나 보고서에 보내지 않는다. 전체 이력을 다시 읽고 각 SQL 본문과 운영 객체·함수 인자/본문·컬럼·제약·trigger·권한을 대조한다. 함수가 후속 Migration으로 대체되었거나 data backfill이 포함된 파일은 단순 객체 존재만으로 적용 완료 판정을 내리지 않는다. 검증되지 않은 항목은 보류하고, 증거가 확보된 버전만 사용자가 요청한 CLI repair로 이력에 등록한 뒤 CLI list와 원격 목록을 다시 비교한다.

SQL 재실행이나 신규 인덱스 생성은 이 작업의 재개 범위에도 포함하지 않는다.

## 전체 불일치 목록

### Local-only versions (70)

| Version | Local SQL |
|---|---|
| 202606130001 | 202606130001_create_pos_category_group_mappings.sql |
| 202606140001 | 202606140001_extend_pos_item_mappings_catalog_link.sql |
| 202606140002 | 202606140002_create_sales_inventory_deduction_batches.sql |
| 202606150001 | 202606150001_apply_sales_inventory_deduction_batch.sql |
| 202606150002 | 202606150002_archive_pos_item_mappings.sql |
| 202606190001 | 202606190001_align_sales_inventory_deduction_status_checks.sql |
| 202606190002 | 202606190002_allow_combo_pos_mapping_type.sql |
| 202606210001 | 202606210001_add_purchase_price_to_sale_deduction_logs.sql |
| 202606230001 | 202606230001_add_pos_sales_sync_run_lock.sql |
| 202606260001 | 202606260001_add_manual_receipt_ref_no_unique_index.sql |
| 202606300001 | 202606300001_add_inventory_package_volume_and_recipe_source.sql |
| 202606300002 | 202606300002_add_direct_mapping_source_content.sql |
| 202607010001 | 202607010001_add_leader_role.sql |
| 202607020001 | 202607020001_create_inventory_keg_tracking.sql |
| 202607020002 | 202607020002_allow_keg_replace_inventory_log_source.sql |
| 202607020003 | 202607020003_keg_replacement_time_and_note.sql |
| 202607050001 | 202607050001_add_inventory_is_active.sql |
| 202607050002 | 202607050002_add_inventory_stock_check_log_index.sql |
| 202607050003 | 202607050003_add_inventory_sale_deduction_log_index.sql |
| 202607050004 | 202607050004_add_inventory_low_stock_enabled.sql |
| 202607060001 | 202607060001_classify_keg_replace_as_sale_deduction.sql |
| 202607090001 | 202607090001_add_sales_sync_lookup_indexes.sql |
| 202607100001 | 202607100001_add_inventory_deduction_receipt_workflow_fingerprint.sql |
| 202607100002 | 202607100002_reprocess_modified_sales_inventory_deduction.sql |
| 202607130001 | 202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql |
| 202607140001 | 202607140001_create_bar_zone_management.sql |
| 202607150001 | 202607150001_add_bar_zone_image_updated_at.sql |
| 202607150002 | 202607150002_create_bar_keeping_management.sql |
| 202607150003 | 202607150003_add_bar_keeping_liquor_source.sql |
| 202607150004 | 202607150004_add_bar_keeping_use_count_fixed_expiry.sql |
| 202607160001 | 202607160001_add_bar_keeping_customer_contact.sql |
| 202607160002 | 202607160002_add_bar_keeping_atomic_update_move.sql |
| 202607170001 | 202607170001_add_sales_receipt_financial_overrides.sql |
| 202607170002 | 202607170002_unify_bar_keeping_action_notes.sql |
| 202607180001 | 202607180001_allow_jpeg_bar_keeping_paths.sql |
| 202607180002 | 202607180002_delete_active_bar_keeping.sql |
| 202607180003 | 202607180003_delete_bar_keeping_v2.sql |
| 202607180004 | 202607180004_add_reactivate_action_note.sql |
| 202607180005 | 202607180005_fix_reprocess_modified_sales_inventory_deduction.sql |
| 202607190001 | 202607190001_create_store_settings_foundation.sql |
| 202607190002 | 202607190002_archive_cleanup_legacy_pos_processed_lines.sql |
| 202607230001 | 202607230001_close_attendance_anon_access.sql |
| 202607230002 | 202607230002_lock_down_sales_inventory_keg_public_access.sql |
| 202607230003 | 202607230003_unify_keg_sales_calculation.sql |
| 202607240001 | 202607240001_create_attendance_policy_shadow_foundation.sql |
| 202607240002 | 202607240002_add_attendance_staff_direct_leave_marker.sql |
| 202607240003 | 202607240003_fix_attendance_cancellation_audit.sql |
| 202607240004 | 202607240004_fix_attendance_cancel_checkout_runtime.sql |
| 202607240005 | 202607240005_add_attendance_manual_override_marker.sql |
| 202607250001 | 202607250001_add_attendance_departure_grace_settings.sql |
| 202607270001 | 202607270001_create_payroll_shadow_foundation.sql |
| 202607270002 | 202607270002_create_payroll_runs.sql |
| 202607280001 | 202607280001_add_employee_lifecycle_and_payroll_schedule.sql |
| 202607280002 | 202607280002_add_payroll_eligibility_override.sql |
| 202607300001 | 202607300001_add_payroll_compensation_and_adjustment_ledger.sql |
| 202607310001 | 202607310001_add_payroll_insurance_v5.sql |
| 202608010001 | 202608010001_add_payroll_work_policy_penalties_v6.sql |
| 202608020001 | 202608020001_correct_latest_unused_payroll_contract.sql |
| 202608020002 | 202608020002_add_unified_payroll_engine_v7.sql |
| 202608030001 | 202608030001_add_employee_level_program_versions.sql |
| 202608040001 | 202608040001_restore_employee_level_base_date_modes.sql |
| 202608070001 | 202608070001_add_payroll_meal_allowance.sql |
| 202608070002 | 202608070002_payroll_fixed_monthly_by_attendance_tracking.sql |
| 202608070003 | 202608070003_fix_fixed_monthly_contract_delegate.sql |
| 20260811103600 | 20260811103600_integrate_attendance_bonus_common_settings.sql |
| 20260917092710 | 20260917092710_count_all_linked_meal_corrections.sql |
| 20260928210713 | 20260928210713_add_sales_receipt_split_payment.sql |
| 20261001061230 | 20261001061230_add_early_leave_admin_selection.sql |
| 20261009080243 | 20261009080243_detect_inventory_purchase_economic_corrections.sql |
| 20261009161017 | 20261009161017_add_inventory_logs_created_at_id_read_index.sql |

### Remote-only versions (3)

| Version | Remote name |
|---|---|
| 20260917094840 | count_all_linked_meal_corrections |
| 20260924135025 | fix_employee_schedule_time_compare |
| 20260928142712 | replace_sales_receipt_split_payment_rpc |

### Same-version name differences (2)

| Version | Local name | Remote name |
|---|---|---|
| 20260811093311 | add_payroll_attendance_bonus | 202608110001_add_payroll_attendance_bonus |
| 20260812162019 | add_unauthorized_absence_attendance | 202608120001_add_unauthorized_absence_attendance |
