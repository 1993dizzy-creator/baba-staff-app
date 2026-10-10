# BABA Production Migration 이력 정합성 정밀 감사

조사일: 2026-10-10. 읽기 전용 조사이며 Migration repair, SQL 재실행, 운영 데이터 변경, Git 명령 및 배포는 수행하지 않았다.

## 결론과 증거 범위

로컬 SQL **181개**, 현재 Production 등록 이력 **114개**, 공통 버전 **111개**, 로컬에만 있는 버전 **70개**, Production에만 있는 버전 **3개**, 동일 버전 이름 불일치 **2개**를 확인했다. **A 0 / B 0 / C 0 / D 70**이며 지금 이력 복구가 승인 가능한 버전은 **0개**다. D는 미적용 판정이 아니다.

원격 이력은 Supabase 연결의 list_migrations 읽기로 확보했다. Production 카탈로그 SELECT는 자동 승인 검토에서 `MCP tool call requires approval, but approval policy is never`로 거절되어 실행되지 않았다. 연결된 CLI의 `migration list --linked`도 access token 부재로 실패했다. 다른 인증 경로로 우회하지 않았다. 따라서 함수 본문·컬럼 정의·실제 권한·인덱스 유효성·운영 보정 이력을 이번 조사에서 검증할 수 없다.

사용자가 이전 조사에서 우선 3개 버전의 주요 객체 존재를 확인했다고 전달한 사실은 참고 증거로만 사용했다. 현재 정의와 전체 SQL 적용 증거로 격상하지 않았다. 2026-09-07의 과거 로컬 preflight 객체 덤프도 현재 운영 정의 증거에서 제외했다. 원격 이력에는 본문/체크섬이 없어 이름만으로 동일 SQL 실행을 입증할 수 없다.

증거 파일: `.tmp/migration-classification-remote.json`, `.tmp/migration-classification-analysis.json`, `.tmp/migration-classification-cli.log`, `.tmp/migration-classification-validation.json`. 분석 JSON은 181개 파일의 SHA-256, 추출 이벤트, 소스 위치 및 후속 참조를 보존한다. 임시 파일은 보존 정책에 따라 별도 관리해야 하며 이 보고서는 해당 파일 없이도 판정과 검증 범위를 확인할 수 있도록 작성했다.

## 판정 기준

| 그룹 | 조건 | 건수 |
|---|---|---:|
| A 적용 확인 | SQL 전체의 현재 정의/후속 계보와 실행 근거가 충분함. 보정·권한 포함 | 0 |
| B 후속 버전으로 대체 | 운영의 대체 정의와 후속 계보가 검증됨. 원본 실행 여부는 별도 | 0 |
| C 미적용 확인 | 후속 제거/대체 가능성까지 배제한 충분한 반증 | 0 |
| D 확인 불가 | 본문·권한·데이터 실행 등 필요한 증거 부족 | 70 |

70건 중 **46건**에 로컬 후속 변경 후보가 있고 **14건**에 seed/backfill 또는 DO 내부 데이터 변경 후보가 있다. 이것은 실행 횟수나 실제 적용 건수가 아니다. [R]은 후속 버전이 원격 이력에 등록됨, [L]은 로컬에만 있음이다. [R]도 본문 동일성을 보증하지 않는다.

## 70건 전체 판정표

모든 행의 판정 근거는 해당 SQL의 로컬 정적 분석 및 원격 버전 부재다. 현재 Production 객체 비교는 권한 차단으로 수행하지 못했다. 신뢰도는 **증거 부족/D 판정: 높음, 실제 적용 여부: 평가 불가**다. 아래 객체 수는 SQL 이벤트 수로 중복 변경을 포함하며 객체의 유일 개수와 다르다. 각 행의 구체적인 객체·권한·추가 확인은 뒤의 개별 명세를 참조한다.

| 버전·파일 | 영향 범위 | 후속 변경 후보 | 판정·신뢰도 | 복구 |
|---|---|---|---|---|
| [202606130001_create_pos_category_group_mappings.sql](../../supabase/migrations/202606130001_create_pos_category_group_mappings.sql) | table:2, column:8, data:1; RLS; data execution unproven | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606140001_extend_pos_item_mappings_catalog_link.sql](../../supabase/migrations/202606140001_extend_pos_item_mappings_catalog_link.sql) | table:12, column:22, data:4, constraint:5, index:5; data execution unproven | 202606150002 [L]<br>202606190002 [L]<br>202606300002 [L]<br>202606300001 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606140002_create_sales_inventory_deduction_batches.sql](../../supabase/migrations/202606140002_create_sales_inventory_deduction_batches.sql) | table:17, column:79, index:7, constraint:4 | 202606150001 [L]<br>202606190001 [L]<br>202607100001 [L]<br>202607130001 [L]<br>202607230002 [L]<br>202606190002 [L]<br>202607190002 [L]<br>202607020002 [L]<br>20260906114438 [R]<br>20260914161954 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606150001_apply_sales_inventory_deduction_batch.sql](../../supabase/migrations/202606150001_apply_sales_inventory_deduction_batch.sql) | table:3, column:1, constraint:2, function:1, privilege:2 | 202606190001 [L]<br>202607100001 [L]<br>202607130001 [L]<br>202607230002 [L]<br>202606210001 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606150002_archive_pos_item_mappings.sql](../../supabase/migrations/202606150002_archive_pos_item_mappings.sql) | table:1, column:3, index:5 | 202606190002 [L]<br>202606300002 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606190001_align_sales_inventory_deduction_status_checks.sql](../../supabase/migrations/202606190001_align_sales_inventory_deduction_status_checks.sql) | table:6, constraint:6 | 202606190002 [L]<br>202607190002 [L]<br>202607100001 [L]<br>202607130001 [L]<br>202607230002 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606190002_allow_combo_pos_mapping_type.sql](../../supabase/migrations/202606190002_allow_combo_pos_mapping_type.sql) | table:4, constraint:4 | 202606300002 [L]<br>202607190002 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606210001_add_purchase_price_to_sale_deduction_logs.sql](../../supabase/migrations/202606210001_add_purchase_price_to_sale_deduction_logs.sql) | function:1, privilege:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606230001_add_pos_sales_sync_run_lock.sql](../../supabase/migrations/202606230001_add_pos_sales_sync_run_lock.sql) | index:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606260001_add_manual_receipt_ref_no_unique_index.sql](../../supabase/migrations/202606260001_add_manual_receipt_ref_no_unique_index.sql) | index:1 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606300001_add_inventory_package_volume_and_recipe_source.sql](../../supabase/migrations/202606300001_add_inventory_package_volume_and_recipe_source.sql) | table:5, column:6, constraint:3 | 202607050001 [L]<br>202607050004 [L]<br>202608060002 [R]<br>202608220002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202606300002_add_direct_mapping_source_content.sql](../../supabase/migrations/202606300002_add_direct_mapping_source_content.sql) | table:3, column:4, constraint:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607010001_add_leader_role.sql](../../supabase/migrations/202607010001_add_leader_role.sql) | table:2, constraint:1 | 202607280001 [L]<br>202607280002 [L]<br>20260728182601 [R]<br>202608060001 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607020001_create_inventory_keg_tracking.sql](../../supabase/migrations/202607020001_create_inventory_keg_tracking.sql) | table:2, column:29, index:5, function:1 | 202607230003 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607020002_allow_keg_replace_inventory_log_source.sql](../../supabase/migrations/202607020002_allow_keg_replace_inventory_log_source.sql) | table:2, constraint:2 | 20260906114438 [R]<br>20260914161954 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607020003_keg_replacement_time_and_note.sql](../../supabase/migrations/202607020003_keg_replacement_time_and_note.sql) | function:1 | 202607060001 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607050001_add_inventory_is_active.sql](../../supabase/migrations/202607050001_add_inventory_is_active.sql) | table:1, column:1, index:1 | 202607050004 [L]<br>202608060002 [R]<br>202608220002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607050002_add_inventory_stock_check_log_index.sql](../../supabase/migrations/202607050002_add_inventory_stock_check_log_index.sql) | index:1 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607050003_add_inventory_sale_deduction_log_index.sql](../../supabase/migrations/202607050003_add_inventory_sale_deduction_log_index.sql) | index:1 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607050004_add_inventory_low_stock_enabled.sql](../../supabase/migrations/202607050004_add_inventory_low_stock_enabled.sql) | table:1, column:1 | 202608060002 [R]<br>202608220002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607060001_classify_keg_replace_as_sale_deduction.sql](../../supabase/migrations/202607060001_classify_keg_replace_as_sale_deduction.sql) | function:1 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607090001_add_sales_sync_lookup_indexes.sql](../../supabase/migrations/202607090001_add_sales_sync_lookup_indexes.sql) | index:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607100001_add_inventory_deduction_receipt_workflow_fingerprint.sql](../../supabase/migrations/202607100001_add_inventory_deduction_receipt_workflow_fingerprint.sql) | table:4, column:3, constraint:3, index:2 | 202607130001 [L]<br>202607230002 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607100002_reprocess_modified_sales_inventory_deduction.sql](../../supabase/migrations/202607100002_reprocess_modified_sales_inventory_deduction.sql) | index:2, function:1 | 202607180005 [L]<br>202607190002 [L] (dynamic patch candidate) | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql](../../supabase/migrations/202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql) | table:3, column:8, index:1, constraint:2, function:1, privilege:4 | 202607170001 [L]<br>202607230002 [L]<br>202607190002 [L] (dynamic patch candidate) | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607140001_create_bar_zone_management.sql](../../supabase/migrations/202607140001_create_bar_zone_management.sql) | table:6, column:28, index:6, data:2, function:2, privilege:4; RLS; data execution unproven | 202607150001 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607150001_add_bar_zone_image_updated_at.sql](../../supabase/migrations/202607150001_add_bar_zone_image_updated_at.sql) | table:1, column:1, data:1, function:1, privilege:2; data execution unproven | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607150002_create_bar_keeping_management.sql](../../supabase/migrations/202607150002_create_bar_keeping_management.sql) | table:2, column:23, index:4, data:1, function:2, privilege:4; RLS; data execution unproven | 202607150003 [L]<br>202607150004 [L]<br>202607160001 [L]<br>202607180001 [L]<br>202608080002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607150003_add_bar_keeping_liquor_source.sql](../../supabase/migrations/202607150003_add_bar_keeping_liquor_source.sql) | table:2, column:2, constraint:3, index:1, function:2, privilege:5 | 202607150004 [L]<br>202607160001 [L]<br>202607180001 [L]<br>202608080002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607150004_add_bar_keeping_use_count_fixed_expiry.sql](../../supabase/migrations/202607150004_add_bar_keeping_use_count_fixed_expiry.sql) | table:1, column:1, constraint:1, data:2, function:2, privilege:4; data execution unproven | 202607160001 [L]<br>202607180001 [L]<br>202608080002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607160001_add_bar_keeping_customer_contact.sql](../../supabase/migrations/202607160001_add_bar_keeping_customer_contact.sql) | table:1, column:1, constraint:1, function:2, privilege:4 | 202607180001 [L]<br>202608080002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607160002_add_bar_keeping_atomic_update_move.sql](../../supabase/migrations/202607160002_add_bar_keeping_atomic_update_move.sql) | function:1, privilege:2 | 202608080001 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607170001_add_sales_receipt_financial_overrides.sql](../../supabase/migrations/202607170001_add_sales_receipt_financial_overrides.sql) | table:4, column:16, constraint:8, function:1, privilege:5; RLS | 20260928210713 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607170002_unify_bar_keeping_action_notes.sql](../../supabase/migrations/202607170002_unify_bar_keeping_action_notes.sql) | data:1, function:1, privilege:2; data execution unproven | 202608080002 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607180001_allow_jpeg_bar_keeping_paths.sql](../../supabase/migrations/202607180001_allow_jpeg_bar_keeping_paths.sql) | table:1, constraint:4 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607180002_delete_active_bar_keeping.sql](../../supabase/migrations/202607180002_delete_active_bar_keeping.sql) | function:1, privilege:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607180003_delete_bar_keeping_v2.sql](../../supabase/migrations/202607180003_delete_bar_keeping_v2.sql) | function:1, privilege:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607180004_add_reactivate_action_note.sql](../../supabase/migrations/202607180004_add_reactivate_action_note.sql) | function:1, privilege:2 | 202608080001 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607180005_fix_reprocess_modified_sales_inventory_deduction.sql](../../supabase/migrations/202607180005_fix_reprocess_modified_sales_inventory_deduction.sql) | function:1, privilege:2 | 202607190002 [L] (dynamic patch candidate) | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607190001_create_store_settings_foundation.sql](../../supabase/migrations/202607190001_create_store_settings_foundation.sql) | table:6, column:25, index:3, privilege:23, function:7; RLS | 202607240001 [L]<br>202607250001 [L]<br>202608070005 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607190002_archive_cleanup_legacy_pos_processed_lines.sql](../../supabase/migrations/202607190002_archive_cleanup_legacy_pos_processed_lines.sql) | index:2, table:9, column:36, privilege:9, data:3, function:1, constraint:3, trigger:1, sequence:1; RLS; data execution unproven | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607230001_close_attendance_anon_access.sql](../../supabase/migrations/202607230001_close_attendance_anon_access.sql) | policy:3, privilege:4 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607230002_lock_down_sales_inventory_keg_public_access.sql](../../supabase/migrations/202607230002_lock_down_sales_inventory_keg_public_access.sql) | table:1, privilege:8; RLS | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607230003_unify_keg_sales_calculation.sql](../../supabase/migrations/202607230003_unify_keg_sales_calculation.sql) | function:3, privilege:6 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607240001_create_attendance_policy_shadow_foundation.sql](../../supabase/migrations/202607240001_create_attendance_policy_shadow_foundation.sql) | table:6, column:23, data:1, index:3, privilege:10, function:3; RLS; data execution unproven | 202607250001 [L]<br>202608070005 [R]<br>202607240003 [L]<br>20260812162019 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607240002_add_attendance_staff_direct_leave_marker.sql](../../supabase/migrations/202607240002_add_attendance_staff_direct_leave_marker.sql) | table:1, column:1 | 20260812162019 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607240003_fix_attendance_cancellation_audit.sql](../../supabase/migrations/202607240003_fix_attendance_cancellation_audit.sql) | table:2, constraint:4, column:5, index:1, function:1, privilege:2 | 20260812162019 [R]<br>202607240004 [L]<br>20260813180226 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607240004_fix_attendance_cancel_checkout_runtime.sql](../../supabase/migrations/202607240004_fix_attendance_cancel_checkout_runtime.sql) | function:1 | 20260813180226 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607240005_add_attendance_manual_override_marker.sql](../../supabase/migrations/202607240005_add_attendance_manual_override_marker.sql) | table:2, column:10, index:2, privilege:6, function:1; RLS | 20261001061230 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607250001_add_attendance_departure_grace_settings.sql](../../supabase/migrations/202607250001_add_attendance_departure_grace_settings.sql) | table:1, column:2, constraint:2, function:3, privilege:4 | 202608070005 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607270001_create_payroll_shadow_foundation.sql](../../supabase/migrations/202607270001_create_payroll_shadow_foundation.sql) | schema:1, table:6, column:38, index:3, privilege:13, data:1, function:2; RLS; data execution unproven | 202608010002 [R]<br>20260728182601 [R]<br>202607300001 [L]<br>202608010003 [R]<br>20260804152308 [R]<br>202608020001 [L]<br>202607280001 [L] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607270002_create_payroll_runs.sql](../../supabase/migrations/202607270002_create_payroll_runs.sql) | table:10, column:84, index:6, privilege:9, function:8; RLS | 202607280001 [L]<br>202607300001 [L]<br>202607310001 [L]<br>202608010001 [L]<br>202608070004 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607280001_add_employee_lifecycle_and_payroll_schedule.sql](../../supabase/migrations/202607280001_add_employee_lifecycle_and_payroll_schedule.sql) | table:8, column:9, constraint:4, index:1, data:2, privilege:8, function:4; RLS; data execution unproven | 202607280002 [L]<br>20260728182601 [R]<br>202608060001 [R]<br>202607310001 [L]<br>202608010001 [L]<br>20260911102823 [R]<br>202607300001 [L]<br>202608070004 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607280002_add_payroll_eligibility_override.sql](../../supabase/migrations/202607280002_add_payroll_eligibility_override.sql) | table:1, column:1 | 20260728182601 [R]<br>202608060001 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607300001_add_payroll_compensation_and_adjustment_ledger.sql](../../supabase/migrations/202607300001_add_payroll_compensation_and_adjustment_ledger.sql) | table:4, column:21, constraint:4, index:2, privilege:8, function:2; RLS | 202608010003 [R]<br>20260804152308 [R]<br>202607310001 [L]<br>202608010001 [L]<br>202608070004 [R]<br>20260908110641 [R]<br>20260928122112 [R]<br>202608070003 [L] (dynamic patch candidate) | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202607310001_add_payroll_insurance_v5.sql](../../supabase/migrations/202607310001_add_payroll_insurance_v5.sql) | table:11, column:25, constraint:9, index:3, privilege:6, data:1, function:8; RLS; data execution unproven | 202608010001 [L]<br>20260911102823 [R]<br>202608070004 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608010001_add_payroll_work_policy_penalties_v6.sql](../../supabase/migrations/202608010001_add_payroll_work_policy_penalties_v6.sql) | table:6, column:5, constraint:8, index:2, function:7, privilege:2 | 20260911102823 [R]<br>202608070004 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608020001_correct_latest_unused_payroll_contract.sql](../../supabase/migrations/202608020001_correct_latest_unused_payroll_contract.sql) | table:2, constraint:2, function:1, privilege:2 | 202608020002 [L] (dynamic patch candidate)<br>202608070003 [L] (dynamic patch candidate) | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608020002_add_unified_payroll_engine_v7.sql](../../supabase/migrations/202608020002_add_unified_payroll_engine_v7.sql) | function:2, privilege:4 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608030001_add_employee_level_program_versions.sql](../../supabase/migrations/202608030001_add_employee_level_program_versions.sql) | table:2, column:11, index:2, privilege:9, data:2, function:3; RLS; data execution unproven | 202608040001 [L]<br>202608070007 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608040001_restore_employee_level_base_date_modes.sql](../../supabase/migrations/202608040001_restore_employee_level_base_date_modes.sql) | table:4, column:3, constraint:4, data:2, function:5, privilege:6; data execution unproven | 202608070007 [R]<br>202608070006 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608070001_add_payroll_meal_allowance.sql](../../supabase/migrations/202608070001_add_payroll_meal_allowance.sql) | table:4, column:15, index:3, privilege:15, function:4, trigger:2; RLS | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608070002_payroll_fixed_monthly_by_attendance_tracking.sql](../../supabase/migrations/202608070002_payroll_fixed_monthly_by_attendance_tracking.sql) | function:2, privilege:4 | 202608070003 [L]<br>202608070003 [L] (dynamic patch candidate) | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [202608070003_fix_fixed_monthly_contract_delegate.sql](../../supabase/migrations/202608070003_fix_fixed_monthly_contract_delegate.sql) | function:3, privilege:6 | 20260909231222 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [20260811103600_integrate_attendance_bonus_common_settings.sql](../../supabase/migrations/20260811103600_integrate_attendance_bonus_common_settings.sql) | function:1, privilege:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [20260917092710_count_all_linked_meal_corrections.sql](../../supabase/migrations/20260917092710_count_all_linked_meal_corrections.sql) | function:2, privilege:2 | 20261001131334 [R] | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [20260928210713_add_sales_receipt_split_payment.sql](../../supabase/migrations/20260928210713_add_sales_receipt_split_payment.sql) | function:2, privilege:2 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [20261001061230_add_early_leave_admin_selection.sql](../../supabase/migrations/20261001061230_add_early_leave_admin_selection.sql) | table:3, column:2, constraint:2, function:6, trigger:3, privilege:9 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [20261009080243_detect_inventory_purchase_economic_corrections.sql](../../supabase/migrations/20261009080243_detect_inventory_purchase_economic_corrections.sql) | function:14, privilege:11 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |
| [20261009161017_add_inventory_logs_created_at_id_read_index.sql](../../supabase/migrations/20261009161017_add_inventory_logs_created_at_id_read_index.sql) | index:1 | No exact local successor extracted | D / 증거부족 높음; 적용 평가불가 | 제외 |

## 우선 3건 정밀 검토

### 20261001061230 — 조퇴 판정

원본 SQL에는 manual override의 `decision_threshold_at timestamptz`, `decision_grace_minutes integer` 컬럼, action CHECK 재정의, 조퇴 context/resolution RPC 및 지급된 근태 보호·보류 조퇴 지급 차단을 포함한 3개 트리거가 있다. SQL은 BEGIN/COMMIT 단위다. 후속 로컬 동일 객체 대체는 추출되지 않았다.

확인 필요: 두 컬럼의 타입·NULL·기본값, CHECK 표현식 전체, 아래 명세의 6개 함수의 오버로드·본문·security invoker/search_path·소유자, 3개 트리거의 대상/시점/UPDATE 열/활성 상태 및 함수 연결. PUBLIC/anon/authenticated revoke와 context 2개·admin resolve 함수의 service_role EXECUTE를 각각 대조해야 한다. 기존 service_role 직접 ACL 및 소유자 권한도 구분한다. 근태나 지급 데이터를 수정하여 검증하지 않는다. 주요 함수 존재만으로 트리거와 권한 적용을 확정할 수 없다.

### 20261009080243 — 입고 경제적 정정

economics, purchase_supplier_matches, compare_purchase_supplier, correction guard, inspect_purchase_repair, preview, resolution v2 및 v1 wrapper의 총 8개 고유 함수에 변경이 있다. 원매입 projector 자체를 이 파일에서 새로 정의하는 것은 아니다. 기존 projector 및 guard 트리거 연결도 의존성으로 확인해야 한다. 거래처 변경 fingerprint와 별도 확인, v1 호환 경로의 제한, 0원 취소 경로 및 마감/지급 보호의 전체 본문을 비교해야 한다.

private helper는 PUBLIC/anon/authenticated/service_role 직접 실행을 revoke하고, public preview/v1/v2의 owner postgres 및 service_role EXECUTE 부여를 확인해야 한다. guard는 SECURITY INVOKER 및 역할 검증까지 대조한다. 함수 내부 정정 DML은 RPC 실행 로직이며 이 Migration의 top-level Milan Food backfill로 취급하지 않는다. 객체 존재는 #12007/#12008, #12655 실제 처리나 전체 Migration 실행 증명이 아니다. 이번 조사에서는 거래 실행·취소·복구를 하지 않았다.

### 20261009161017 — 재고 조회 인덱스

SQL은 `CREATE INDEX inventory_logs_created_at_id_read_idx ON public.inventory_logs USING btree (created_at DESC NULLS LAST, id DESC)`이다. 확인 필요: 대상 테이블 OID, 비유일 btree, 두 키의 순서·정렬·NULL 순서·opclass/collation, INCLUDE/부분 조건 유무, indisvalid/indisready/indislive. 함수나 데이터 보정은 없다. IF NOT EXISTS가 없어 동일 이름 인덱스에 재실행하면 실패할 수 있다. 현재 정의 확인 후에도 SQL 실행 이력인지 수동 동등 생성인지 증거 출처를 구분한다. 인덱스는 생성/재생성하지 않는다.

## Production에만 있는 3건

| 원격 버전 | 원격 이름 | 로컬 비교 후보 | 판정·필요 증거 |
|---|---|---|---|
| 20260917094840 | count_all_linked_meal_corrections | 20260917092710_count_all_linked_meal_corrections.sql | 관계 확인 불가. 원격 statements/배포 SQL 원본 및 현재 함수 본문 비교 필요. 원격 이력 유지 |
| 20260924135025 | fix_employee_schedule_time_compare | 명확한 동등 파일 미확인 | 관계 확인 불가. 원격 statements/배포 SQL 원본 및 현재 함수 본문 비교 필요. 원격 이력 유지 |
| 20260928142712 | replace_sales_receipt_split_payment_rpc | 20260928210713_add_sales_receipt_split_payment.sql | 관계 확인 불가. 원격 statements/배포 SQL 원본 및 현재 함수 본문 비교 필요. 원격 이력 유지 |

식대 후보는 `ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)`를 교체하며 이후 `20261001131334_review_meal_source_drift_without_financial_changes.sql`에 동일 RPC 후속 변경이 있다. 이름 일치는 별도 버전 SQL의 동등성 증명이 아니다. split-payment 후보는 `admin_update_paid_sales_receipt`의 기존 10인자 signature를 DROP하고 `p_split_cash_amount numeric`가 추가된 11인자 signature를 정의한다. 원격 replace 버전이 같은 DROP·본문·권한 전체를 실행했는지 확인해야 한다. schedule time compare 버전은 실제 원격 SQL 확보 전 로컬 파일을 임의 대응시키지 않는다.

## 동일 버전 이름 불일치 2건

| 버전 | 로컬 이름 | 원격 이름 | 판정 |
|---|---|---|---|
| 20260811093311 | add_payroll_attendance_bonus | 202608110001_add_payroll_attendance_bonus | 버전 등록은 확인; 본문 동등성 불명. 이름만 바꾸거나 repair하지 않음 |
| 20260812162019 | add_unauthorized_absence_attendance | 202608120001_add_unauthorized_absence_attendance | 버전 등록은 확인; 본문 동등성 불명. 이름만 바꾸거나 repair하지 않음 |

이 두 버전은 70개 로컬 전용 목록에 포함되지 않는다. 날짜형 접두사 차이가 이름에 들어 있으나 SQL body/hash가 없으므로 단순 별칭이라고 확정하지 않는다.

## 제거·대체 계보의 해석

- 등록된 `202608070004_remove_legacy_payroll_run_engine.sql`은 과거 run engine의 함수·테이블을 명시적으로 제거한다. 202607270002/202607280001/202607300001/202607310001/202608010001의 일부 객체 부재는 이 계보로 설명될 수 있다. 보험 seed·계약·설정·잔존 actor helper까지 Migration 전체가 제거되었다고 확대하지 않는다. SQL 주석의 당시 0행 주장도 현재 데이터 증거가 아니다.
- 등록된 `202608070006_flatten_employee_management_rpcs.sql`, `202608070007_remove_legacy_employee_management_rpcs.sql`은 과거 직원 관리 RPC를 교체/제거한다. 레벨 관련 데이터 seed의 실행 여부는 별도다.
- 등록된 `202608080001_flatten_bar_keeping_rpcs.sql`, `202608080002_remove_legacy_bar_keeping_mutation_rpcs.sql`은 과거 보관 RPC 계보를 바꾼다. 제거된 RPC가 없다는 이유로 원본 Migration을 C로 판정하지 않는다.
- 등록된 `202608070005_remove_default_normal_checkout_time.sql`은 근태/정책 컬럼 제거 계보다. 후속 변경이 일부 컬럼에만 적용된 경우 원본 전체를 B로 분류하지 않는다.

위 관계는 로컬 SQL + 원격 등록 버전 근거이며 실제 Production 대체 본문 검증은 미완료다. 따라서 해당 원본의 현재 판정은 B가 아닌 D다.

## 데이터 보정·seed 실행 증거

| 버전 | 후보 소스 위치 | 변경 대상 | 추가 확인 |
|---|---|---|---|
| 202606130001 | L16 | public.pos_category_group_mappings | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202606140001 | L65, L69, L210, L214 | public.pos_item_mappings, public.pos_item_mapping_recipes | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607140001 | L66, L88 | public.bar_zones, storage.buckets | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607150001 | L4 | public.bar_zones | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607150002 | L53 | storage.buckets | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607150004 | L8, L17 | public.bar_keepings | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607170002 | L4 | public.bar_keepings | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607190002 | L280, L294, L442 | public.legacy_pos_processed_line_archive, public.legacy_pos_inventory_deduction_archive, public.pos_inventory_deductions | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607240001 | L11 | public.store_attendance_policies | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607270001 | L83 | public.employee_work_schedule_versions | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607280001 | L14, L38 | public.users, public.payroll_settings | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202607310001 | L46 | public.payroll_insurance_setting_versions | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202608030001 | L48, L77 | public.employee_level_program_versions, public.users | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |
| 202608040001 | L17, L97 | public.employee_level_program_versions, public.users | DO 조건/실행문 전체 수동 확인, 실행 로그 또는 당시 전후 snapshot·감사 증거. 현재 값만으로 실행 입증 불가 |

DO 내부 SQL은 조건부 실행 또는 동적으로 작성한 함수 내부 문자열일 수 있어 14건 전부를 확정된 운영 backfill로 세지 않았다. 정적 후보다. 이후 앱 저장·다른 Migration·수동 보정도 같은 최종 값을 만들 수 있다. 현재 데이터에서 충족되지 않는 조건도 후속 수정으로 설명될 수 있어 미실행 반증으로 단정하지 않는다.

## 개별 70건 명세 및 추가 검증

### 202606130001 — 202606130001_create_pos_category_group_mappings.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `8972692c7ef1e5d86fd7ec1d4b113baaddcb47bc2ce5113a0a2c21a091f3669c`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.pos_category_group_mappings — L1
  - column create: column:public.pos_category_group_mappings.id — L1
  - column create: column:public.pos_category_group_mappings.category_name — L1
  - column create: column:public.pos_category_group_mappings.group_type — L1
  - column create: column:public.pos_category_group_mappings.display_name — L1
  - column create: column:public.pos_category_group_mappings.note — L1
  - column create: column:public.pos_category_group_mappings.created_at — L1
  - column create: column:public.pos_category_group_mappings.updated_at — L1
  - column create: column:public.pos_category_group_mappings.updated_by — L1
  - alter table: table:public.pos_category_group_mappings — L14
  - insert into: data:public.pos_category_group_mappings — L16
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202606140001 — 202606140001_extend_pos_item_mappings_catalog_link.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `0ee803aef4cc097ab02ba906a9a8bf7e43d0e598261c8d32df1a6881563a00f6`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_item_mappings — L38 [conditional/dynamic DO candidate]
  - column add: column:public.pos_item_mappings.pos_product_id — L1 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_item_mappings — L50
  - column add: column:public.pos_item_mappings.target_type — L50
  - column add: column:public.pos_item_mappings.pos_option_id — L50
  - column add: column:public.pos_item_mappings.pos_product_code_snapshot — L50
  - column add: column:public.pos_item_mappings.pos_product_name_snapshot — L50
  - column add: column:public.pos_item_mappings.pos_option_name_snapshot — L50
  - column add: column:public.pos_item_mappings.mapping_version — L50
  - column add: column:public.pos_item_mappings.last_reconciled_at — L50
  - column add: column:public.pos_item_mappings.updated_at — L50
  - column add: column:public.pos_item_mappings.updated_by — L50
  - alter table: table:public.pos_item_mappings — L61
  - column alter: column:public.pos_item_mappings.target_type — L61
  - column alter: column:public.pos_item_mappings.mapping_version — L61
  - update: data:public.pos_item_mappings — L65
  - update: data:public.pos_item_mappings — L69
  - alter table: table:public.pos_item_mappings — L73
  - column alter: column:public.pos_item_mappings.target_type — L73
  - column alter: column:public.pos_item_mappings.mapping_version — L73
  - alter table: table:public.pos_item_mappings — L85 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mappings.pos_item_mappings_target_type_check — L77 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_item_mappings — L97 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mappings.pos_item_mappings_mapping_version_check — L77 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_item_mappings — L109 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mappings.pos_item_mappings_option_target_check — L77 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_item_mappings — L125 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mappings.pos_item_mappings_pos_product_id_fkey — L77 [conditional/dynamic DO candidate]
  - create unique index: index:public.pos_item_mappings_active_product_uidx — L156 [conditional/dynamic DO candidate]
  - create unique index: index:public.pos_item_mappings_active_option_uidx — L183 [conditional/dynamic DO candidate]
  - create index: index:public.pos_item_mappings_pos_product_id_idx — L194
  - create index: index:public.pos_item_mappings_pos_item_code_idx — L197
  - alter table: table:public.pos_item_mapping_recipes — L200
  - column add: column:public.pos_item_mapping_recipes.is_required — L200
  - column add: column:public.pos_item_mapping_recipes.version — L200
  - column add: column:public.pos_item_mapping_recipes.updated_at — L200
  - column add: column:public.pos_item_mapping_recipes.updated_by — L200
  - alter table: table:public.pos_item_mapping_recipes — L206
  - column alter: column:public.pos_item_mapping_recipes.is_required — L206
  - column alter: column:public.pos_item_mapping_recipes.version — L206
  - update: data:public.pos_item_mapping_recipes — L210
  - update: data:public.pos_item_mapping_recipes — L214
  - alter table: table:public.pos_item_mapping_recipes — L218
  - column alter: column:public.pos_item_mapping_recipes.is_required — L218
  - column alter: column:public.pos_item_mapping_recipes.version — L218
  - alter table: table:public.pos_item_mapping_recipes — L230 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mapping_recipes.pos_item_mapping_recipes_version_check — L222 [conditional/dynamic DO candidate]
  - create index: index:public.pos_item_mapping_recipes_mapping_id_idx — L238
- 후속 동일 객체 변경 후보:
  - table:public.pos_item_mappings → 202606150002 alter table, L1 [L]
  - table:public.pos_item_mappings → 202606190002 alter table, L1 [L]
  - table:public.pos_item_mappings → 202606190002 alter table, L4 [L]
  - table:public.pos_item_mappings → 202606300002 alter table, L1 [L]
  - table:public.pos_item_mappings → 202606300002 alter table, L15 [L] [conditional]
  - table:public.pos_item_mappings → 202606300002 alter table, L27 [L] [conditional]
  - index:public.pos_item_mappings_active_product_uidx → 202606150002 drop index, L9 [L]
  - index:public.pos_item_mappings_active_option_uidx → 202606150002 drop index, L17 [L]
  - table:public.pos_item_mapping_recipes → 202606300001 alter table, L21 [L]
  - table:public.pos_item_mapping_recipes → 202606300001 alter table, L35 [L] [conditional]
  - table:public.pos_item_mapping_recipes → 202606300001 alter table, L47 [L] [conditional]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202606140002 — 202606140002_create_sales_inventory_deduction_batches.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `f567f37741cf7cd845052fe62c98059c48a6ccd5605365b7dcbdaa3f320a1d64`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.pos_inventory_deduction_batches — L1
  - column create: column:public.pos_inventory_deduction_batches.flow_version — L1
  - column create: column:public.pos_inventory_deduction_batches.business_date_from — L1
  - column create: column:public.pos_inventory_deduction_batches.business_date_to — L1
  - column create: column:public.pos_inventory_deduction_batches.source — L1
  - column create: column:public.pos_inventory_deduction_batches.status — L1
  - column create: column:public.pos_inventory_deduction_batches.receipt_count — L1
  - column create: column:public.pos_inventory_deduction_batches.ready_receipt_count — L1
  - column create: column:public.pos_inventory_deduction_batches.blocked_receipt_count — L1
  - column create: column:public.pos_inventory_deduction_batches.skipped_receipt_count — L1
  - column create: column:public.pos_inventory_deduction_batches.already_applied_receipt_count — L1
  - column create: column:public.pos_inventory_deduction_batches.missing_mapping_count — L1
  - column create: column:public.pos_inventory_deduction_batches.manual_review_count — L1
  - column create: column:public.pos_inventory_deduction_batches.invalid_mapping_count — L1
  - column create: column:public.pos_inventory_deduction_batches.incomplete_recipe_count — L1
  - column create: column:public.pos_inventory_deduction_batches.insufficient_stock_count — L1
  - column create: column:public.pos_inventory_deduction_batches.review_required_count — L1
  - column create: column:public.pos_inventory_deduction_batches.created_by — L1
  - column create: column:public.pos_inventory_deduction_batches.created_at — L1
  - column create: column:public.pos_inventory_deduction_batches.previewed_at — L1
  - column create: column:public.pos_inventory_deduction_batches.confirmed_by — L1
  - column create: column:public.pos_inventory_deduction_batches.confirmed_at — L1
  - column create: column:public.pos_inventory_deduction_batches.reverted_by — L1
  - column create: column:public.pos_inventory_deduction_batches.reverted_at — L1
  - column create: column:public.pos_inventory_deduction_batches.error_message — L1
  - column create: column:public.pos_inventory_deduction_batches.note — L1
  - column create: column:public.pos_inventory_deduction_batches.metadata — L1
  - column create: column:public.pos_inventory_deduction_batches.updated_at — L1
  - create index: index:public.pos_inventory_deduction_batches_dates_idx — L50
  - create index: index:public.pos_inventory_deduction_batches_status_created_idx — L56
  - create table: table:public.pos_inventory_deduction_receipts — L81 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.batch_id — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.receipt_ref_no — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.business_date — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.status — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.inventory_affecting_hash — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.amount_hash — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.previewed_receipt_updated_at — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.blocked_reasons — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.line_summary — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.selected_for_apply — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.applied_at — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.applied_by — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.reverted_at — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.reverted_by — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.review_required_at — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.review_reason — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.error_message — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.created_at — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.updated_at — L59 [conditional/dynamic DO candidate]
  - column create: column:public.pos_inventory_deduction_receipts.references — L59 [conditional/dynamic DO candidate]
  - create index: index:public.pos_inventory_deduction_receipts_batch_status_idx — L140
  - create index: index:public.pos_inventory_deduction_receipts_receipt_idx — L147
  - alter table: table:public.pos_inventory_deductions — L150
  - column add: column:public.pos_inventory_deductions.flow_version — L150
  - column add: column:public.pos_inventory_deductions.batch_id — L150
  - column add: column:public.pos_inventory_deductions.batch_receipt_id — L150
  - column add: column:public.pos_inventory_deductions.receipt_ref_no — L150
  - column add: column:public.pos_inventory_deductions.business_date — L150
  - column add: column:public.pos_inventory_deductions.mapping_type — L150
  - column add: column:public.pos_inventory_deductions.operation_type — L150
  - column add: column:public.pos_inventory_deductions.mapping_snapshot — L150
  - column add: column:public.pos_inventory_deductions.inventory_affecting_hash — L150
  - column add: column:public.pos_inventory_deductions.amount_hash — L150
  - column add: column:public.pos_inventory_deductions.idempotency_key — L150
  - column add: column:public.pos_inventory_deductions.quantity_sold — L150
  - column add: column:public.pos_inventory_deductions.deduct_quantity_per_unit — L150
  - column add: column:public.pos_inventory_deductions.deduct_quantity_total — L150
  - column add: column:public.pos_inventory_deductions.current_quantity_snapshot — L150
  - column add: column:public.pos_inventory_deductions.after_quantity_snapshot — L150
  - column add: column:public.pos_inventory_deductions.blocked_reason — L150
  - column add: column:public.pos_inventory_deductions.reverted_at — L150
  - column add: column:public.pos_inventory_deductions.reverted_by — L150
  - column add: column:public.pos_inventory_deductions.updated_at — L150
  - alter table: table:public.pos_inventory_deductions — L251 [conditional/dynamic DO candidate]
  - column add: column:public.pos_inventory_deductions.receipt_id — L172 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L264 [conditional/dynamic DO candidate]
  - column add: column:public.pos_inventory_deductions.receipt_line_id — L172 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L277 [conditional/dynamic DO candidate]
  - column add: column:public.pos_inventory_deductions.mapping_id — L172 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L290 [conditional/dynamic DO candidate]
  - column add: column:public.pos_inventory_deductions.recipe_id — L172 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L303 [conditional/dynamic DO candidate]
  - column add: column:public.pos_inventory_deductions.reversal_of_deduction_id — L172 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L320 [conditional/dynamic DO candidate]
  - column alter: column:public.pos_inventory_deductions.processed_line_id — L310 [conditional/dynamic DO candidate]
  - column drop: column:public.pos_inventory_deductions.not — L310 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L329 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_inventory_deductions.pos_inventory_deductions_batch_fkey — L310 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L342 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_inventory_deductions.pos_inventory_deductions_batch_receipt_fkey — L310 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L355 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_inventory_deductions.pos_inventory_deductions_operation_type_check — L310 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_inventory_deductions — L366 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_inventory_deductions.pos_inventory_deductions_sales_status_check — L310 [conditional/dynamic DO candidate]
  - create unique index: index:public.pos_inventory_deductions_idempotency_uidx — L385
  - create index: index:public.pos_inventory_deductions_batch_receipt_idx — L389
  - alter table: table:public.inventory_logs — L438 [conditional/dynamic DO candidate]
  - column add: column:public.inventory_logs.related_receipt_id — L392 [conditional/dynamic DO candidate]
  - alter table: table:public.inventory_logs — L450 [conditional/dynamic DO candidate]
  - column add: column:public.inventory_logs.related_receipt_line_id — L392 [conditional/dynamic DO candidate]
  - alter table: table:public.inventory_logs — L462 [conditional/dynamic DO candidate]
  - column add: column:public.inventory_logs.related_deduction_id — L392 [conditional/dynamic DO candidate]
  - alter table: table:public.inventory_logs — L467 [conditional/dynamic DO candidate]
  - column add: column:public.inventory_logs.related_batch_id — L392 [conditional/dynamic DO candidate]
  - create index: index:public.inventory_logs_related_batch_idx — L472
- 후속 동일 객체 변경 후보:
  - table:public.pos_inventory_deduction_batches → 202606150001 alter table, L1 [L]
  - table:public.pos_inventory_deduction_receipts → 202606150001 alter table, L4 [L]
  - table:public.pos_inventory_deduction_receipts → 202606150001 alter table, L7 [L]
  - table:public.pos_inventory_deduction_receipts → 202606190001 alter table, L46 [L]
  - table:public.pos_inventory_deduction_receipts → 202606190001 alter table, L49 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L1 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L6 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L9 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L24 [L] [conditional]
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L30 [L]
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L33 [L]
  - table:public.pos_inventory_deduction_receipts → 202607230002 alter table, L1 [L]
  - table:public.pos_inventory_deductions → 202606190001 alter table, L1 [L]
  - table:public.pos_inventory_deductions → 202606190001 alter table, L4 [L]
  - table:public.pos_inventory_deductions → 202606190001 alter table, L7 [L]
  - table:public.pos_inventory_deductions → 202606190001 alter table, L26 [L]
  - table:public.pos_inventory_deductions → 202606190002 alter table, L10 [L]
  - table:public.pos_inventory_deductions → 202606190002 alter table, L13 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L471 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L473 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L476 [L]
  - column:public.pos_inventory_deductions.processed_line_id → 202607190002 column drop, L476 [L]
  - constraint:public.pos_inventory_deductions.pos_inventory_deductions_sales_status_check → 202606190001 constraint drop, L4 [L]
  - constraint:public.pos_inventory_deductions.pos_inventory_deductions_sales_status_check → 202606190001 constraint add, L26 [L]
  - table:public.inventory_logs → 202607020002 alter table, L1 [L]
  - table:public.inventory_logs → 202607020002 alter table, L4 [L]
  - table:public.inventory_logs → 20260906114438 alter table, L508 [R]
  - table:public.inventory_logs → 20260914161954 alter table, L3 [R]
  - table:public.inventory_logs → 20260914161954 alter table, L5 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606150001 — 202606150001_apply_sales_inventory_deduction_batch.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `cd368451babc1f5d1e52042fa51be2fb1e94259801f438d0af179ed33b724d8c`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_inventory_deduction_batches — L1
  - column add: column:public.pos_inventory_deduction_batches.applied_receipt_count — L1
  - alter table: table:public.pos_inventory_deduction_receipts — L4
  - constraint drop: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_selection_check — L4
  - alter table: table:public.pos_inventory_deduction_receipts — L7
  - constraint add: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_selection_check — L7
  - create or replace function: function:public.apply_sales_inventory_deduction_batch(bigint,text,jsonb) — L14
  - revoke: privilege:revoke all on function public.apply_sales_inventory_deduction_batch( bigint, text, jsonb ) from public; — L605
  - grant: privilege:grant execute on function public.apply_sales_inventory_deduction_batch( bigint, text, jsonb ) to service_role; — L611
- 후속 동일 객체 변경 후보:
  - table:public.pos_inventory_deduction_receipts → 202606190001 alter table, L46 [L]
  - table:public.pos_inventory_deduction_receipts → 202606190001 alter table, L49 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L1 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L6 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L9 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L24 [L] [conditional]
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L30 [L]
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L33 [L]
  - table:public.pos_inventory_deduction_receipts → 202607230002 alter table, L1 [L]
  - function:public.apply_sales_inventory_deduction_batch(bigint,text,jsonb) → 202606210001 create or replace function, L1 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606150002 — 202606150002_archive_pos_item_mappings.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `a7f9473c80ce10a774cf24521eeb3aad06279cfddf9c1c340293e2e427e80ce4`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_item_mappings — L1
  - column add: column:public.pos_item_mappings.archived_at — L1
  - column add: column:public.pos_item_mappings.archived_by — L1
  - column add: column:public.pos_item_mappings.archive_reason — L1
  - create index: index:public.pos_item_mappings_archived_at_idx — L6
  - drop index: index:public.pos_item_mappings_active_product_uidx — L9
  - create unique index: index:public.pos_item_mappings_active_product_uidx — L10
  - drop index: index:public.pos_item_mappings_active_option_uidx — L17
  - create unique index: index:public.pos_item_mappings_active_option_uidx — L18
  - 동적 함수 patch/문자열 치환 후보 포함: pg_get_functiondef 원문과 치환 전제·결과 본문 확인 필요.
- 후속 동일 객체 변경 후보:
  - table:public.pos_item_mappings → 202606190002 alter table, L1 [L]
  - table:public.pos_item_mappings → 202606190002 alter table, L4 [L]
  - table:public.pos_item_mappings → 202606300002 alter table, L1 [L]
  - table:public.pos_item_mappings → 202606300002 alter table, L15 [L] [conditional]
  - table:public.pos_item_mappings → 202606300002 alter table, L27 [L] [conditional]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606190001 — 202606190001_align_sales_inventory_deduction_status_checks.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `1f5471d3b8a22f41c524089119d15adad6df97349691049e151bac03f575721a`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_inventory_deductions — L1
  - constraint drop: constraint:public.pos_inventory_deductions.pos_inventory_deductions_status_check — L1
  - alter table: table:public.pos_inventory_deductions — L4
  - constraint drop: constraint:public.pos_inventory_deductions.pos_inventory_deductions_sales_status_check — L4
  - alter table: table:public.pos_inventory_deductions — L7
  - constraint add: constraint:public.pos_inventory_deductions.pos_inventory_deductions_status_check — L7
  - alter table: table:public.pos_inventory_deductions — L26
  - constraint add: constraint:public.pos_inventory_deductions.pos_inventory_deductions_sales_status_check — L26
  - alter table: table:public.pos_inventory_deduction_receipts — L46
  - constraint drop: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_status_check — L46
  - alter table: table:public.pos_inventory_deduction_receipts — L49
  - constraint add: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_status_check — L49
- 후속 동일 객체 변경 후보:
  - table:public.pos_inventory_deductions → 202606190002 alter table, L10 [L]
  - table:public.pos_inventory_deductions → 202606190002 alter table, L13 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L471 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L473 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L476 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L1 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L6 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L9 [L]
  - table:public.pos_inventory_deduction_receipts → 202607100001 alter table, L24 [L] [conditional]
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L30 [L]
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L33 [L]
  - table:public.pos_inventory_deduction_receipts → 202607230002 alter table, L1 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606190002 — 202606190002_allow_combo_pos_mapping_type.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `eebf66cd3d6915c59a39e55cd0307dc7e2c7c09145df57f2b500440ee300e71d`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_item_mappings — L1
  - constraint drop: constraint:public.pos_item_mappings.pos_item_mappings_mapping_type_check — L1
  - alter table: table:public.pos_item_mappings — L4
  - constraint add: constraint:public.pos_item_mappings.pos_item_mappings_mapping_type_check — L4
  - alter table: table:public.pos_inventory_deductions — L10
  - constraint drop: constraint:public.pos_inventory_deductions.pos_inventory_deductions_mapping_type_check — L10
  - alter table: table:public.pos_inventory_deductions — L13
  - constraint add: constraint:public.pos_inventory_deductions.pos_inventory_deductions_mapping_type_check — L13
- 후속 동일 객체 변경 후보:
  - table:public.pos_item_mappings → 202606300002 alter table, L1 [L]
  - table:public.pos_item_mappings → 202606300002 alter table, L15 [L] [conditional]
  - table:public.pos_item_mappings → 202606300002 alter table, L27 [L] [conditional]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L471 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L473 [L]
  - table:public.pos_inventory_deductions → 202607190002 alter table, L476 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606210001 — 202606210001_add_purchase_price_to_sale_deduction_logs.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Accounting linkage, settlement or closed-month behavior: object presence cannot prove economic correction or historical execution.
- 파일 SHA-256: `00243d23bee9c2d422982e4e470338f88258766c8f25c60ddd639996363c9f8c`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.apply_sales_inventory_deduction_batch(bigint,text,jsonb) — L1
  - revoke: privilege:revoke all on function public.apply_sales_inventory_deduction_batch( bigint, text, jsonb ) from public; — L596
  - grant: privilege:grant execute on function public.apply_sales_inventory_deduction_batch( bigint, text, jsonb ) to service_role; — L602
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606230001 — 202606230001_add_pos_sales_sync_run_lock.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `0a7b23330ffa3570b7aff9fc80a85ccc82fd50969be6541030c96f4effefa247`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create unique index: index:public.pos_sales_sync_runs_running_lock_uidx — L1
  - create index: index:public.pos_sales_sync_runs_running_started_idx — L5
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606260001 — 202606260001_add_manual_receipt_ref_no_unique_index.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `099018eaf705e82cf90f3c76578652b567e2379af7788defd83a5b255f34231d`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create unique index: index:public.pos_sales_receipts_manual_ref_no_uidx — L1
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606300001 — 202606300001_add_inventory_package_volume_and_recipe_source.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `772ad8fefe73eef5354d61d94e1c7a22a2b58c70410bd847a1b67207fa7a4931`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.inventory — L1
  - column add: column:public.inventory.package_content_quantity — L1
  - column add: column:public.inventory.package_content_unit — L1
  - alter table: table:public.inventory — L13 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.inventory.inventory_package_content_quantity_positive_check — L5 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_item_mapping_recipes — L21
  - column add: column:public.pos_item_mapping_recipes.source_quantity — L21
  - column add: column:public.pos_item_mapping_recipes.source_unit — L21
  - column add: column:public.pos_item_mapping_recipes.source_package_content_quantity — L21
  - column add: column:public.pos_item_mapping_recipes.source_package_content_unit — L21
  - alter table: table:public.pos_item_mapping_recipes — L35 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mapping_recipes.pos_item_mapping_recipes_source_quantity_positive_check — L27 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_item_mapping_recipes — L47 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mapping_recipes.pos_item_mapping_recipes_source_package_content_quantity_positive_check — L27 [conditional/dynamic DO candidate]
- 후속 동일 객체 변경 후보:
  - table:public.inventory → 202607050001 alter table, L1 [L]
  - table:public.inventory → 202607050004 alter table, L1 [L]
  - table:public.inventory → 202608060002 alter table, L57 [R] [conditional]
  - table:public.inventory → 202608060002 alter table, L68 [R]
  - table:public.inventory → 202608060002 alter table, L71 [R]
  - table:public.inventory → 202608220002 alter table, L28 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202606300002 — 202606300002_add_direct_mapping_source_content.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `6953960cd9f300a2a8a9fb8634fa91b6a9635957fdb7031f5c06cfee99c7fa23`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_item_mappings — L1
  - column add: column:public.pos_item_mappings.source_quantity — L1
  - column add: column:public.pos_item_mappings.source_unit — L1
  - column add: column:public.pos_item_mappings.source_package_content_quantity — L1
  - column add: column:public.pos_item_mappings.source_package_content_unit — L1
  - alter table: table:public.pos_item_mappings — L15 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mappings.pos_item_mappings_source_quantity_positive_check — L7 [conditional/dynamic DO candidate]
  - alter table: table:public.pos_item_mappings — L27 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_item_mappings.pos_item_mappings_source_package_content_quantity_positive_check — L7 [conditional/dynamic DO candidate]
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607010001 — 202607010001_add_leader_role.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `94207a9ecf635134a393d67a6958491d992443d358eef8d0054832a557870a9a`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.users — L14 [conditional/dynamic DO candidate]
  - alter table: table:public.users — L18
  - constraint add: constraint:public.users.users_role_check — L18
- 후속 동일 객체 변경 후보:
  - table:public.users → 202607280001 alter table, L3 [L]
  - table:public.users → 202607280001 alter table, L7 [L]
  - table:public.users → 202607280001 alter table, L8 [L]
  - table:public.users → 202607280002 alter table, L3 [L]
  - table:public.users → 20260728182601 alter table, L3 [R]
  - table:public.users → 20260728182601 alter table, L7 [R]
  - table:public.users → 202608060001 alter table, L16 [R]
  - table:public.users → 202608060001 alter table, L49 [R]
  - table:public.users → 202608060001 alter table, L51 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607020001 — 202607020001_create_inventory_keg_tracking.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `125b1460d87a7ea377dca000345cf1e42246ff7913fe849b9ccbc75b6afcf605`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.inventory_keg_sessions — L1
  - column create: column:public.inventory_keg_sessions.inventory_item_id — L1
  - column create: column:public.inventory_keg_sessions.status — L1
  - column create: column:public.inventory_keg_sessions.started_at — L1
  - column create: column:public.inventory_keg_sessions.started_business_date — L1
  - column create: column:public.inventory_keg_sessions.started_log_id — L1
  - column create: column:public.inventory_keg_sessions.ended_at — L1
  - column create: column:public.inventory_keg_sessions.ended_business_date — L1
  - column create: column:public.inventory_keg_sessions.ended_log_id — L1
  - column create: column:public.inventory_keg_sessions.capacity_quantity — L1
  - column create: column:public.inventory_keg_sessions.capacity_unit — L1
  - column create: column:public.inventory_keg_sessions.sold_quantity — L1
  - column create: column:public.inventory_keg_sessions.sold_unit — L1
  - column create: column:public.inventory_keg_sessions.loss_quantity — L1
  - column create: column:public.inventory_keg_sessions.loss_rate — L1
  - column create: column:public.inventory_keg_sessions.summary_note — L1
  - column create: column:public.inventory_keg_sessions.created_by — L1
  - column create: column:public.inventory_keg_sessions.closed_by — L1
  - column create: column:public.inventory_keg_sessions.created_at — L1
  - column create: column:public.inventory_keg_sessions.updated_at — L1
  - create unique index: index:public.inventory_keg_sessions_one_active_uidx — L40
  - create index: index:public.inventory_keg_sessions_item_started_idx — L44
  - create table: table:public.inventory_keg_tracking_mappings — L47
  - column create: column:public.inventory_keg_tracking_mappings.inventory_item_id — L47
  - column create: column:public.inventory_keg_tracking_mappings.target_type — L47
  - column create: column:public.inventory_keg_tracking_mappings.pos_product_id — L47
  - column create: column:public.inventory_keg_tracking_mappings.pos_option_id — L47
  - column create: column:public.inventory_keg_tracking_mappings.quantity_per_pos_unit — L47
  - column create: column:public.inventory_keg_tracking_mappings.unit — L47
  - column create: column:public.inventory_keg_tracking_mappings.is_active — L47
  - column create: column:public.inventory_keg_tracking_mappings.created_at — L47
  - column create: column:public.inventory_keg_tracking_mappings.updated_at — L47
  - column create: column:public.inventory_keg_tracking_mappings.updated_by — L47
  - create unique index: index:public.inventory_keg_tracking_product_active_uidx — L71
  - create unique index: index:public.inventory_keg_tracking_option_active_uidx — L75
  - create index: index:public.inventory_keg_tracking_item_active_idx — L79
  - create or replace function: function:public.replace_inventory_keg(bigint,text,date,numeric) — L82
- 후속 동일 객체 변경 후보:
  - function:public.replace_inventory_keg(bigint,text,date,numeric) → 202607230003 create or replace function, L316 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607020002 — 202607020002_allow_keg_replace_inventory_log_source.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `1c922163bb51e7c4f3d6290151d78f997280c6fe3653ab02436a866b0294e549`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.inventory_logs — L1
  - constraint drop: constraint:public.inventory_logs.inventory_logs_source_check — L1
  - alter table: table:public.inventory_logs — L4
  - constraint add: constraint:public.inventory_logs.inventory_logs_source_check — L4
- 후속 동일 객체 변경 후보:
  - table:public.inventory_logs → 20260906114438 alter table, L508 [R]
  - table:public.inventory_logs → 20260914161954 alter table, L3 [R]
  - table:public.inventory_logs → 20260914161954 alter table, L5 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607020003 — 202607020003_keg_replacement_time_and_note.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `8ad224ce1f8cda8151b6e656f0e89af8d156888e4c373484a528b253d966546e`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.replace_inventory_keg(bigint,text,date,numeric,timestamptz) — L1
- 후속 동일 객체 변경 후보:
  - function:public.replace_inventory_keg(bigint,text,date,numeric,timestamptz) → 202607060001 create or replace function, L1 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607050001 — 202607050001_add_inventory_is_active.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `6877885ed7053e7541eb5b51fdec4a873e5f3817565f6193eb49a41c31cec0dd`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.inventory — L1
  - column add: column:public.inventory.is_active — L1
  - create index: index:public.inventory_is_active_updated_idx — L4
- 후속 동일 객체 변경 후보:
  - table:public.inventory → 202607050004 alter table, L1 [L]
  - table:public.inventory → 202608060002 alter table, L57 [R] [conditional]
  - table:public.inventory → 202608060002 alter table, L68 [R]
  - table:public.inventory → 202608060002 alter table, L71 [R]
  - table:public.inventory → 202608220002 alter table, L28 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607050002 — 202607050002_add_inventory_stock_check_log_index.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Query plan / index definition and write overhead; never recreate an existing index merely to register history.
- 파일 SHA-256: `dbfb3a2319898629c840783b3efdc39d5f802dff6c9a1ec92595ae4c3a30ed7d`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create index: index:public.inventory_logs_stock_check_item_business_date_idx — L1
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607050003 — 202607050003_add_inventory_sale_deduction_log_index.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `1e62c94caa75781fb5f7835d552c18b0b24b4365c8f063b8204d1f6dde932ecd`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create index: index:public.inventory_logs_sale_deduction_item_business_date_idx — L1
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607050004 — 202607050004_add_inventory_low_stock_enabled.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `1add4ccdf567e453cb3d0caa803e43f4f85e79f02ff20ac49934221440d1d9e6`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.inventory — L1
  - column add: column:public.inventory.low_stock_enabled — L1
- 후속 동일 객체 변경 후보:
  - table:public.inventory → 202608060002 alter table, L57 [R] [conditional]
  - table:public.inventory → 202608060002 alter table, L68 [R]
  - table:public.inventory → 202608060002 alter table, L71 [R]
  - table:public.inventory → 202608220002 alter table, L28 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607060001 — 202607060001_classify_keg_replace_as_sale_deduction.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `c02754a4fcea698487eb15ccd0aaa1803d849af9df1fd210749e37ce719d870d`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.replace_inventory_keg(bigint,text,date,numeric,timestamptz) — L1
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607090001 — 202607090001_add_sales_sync_lookup_indexes.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Query plan / index definition and write overhead; never recreate an existing index merely to register history.
- 파일 SHA-256: `52d49f1bd43e5d84faf8a56046e3e283b534fec6504533501502700e663b2e0c`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create index: index:public.pos_sales_sync_runs_recent_success_idx — L1
  - create index: index:public.pos_inventory_deductions_receipt_id_idx — L10
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607100001 — 202607100001_add_inventory_deduction_receipt_workflow_fingerprint.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `87e1118c4d3c128b6f0c79dbcbd1a19202ec3282cee7cccf37fe3dce8c673013`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_inventory_deduction_receipts — L1
  - column add: column:public.pos_inventory_deduction_receipts.workflow_type — L1
  - column add: column:public.pos_inventory_deduction_receipts.receipt_content_fingerprint — L1
  - column add: column:public.pos_inventory_deduction_receipts.supersedes_deduction_receipt_id — L1
  - alter table: table:public.pos_inventory_deduction_receipts — L6
  - constraint drop: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_workflow_type_check — L6
  - alter table: table:public.pos_inventory_deduction_receipts — L9
  - constraint add: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_workflow_type_check — L9
  - alter table: table:public.pos_inventory_deduction_receipts — L24 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_supersedes_fkey — L17 [conditional/dynamic DO candidate]
  - create index: index:public.pos_inventory_deduction_receipts_fingerprint_idx — L33
  - create unique index: index:public.pos_inventory_deduction_receipts_success_fingerprint_uidx — L40
- 후속 동일 객체 변경 후보:
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L30 [L]
  - table:public.pos_inventory_deduction_receipts → 202607130001 alter table, L33 [L]
  - table:public.pos_inventory_deduction_receipts → 202607230002 alter table, L1 [L]
  - constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_workflow_type_check → 202607130001 constraint drop, L30 [L]
  - constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_workflow_type_check → 202607130001 constraint add, L33 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607100002 — 202607100002_reprocess_modified_sales_inventory_deduction.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `f5e3be1aff6b9a3b42a8073ca760c554d8eac2564d1299fb7ba6e1cd30fd4c41`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create unique index: index:public.pos_inventory_deductions_idempotency_uidx — L1
  - create unique index: index:public.pos_inventory_deductions_success_reversal_uidx — L5
  - create or replace function: function:public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text) — L15
- 후속 동일 객체 변경 후보:
  - function:public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text) → 202607180005 create or replace function, L5 [L]
  - Dynamic patch reference → 202607190002 [L]; 원본 실행 및 patch 성공은 입증되지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607130001 — 202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `10966698df283c6a3702d215d098f09c880b53bbc4268317b223972d0a6de64b`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_sales_receipts — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_auto_eligible_at — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_processing_paused — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_processing_paused_at — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_processing_error — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_reprocess_required — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_last_checked_at — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_pending_fingerprint — L1
  - column add: column:public.pos_sales_receipts.inventory_deduction_pending_status — L1
  - create index: index:public.pos_sales_receipts_auto_deduction_eligible_idx — L22
  - alter table: table:public.pos_inventory_deduction_receipts — L30
  - constraint drop: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_workflow_type_check — L30
  - alter table: table:public.pos_inventory_deduction_receipts — L33
  - constraint add: constraint:public.pos_inventory_deduction_receipts.pos_inventory_deduction_receipts_workflow_type_check — L33
  - create or replace function: function:public.rollback_canceled_sales_inventory_deduction_receipt(bigint,text,timestamptz,text) — L45
  - revoke: privilege:revoke all on function public.rollback_canceled_sales_inventory_deduction_receipt( bigint, text, timestamptz, text ) from public; — L391
  - grant: privilege:grant execute on function public.rollback_canceled_sales_inventory_deduction_receipt( bigint, text, timestamptz, text ) to service_role; — L398
  - revoke: privilege:revoke all on function public.reprocess_modified_sales_inventory_deduction_receipt( bigint, text, timestamptz, text, text ) from public; — L405
  - grant: privilege:grant execute on function public.reprocess_modified_sales_inventory_deduction_receipt( bigint, text, timestamptz, text, text ) to service_role; — L413
- 후속 동일 객체 변경 후보:
  - table:public.pos_sales_receipts → 202607170001 alter table, L1 [L]
  - table:public.pos_sales_receipts → 202607170001 alter table, L8 [L]
  - table:public.pos_inventory_deduction_receipts → 202607230002 alter table, L1 [L]
  - Dynamic patch reference → 202607190002 [L]; 원본 실행 및 patch 성공은 입증되지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607140001 — 202607140001_create_bar_zone_management.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `364c3aa03721490813a473cf556f088571476d0a0c4b95ecf480b975a0926d4d`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.bar_zones — L4
  - column create: column:public.bar_zones.id — L4
  - column create: column:public.bar_zones.code — L4
  - column create: column:public.bar_zones.kind — L4
  - column create: column:public.bar_zones.selectable_for_keeping — L4
  - column create: column:public.bar_zones.note_ko — L4
  - column create: column:public.bar_zones.note_vi — L4
  - column create: column:public.bar_zones.image_path — L4
  - column create: column:public.bar_zones.assignee_user_id — L4
  - column create: column:public.bar_zones.is_active — L4
  - column create: column:public.bar_zones.version — L4
  - column create: column:public.bar_zones.created_at — L4
  - column create: column:public.bar_zones.updated_at — L4
  - column create: column:public.bar_zones.updated_by_user_id — L4
  - create index: index:public.bar_zones_assignee_user_id_idx — L30
  - create index: index:public.bar_zones_is_active_idx — L31
  - create table: table:public.bar_staff_profiles — L33
  - column create: column:public.bar_staff_profiles.user_id — L33
  - column create: column:public.bar_staff_profiles.color_key — L33
  - column create: column:public.bar_staff_profiles.updated_by_user_id — L33
  - column create: column:public.bar_staff_profiles.created_at — L33
  - column create: column:public.bar_staff_profiles.updated_at — L33
  - create table: table:public.bar_activity_logs — L44
  - column create: column:public.bar_activity_logs.id — L44
  - column create: column:public.bar_activity_logs.entity_type — L44
  - column create: column:public.bar_activity_logs.entity_id — L44
  - column create: column:public.bar_activity_logs.entity_code_snapshot — L44
  - column create: column:public.bar_activity_logs.action_type — L44
  - column create: column:public.bar_activity_logs.before_data — L44
  - column create: column:public.bar_activity_logs.after_data — L44
  - column create: column:public.bar_activity_logs.actor_user_id — L44
  - column create: column:public.bar_activity_logs.actor_name_snapshot — L44
  - column create: column:public.bar_activity_logs.created_at — L44
  - create index: index:public.bar_activity_logs_recent_idx — L57
  - create index: index:public.bar_activity_logs_entity_idx — L58
  - create index: index:public.bar_activity_logs_actor_idx — L59
  - create index: index:public.bar_activity_logs_action_idx — L60
  - alter table: table:public.bar_zones — L62
  - alter table: table:public.bar_staff_profiles — L63
  - alter table: table:public.bar_activity_logs — L64
  - insert into: data:public.bar_zones — L66
  - insert into: data:storage.buckets — L88
  - create or replace function: function:public.bar_update_zone(text,integer,bigint,text,boolean,text,text,boolean,bigint,boolean,text) — L101
  - create or replace function: function:public.bar_update_zone_photo(text,integer,text,bigint,text) — L219
  - revoke: privilege:revoke all on function public.bar_update_zone(text, integer, bigint, text, boolean, text, text, boolean, bigint, boolean, text) from public, anon, authenticated; — L278
  - revoke: privilege:revoke all on function public.bar_update_zone_photo(text, integer, text, bigint, text) from public, anon, authenticated; — L279
  - grant: privilege:grant execute on function public.bar_update_zone(text, integer, bigint, text, boolean, text, text, boolean, bigint, boolean, text) to service_role; — L280
  - grant: privilege:grant execute on function public.bar_update_zone_photo(text, integer, text, bigint, text) to service_role; — L281
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.bar_zones → 202607150001 alter table, L1 [L]
  - function:public.bar_update_zone_photo(text,integer,text,bigint,text) → 202607150001 create or replace function, L20 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607150001 — 202607150001_add_bar_zone_image_updated_at.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `a7d9e6069ff0bedfa7d7e71324bb684abf611317baf71f5dcb689843a82fc37c`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.bar_zones — L1
  - column add: column:public.bar_zones.image_updated_at — L1
  - update: data:public.bar_zones — L4
  - create or replace function: function:public.bar_update_zone_photo(text,integer,text,bigint,text) — L20
  - revoke: privilege:revoke all on function public.bar_update_zone_photo(text, integer, text, bigint, text) from public, anon, authenticated; — L82
  - grant: privilege:grant execute on function public.bar_update_zone_photo(text, integer, text, bigint, text) to service_role; — L83
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607150002 — 202607150002_create_bar_keeping_management.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `c3e5bb94119d116f3d6035b7866fa8ef7c7de65c7017ec0cf53c13672f318576`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.bar_keepings — L4
  - column create: column:public.bar_keepings.id — L4
  - column create: column:public.bar_keepings.customer_name — L4
  - column create: column:public.bar_keepings.customer_identifier — L4
  - column create: column:public.bar_keepings.liquor_name — L4
  - column create: column:public.bar_keepings.note — L4
  - column create: column:public.bar_keepings.zone_code — L4
  - column create: column:public.bar_keepings.status — L4
  - column create: column:public.bar_keepings.close_reason — L4
  - column create: column:public.bar_keepings.close_note — L4
  - column create: column:public.bar_keepings.remaining_percent — L4
  - column create: column:public.bar_keepings.image_path — L4
  - column create: column:public.bar_keepings.thumbnail_path — L4
  - column create: column:public.bar_keepings.image_updated_at — L4
  - column create: column:public.bar_keepings.stored_at — L4
  - column create: column:public.bar_keepings.last_used_at — L4
  - column create: column:public.bar_keepings.expires_at — L4
  - column create: column:public.bar_keepings.closed_at — L4
  - column create: column:public.bar_keepings.created_by_user_id — L4
  - column create: column:public.bar_keepings.updated_by_user_id — L4
  - column create: column:public.bar_keepings.closed_by_user_id — L4
  - column create: column:public.bar_keepings.version — L4
  - column create: column:public.bar_keepings.created_at — L4
  - column create: column:public.bar_keepings.updated_at — L4
  - create index: index:public.bar_keepings_status_recent_idx — L47
  - create index: index:public.bar_keepings_zone_status_recent_idx — L48
  - create index: index:public.bar_keepings_expiry_idx — L49
  - create index: index:public.bar_keepings_customer_sort_idx — L50
  - alter table: table:public.bar_keepings — L51
  - insert into: data:storage.buckets — L53
  - create or replace function: function:public.bar_create_keeping(text,text,text,text,text,integer,text,text,date,date,bigint) — L57
  - create or replace function: function:public.bar_mutate_keeping(bigint,integer,text,jsonb,bigint) — L81
  - revoke: privilege:revoke all on function public.bar_create_keeping(text,text,text,text,text,integer,text,text,date,date,bigint) from public, anon, authenticated; — L158
  - revoke: privilege:revoke all on function public.bar_mutate_keeping(bigint,integer,text,jsonb,bigint) from public, anon, authenticated; — L159
  - grant: privilege:grant execute on function public.bar_create_keeping(text,text,text,text,text,integer,text,text,date,date,bigint) to service_role; — L160
  - grant: privilege:grant execute on function public.bar_mutate_keeping(bigint,integer,text,jsonb,bigint) to service_role; — L161
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.bar_keepings → 202607150003 alter table, L4 [L]
  - table:public.bar_keepings → 202607150003 alter table, L8 [L]
  - table:public.bar_keepings → 202607150004 alter table, L4 [L]
  - table:public.bar_keepings → 202607160001 alter table, L4 [L]
  - table:public.bar_keepings → 202607180001 alter table, L2 [L]
  - function:public.bar_mutate_keeping(bigint,integer,text,jsonb,bigint) → 202608080002 drop function, L40 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607150003 — 202607150003_add_bar_keeping_liquor_source.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `259fa282095b6c6c20ef5f959ac7b60aa1a947533c14bd40bbb866aef05d83ce`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.bar_keepings — L4
  - column add: column:public.bar_keepings.liquor_source — L4
  - column add: column:public.bar_keepings.inventory_item_id — L4
  - alter table: table:public.bar_keepings — L8
  - constraint add: constraint:public.bar_keepings.bar_keepings_liquor_source_check — L8
  - constraint add: constraint:public.bar_keepings.bar_keepings_liquor_source_item_check — L8
  - constraint add: constraint:public.bar_keepings.bar_keepings_inventory_item_fkey — L8
  - create index: index:public.bar_keepings_inventory_item_idx — L20
  - create or replace function: function:public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) — L24
  - create or replace function: function:public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) — L67
  - revoke: privilege:revoke all on function public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) from public,anon,authenticated; — L102
  - revoke: privilege:revoke all on function public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) from public,anon,authenticated; — L103
  - revoke: privilege:revoke execute on function public.bar_create_keeping(text,text,text,text,text,integer,text,text,date,date,bigint) from service_role; — L104
  - grant: privilege:grant execute on function public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) to service_role; — L105
  - grant: privilege:grant execute on function public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) to service_role; — L106
- 후속 동일 객체 변경 후보:
  - table:public.bar_keepings → 202607150004 alter table, L4 [L]
  - table:public.bar_keepings → 202607160001 alter table, L4 [L]
  - table:public.bar_keepings → 202607180001 alter table, L2 [L]
  - function:public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) → 202607150004 create or replace function, L21 [L]
  - function:public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) → 202607150004 create or replace function, L63 [L]
  - function:public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) → 202608080002 drop function, L48 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607150004 — 202607150004_add_bar_keeping_use_count_fixed_expiry.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `7b53678e0860f5040a3b6db91bad0870b8b24649c2c375ee90720831d314b207`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.bar_keepings — L4
  - column add: column:public.bar_keepings.use_count — L4
  - constraint add: constraint:public.bar_keepings.bar_keepings_use_count_check — L4
  - update: data:public.bar_keepings — L8
  - update: data:public.bar_keepings — L17
  - create or replace function: function:public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) — L21
  - create or replace function: function:public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) — L63
  - revoke: privilege:revoke all on function public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) from public,anon,authenticated; — L129
  - revoke: privilege:revoke all on function public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) from public,anon,authenticated; — L130
  - grant: privilege:grant execute on function public.bar_create_keeping(text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) to service_role; — L131
  - grant: privilege:grant execute on function public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) to service_role; — L132
- 후속 동일 객체 변경 후보:
  - table:public.bar_keepings → 202607160001 alter table, L4 [L]
  - table:public.bar_keepings → 202607180001 alter table, L2 [L]
  - function:public.bar_mutate_keeping_v2(bigint,integer,text,jsonb,bigint) → 202608080002 drop function, L48 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607160001 — 202607160001_add_bar_keeping_customer_contact.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `6bb1905360c6a4f857443152952141565258eec3b0b32bc91f68779d94727d5a`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.bar_keepings — L4
  - column add: column:public.bar_keepings.customer_contact — L4
  - constraint add: constraint:public.bar_keepings.bar_keepings_customer_contact_check — L4
  - create or replace function: function:public.bar_create_keeping(text,text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) — L11
  - create or replace function: function:public.bar_mutate_keeping_v3(bigint,integer,text,jsonb,bigint) — L46
  - revoke: privilege:revoke all on function public.bar_create_keeping(text,text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) from public, anon, authenticated; — L78
  - revoke: privilege:revoke all on function public.bar_mutate_keeping_v3(bigint,integer,text,jsonb,bigint) from public, anon, authenticated; — L79
  - grant: privilege:grant execute on function public.bar_create_keeping(text,text,text,text,bigint,text,text,text,integer,text,text,date,date,bigint) to service_role; — L80
  - grant: privilege:grant execute on function public.bar_mutate_keeping_v3(bigint,integer,text,jsonb,bigint) to service_role; — L81
- 후속 동일 객체 변경 후보:
  - table:public.bar_keepings → 202607180001 alter table, L2 [L]
  - function:public.bar_mutate_keeping_v3(bigint,integer,text,jsonb,bigint) → 202608080002 drop function, L56 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607160002 — 202607160002_add_bar_keeping_atomic_update_move.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `62f8925635b81731d88a21175d16c4bf8bdf54ccd19bee572961ae17a7c85086`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.bar_update_and_move_keeping(bigint,integer,jsonb,jsonb,bigint) — L4
  - revoke: privilege:revoke all on function public.bar_update_and_move_keeping(bigint,integer,jsonb,jsonb,bigint) from public, anon, authenticated; — L32
  - grant: privilege:grant execute on function public.bar_update_and_move_keeping(bigint,integer,jsonb,jsonb,bigint) to service_role; — L34
- 후속 동일 객체 변경 후보:
  - function:public.bar_update_and_move_keeping(bigint,integer,jsonb,jsonb,bigint) → 202608080001 create or replace function, L480 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607170001 — 202607170001_add_sales_receipt_financial_overrides.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `1a63de05a6a720f1c690c774dec02d1946e7623c34f2fe583ff41ab939b383ee`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_sales_receipts — L1
  - column add: column:public.pos_sales_receipts.tax_override_mode — L1
  - column add: column:public.pos_sales_receipts.calculated_vat_amount — L1
  - column add: column:public.pos_sales_receipts.calculated_final_amount — L1
  - column add: column:public.pos_sales_receipts.final_amount_override — L1
  - column add: column:public.pos_sales_receipts.revision — L1
  - alter table: table:public.pos_sales_receipts — L8
  - constraint drop: constraint:public.pos_sales_receipts.pos_sales_receipts_tax_override_mode_check — L8
  - constraint add: constraint:public.pos_sales_receipts.pos_sales_receipts_tax_override_mode_check — L8
  - constraint drop: constraint:public.pos_sales_receipts.pos_sales_receipts_calculated_vat_amount_check — L8
  - constraint add: constraint:public.pos_sales_receipts.pos_sales_receipts_calculated_vat_amount_check — L8
  - constraint drop: constraint:public.pos_sales_receipts.pos_sales_receipts_calculated_final_amount_check — L8
  - constraint add: constraint:public.pos_sales_receipts.pos_sales_receipts_calculated_final_amount_check — L8
  - constraint drop: constraint:public.pos_sales_receipts.pos_sales_receipts_final_amount_override_check — L8
  - constraint add: constraint:public.pos_sales_receipts.pos_sales_receipts_final_amount_override_check — L8
  - create table: table:public.pos_sales_receipt_modifications — L22
  - column create: column:public.pos_sales_receipt_modifications.id — L22
  - column create: column:public.pos_sales_receipt_modifications.receipt_id — L22
  - column create: column:public.pos_sales_receipt_modifications.request_id — L22
  - column create: column:public.pos_sales_receipt_modifications.revision_before — L22
  - column create: column:public.pos_sales_receipt_modifications.revision_after — L22
  - column create: column:public.pos_sales_receipt_modifications.modified_by — L22
  - column create: column:public.pos_sales_receipt_modifications.modification_note — L22
  - column create: column:public.pos_sales_receipt_modifications.before_state — L22
  - column create: column:public.pos_sales_receipt_modifications.after_state — L22
  - column create: column:public.pos_sales_receipt_modifications.result — L22
  - column create: column:public.pos_sales_receipt_modifications.created_at — L22
  - alter table: table:public.pos_sales_receipt_modifications — L37
  - create or replace function: function:public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb) — L39
  - revoke: privilege:revoke all on function public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb) from public, anon, authenticated; — L300
  - grant: privilege:grant execute on function public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb) to service_role; — L302
  - revoke: privilege:revoke all on table public.pos_sales_receipt_modifications from public, anon, authenticated; — L305
  - grant: privilege:grant select, insert on table public.pos_sales_receipt_modifications to service_role; — L306
  - grant: privilege:grant usage, select on sequence public.pos_sales_receipt_modifications_id_seq to service_role; — L307
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - function:public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb) → 20260928210713 drop function, L2 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607170002 — 202607170002_unify_bar_keeping_action_notes.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `720c5b5fe7bf3b9b6d15752a0ce01c9c20fc098f2786afd190c730fbf26780a3`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - update: data:public.bar_keepings — L4
  - create or replace function: function:public.bar_mutate_keeping_v4(bigint,integer,text,jsonb,bigint) — L9
  - revoke: privilege:revoke all on function public.bar_mutate_keeping_v4(bigint,integer,text,jsonb,bigint) from public, anon, authenticated; — L113
  - grant: privilege:grant execute on function public.bar_mutate_keeping_v4(bigint,integer,text,jsonb,bigint) to service_role; — L115
- 후속 동일 객체 변경 후보:
  - function:public.bar_mutate_keeping_v4(bigint,integer,text,jsonb,bigint) → 202608080002 drop function, L64 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607180001 — 202607180001_allow_jpeg_bar_keeping_paths.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `55fc62b52e20e9ac63cf60d114b528b8a746606908fa1d993c4e579fb7fccfdd`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.bar_keepings — L2
  - constraint drop: constraint:public.bar_keepings.bar_keepings_image_path_check — L2
  - constraint add: constraint:public.bar_keepings.bar_keepings_image_path_check — L2
  - constraint drop: constraint:public.bar_keepings.bar_keepings_thumbnail_path_check — L2
  - constraint add: constraint:public.bar_keepings.bar_keepings_thumbnail_path_check — L2
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607180002 — 202607180002_delete_active_bar_keeping.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `2d31ec7f86a2c7577a57cae892840d5d563cb053f8e4ee2ec0bedd6dceb65fdc`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.bar_delete_active_keeping_v1(bigint,integer,bigint) — L1
  - revoke: privilege:revoke all on function public.bar_delete_active_keeping_v1(bigint, integer, bigint) from public, anon, authenticated; — L82
  - grant: privilege:grant execute on function public.bar_delete_active_keeping_v1(bigint, integer, bigint) to service_role; — L84
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607180003 — 202607180003_delete_bar_keeping_v2.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Stored-stock status, usage and RPC compatibility; partial application may leave legacy signatures.
- 파일 SHA-256: `4ec89948472ad2aab9935a9aed42493f40e3112cd3925a10602e78644808aa65`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.bar_delete_keeping_v2(bigint,integer,bigint) — L1
  - revoke: privilege:revoke all on function public.bar_delete_keeping_v2(bigint, integer, bigint) from public, anon, authenticated; — L83
  - grant: privilege:grant execute on function public.bar_delete_keeping_v2(bigint, integer, bigint) to service_role; — L85
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607180004 — 202607180004_add_reactivate_action_note.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `cd5fdfb7747395169c0730603bce0e596a6cf133019c648583775be4d7ae6f01`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.bar_mutate_keeping_v5(bigint,integer,text,jsonb,bigint) — L1
  - revoke: privilege:revoke all on function public.bar_mutate_keeping_v5(bigint, integer, text, jsonb, bigint) from public, anon, authenticated; — L95
  - grant: privilege:grant execute on function public.bar_mutate_keeping_v5(bigint, integer, text, jsonb, bigint) to service_role; — L97
- 후속 동일 객체 변경 후보:
  - function:public.bar_mutate_keeping_v5(bigint,integer,text,jsonb,bigint) → 202608080001 create or replace function, L90 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607180005 — 202607180005_fix_reprocess_modified_sales_inventory_deduction.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `b8723ed2673d1dc48c88ad633e446eacf7e9197237e67d76d565caccbdfba658`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.reprocess_modified_sales_inventory_deduction_receipt(bigint,text,timestamptz,text,text) — L5
  - revoke: privilege:revoke all on function public.reprocess_modified_sales_inventory_deduction_receipt( bigint, text, timestamptz, text, text ) from public, anon, authenticated; — L1038
  - grant: privilege:grant execute on function public.reprocess_modified_sales_inventory_deduction_receipt( bigint, text, timestamptz, text, text ) to service_role; — L1042
- 후속 동일 객체 변경 후보:
  - Dynamic patch reference → 202607190002 [L]; 원본 실행 및 patch 성공은 입증되지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607190001 — 202607190001_create_store_settings_foundation.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `e6d8c756179cba2eff69f88bbb9d8d03759fa75af18ae4f9ca73028f7a259a84`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.store_setting_versions — L1
  - column create: column:public.store_setting_versions.id — L1
  - column create: column:public.store_setting_versions.timezone — L1
  - column create: column:public.store_setting_versions.business_day_cutoff_time — L1
  - column create: column:public.store_setting_versions.effective_from_business_date — L1
  - column create: column:public.store_setting_versions.revision — L1
  - column create: column:public.store_setting_versions.state — L1
  - column create: column:public.store_setting_versions.created_by — L1
  - column create: column:public.store_setting_versions.created_at — L1
  - column create: column:public.store_setting_versions.cancelled_by — L1
  - column create: column:public.store_setting_versions.cancelled_at — L1
  - column create: column:public.store_setting_versions.cancel_reason — L1
  - create table: table:public.store_business_hours — L23
  - column create: column:public.store_business_hours.id — L23
  - column create: column:public.store_business_hours.setting_version_id — L23
  - column create: column:public.store_business_hours.weekday — L23
  - column create: column:public.store_business_hours.is_closed — L23
  - column create: column:public.store_business_hours.open_time — L23
  - column create: column:public.store_business_hours.close_time — L23
  - column create: column:public.store_business_hours.created_at — L23
  - create table: table:public.store_setting_audit_logs — L39
  - column create: column:public.store_setting_audit_logs.id — L39
  - column create: column:public.store_setting_audit_logs.setting_version_id — L39
  - column create: column:public.store_setting_audit_logs.action — L39
  - column create: column:public.store_setting_audit_logs.actor_user_id — L39
  - column create: column:public.store_setting_audit_logs.before_snapshot — L39
  - column create: column:public.store_setting_audit_logs.after_snapshot — L39
  - column create: column:public.store_setting_audit_logs.created_at — L39
  - create index: index:public.store_setting_versions_active_effective_idx — L50
  - create unique index: index:public.store_setting_versions_active_effective_unique — L53
  - create index: index:public.store_setting_audit_logs_created_idx — L56
  - alter table: table:public.store_setting_versions — L59
  - alter table: table:public.store_business_hours — L60
  - alter table: table:public.store_setting_audit_logs — L61
  - revoke: privilege:revoke all on table public.store_setting_versions from public, anon, authenticated; — L63
  - revoke: privilege:revoke all on table public.store_business_hours from public, anon, authenticated; — L64
  - revoke: privilege:revoke all on table public.store_setting_audit_logs from public, anon, authenticated; — L65
  - grant: privilege:grant select, insert, update on table public.store_setting_versions to service_role; — L66
  - grant: privilege:grant select, insert on table public.store_business_hours to service_role; — L67
  - grant: privilege:grant select, insert on table public.store_setting_audit_logs to service_role; — L68
  - grant: privilege:grant usage, select on sequence public.store_setting_versions_id_seq to service_role; — L69
  - grant: privilege:grant usage, select on sequence public.store_business_hours_id_seq to service_role; — L70
  - grant: privilege:grant usage, select on sequence public.store_setting_audit_logs_id_seq to service_role; — L71
  - create or replace function: function:public.store_business_date_v1(timestamptz,text,time without time zone) — L73
  - create or replace function: function:public.store_setting_snapshot_v1(bigint) — L99
  - create or replace function: function:public.store_business_date_for_timestamp_v1(timestamptz) — L130
  - create or replace function: function:public.store_get_settings_overview_v1(date) — L155
  - create or replace function: function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint) — L184
  - create or replace function: function:public.store_cancel_scheduled_settings_v1(bigint,bigint,bigint,text) — L248
  - create or replace function: function:public.store_list_setting_audit_logs_v1(integer) — L280
  - revoke: privilege:revoke all on function public.store_business_date_v1(timestamptz,text,time) from public,anon,authenticated; — L285
  - revoke: privilege:revoke all on function public.store_setting_snapshot_v1(bigint) from public,anon,authenticated; — L286
  - revoke: privilege:revoke all on function public.store_business_date_for_timestamp_v1(timestamptz) from public,anon,authenticated; — L287
  - revoke: privilege:revoke all on function public.store_get_settings_overview_v1(date) from public,anon,authenticated; — L288
  - revoke: privilege:revoke all on function public.store_schedule_settings_v1(date,bigint,text,time,jsonb,bigint) from public,anon,authenticated; — L289
  - revoke: privilege:revoke all on function public.store_cancel_scheduled_settings_v1(bigint,bigint,bigint,text) from public,anon,authenticated; — L290
  - revoke: privilege:revoke all on function public.store_list_setting_audit_logs_v1(integer) from public,anon,authenticated; — L291
  - grant: privilege:grant execute on function public.store_business_date_v1(timestamptz,text,time) to service_role; — L292
  - grant: privilege:grant execute on function public.store_setting_snapshot_v1(bigint) to service_role; — L293
  - grant: privilege:grant execute on function public.store_business_date_for_timestamp_v1(timestamptz) to service_role; — L294
  - grant: privilege:grant execute on function public.store_get_settings_overview_v1(date) to service_role; — L295
  - grant: privilege:grant execute on function public.store_schedule_settings_v1(date,bigint,text,time,jsonb,bigint) to service_role; — L296
  - grant: privilege:grant execute on function public.store_cancel_scheduled_settings_v1(bigint,bigint,bigint,text) to service_role; — L297
  - grant: privilege:grant execute on function public.store_list_setting_audit_logs_v1(integer) to service_role; — L298
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - function:public.store_setting_snapshot_v1(bigint) → 202607240001 create or replace function, L98 [L]
  - function:public.store_setting_snapshot_v1(bigint) → 202607250001 create or replace function, L28 [L]
  - function:public.store_setting_snapshot_v1(bigint) → 202608070005 create or replace function, L241 [R]
  - function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint) → 202607240001 drop function, L138 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607190002 — 202607190002_archive_cleanup_legacy_pos_processed_lines.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: POS mapping and inventory deduction correctness: preserve original totals, VAT and business-day boundary.
- 파일 SHA-256: `669be78fb53c934909708f5a049aa6d0d4288e60e8bcef6616a172852496b6b6`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create index: index:public.idx_pos_inventory_deductions_processed_line_id — L61 [conditional/dynamic DO candidate]
  - create table: table:public.legacy_pos_processed_line_archive — L221
  - column create: column:public.legacy_pos_processed_line_archive.legacy_processed_line_id — L221
  - column create: column:public.legacy_pos_processed_line_archive.invoice_ref_id — L221
  - column create: column:public.legacy_pos_processed_line_archive.invoice_ref_no — L221
  - column create: column:public.legacy_pos_processed_line_archive.invoice_date — L221
  - column create: column:public.legacy_pos_processed_line_archive.ref_detail_id — L221
  - column create: column:public.legacy_pos_processed_line_archive.order_detail_id — L221
  - column create: column:public.legacy_pos_processed_line_archive.parent_id — L221
  - column create: column:public.legacy_pos_processed_line_archive.ref_detail_type — L221
  - column create: column:public.legacy_pos_processed_line_archive.pos_item_code — L221
  - column create: column:public.legacy_pos_processed_line_archive.pos_item_name — L221
  - column create: column:public.legacy_pos_processed_line_archive.quantity — L221
  - column create: column:public.legacy_pos_processed_line_archive.unit_name — L221
  - column create: column:public.legacy_pos_processed_line_archive.amount — L221
  - column create: column:public.legacy_pos_processed_line_archive.mapping_id — L221
  - column create: column:public.legacy_pos_processed_line_archive.mapping_type — L221
  - column create: column:public.legacy_pos_processed_line_archive.processed_status — L221
  - column create: column:public.legacy_pos_processed_line_archive.processed_at — L221
  - column create: column:public.legacy_pos_processed_line_archive.legacy_created_at — L221
  - column create: column:public.legacy_pos_processed_line_archive.legacy_updated_at — L221
  - column create: column:public.legacy_pos_processed_line_archive.archived_at — L221
  - column create: column:public.legacy_pos_processed_line_archive.archive_version — L221
  - column create: column:public.legacy_pos_processed_line_archive.archive_reason — L221
  - create table: table:public.legacy_pos_inventory_deduction_archive — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.legacy_deduction_id — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.legacy_processed_line_id — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.inventory_item_id — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.deduct_quantity — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.deduction_status — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.error_message — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.applied_at — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.inventory_log_id — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.legacy_created_at — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.legacy_updated_at — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.archived_at — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.archive_version — L249
  - column create: column:public.legacy_pos_inventory_deduction_archive.archive_reason — L249
  - alter table: table:public.legacy_pos_processed_line_archive — L270
  - alter table: table:public.legacy_pos_inventory_deduction_archive — L271
  - revoke: privilege:revoke all on table public.legacy_pos_processed_line_archive from public, anon, authenticated, service_role; — L273
  - revoke: privilege:revoke all on table public.legacy_pos_inventory_deduction_archive from public, anon, authenticated, service_role; — L275
  - grant: privilege:grant select on table public.legacy_pos_processed_line_archive to service_role; — L277
  - grant: privilege:grant select on table public.legacy_pos_inventory_deduction_archive to service_role; — L278
  - insert into: data:public.legacy_pos_processed_line_archive — L280
  - insert into: data:public.legacy_pos_inventory_deduction_archive — L294
  - revoke: privilege:revoke all on function public.apply_pos_direct_inventory_deductions( date, integer, text, text ) from public, anon, authenticated, service_role; — L362
  - drop function: function:public.apply_pos_direct_inventory_deductions(date,integer,text,text) — L366
  - revoke: privilege:revoke all on function public.reprocess_modified_sales_inventory_deduction_receipt( bigint, text, timestamptz, text, text ) from public, anon, authenticated; — L428
  - grant: privilege:grant execute on function public.reprocess_modified_sales_inventory_deduction_receipt( bigint, text, timestamptz, text, text ) to service_role; — L431
  - revoke: privilege:revoke all on function public.rollback_canceled_sales_inventory_deduction_receipt( bigint, text, timestamptz, text ) from public, anon, authenticated; — L435
  - grant: privilege:grant execute on function public.rollback_canceled_sales_inventory_deduction_receipt( bigint, text, timestamptz, text ) to service_role; — L438
  - delete from: data:public.pos_inventory_deductions — L442
  - alter table: table:public.pos_inventory_deductions — L471
  - constraint drop: constraint:public.pos_inventory_deductions.pos_inventory_deductions_processed_line_id_fkey — L471
  - alter table: table:public.pos_inventory_deductions — L473
  - constraint drop: constraint:public.pos_inventory_deductions.pos_inventory_deductions_unique_item — L473
  - drop index: index:public.idx_pos_inventory_deductions_processed_line_id — L475
  - alter table: table:public.pos_inventory_deductions — L476
  - column drop: column:public.pos_inventory_deductions.processed_line_id — L476
  - drop trigger: trigger:public.trg_pos_processed_invoice_lines_updated_at@public.pos_processed_invoice_lines — L478
  - alter table: table:public.pos_processed_invoice_lines — L480
  - constraint drop: constraint:public.pos_processed_invoice_lines.pos_processed_invoice_lines_mapping_id_fkey — L480
  - alter sequence: sequence:public.pos_processed_invoice_lines_id_seq — L482
  - drop table: table:public.pos_processed_invoice_lines — L483
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
  - 동적 함수 patch/문자열 치환 후보 포함: pg_get_functiondef 원문과 치환 전제·결과 본문 확인 필요.
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607230001 — 202607230001_close_attendance_anon_access.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `5c79b3fb2db68a7fbe63e52ced5c76d488edaa2f9f8dcde97c52a15c8a1c2ed2`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - drop policy: policy:public.if@public.attendance_records — L1
  - drop policy: policy:public.if@public.attendance_records — L4
  - drop policy: policy:public.if@public.attendance_check_logs — L7
  - revoke: privilege:revoke all privileges on table public.attendance_records from anon, authenticated; — L10
  - revoke: privilege:revoke all privileges on table public.attendance_check_logs from anon, authenticated; — L14
  - revoke: privilege:revoke all privileges on sequence public.attendance_records_id_seq from anon, authenticated; — L18
  - revoke: privilege:revoke all privileges on sequence public.attendance_check_logs_id_seq from anon, authenticated; — L22
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607230002 — 202607230002_lock_down_sales_inventory_keg_public_access.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `ec00f81282ef7aa23b57c729cfd836d212abdb81e53cfdf8f7dffd547761fe9f`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.pos_inventory_deduction_receipts — L1
  - revoke: privilege:revoke all privileges on table public.pos_inventory_deduction_receipts from public, anon, authenticated; — L4
  - grant: privilege:grant select, insert, update, delete on table public.pos_inventory_deduction_receipts to service_role; — L8
  - revoke: privilege:revoke execute on function public.apply_sales_inventory_deduction_batch( bigint, text, jsonb ) from public, anon, authenticated; — L12
  - grant: privilege:grant execute on function public.apply_sales_inventory_deduction_batch( bigint, text, jsonb ) to service_role; — L20
  - revoke: privilege:revoke execute on function public.replace_inventory_keg( bigint, text, date, numeric ) from public, anon, authenticated; — L28
  - grant: privilege:grant execute on function public.replace_inventory_keg( bigint, text, date, numeric ) to service_role; — L37
  - revoke: privilege:revoke execute on function public.replace_inventory_keg( bigint, text, date, numeric, timestamp with time zone ) from public, anon, authenticated; — L46
  - grant: privilege:grant execute on function public.replace_inventory_keg( bigint, text, date, numeric, timestamp with time zone ) to service_role; — L56
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607230003 — 202607230003_unify_keg_sales_calculation.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `c9be7f532e2cff918ee56bc8199eed44382a4af59bdedbdc2fef58830abbda7d`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.calculate_inventory_keg_sales(bigint,timestamp with time zone,timestamp with time zone) — L1
  - create or replace function: function:public.replace_inventory_keg(bigint,text,date,numeric,timestamp with time zone) — L103
  - create or replace function: function:public.replace_inventory_keg(bigint,text,date,numeric) — L316
  - revoke: privilege:revoke execute on function public.calculate_inventory_keg_sales( bigint, timestamp with time zone, timestamp with time zone ) from public, anon, authenticated; — L336
  - grant: privilege:grant execute on function public.calculate_inventory_keg_sales( bigint, timestamp with time zone, timestamp with time zone ) to service_role, postgres; — L341
  - revoke: privilege:revoke execute on function public.replace_inventory_keg( bigint, text, date, numeric ) from public, anon, authenticated; — L347
  - grant: privilege:grant execute on function public.replace_inventory_keg( bigint, text, date, numeric ) to service_role, postgres; — L350
  - revoke: privilege:revoke execute on function public.replace_inventory_keg( bigint, text, date, numeric, timestamp with time zone ) from public, anon, authenticated; — L354
  - grant: privilege:grant execute on function public.replace_inventory_keg( bigint, text, date, numeric, timestamp with time zone ) to service_role, postgres; — L357
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607240001 — 202607240001_create_attendance_policy_shadow_foundation.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `3c1e1455a677c74fa1a5afe0c3f0e82875a5ff1a531ff156718882c9638b12ab`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.store_attendance_policies — L1
  - column create: column:public.store_attendance_policies.setting_version_id — L1
  - column create: column:public.store_attendance_policies.late_grace_minutes — L1
  - column create: column:public.store_attendance_policies.default_normal_checkout_time — L1
  - column create: column:public.store_attendance_policies.created_at — L1
  - insert into: data:public.store_attendance_policies — L11
  - create table: table:public.store_business_day_overrides — L20
  - column create: column:public.store_business_day_overrides.id — L20
  - column create: column:public.store_business_day_overrides.business_date — L20
  - column create: column:public.store_business_day_overrides.actual_close_time — L20
  - column create: column:public.store_business_day_overrides.reason — L20
  - column create: column:public.store_business_day_overrides.state — L20
  - column create: column:public.store_business_day_overrides.created_by — L20
  - column create: column:public.store_business_day_overrides.created_at — L20
  - column create: column:public.store_business_day_overrides.updated_by — L20
  - column create: column:public.store_business_day_overrides.updated_at — L20
  - column create: column:public.store_business_day_overrides.cancelled_by — L20
  - column create: column:public.store_business_day_overrides.cancelled_at — L20
  - create unique index: index:public.store_business_day_overrides_active_date_unique — L40
  - create index: index:public.store_business_day_overrides_date_idx — L44
  - create table: table:public.attendance_record_audit_logs — L47
  - column create: column:public.attendance_record_audit_logs.id — L47
  - column create: column:public.attendance_record_audit_logs.attendance_record_id — L47
  - column create: column:public.attendance_record_audit_logs.action — L47
  - column create: column:public.attendance_record_audit_logs.actor_user_id — L47
  - column create: column:public.attendance_record_audit_logs.before_snapshot — L47
  - column create: column:public.attendance_record_audit_logs.after_snapshot — L47
  - column create: column:public.attendance_record_audit_logs.reason — L47
  - column create: column:public.attendance_record_audit_logs.created_at — L47
  - create index: index:public.attendance_record_audit_logs_record_created_idx — L68
  - alter table: table:public.store_attendance_policies — L75
  - alter table: table:public.store_business_day_overrides — L76
  - alter table: table:public.attendance_record_audit_logs — L77
  - revoke: privilege:revoke all on table public.store_attendance_policies from public, anon, authenticated; — L79
  - revoke: privilege:revoke all on table public.store_business_day_overrides from public, anon, authenticated; — L81
  - revoke: privilege:revoke all on table public.attendance_record_audit_logs from public, anon, authenticated; — L83
  - grant: privilege:grant select, insert, update on table public.store_attendance_policies to service_role; — L86
  - grant: privilege:grant select, insert, update on table public.store_business_day_overrides to service_role; — L88
  - grant: privilege:grant select, insert on table public.attendance_record_audit_logs to service_role; — L90
  - grant: privilege:grant usage, select on sequence public.store_business_day_overrides_id_seq to service_role; — L93
  - grant: privilege:grant usage, select on sequence public.attendance_record_audit_logs_id_seq to service_role; — L95
  - create or replace function: function:public.store_setting_snapshot_v1(bigint) — L98
  - drop function: function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint) — L138
  - create function: function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint,integer,time without time zone) — L147
  - revoke: privilege:revoke all on function public.store_schedule_settings_v1( date, bigint, text, time without time zone, jsonb, bigint, integer, time without time zone ) from public, anon, authenticated; — L307
  - grant: privilege:grant execute on function public.store_schedule_settings_v1( date, bigint, text, time without time zone, jsonb, bigint, integer, time without time zone ) to service_role; — L318
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.store_attendance_policies → 202607250001 alter table, L11 [L]
  - table:public.store_attendance_policies → 202608070005 alter table, L288 [R]
  - column:public.store_attendance_policies.default_normal_checkout_time → 202608070005 column drop, L288 [R]
  - table:public.attendance_record_audit_logs → 202607240003 alter table, L10 [L]
  - table:public.attendance_record_audit_logs → 202607240003 alter table, L14 [L]
  - table:public.attendance_record_audit_logs → 20260812162019 alter table, L70 [R]
  - table:public.attendance_record_audit_logs → 20260812162019 alter table, L73 [R]
  - column:public.attendance_record_audit_logs.attendance_record_id → 202607240003 column alter, L14 [L]
  - function:public.store_setting_snapshot_v1(bigint) → 202607250001 create or replace function, L28 [L]
  - function:public.store_setting_snapshot_v1(bigint) → 202608070005 create or replace function, L241 [R]
  - function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint,integer,time without time zone) → 202607250001 drop function, L74 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607240002 — 202607240002_add_attendance_staff_direct_leave_marker.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `31e36c2956fd2b00cdfe6e4f2d38b9a55bee33100b5a9bca7edaf45ef555a7af`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.attendance_records — L1
  - column add: column:public.attendance_records.is_staff_direct_leave — L1
- 후속 동일 객체 변경 후보:
  - table:public.attendance_records → 20260812162019 alter table, L65 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607240003 — 202607240003_fix_attendance_cancellation_audit.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `75857aa16280c86e3ea702594281df2dd8a5350f140f3e7693b403ca1c503e59`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.attendance_record_audit_logs — L10
  - constraint drop: constraint:public.attendance_record_audit_logs.attendance_record_audit_logs_action_check — L10
  - constraint drop: constraint:public.attendance_record_audit_logs.attendance_record_audit_logs_attendance_record_id_fkey — L10
  - alter table: table:public.attendance_record_audit_logs — L14
  - column alter: column:public.attendance_record_audit_logs.attendance_record_id — L14
  - column drop: column:public.attendance_record_audit_logs.not — L14
  - column add: column:public.attendance_record_audit_logs.source_attendance_record_id — L14
  - column add: column:public.attendance_record_audit_logs.target_user_id — L14
  - column add: column:public.attendance_record_audit_logs.work_date — L14
  - constraint add: constraint:public.attendance_record_audit_logs.attendance_record_audit_logs_attendance_record_id_fkey — L14
  - constraint add: constraint:public.attendance_record_audit_logs.attendance_record_audit_logs_action_check — L14
  - create index: index:public.attendance_record_audit_logs_target_date_created_idx — L45
  - create or replace function: function:public.attendance_admin_cancel_record_v1(text,bigint,date,bigint,text) — L53
  - revoke: privilege:revoke all on function public.attendance_admin_cancel_record_v1( text, bigint, date, bigint, text ) from public, anon, authenticated; — L235
  - grant: privilege:grant execute on function public.attendance_admin_cancel_record_v1( text, bigint, date, bigint, text ) to service_role; — L243
- 후속 동일 객체 변경 후보:
  - table:public.attendance_record_audit_logs → 20260812162019 alter table, L70 [R]
  - table:public.attendance_record_audit_logs → 20260812162019 alter table, L73 [R]
  - constraint:public.attendance_record_audit_logs.attendance_record_audit_logs_action_check → 20260812162019 constraint drop, L70 [R]
  - constraint:public.attendance_record_audit_logs.attendance_record_audit_logs_action_check → 20260812162019 constraint add, L73 [R]
  - function:public.attendance_admin_cancel_record_v1(text,bigint,date,bigint,text) → 202607240004 create or replace function, L1 [L]
  - function:public.attendance_admin_cancel_record_v1(text,bigint,date,bigint,text) → 20260813180226 create or replace function, L3 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607240004 — 202607240004_fix_attendance_cancel_checkout_runtime.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `44c4986bdcb608699dd4488412d9aaecfa80010aa50800856a82f10c82b36ab0`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.attendance_admin_cancel_record_v1(text,bigint,date,bigint,text) — L1
- 후속 동일 객체 변경 후보:
  - function:public.attendance_admin_cancel_record_v1(text,bigint,date,bigint,text) → 20260813180226 create or replace function, L3 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607240005 — 202607240005_add_attendance_manual_override_marker.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `f4165900d019a13fbbb032087f77e60d6c4654c8fe81f06e621e0302c0177c54`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.attendance_record_manual_overrides — L1
  - column create: column:public.attendance_record_manual_overrides.id — L1
  - column create: column:public.attendance_record_manual_overrides.attendance_record_id — L1
  - column create: column:public.attendance_record_manual_overrides.override_metric — L1
  - column create: column:public.attendance_record_manual_overrides.override_action — L1
  - column create: column:public.attendance_record_manual_overrides.actor_user_id — L1
  - column create: column:public.attendance_record_manual_overrides.reason — L1
  - column create: column:public.attendance_record_manual_overrides.created_at — L1
  - column create: column:public.attendance_record_manual_overrides.revoked_at — L1
  - column create: column:public.attendance_record_manual_overrides.revoked_by — L1
  - column create: column:public.attendance_record_manual_overrides.revoke_reason — L1
  - create unique index: index:public.attendance_record_manual_overrides_active_metric_unique — L19
  - create index: index:public.attendance_record_manual_overrides_record_created_idx — L26
  - alter table: table:public.attendance_record_manual_overrides — L32
  - revoke: privilege:revoke all on table public.attendance_record_manual_overrides from public, anon, authenticated, service_role; — L34
  - revoke: privilege:revoke all on sequence public.attendance_record_manual_overrides_id_seq from public, anon, authenticated, service_role; — L36
  - grant: privilege:grant select, insert, update on table public.attendance_record_manual_overrides to service_role; — L38
  - grant: privilege:grant usage, select on sequence public.attendance_record_manual_overrides_id_seq to service_role; — L40
  - create or replace function: function:public.attendance_admin_normalize_late_v1(bigint,bigint,text) — L50
  - revoke: privilege:revoke execute on function public.attendance_admin_normalize_late_v1( bigint, bigint, text ) from public, anon, authenticated; — L148
  - grant: privilege:grant execute on function public.attendance_admin_normalize_late_v1( bigint, bigint, text ) to service_role; — L153
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.attendance_record_manual_overrides → 20261001061230 alter table, L3 [L]
  - table:public.attendance_record_manual_overrides → 20261001061230 alter table, L7 [L]
  - table:public.attendance_record_manual_overrides → 20261001061230 alter table, L9 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607250001 — 202607250001_add_attendance_departure_grace_settings.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `3e71602a49258261d3e23b30554d047107fe7c9d1ebab1a8908efb85e2f55388`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.store_attendance_policies — L11
  - column add: column:public.store_attendance_policies.early_leave_grace_minutes — L11
  - column add: column:public.store_attendance_policies.missing_checkout_grace_minutes — L11
  - constraint add: constraint:public.store_attendance_policies.store_attendance_policies_early_leave_grace_check — L11
  - constraint add: constraint:public.store_attendance_policies.store_attendance_policies_missing_checkout_grace_check — L11
  - create or replace function: function:public.store_setting_snapshot_v1(bigint) — L28
  - drop function: function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint,integer,time without time zone) — L74
  - create function: function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint,integer,time without time zone,integer,integer) — L85
  - revoke: privilege:revoke all on function public.store_schedule_settings_v1( date, bigint, text, time without time zone, jsonb, bigint, integer, time without time zone, integer, integer ) from public; — L257
  - revoke: privilege:revoke all on function public.store_schedule_settings_v1( date, bigint, text, time without time zone, jsonb, bigint, integer, time without time zone, integer, integer ) from anon; — L270
  - revoke: privilege:revoke all on function public.store_schedule_settings_v1( date, bigint, text, time without time zone, jsonb, bigint, integer, time without time zone, integer, integer ) from authenticated; — L283
  - grant: privilege:grant execute on function public.store_schedule_settings_v1( date, bigint, text, time without time zone, jsonb, bigint, integer, time without time zone, integer, integer ) to service_role; — L296
- 후속 동일 객체 변경 후보:
  - table:public.store_attendance_policies → 202608070005 alter table, L288 [R]
  - function:public.store_setting_snapshot_v1(bigint) → 202608070005 create or replace function, L241 [R]
  - function:public.store_schedule_settings_v1(date,bigint,text,time without time zone,jsonb,bigint,integer,time without time zone,integer,integer) → 202608070005 drop function, L40 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607270001 — 202607270001_create_payroll_shadow_foundation.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `7cd994346e0bad838687f9926addd760cc0e7345514820a3236bf67430f6f83f`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create schema: schema:extensions — L1
  - create table: table:public.employee_work_schedule_versions — L4
  - column create: column:public.employee_work_schedule_versions.id — L4
  - column create: column:public.employee_work_schedule_versions.user_id — L4
  - column create: column:public.employee_work_schedule_versions.start_time — L4
  - column create: column:public.employee_work_schedule_versions.end_time — L4
  - column create: column:public.employee_work_schedule_versions.unpaid_break_minutes — L4
  - column create: column:public.employee_work_schedule_versions.effective_from — L4
  - column create: column:public.employee_work_schedule_versions.effective_to — L4
  - column create: column:public.employee_work_schedule_versions.revision — L4
  - column create: column:public.employee_work_schedule_versions.created_by — L4
  - column create: column:public.employee_work_schedule_versions.created_at — L4
  - column create: column:public.employee_work_schedule_versions.change_reason — L4
  - create table: table:public.payroll_contract_versions — L24
  - column create: column:public.payroll_contract_versions.id — L24
  - column create: column:public.payroll_contract_versions.user_id — L24
  - column create: column:public.payroll_contract_versions.pay_type — L24
  - column create: column:public.payroll_contract_versions.calculation_basis — L24
  - column create: column:public.payroll_contract_versions.base_salary — L24
  - column create: column:public.payroll_contract_versions.standard_workdays — L24
  - column create: column:public.payroll_contract_versions.standard_minutes_per_day — L24
  - column create: column:public.payroll_contract_versions.time_block_minutes — L24
  - column create: column:public.payroll_contract_versions.rounding_mode — L24
  - column create: column:public.payroll_contract_versions.late_adjustment_mode — L24
  - column create: column:public.payroll_contract_versions.early_leave_adjustment_mode — L24
  - column create: column:public.payroll_contract_versions.overtime_mode — L24
  - column create: column:public.payroll_contract_versions.paid_leave_mode — L24
  - column create: column:public.payroll_contract_versions.effective_from — L24
  - column create: column:public.payroll_contract_versions.effective_to — L24
  - column create: column:public.payroll_contract_versions.revision — L24
  - column create: column:public.payroll_contract_versions.created_by — L24
  - column create: column:public.payroll_contract_versions.created_at — L24
  - column create: column:public.payroll_contract_versions.note — L24
  - create table: table:public.payroll_contract_audit_logs — L53
  - column create: column:public.payroll_contract_audit_logs.id — L53
  - column create: column:public.payroll_contract_audit_logs.contract_version_id — L53
  - column create: column:public.payroll_contract_audit_logs.user_id — L53
  - column create: column:public.payroll_contract_audit_logs.action — L53
  - column create: column:public.payroll_contract_audit_logs.actor_user_id — L53
  - column create: column:public.payroll_contract_audit_logs.snapshot — L53
  - column create: column:public.payroll_contract_audit_logs.reason — L53
  - column create: column:public.payroll_contract_audit_logs.created_at — L53
  - create index: index:public.employee_schedule_user_dates_idx — L64
  - create index: index:public.payroll_contract_user_dates_idx — L65
  - create index: index:public.payroll_contract_audit_user_created_idx — L66
  - alter table: table:public.employee_work_schedule_versions — L68
  - alter table: table:public.payroll_contract_versions — L69
  - alter table: table:public.payroll_contract_audit_logs — L70
  - revoke: privilege:revoke all on table public.employee_work_schedule_versions from public, anon, authenticated, service_role; — L72
  - revoke: privilege:revoke all on table public.payroll_contract_versions from public, anon, authenticated, service_role; — L73
  - revoke: privilege:revoke all on table public.payroll_contract_audit_logs from public, anon, authenticated, service_role; — L74
  - revoke: privilege:revoke all on sequence public.employee_work_schedule_versions_id_seq from public, anon, authenticated, service_role; — L75
  - revoke: privilege:revoke all on sequence public.payroll_contract_versions_id_seq from public, anon, authenticated, service_role; — L76
  - revoke: privilege:revoke all on sequence public.payroll_contract_audit_logs_id_seq from public, anon, authenticated, service_role; — L77
  - grant: privilege:grant select on table public.employee_work_schedule_versions to service_role; — L79
  - grant: privilege:grant select on table public.payroll_contract_versions to service_role; — L80
  - grant: privilege:grant select on table public.payroll_contract_audit_logs to service_role; — L81
  - insert into: data:public.employee_work_schedule_versions — L83
  - create or replace function: function:public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text) — L92
  - revoke: privilege:revoke all on function public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text) from public, anon, authenticated; — L148
  - grant: privilege:grant execute on function public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text) to service_role; — L149
  - create or replace function: function:public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) — L151
  - revoke: privilege:revoke all on function public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) from public, anon, authenticated; — L221
  - grant: privilege:grant execute on function public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) to service_role; — L222
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.employee_work_schedule_versions → 202608010002 alter table, L3 [R]
  - table:public.employee_work_schedule_versions → 202608010002 alter table, L5 [R]
  - table:public.payroll_contract_versions → 20260728182601 alter table, L34 [R]
  - table:public.payroll_contract_versions → 20260728182601 alter table, L37 [R]
  - table:public.payroll_contract_versions → 202607300001 alter table, L1 [L]
  - table:public.payroll_contract_versions → 202608010003 alter table, L1 [R]
  - table:public.payroll_contract_versions → 202608010003 alter table, L4 [R]
  - table:public.payroll_contract_versions → 20260804152308 alter table, L47 [R]
  - table:public.payroll_contract_versions → 20260804152308 alter table, L50 [R]
  - table:public.payroll_contract_audit_logs → 202608020001 alter table, L139 [L] [conditional]
  - table:public.payroll_contract_audit_logs → 202608020001 alter table, L141 [L] [conditional]
  - function:public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text) → 202607280001 create or replace function, L131 [L]
  - function:public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) → 202607280001 create or replace function, L157 [L]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607270002 — 202607270002_create_payroll_runs.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `9b7595dadc9a71d0ebab45007352e29b73eec95ae240a1f4e1696136d2b2ddb4`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.payroll_runs — L1
  - column create: column:public.payroll_runs.id — L1
  - column create: column:public.payroll_runs.payroll_month — L1
  - column create: column:public.payroll_runs.revision — L1
  - column create: column:public.payroll_runs.status — L1
  - column create: column:public.payroll_runs.calculated_at — L1
  - column create: column:public.payroll_runs.engine_version — L1
  - column create: column:public.payroll_runs.source_snapshot — L1
  - column create: column:public.payroll_runs.employee_count — L1
  - column create: column:public.payroll_runs.requires_review_count — L1
  - column create: column:public.payroll_runs.total_base_amount — L1
  - column create: column:public.payroll_runs.total_addition_amount — L1
  - column create: column:public.payroll_runs.total_deduction_amount — L1
  - column create: column:public.payroll_runs.total_net_amount — L1
  - column create: column:public.payroll_runs.created_by — L1
  - column create: column:public.payroll_runs.created_at — L1
  - column create: column:public.payroll_runs.updated_at — L1
  - column create: column:public.payroll_runs.finalized_by — L1
  - column create: column:public.payroll_runs.finalized_at — L1
  - column create: column:public.payroll_runs.finalize_reason — L1
  - column create: column:public.payroll_runs.paid_by — L1
  - column create: column:public.payroll_runs.paid_at — L1
  - column create: column:public.payroll_runs.payment_date — L1
  - column create: column:public.payroll_runs.payment_method — L1
  - column create: column:public.payroll_runs.payment_note — L1
  - column create: column:public.payroll_runs.cancelled_by — L1
  - column create: column:public.payroll_runs.cancelled_at — L1
  - column create: column:public.payroll_runs.cancel_reason — L1
  - create unique index: index:public.payroll_runs_one_active_per_month — L21
  - create table: table:public.payroll_run_employees — L23
  - column create: column:public.payroll_run_employees.id — L23
  - column create: column:public.payroll_run_employees.payroll_run_id — L23
  - column create: column:public.payroll_run_employees.user_id — L23
  - column create: column:public.payroll_run_employees.employee_name — L23
  - column create: column:public.payroll_run_employees.calculation_status — L23
  - column create: column:public.payroll_run_employees.contract_snapshot — L23
  - column create: column:public.payroll_run_employees.attendance_snapshot — L23
  - column create: column:public.payroll_run_employees.recognized_workdays — L23
  - column create: column:public.payroll_run_employees.recognized_minutes — L23
  - column create: column:public.payroll_run_employees.late_minutes — L23
  - column create: column:public.payroll_run_employees.early_leave_minutes — L23
  - column create: column:public.payroll_run_employees.overtime_candidate_minutes — L23
  - column create: column:public.payroll_run_employees.base_amount — L23
  - column create: column:public.payroll_run_employees.addition_amount — L23
  - column create: column:public.payroll_run_employees.deduction_amount — L23
  - column create: column:public.payroll_run_employees.net_amount — L23
  - column create: column:public.payroll_run_employees.admin_note — L23
  - column create: column:public.payroll_run_employees.created_at — L23
  - column create: column:public.payroll_run_employees.updated_at — L23
  - create table: table:public.payroll_run_reviews — L45
  - column create: column:public.payroll_run_reviews.id — L45
  - column create: column:public.payroll_run_reviews.payroll_run_employee_id — L45
  - column create: column:public.payroll_run_reviews.warning_code — L45
  - column create: column:public.payroll_run_reviews.review_level — L45
  - column create: column:public.payroll_run_reviews.business_date — L45
  - column create: column:public.payroll_run_reviews.source_snapshot — L45
  - column create: column:public.payroll_run_reviews.status — L45
  - column create: column:public.payroll_run_reviews.resolution_action — L45
  - column create: column:public.payroll_run_reviews.resolution_snapshot — L45
  - column create: column:public.payroll_run_reviews.amount_delta — L45
  - column create: column:public.payroll_run_reviews.reason — L45
  - column create: column:public.payroll_run_reviews.resolved_by — L45
  - column create: column:public.payroll_run_reviews.resolved_at — L45
  - column create: column:public.payroll_run_reviews.created_at — L45
  - create table: table:public.payroll_run_items — L63
  - column create: column:public.payroll_run_items.id — L63
  - column create: column:public.payroll_run_items.payroll_run_employee_id — L63
  - column create: column:public.payroll_run_items.payroll_run_review_id — L63
  - column create: column:public.payroll_run_items.item_type — L63
  - column create: column:public.payroll_run_items.category — L63
  - column create: column:public.payroll_run_items.direction — L63
  - column create: column:public.payroll_run_items.amount — L63
  - column create: column:public.payroll_run_items.original_amount — L63
  - column create: column:public.payroll_run_items.business_date — L63
  - column create: column:public.payroll_run_items.source_snapshot — L63
  - column create: column:public.payroll_run_items.description — L63
  - column create: column:public.payroll_run_items.reason — L63
  - column create: column:public.payroll_run_items.created_by — L63
  - column create: column:public.payroll_run_items.created_at — L63
  - column create: column:public.payroll_run_items.updated_at — L63
  - create unique index: index:public.payroll_run_item_review_unique — L79
  - create table: table:public.payroll_run_audit_logs — L81
  - column create: column:public.payroll_run_audit_logs.id — L81
  - column create: column:public.payroll_run_audit_logs.payroll_run_id — L81
  - column create: column:public.payroll_run_audit_logs.payroll_run_employee_id — L81
  - column create: column:public.payroll_run_audit_logs.action — L81
  - column create: column:public.payroll_run_audit_logs.actor_user_id — L81
  - column create: column:public.payroll_run_audit_logs.reason — L81
  - column create: column:public.payroll_run_audit_logs.before_snapshot — L81
  - column create: column:public.payroll_run_audit_logs.after_snapshot — L81
  - column create: column:public.payroll_run_audit_logs.created_at — L81
  - create index: index:public.payroll_run_employees_run_idx — L91
  - create index: index:public.payroll_run_reviews_employee_status_idx — L92
  - create index: index:public.payroll_run_items_employee_idx — L93
  - create index: index:public.payroll_run_audit_run_created_idx — L94
  - alter table: table:public.payroll_runs — L96
  - alter table: table:public.payroll_run_employees — L97
  - alter table: table:public.payroll_run_reviews — L98
  - alter table: table:public.payroll_run_items — L99
  - alter table: table:public.payroll_run_audit_logs — L100
  - revoke: privilege:revoke all on table public.payroll_runs,public.payroll_run_employees,public.payroll_run_reviews,public.payroll_run_items,public.payroll_run_audit_logs from public,anon,authenticated,service_role; — L101
  - revoke: privilege:revoke all on sequence public.payroll_runs_id_seq,public.payroll_run_employees_id_seq,public.payroll_run_reviews_id_seq,public.payroll_run_items_id_seq,public.payroll_run_audit_logs_id_seq from public,anon,authenticated,service_role; — L102
  - grant: privilege:grant select on table public.payroll_runs,public.payroll_run_employees,public.payroll_run_reviews,public.payroll_run_items,public.payroll_run_audit_logs to service_role; — L103
  - create function: function:public.payroll_assert_actor_v2(bigint) — L105
  - create function: function:public.payroll_refresh_totals_v2(bigint) — L111
  - create function: function:public.payroll_insert_payload_v2(bigint,jsonb,bigint,bigint) — L132
  - create function: function:public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) — L157
  - create function: function:public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) — L171
  - create function: function:public.payroll_mutate_item_v2(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint) — L187
  - create function: function:public.payroll_resolve_review_v2(bigint,bigint,bigint,text,integer,text,bigint) — L202
  - create function: function:public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) — L229
  - revoke: privilege:revoke all on function public.payroll_assert_actor_v2(bigint),public.payroll_refresh_totals_v2(bigint),public.payroll_insert_payload_v2(bigint,jsonb,bigint,bigint),public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint),public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint),public. — L242
  - grant: privilege:grant execute on function public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) to service_role; — L243
  - grant: privilege:grant execute on function public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) to service_role; — L244
  - grant: privilege:grant execute on function public.payroll_mutate_item_v2(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint) to service_role; — L245
  - grant: privilege:grant execute on function public.payroll_resolve_review_v2(bigint,bigint,bigint,text,integer,text,bigint) to service_role; — L246
  - grant: privilege:grant execute on function public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) to service_role; — L247
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.payroll_runs → 202607280001 alter table, L46 [L]
  - table:public.payroll_runs → 202607280001 alter table, L50 [L]
  - table:public.payroll_runs → 202607280001 alter table, L51 [L]
  - table:public.payroll_runs → 202607300001 alter table, L6 [L]
  - table:public.payroll_runs → 202607310001 alter table, L86 [L]
  - table:public.payroll_runs → 202608010001 alter table, L31 [L]
  - table:public.payroll_runs → 202608070004 drop table, L87 [R]
  - table:public.payroll_run_employees → 202607310001 alter table, L80 [L]
  - table:public.payroll_run_employees → 202608070004 drop table, L84 [R]
  - table:public.payroll_run_reviews → 202608070004 drop table, L81 [R]
  - table:public.payroll_run_items → 202607310001 alter table, L68 [L]
  - table:public.payroll_run_items → 202607310001 alter table, L69 [L]
  - table:public.payroll_run_items → 202607310001 alter table, L70 [L]
  - table:public.payroll_run_items → 202607310001 alter table, L71 [L]
  - table:public.payroll_run_items → 202607310001 alter table, L75 [L]
  - table:public.payroll_run_items → 202608010001 alter table, L34 [L]
  - table:public.payroll_run_items → 202608010001 alter table, L35 [L]
  - table:public.payroll_run_items → 202608010001 alter table, L38 [L]
  - table:public.payroll_run_items → 202608010001 alter table, L39 [L]
  - table:public.payroll_run_items → 202608070004 drop table, L78 [R]
  - table:public.payroll_run_audit_logs → 202608070004 drop table, L75 [R]
  - function:public.payroll_refresh_totals_v2(bigint) → 202608070004 drop function, L50 [R]
  - function:public.payroll_insert_payload_v2(bigint,jsonb,bigint,bigint) → 202608070004 drop function, L46 [R]
  - function:public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) → 202607280001 create or replace function, L54 [L]
  - function:public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L38 [R]
  - function:public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) → 202607280001 create or replace function, L96 [L]
  - function:public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L42 [R]
  - function:public.payroll_mutate_item_v2(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint) → 202608070004 drop function, L54 [R]
  - function:public.payroll_resolve_review_v2(bigint,bigint,bigint,text,integer,text,bigint) → 202608070004 drop function, L58 [R]
  - function:public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) → 202607300001 create or replace function, L98 [L]
  - function:public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) → 202608070004 drop function, L62 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607280001 — 202607280001_add_employee_lifecycle_and_payroll_schedule.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `4e5b24077fd92cdd9cdbf4656911a42d24fb62a11d0ff356958bca8715a6291b`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.users — L3
  - column add: column:public.users.is_system_account — L3
  - column add: column:public.users.termination_date — L3
  - alter table: table:public.users — L7
  - constraint drop: constraint:public.users.users_employment_dates_check — L7
  - alter table: table:public.users — L8
  - constraint add: constraint:public.users.users_employment_dates_check — L8
  - create index: index:public.users_non_system_account_idx — L11
  - update: data:public.users — L14 [conditional/dynamic DO candidate]
  - create table: table:public.payroll_settings — L30
  - column create: column:public.payroll_settings.id — L30
  - column create: column:public.payroll_settings.payment_day — L30
  - column create: column:public.payroll_settings.payment_month_offset — L30
  - column create: column:public.payroll_settings.updated_at — L30
  - column create: column:public.payroll_settings.updated_by — L30
  - insert into: data:public.payroll_settings — L38
  - alter table: table:public.payroll_settings — L42
  - revoke: privilege:revoke all on table public.payroll_settings from public, anon, authenticated, service_role; — L43
  - grant: privilege:grant select, insert, update on table public.payroll_settings to service_role; — L44
  - alter table: table:public.payroll_runs — L46
  - column add: column:public.payroll_runs.payment_due_date — L46
  - column add: column:public.payroll_runs.payment_schedule_snapshot — L46
  - alter table: table:public.payroll_runs — L50
  - constraint drop: constraint:public.payroll_runs.payroll_runs_payroll_month_check — L50
  - alter table: table:public.payroll_runs — L51
  - constraint add: constraint:public.payroll_runs.payroll_runs_payroll_month_check — L51
  - create or replace function: function:public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) — L54
  - revoke: privilege:revoke all on function public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) from public,anon,authenticated; — L91
  - grant: privilege:grant execute on function public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) to service_role; — L93
  - create or replace function: function:public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) — L96
  - revoke: privilege:revoke all on function public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) from public,anon,authenticated; — L126
  - grant: privilege:grant execute on function public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) to service_role; — L128
  - create or replace function: function:public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text) — L131
  - create or replace function: function:public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) — L157
  - revoke: privilege:revoke all on function public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text), public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) from public,anon,authenticated; — L188
  - grant: privilege:grant execute on function public.employee_create_work_schedule_version_v1(bigint,time without time zone,time without time zone,integer,date,bigint,text), public.payroll_create_contract_version_v1(bigint,text,text,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) to service_role; — L189
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.users → 202607280002 alter table, L3 [L]
  - table:public.users → 20260728182601 alter table, L3 [R]
  - table:public.users → 20260728182601 alter table, L7 [R]
  - table:public.users → 202608060001 alter table, L16 [R]
  - table:public.users → 202608060001 alter table, L49 [R]
  - table:public.users → 202608060001 alter table, L51 [R]
  - table:public.payroll_settings → 202607310001 alter table, L3 [L]
  - table:public.payroll_settings → 202607310001 alter table, L10 [L]
  - table:public.payroll_settings → 202608010001 alter table, L21 [L]
  - table:public.payroll_settings → 20260911102823 alter table, L1 [R]
  - table:public.payroll_settings → 20260911102823 alter table, L16 [R] [conditional]
  - table:public.payroll_settings → 20260911102823 alter table, L27 [R] [conditional]
  - table:public.payroll_settings → 20260911102823 alter table, L40 [R] [conditional]
  - table:public.payroll_runs → 202607300001 alter table, L6 [L]
  - table:public.payroll_runs → 202607310001 alter table, L86 [L]
  - table:public.payroll_runs → 202608010001 alter table, L31 [L]
  - table:public.payroll_runs → 202608070004 drop table, L87 [R]
  - function:public.payroll_create_run_v2(date,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L38 [R]
  - function:public.payroll_recalculate_run_v2(bigint,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L42 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202607280002 — 202607280002_add_payroll_eligibility_override.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `269377a41ee11e3d20c62b979d58e8dab471c54a822dfffc3e6a9ef26e095b3b`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.users — L3
  - column add: column:public.users.payroll_eligible_override — L3
- 후속 동일 객체 변경 후보:
  - table:public.users → 20260728182601 alter table, L3 [R]
  - table:public.users → 20260728182601 alter table, L7 [R]
  - table:public.users → 202608060001 alter table, L16 [R]
  - table:public.users → 202608060001 alter table, L49 [R]
  - table:public.users → 202608060001 alter table, L51 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607300001 — 202607300001_add_payroll_compensation_and_adjustment_ledger.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `12b0e509b9106c6eb41f04e6ac4cb2f4b6e5610492a225c74d35d9f0286a9dfb`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.payroll_contract_versions — L1
  - column add: column:public.payroll_contract_versions.fixed_raise_amount — L1
  - constraint add: constraint:public.payroll_contract_versions.payroll_contract_fixed_raise_nonnegative — L1
  - constraint add: constraint:public.payroll_contract_versions.payroll_contract_monthly_fixed_raise_only — L1
  - alter table: table:public.payroll_runs — L6
  - column add: column:public.payroll_runs.force_finalized — L6
  - column add: column:public.payroll_runs.finalized_actor_role — L6
  - column add: column:public.payroll_runs.force_finalize_reason — L6
  - column add: column:public.payroll_runs.force_finalize_snapshot — L6
  - constraint add: constraint:public.payroll_runs.payroll_run_finalized_actor_role — L6
  - constraint add: constraint:public.payroll_runs.payroll_run_force_finalize_audit — L6
  - create table: table:public.payroll_monthly_adjustments — L24
  - column create: column:public.payroll_monthly_adjustments.id — L24
  - column create: column:public.payroll_monthly_adjustments.user_id — L24
  - column create: column:public.payroll_monthly_adjustments.payroll_month — L24
  - column create: column:public.payroll_monthly_adjustments.kind — L24
  - column create: column:public.payroll_monthly_adjustments.category — L24
  - column create: column:public.payroll_monthly_adjustments.amount — L24
  - column create: column:public.payroll_monthly_adjustments.business_date — L24
  - column create: column:public.payroll_monthly_adjustments.reason — L24
  - column create: column:public.payroll_monthly_adjustments.note — L24
  - column create: column:public.payroll_monthly_adjustments.source_type — L24
  - column create: column:public.payroll_monthly_adjustments.source_key — L24
  - column create: column:public.payroll_monthly_adjustments.created_by — L24
  - column create: column:public.payroll_monthly_adjustments.created_at — L24
  - column create: column:public.payroll_monthly_adjustments.cancelled_at — L24
  - column create: column:public.payroll_monthly_adjustments.cancelled_by — L24
  - column create: column:public.payroll_monthly_adjustments.cancellation_reason — L24
  - create index: index:public.payroll_monthly_adjustments_month_user_idx — L48
  - create unique index: index:public.payroll_monthly_adjustments_source_unique — L50
  - alter table: table:public.payroll_monthly_adjustments — L54
  - revoke: privilege:revoke all on table public.payroll_monthly_adjustments from public, anon, authenticated, service_role; — L55
  - revoke: privilege:revoke all on sequence public.payroll_monthly_adjustments_id_seq from public, anon, authenticated, service_role; — L56
  - grant: privilege:grant select, insert, update on table public.payroll_monthly_adjustments to service_role; — L57
  - grant: privilege:grant usage, select on sequence public.payroll_monthly_adjustments_id_seq to service_role; — L58
  - create or replace function: function:public.payroll_create_contract_version_v2(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) — L60
  - revoke: privilege:revoke all on function public.payroll_create_contract_version_v2(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) from public,anon,authenticated; — L95
  - grant: privilege:grant execute on function public.payroll_create_contract_version_v2(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) to service_role; — L96
  - create or replace function: function:public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) — L98
  - revoke: privilege:revoke all on function public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) from public,anon,authenticated; — L178
  - grant: privilege:grant execute on function public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) to service_role; — L179
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.payroll_contract_versions → 202608010003 alter table, L1 [R]
  - table:public.payroll_contract_versions → 202608010003 alter table, L4 [R]
  - table:public.payroll_contract_versions → 20260804152308 alter table, L47 [R]
  - table:public.payroll_contract_versions → 20260804152308 alter table, L50 [R]
  - table:public.payroll_runs → 202607310001 alter table, L86 [L]
  - table:public.payroll_runs → 202608010001 alter table, L31 [L]
  - table:public.payroll_runs → 202608070004 drop table, L87 [R]
  - table:public.payroll_monthly_adjustments → 20260908110641 alter table, L3 [R]
  - table:public.payroll_monthly_adjustments → 20260928122112 alter table, L1 [R]
  - table:public.payroll_monthly_adjustments → 20260928122112 alter table, L4 [R]
  - function:public.payroll_transition_run_v2(bigint,text,text,date,text,text,bigint) → 202608070004 drop function, L62 [R]
  - Dynamic patch reference → 202608070003 [L]; 원본 실행 및 patch 성공은 입증되지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202607310001 — 202607310001_add_payroll_insurance_v5.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `5915ad1dc626b09f615be0b9e3ca0f9c3530e8f44657a307469173743952a05f`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.payroll_settings — L3
  - column add: column:public.payroll_settings.employee_insurance_rate_bp — L3
  - column add: column:public.payroll_settings.employer_insurance_rate_bp — L3
  - column add: column:public.payroll_settings.director_insurance_enabled — L3
  - column add: column:public.payroll_settings.director_insurance_base_amount — L3
  - column add: column:public.payroll_settings.director_insurance_rate_bp — L3
  - alter table: table:public.payroll_settings — L10
  - constraint add: constraint:public.payroll_settings.payroll_settings_employee_insurance_rate_check — L10
  - constraint add: constraint:public.payroll_settings.payroll_settings_employer_insurance_rate_check — L10
  - constraint add: constraint:public.payroll_settings.payroll_settings_director_insurance_base_check — L10
  - constraint add: constraint:public.payroll_settings.payroll_settings_director_insurance_rate_check — L10
  - create table: table:public.payroll_insurance_setting_versions — L16
  - column create: column:public.payroll_insurance_setting_versions.id — L16
  - column create: column:public.payroll_insurance_setting_versions.user_id — L16
  - column create: column:public.payroll_insurance_setting_versions.is_enrolled — L16
  - column create: column:public.payroll_insurance_setting_versions.insurance_base_amount — L16
  - column create: column:public.payroll_insurance_setting_versions.effective_month — L16
  - column create: column:public.payroll_insurance_setting_versions.revision — L16
  - column create: column:public.payroll_insurance_setting_versions.created_by — L16
  - column create: column:public.payroll_insurance_setting_versions.created_at — L16
  - column create: column:public.payroll_insurance_setting_versions.note — L16
  - create index: index:public.payroll_insurance_setting_lookup_idx — L35
  - create index: index:public.payroll_insurance_setting_created_by_idx — L37
  - alter table: table:public.payroll_insurance_setting_versions — L40
  - revoke: privilege:revoke all on table public.payroll_insurance_setting_versions from public,anon,authenticated,service_role; — L41
  - revoke: privilege:revoke all on sequence public.payroll_insurance_setting_versions_id_seq from public,anon,authenticated,service_role; — L42
  - grant: privilege:grant select,insert on table public.payroll_insurance_setting_versions to service_role; — L43
  - grant: privilege:grant usage,select on sequence public.payroll_insurance_setting_versions_id_seq to service_role; — L44
  - insert into: data:public.payroll_insurance_setting_versions — L46 [conditional/dynamic DO candidate]
  - alter table: table:public.payroll_run_items — L68
  - constraint drop: constraint:public.payroll_run_items.payroll_run_items_category_check — L68
  - alter table: table:public.payroll_run_items — L69
  - constraint add: constraint:public.payroll_run_items.payroll_run_items_category_check — L69
  - alter table: table:public.payroll_run_items — L70
  - constraint drop: constraint:public.payroll_run_items.payroll_run_item_category_direction_check — L70
  - alter table: table:public.payroll_run_items — L71
  - constraint add: constraint:public.payroll_run_items.payroll_run_item_category_direction_check — L71
  - alter table: table:public.payroll_run_items — L75
  - constraint add: constraint:public.payroll_run_items.payroll_run_item_employee_insurance_shape_check — L75
  - create unique index: index:public.payroll_run_item_employee_insurance_unique — L78
  - alter table: table:public.payroll_run_employees — L80
  - column add: column:public.payroll_run_employees.insurance_snapshot — L80
  - column add: column:public.payroll_run_employees.pre_insurance_payout_amount — L80
  - column add: column:public.payroll_run_employees.employee_insurance_deduction_amount — L80
  - column add: column:public.payroll_run_employees.employer_insurance_amount — L80
  - alter table: table:public.payroll_runs — L86
  - column add: column:public.payroll_runs.insurance_settings_snapshot — L86
  - column add: column:public.payroll_runs.total_pre_insurance_payout_amount — L86
  - column add: column:public.payroll_runs.total_employee_insurance_deduction_amount — L86
  - column add: column:public.payroll_runs.total_employer_insurance_amount — L86
  - column add: column:public.payroll_runs.director_insurance_amount — L86
  - column add: column:public.payroll_runs.total_insurance_remittance_amount — L86
  - column add: column:public.payroll_runs.total_company_cost_amount — L86
  - create function: function:public.payroll_create_insurance_setting_version_v1(bigint,boolean,bigint,date,bigint,text) — L95
  - create function: function:public.payroll_refresh_totals_v3(bigint) — L112
  - create function: function:public.payroll_insert_payload_v3(bigint,jsonb,bigint,bigint) — L142
  - create function: function:public.payroll_create_run_v3(date,timestamptz,text,jsonb,jsonb,bigint) — L165
  - create function: function:public.payroll_recalculate_run_v3(bigint,timestamptz,text,jsonb,jsonb,bigint) — L184
  - create function: function:public.payroll_mutate_item_v3(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint) — L198
  - create function: function:public.payroll_resolve_review_v3(bigint,bigint,bigint,text,integer,text,bigint) — L204
  - create function: function:public.payroll_transition_run_v3(bigint,text,text,date,text,text,bigint) — L209
  - revoke: privilege:revoke all on function public.payroll_create_insurance_setting_version_v1(bigint,boolean,bigint,date,bigint,text),public.payroll_refresh_totals_v3(bigint),public.payroll_insert_payload_v3(bigint,jsonb,bigint,bigint),public.payroll_create_run_v3(date,timestamptz,text,jsonb,jsonb,bigint),public.payroll_recalculate_run_v3 — L243
  - grant: privilege:grant execute on function public.payroll_create_insurance_setting_version_v1(bigint,boolean,bigint,date,bigint,text),public.payroll_create_run_v3(date,timestamptz,text,jsonb,jsonb,bigint),public.payroll_recalculate_run_v3(bigint,timestamptz,text,jsonb,jsonb,bigint),public.payroll_mutate_item_v3(bigint,bigint,bigint,tex — L244
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.payroll_settings → 202608010001 alter table, L21 [L]
  - table:public.payroll_settings → 20260911102823 alter table, L1 [R]
  - table:public.payroll_settings → 20260911102823 alter table, L16 [R] [conditional]
  - table:public.payroll_settings → 20260911102823 alter table, L27 [R] [conditional]
  - table:public.payroll_settings → 20260911102823 alter table, L40 [R] [conditional]
  - table:public.payroll_run_items → 202608010001 alter table, L34 [L]
  - table:public.payroll_run_items → 202608010001 alter table, L35 [L]
  - table:public.payroll_run_items → 202608010001 alter table, L38 [L]
  - table:public.payroll_run_items → 202608010001 alter table, L39 [L]
  - table:public.payroll_run_items → 202608070004 drop table, L78 [R]
  - constraint:public.payroll_run_items.payroll_run_items_category_check → 202608010001 constraint drop, L34 [L]
  - constraint:public.payroll_run_items.payroll_run_items_category_check → 202608010001 constraint add, L35 [L]
  - constraint:public.payroll_run_items.payroll_run_item_category_direction_check → 202608010001 constraint drop, L38 [L]
  - constraint:public.payroll_run_items.payroll_run_item_category_direction_check → 202608010001 constraint add, L39 [L]
  - table:public.payroll_run_employees → 202608070004 drop table, L84 [R]
  - table:public.payroll_runs → 202608010001 alter table, L31 [L]
  - table:public.payroll_runs → 202608070004 drop table, L87 [R]
  - function:public.payroll_refresh_totals_v3(bigint) → 202608070004 drop function, L51 [R]
  - function:public.payroll_insert_payload_v3(bigint,jsonb,bigint,bigint) → 202608070004 drop function, L47 [R]
  - function:public.payroll_create_run_v3(date,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L39 [R]
  - function:public.payroll_recalculate_run_v3(bigint,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L43 [R]
  - function:public.payroll_mutate_item_v3(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint) → 202608070004 drop function, L55 [R]
  - function:public.payroll_resolve_review_v3(bigint,bigint,bigint,text,integer,text,bigint) → 202608070004 drop function, L59 [R]
  - function:public.payroll_transition_run_v3(bigint,text,text,date,text,text,bigint) → 202608070004 drop function, L63 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202608010001 — 202608010001_add_payroll_work_policy_penalties_v6.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `a3ea5f4c269948c48b240d97d65088e261f79d3f4bd11315c857bef85dfad1bf`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.payroll_settings — L21
  - column add: column:public.payroll_settings.late_major_threshold_minutes — L21
  - column add: column:public.payroll_settings.late_minor_penalty_minutes — L21
  - column add: column:public.payroll_settings.late_major_penalty_rate_bp — L21
  - column add: column:public.payroll_settings.unauthorized_absence_penalty_days — L21
  - constraint add: constraint:public.payroll_settings.payroll_settings_late_major_threshold_check — L21
  - constraint add: constraint:public.payroll_settings.payroll_settings_late_minor_penalty_check — L21
  - constraint add: constraint:public.payroll_settings.payroll_settings_late_major_rate_check — L21
  - constraint add: constraint:public.payroll_settings.payroll_settings_unauthorized_absence_days_check — L21
  - alter table: table:public.payroll_runs — L31
  - column add: column:public.payroll_runs.penalty_settings_snapshot — L31
  - alter table: table:public.payroll_run_items — L34
  - constraint drop: constraint:public.payroll_run_items.payroll_run_items_category_check — L34
  - alter table: table:public.payroll_run_items — L35
  - constraint add: constraint:public.payroll_run_items.payroll_run_items_category_check — L35
  - alter table: table:public.payroll_run_items — L38
  - constraint drop: constraint:public.payroll_run_items.payroll_run_item_category_direction_check — L38
  - alter table: table:public.payroll_run_items — L39
  - constraint add: constraint:public.payroll_run_items.payroll_run_item_category_direction_check — L39
  - create unique index: index:public.payroll_run_item_automatic_late_unique — L44
  - create unique index: index:public.payroll_run_item_unauthorized_absence_unique — L47
  - create function: function:public.payroll_refresh_totals_v4(bigint) — L51
  - create function: function:public.payroll_insert_payload_v4(bigint,jsonb,bigint,bigint) — L57
  - create function: function:public.payroll_create_run_v4(date,timestamptz,text,jsonb,jsonb,bigint) — L63
  - create function: function:public.payroll_recalculate_run_v4(bigint,timestamptz,text,jsonb,jsonb,bigint) — L87
  - create function: function:public.payroll_mutate_item_v4(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint) — L111
  - create function: function:public.payroll_resolve_review_v4(bigint,bigint,bigint,text,integer,text,bigint) — L120
  - create function: function:public.payroll_transition_run_v4(bigint,text,text,date,text,text,bigint) — L152
  - revoke: privilege:revoke all on function public.payroll_refresh_totals_v4(bigint),public.payroll_insert_payload_v4(bigint,jsonb,bigint,bigint),public.payroll_create_run_v4(date,timestamptz,text,jsonb,jsonb,bigint),public.payroll_recalculate_run_v4(bigint,timestamptz,text,jsonb,jsonb,bigint),public.payroll_mutate_item_v4(bigint,bigint,bi — L172
  - grant: privilege:grant execute on function public.payroll_create_run_v4(date,timestamptz,text,jsonb,jsonb,bigint),public.payroll_recalculate_run_v4(bigint,timestamptz,text,jsonb,jsonb,bigint),public.payroll_mutate_item_v4(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint),public.payroll_resolve_review_v4(bigint,bigint,bigint, — L173
- 후속 동일 객체 변경 후보:
  - table:public.payroll_settings → 20260911102823 alter table, L1 [R]
  - table:public.payroll_settings → 20260911102823 alter table, L16 [R] [conditional]
  - table:public.payroll_settings → 20260911102823 alter table, L27 [R] [conditional]
  - table:public.payroll_settings → 20260911102823 alter table, L40 [R] [conditional]
  - table:public.payroll_runs → 202608070004 drop table, L87 [R]
  - table:public.payroll_run_items → 202608070004 drop table, L78 [R]
  - function:public.payroll_refresh_totals_v4(bigint) → 202608070004 drop function, L52 [R]
  - function:public.payroll_insert_payload_v4(bigint,jsonb,bigint,bigint) → 202608070004 drop function, L48 [R]
  - function:public.payroll_create_run_v4(date,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L40 [R]
  - function:public.payroll_recalculate_run_v4(bigint,timestamptz,text,jsonb,jsonb,bigint) → 202608070004 drop function, L44 [R]
  - function:public.payroll_mutate_item_v4(bigint,bigint,bigint,text,text,text,bigint,text,text,bigint) → 202608070004 drop function, L56 [R]
  - function:public.payroll_resolve_review_v4(bigint,bigint,bigint,text,integer,text,bigint) → 202608070004 drop function, L60 [R]
  - function:public.payroll_transition_run_v4(bigint,text,text,date,text,text,bigint) → 202608070004 drop function, L64 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202608020001 — 202608020001_correct_latest_unused_payroll_contract.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `0d2c06d3202db61663f1a52fe26070f9f5f338cffed52ae7a1f21aac49a0ac30`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.payroll_contract_audit_logs — L139 [conditional/dynamic DO candidate]
  - constraint drop: constraint:public.payroll_contract_audit_logs.payroll_contract_audit_logs_action_check — L129 [conditional/dynamic DO candidate]
  - alter table: table:public.payroll_contract_audit_logs — L141 [conditional/dynamic DO candidate]
  - constraint add: constraint:public.payroll_contract_audit_logs.payroll_contract_audit_logs_action_check — L129 [conditional/dynamic DO candidate]
  - create or replace function: function:public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) — L147
  - revoke: privilege:revoke all on function public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) from public, anon, authenticated; — L332
  - grant: privilege:grant execute on function public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) to service_role; — L333
- 후속 동일 객체 변경 후보:
  - Dynamic patch reference → 202608020002 [L]; 원본 실행 및 patch 성공은 입증되지 않음.
  - Dynamic patch reference → 202608070003 [L]; 원본 실행 및 patch 성공은 입증되지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202608020002 — 202608020002_add_unified_payroll_engine_v7.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `daf15a77d4e7d91654ab5e48277b7204feed27eb79dccc9282c4a9694a3dfb5b`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text) — L133
  - revoke: privilege:revoke all on function public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text) from public,anon,authenticated; — L154
  - grant: privilege:grant execute on function public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text) to service_role; — L155
  - create or replace function: function:public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) — L159
  - revoke: privilege:revoke all on function public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) from public,anon,authenticated; — L182
  - grant: privilege:grant execute on function public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) to service_role; — L183
  - 동적 함수 patch/문자열 치환 후보 포함: pg_get_functiondef 원문과 치환 전제·결과 본문 확인 필요.
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202608030001 — 202608030001_add_employee_level_program_versions.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `c83fddfbe003ed307949b67dab74a07a98c2347ef1112ab5b9e7dd03e009588c`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.employee_level_program_versions — L5
  - column create: column:public.employee_level_program_versions.id — L5
  - column create: column:public.employee_level_program_versions.user_id — L5
  - column create: column:public.employee_level_program_versions.enabled — L5
  - column create: column:public.employee_level_program_versions.effective_from — L5
  - column create: column:public.employee_level_program_versions.effective_to — L5
  - column create: column:public.employee_level_program_versions.base_date — L5
  - column create: column:public.employee_level_program_versions.revision — L5
  - column create: column:public.employee_level_program_versions.change_reason — L5
  - column create: column:public.employee_level_program_versions.created_by — L5
  - column create: column:public.employee_level_program_versions.created_by_username — L5
  - column create: column:public.employee_level_program_versions.created_at — L5
  - create index: index:public.employee_level_program_versions_user_period_idx — L37
  - create index: index:public.employee_level_program_versions_created_by_idx — L39
  - alter table: table:public.employee_level_program_versions — L43
  - revoke: privilege:revoke all on table public.employee_level_program_versions from public, anon, authenticated, service_role; — L44
  - revoke: privilege:revoke all on sequence public.employee_level_program_versions_id_seq from public, anon, authenticated, service_role; — L45
  - grant: privilege:grant select on table public.employee_level_program_versions to service_role; — L46
  - insert into: data:public.employee_level_program_versions — L48
  - update: data:public.users — L77
  - create or replace function: function:public.employee_update_profile_and_level_v5(bigint,jsonb,boolean,date,text,bigint,text) — L87
  - create or replace function: function:public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text) — L198
  - create or replace function: function:public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint) — L250
  - revoke: privilege:revoke all on function public.employee_update_profile_and_level_v5(bigint,jsonb,boolean,date,text,bigint,text) from public, anon, authenticated; — L309
  - revoke: privilege:revoke all on function public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text) from public, anon, authenticated; — L311
  - revoke: privilege:revoke all on function public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint) from public, anon, authenticated; — L313
  - grant: privilege:grant execute on function public.employee_update_profile_and_level_v5(bigint,jsonb,boolean,date,text,bigint,text) to service_role; — L315
  - grant: privilege:grant execute on function public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text) to service_role; — L317
  - grant: privilege:grant execute on function public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint) to service_role; — L319
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - table:public.employee_level_program_versions → 202608040001 alter table, L3 [L]
  - table:public.employee_level_program_versions → 202608040001 alter table, L6 [L]
  - table:public.employee_level_program_versions → 202608040001 alter table, L89 [L]
  - function:public.employee_update_profile_and_level_v5(bigint,jsonb,boolean,date,text,bigint,text) → 202608070007 drop function, L57 [R]
  - function:public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text) → 202608040001 create or replace function, L373 [L]
  - function:public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text) → 202608070007 drop function, L90 [R]
  - function:public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint) → 202608040001 create or replace function, L382 [L]
  - function:public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint) → 202608070007 drop function, L103 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202608040001 — 202608040001_restore_employee_level_base_date_modes.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `1ee2218531850fc9fd4533c4661e08357b8d255a19198c6e08269ce58bbc832f`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.employee_level_program_versions — L3
  - column add: column:public.employee_level_program_versions.base_date_mode — L3
  - alter table: table:public.employee_level_program_versions — L6
  - constraint drop: constraint:public.employee_level_program_versions.employee_level_program_versions_base_check — L6
  - alter table: table:public.employee_level_audit_logs — L9
  - column add: column:public.employee_level_audit_logs.previous_base_date_mode — L9
  - column add: column:public.employee_level_audit_logs.next_base_date_mode — L9
  - constraint add: constraint:public.employee_level_audit_logs.employee_level_audit_logs_previous_base_date_mode_check — L9
  - constraint add: constraint:public.employee_level_audit_logs.employee_level_audit_logs_next_base_date_mode_check — L9
  - update: data:public.employee_level_program_versions — L17
  - alter table: table:public.employee_level_program_versions — L89
  - constraint add: constraint:public.employee_level_program_versions.employee_level_program_versions_base_check — L89
  - update: data:public.users — L97
  - create or replace function: function:public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text) — L110
  - create or replace function: function:public.employee_create_with_schedule_v3(jsonb,boolean,text,bigint,text) — L262
  - create or replace function: function:public.employee_rehire_with_level_policy_v3(bigint,date,boolean,text,bigint,text,smallint) — L304
  - create or replace function: function:public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text) — L373
  - create or replace function: function:public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint) — L382
  - revoke: privilege:revoke all on function public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text) from public, anon, authenticated; — L392
  - grant: privilege:grant execute on function public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text) to service_role; — L394
  - revoke: privilege:revoke all on function public.employee_create_with_schedule_v3(jsonb,boolean,text,bigint,text) from public,anon,authenticated; — L396
  - revoke: privilege:revoke all on function public.employee_rehire_with_level_policy_v3(bigint,date,boolean,text,bigint,text,smallint) from public,anon,authenticated; — L397
  - grant: privilege:grant execute on function public.employee_create_with_schedule_v3(jsonb,boolean,text,bigint,text) to service_role; — L398
  - grant: privilege:grant execute on function public.employee_rehire_with_level_policy_v3(bigint,date,boolean,text,bigint,text,smallint) to service_role; — L399
- 후속 동일 객체 변경 후보:
  - function:public.employee_update_profile_and_level_v6(bigint,jsonb,boolean,date,text,date,text,bigint,text) → 202608070007 drop function, L51 [R]
  - function:public.employee_create_with_schedule_v3(jsonb,boolean,text,bigint,text) → 202608070007 drop function, L85 [R]
  - function:public.employee_rehire_with_level_policy_v3(bigint,date,boolean,text,bigint,text,smallint) → 202608070006 create or replace function, L555 [R]
  - function:public.employee_create_with_schedule_v2(jsonb,boolean,text,bigint,text) → 202608070007 drop function, L90 [R]
  - function:public.employee_rehire_with_level_policy_v2(bigint,date,boolean,text,bigint,text,smallint) → 202608070007 drop function, L103 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 데이터 보정 실행 증거 별도 필요; 현재 행 값만으로 적용 완료 판정 금지.

### 202608070001 — 202608070001_add_payroll_meal_allowance.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `d60aa4de1148a5af5fd551f5cacac0645e204f7c118158565db8ed1db5c5aa5b`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create table: table:public.payroll_meal_allowance_policy_versions — L54
  - column create: column:public.payroll_meal_allowance_policy_versions.id — L54
  - column create: column:public.payroll_meal_allowance_policy_versions.daily_amount — L54
  - column create: column:public.payroll_meal_allowance_policy_versions.effective_from — L54
  - column create: column:public.payroll_meal_allowance_policy_versions.revision — L54
  - column create: column:public.payroll_meal_allowance_policy_versions.created_by — L54
  - column create: column:public.payroll_meal_allowance_policy_versions.created_at — L54
  - column create: column:public.payroll_meal_allowance_policy_versions.note — L54
  - create index: index:public.payroll_meal_allowance_policy_lookup_idx — L68
  - alter table: table:public.payroll_meal_allowance_policy_versions — L71
  - revoke: privilege:revoke all on table public.payroll_meal_allowance_policy_versions from public, anon, authenticated, service_role; — L73
  - revoke: privilege:revoke all on sequence public.payroll_meal_allowance_policy_versions_id_seq from public, anon, authenticated, service_role; — L75
  - grant: privilege:grant select, insert on table public.payroll_meal_allowance_policy_versions to service_role; — L77
  - grant: privilege:grant usage, select on sequence public.payroll_meal_allowance_policy_versions_id_seq to service_role; — L78
  - create table: table:public.payroll_meal_allowance_eligibility_versions — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.id — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.user_id — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.is_eligible — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.effective_from — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.revision — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.created_by — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.created_at — L87
  - column create: column:public.payroll_meal_allowance_eligibility_versions.note — L87
  - create index: index:public.payroll_meal_allowance_eligibility_lookup_idx — L100
  - create index: index:public.payroll_meal_allowance_eligibility_created_by_idx — L102
  - alter table: table:public.payroll_meal_allowance_eligibility_versions — L105
  - revoke: privilege:revoke all on table public.payroll_meal_allowance_eligibility_versions from public, anon, authenticated, service_role; — L107
  - revoke: privilege:revoke all on sequence public.payroll_meal_allowance_eligibility_versions_id_seq from public, anon, authenticated, service_role; — L109
  - grant: privilege:grant select, insert on table public.payroll_meal_allowance_eligibility_versions to service_role; — L111
  - grant: privilege:grant usage, select on sequence public.payroll_meal_allowance_eligibility_versions_id_seq to service_role; — L112
  - create or replace function: function:public.payroll_create_meal_allowance_policy_version_v1(numeric,date,bigint,text) — L121
  - revoke: privilege:revoke all on function public.payroll_create_meal_allowance_policy_version_v1(numeric, date, bigint, text) from public, anon, authenticated; — L162
  - grant: privilege:grant execute on function public.payroll_create_meal_allowance_policy_version_v1(numeric, date, bigint, text) to service_role; — L164
  - create or replace function: function:public.payroll_create_meal_allowance_eligibility_version_v1(bigint,boolean,date,bigint,text) — L174
  - revoke: privilege:revoke all on function public.payroll_create_meal_allowance_eligibility_version_v1(bigint, boolean, date, bigint, text) from public, anon, authenticated; — L231
  - grant: privilege:grant execute on function public.payroll_create_meal_allowance_eligibility_version_v1(bigint, boolean, date, bigint, text) to service_role; — L233
  - create or replace function: function:public.users_block_attendance_tracking_disable_when_meal_eligible() — L259
  - drop trigger: trigger:public.users_block_attendance_tracking_disable_when_meal_eligible@public.users — L317
  - create trigger: trigger:public.users_block_attendance_tracking_disable_when_meal_eligible@public.users — L318
  - revoke: privilege:revoke all on function public.users_block_attendance_tracking_disable_when_meal_eligible() from public, anon, authenticated; — L323
  - create or replace function: function:public.payroll_update_common_settings_v1(bigint,integer,integer,integer,boolean,numeric,integer,integer,integer,integer,integer,numeric,date,text) — L344
  - revoke: privilege:revoke all on function public.payroll_update_common_settings_v1( bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer, integer, numeric, date, text ) from public, anon, authenticated; — L476
  - grant: privilege:grant execute on function public.payroll_update_common_settings_v1( bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer, integer, numeric, date, text ) to service_role; — L479
  - RLS enable/disable 문이 있음. 실제 relrowsecurity/relforcerowsecurity 및 정책 전체 비교 필요.
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202608070002 — 202608070002_payroll_fixed_monthly_by_attendance_tracking.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `9205d2ef43b426ae5db4af0e796766d728b0c561a076b461dc5d34623ab7f8ec`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) — L57
  - revoke: privilege:revoke all on function public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) from public,anon,authenticated; — L91
  - grant: privilege:grant execute on function public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) to service_role; — L92
  - create or replace function: function:public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) — L101
  - revoke: privilege:revoke all on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) from public,anon,authenticated; — L136
  - grant: privilege:grant execute on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) to service_role; — L137
- 후속 동일 객체 변경 후보:
  - function:public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) → 202608070003 create or replace function, L294 [L]
  - function:public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) → 202608070003 create or replace function, L347 [L]
  - Dynamic patch reference → 202608070003 [L]; 원본 실행 및 patch 성공은 입증되지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 202608070003 — 202608070003_fix_fixed_monthly_contract_delegate.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Schema, access control or application compatibility; check dependencies and full statement coverage.
- 파일 SHA-256: `3a1dba4c4955dfda4664a26ed8d5e79d3afd5e0f8d4944515962e2d6a18fbb32`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) — L92
  - revoke: privilege:revoke all on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) from public, anon, authenticated; — L280
  - grant: privilege:grant execute on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) to service_role; — L281
  - create or replace function: function:public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) — L294
  - revoke: privilege:revoke all on function public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) from public,anon,authenticated; — L335
  - grant: privilege:grant execute on function public.payroll_create_contract_version_v6(bigint,text,numeric,numeric,numeric,date,bigint,text) to service_role; — L336
  - create or replace function: function:public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) — L347
  - revoke: privilege:revoke all on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) from public,anon,authenticated; — L382
  - grant: privilege:grant execute on function public.payroll_correct_latest_unused_contract_v4(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) to service_role; — L383
  - 동적 함수 patch/문자열 치환 후보 포함: pg_get_functiondef 원문과 치환 전제·결과 본문 확인 필요.
- 후속 동일 객체 변경 후보:
  - function:public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) → 20260909231222 create or replace function, L15 [R]
  - function:public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) → 20260909231222 alter function, L198 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 20260811103600 — 20260811103600_integrate_attendance_bonus_common_settings.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `82bfd82565bbc6e24f0ee9ab9c0c8b6f7ba7853f2d210ca346abad745b5186b2`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create function: function:public.payroll_update_common_settings_v2(bigint,integer,integer,integer,boolean,numeric,integer,integer,integer,integer,integer,numeric,date,text,integer,integer,integer,numeric,date,text) — L5
  - revoke: privilege:revoke all on function public.payroll_update_common_settings_v2( bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer, integer, numeric, date, text, integer, integer, integer, numeric, date, text ) from public, anon, authenticated; — L125
  - grant: privilege:grant execute on function public.payroll_update_common_settings_v2( bigint, integer, integer, integer, boolean, numeric, integer, integer, integer, integer, integer, numeric, date, text, integer, integer, integer, numeric, date, text ) to service_role; — L129
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 20260917092710 — 20260917092710_count_all_linked_meal_corrections.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Accounting linkage, settlement or closed-month behavior: object presence cannot prove economic correction or historical execution.
- 파일 SHA-256: `852afce4fc72d91d0280ff102c7d3c8fa3aa9abc48707f8860896b6cfbfce315`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint) — L4
  - alter function: function:public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint) — L217
  - revoke: privilege:revoke all on function public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint) from public, anon, authenticated; — L219
  - grant: privilege:grant execute on function public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint) to service_role; — L221
- 후속 동일 객체 변경 후보:
  - function:public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint) → 20261001131334 create or replace function, L4 [R]
  - function:public.ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint) → 20261001131334 alter function, L271 [R]
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 20260928210713 — 20260928210713_add_sales_receipt_split_payment.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Accounting linkage, settlement or closed-month behavior: object presence cannot prove economic correction or historical execution.
- 파일 SHA-256: `92bf32954bd408698dd72ba8ca770f2c8d230011e79c2119abc68ffe42687d30`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - drop function: function:public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb) — L2
  - create or replace function: function:public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb,numeric) — L3
  - revoke: privilege:revoke all on function public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb,numeric) from public, anon, authenticated; — L288
  - grant: privilege:grant execute on function public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb,numeric) to service_role; — L290
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 20261001061230 — 20261001061230_add_early_leave_admin_selection.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Payroll/attendance contract, paid-source locks or employee authorization: reconcile body, signature and privileges before history repair.
- 파일 SHA-256: `8bea85e01ac38a966bb5dc86f9d88783c1034ff3d1dc94f3582d854db821c226`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - alter table: table:public.attendance_record_manual_overrides — L3
  - column add: column:public.attendance_record_manual_overrides.decision_threshold_at — L3
  - column add: column:public.attendance_record_manual_overrides.decision_grace_minutes — L3
  - alter table: table:public.attendance_record_manual_overrides — L7
  - constraint drop: constraint:public.attendance_record_manual_overrides.attendance_record_manual_overrides_action_check — L7
  - alter table: table:public.attendance_record_manual_overrides — L9
  - constraint add: constraint:public.attendance_record_manual_overrides.attendance_record_manual_overrides_action_check — L9
  - create function: function:public.attendance_early_leave_context_v1(public.attendance_records) — L15
  - create function: function:public.attendance_early_leave_contexts_v1(date,date,bigint) — L75
  - create function: function:public.attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer) — L85
  - create function: function:public.attendance_revoke_early_leave_decision_v1() — L145
  - create trigger: trigger:public.attendance_records_revoke_early_leave_decision@public.attendance_records — L157
  - create function: function:public.attendance_lock_paid_early_leave_source_v1() — L161
  - create trigger: trigger:public.attendance_records_paid_early_leave_source_lock@public.attendance_records — L185
  - revoke: privilege:revoke all on function public.attendance_early_leave_context_v1(public.attendance_records) from public,anon,authenticated; — L189
  - revoke: privilege:revoke all on function public.attendance_early_leave_contexts_v1(date,date,bigint) from public,anon,authenticated; — L190
  - revoke: privilege:revoke all on function public.attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer) from public,anon,authenticated; — L191
  - revoke: privilege:revoke all on function public.attendance_revoke_early_leave_decision_v1() from public,anon,authenticated; — L192
  - revoke: privilege:revoke all on function public.attendance_lock_paid_early_leave_source_v1() from public,anon,authenticated; — L193
  - grant: privilege:grant execute on function public.attendance_early_leave_context_v1(public.attendance_records) to service_role; — L194
  - grant: privilege:grant execute on function public.attendance_early_leave_contexts_v1(date,date,bigint) to service_role; — L195
  - grant: privilege:grant execute on function public.attendance_admin_resolve_early_leave_v1(bigint,bigint,text,timestamptz,timestamptz,timestamptz,timestamptz,integer) to service_role; — L196
  - create function: function:public.payroll_block_pending_early_leave_v1() — L199
  - create trigger: trigger:public.payroll_employee_payments_early_leave_review_lock@public.payroll_employee_payments — L212
  - revoke: privilege:revoke all on function public.payroll_block_pending_early_leave_v1() from public,anon,authenticated; — L215
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 20261009080243 — 20261009080243_detect_inventory_purchase_economic_corrections.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Accounting linkage, settlement or closed-month behavior: object presence cannot prove economic correction or historical execution.
- 파일 SHA-256: `8a16c84092ed80d1fd943ccb5910f3eda76b0dfabe22ec05704cd7cf0a12a790`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create or replace function: function:inventory_ledger_private.economics(jsonb) — L3
  - revoke: privilege:revoke all on function inventory_ledger_private.economics(jsonb) from public,anon,authenticated,service_role; — L7
  - create function: function:inventory_ledger_private.purchase_supplier_matches(text,text,text,text) — L11
  - create function: function:inventory_ledger_private.compare_purchase_supplier(jsonb,jsonb) — L31
  - alter function: function:inventory_ledger_private.purchase_supplier_matches(text,text,text,text) — L58
  - alter function: function:inventory_ledger_private.compare_purchase_supplier(jsonb,jsonb) — L59
  - revoke: privilege:revoke all on function inventory_ledger_private.purchase_supplier_matches(text,text,text,text) from public,anon,authenticated,service_role; — L60
  - revoke: privilege:revoke all on function inventory_ledger_private.compare_purchase_supplier(jsonb,jsonb) from public,anon,authenticated,service_role; — L61
  - create or replace function: function:public.inventory_purchase_correction_guard_v1() — L63
  - revoke: privilege:revoke all on function public.inventory_purchase_correction_guard_v1() from public,anon,authenticated,service_role; — L133
  - create or replace function: function:inventory_ledger_private.inspect_purchase_repair(bigint,bigint) — L165
  - revoke: privilege:revoke all on function inventory_ledger_private.inspect_purchase_repair(bigint,bigint) from public,anon,authenticated,service_role; — L256
  - alter function: function:inventory_ledger_private.inspect_purchase_repair(bigint,bigint) — L257
  - create or replace function: function:public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) — L259
  - create function: function:public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb) — L294
  - create or replace function: function:public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) — L363
  - alter function: function:public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb) — L368
  - revoke: privilege:revoke all on function public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb) from public,anon,authenticated,service_role; — L369
  - grant: privilege:grant execute on function public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb) to service_role; — L370
  - alter function: function:public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) — L371
  - alter function: function:public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) — L372
  - revoke: privilege:revoke all on function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) from public,anon,authenticated,service_role; — L373
  - revoke: privilege:revoke all on function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) from public,anon,authenticated,service_role; — L374
  - grant: privilege:grant execute on function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) to service_role; — L375
  - grant: privilege:grant execute on function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) to service_role; — L376
  - 동적 함수 patch/문자열 치환 후보 포함: pg_get_functiondef 원문과 치환 전제·결과 본문 확인 필요.
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

### 20261009161017 — 20261009161017_add_inventory_logs_created_at_id_read_index.sql

- 판정: **D**, 이력 복구 제외. 근거: 원격 버전 부재, 현재 카탈로그/본문 비교 불가. 신뢰도: 증거 부족 판정 높음 / 실제 적용 여부 평가 불가.
- 영향 및 운영 위험: Query plan / index definition and write overhead; never recreate an existing index merely to register history.
- 파일 SHA-256: `251ae94dca18b87b870f7d8bfe2f19fe76f72ffcfde2f1754fea27b03d449462`.
- 영향 객체/변경문 (정적 추출, 소스 줄; 조건부 DO는 candidate):
  - create index: index:public.inventory_logs_created_at_id_read_idx — L7
- 후속 동일 객체 변경 후보:
  - 정확한 키로 연결된 후속 로컬 변경 미추출. 운영 수동 변경/동적 SQL/다른 signature 가능성을 배제하지 않음.
- 추가 확인: 객체 종류별 정의·소유자·ACL·의존성·오버로드 비교; inline CHECK/FK/default 및 DO 내부 동적 식별자는 원본 SQL 전체와 수동 대조. 함수 내부 실행 DML을 Migration backfill로 혼동하지 않음.

## 전체 181개 버전 계보 인벤토리

| 버전·파일 | 원격 등록 | 영향 종류/이벤트 | 후속 버전 후보 |
|---|---|---|---|
| [202606130001_create_pos_category_group_mappings.sql](../../supabase/migrations/202606130001_create_pos_category_group_mappings.sql) | 누락 (D) | table:2, column:8, data:1; RLS | — |
| [202606140001_extend_pos_item_mappings_catalog_link.sql](../../supabase/migrations/202606140001_extend_pos_item_mappings_catalog_link.sql) | 누락 (D) | table:12, column:22, data:4, constraint:5, index:5 | 202606150002 [L], 202606190002 [L], 202606300002 [L], 202606300001 [L] |
| [202606140002_create_sales_inventory_deduction_batches.sql](../../supabase/migrations/202606140002_create_sales_inventory_deduction_batches.sql) | 누락 (D) | table:17, column:79, index:7, constraint:4 | 202606150001 [L], 202606190001 [L], 202607100001 [L], 202607130001 [L], 202607230002 [L], 202606190002 [L], 202607190002 [L], 202607020002 [L], 20260906114438 [R], 20260914161954 [R] |
| [202606150001_apply_sales_inventory_deduction_batch.sql](../../supabase/migrations/202606150001_apply_sales_inventory_deduction_batch.sql) | 누락 (D) | table:3, column:1, constraint:2, function:1, privilege:2 | 202606190001 [L], 202607100001 [L], 202607130001 [L], 202607230002 [L], 202606210001 [L] |
| [202606150002_archive_pos_item_mappings.sql](../../supabase/migrations/202606150002_archive_pos_item_mappings.sql) | 누락 (D) | table:1, column:3, index:5 | 202606190002 [L], 202606300002 [L] |
| [202606190001_align_sales_inventory_deduction_status_checks.sql](../../supabase/migrations/202606190001_align_sales_inventory_deduction_status_checks.sql) | 누락 (D) | table:6, constraint:6 | 202606190002 [L], 202607190002 [L], 202607100001 [L], 202607130001 [L], 202607230002 [L] |
| [202606190002_allow_combo_pos_mapping_type.sql](../../supabase/migrations/202606190002_allow_combo_pos_mapping_type.sql) | 누락 (D) | table:4, constraint:4 | 202606300002 [L], 202607190002 [L] |
| [202606210001_add_purchase_price_to_sale_deduction_logs.sql](../../supabase/migrations/202606210001_add_purchase_price_to_sale_deduction_logs.sql) | 누락 (D) | function:1, privilege:2 | — |
| [202606230001_add_pos_sales_sync_run_lock.sql](../../supabase/migrations/202606230001_add_pos_sales_sync_run_lock.sql) | 누락 (D) | index:2 | — |
| [202606260001_add_manual_receipt_ref_no_unique_index.sql](../../supabase/migrations/202606260001_add_manual_receipt_ref_no_unique_index.sql) | 누락 (D) | index:1 | — |
| [202606300001_add_inventory_package_volume_and_recipe_source.sql](../../supabase/migrations/202606300001_add_inventory_package_volume_and_recipe_source.sql) | 누락 (D) | table:5, column:6, constraint:3 | 202607050001 [L], 202607050004 [L], 202608060002 [R], 202608220002 [R] |
| [202606300002_add_direct_mapping_source_content.sql](../../supabase/migrations/202606300002_add_direct_mapping_source_content.sql) | 누락 (D) | table:3, column:4, constraint:2 | — |
| [202607010001_add_leader_role.sql](../../supabase/migrations/202607010001_add_leader_role.sql) | 누락 (D) | table:2, constraint:1 | 202607280001 [L], 202607280002 [L], 20260728182601 [R], 202608060001 [R] |
| [202607020001_create_inventory_keg_tracking.sql](../../supabase/migrations/202607020001_create_inventory_keg_tracking.sql) | 누락 (D) | table:2, column:29, index:5, function:1 | 202607230003 [L] |
| [202607020002_allow_keg_replace_inventory_log_source.sql](../../supabase/migrations/202607020002_allow_keg_replace_inventory_log_source.sql) | 누락 (D) | table:2, constraint:2 | 20260906114438 [R], 20260914161954 [R] |
| [202607020003_keg_replacement_time_and_note.sql](../../supabase/migrations/202607020003_keg_replacement_time_and_note.sql) | 누락 (D) | function:1 | 202607060001 [L] |
| [202607050001_add_inventory_is_active.sql](../../supabase/migrations/202607050001_add_inventory_is_active.sql) | 누락 (D) | table:1, column:1, index:1 | 202607050004 [L], 202608060002 [R], 202608220002 [R] |
| [202607050002_add_inventory_stock_check_log_index.sql](../../supabase/migrations/202607050002_add_inventory_stock_check_log_index.sql) | 누락 (D) | index:1 | — |
| [202607050003_add_inventory_sale_deduction_log_index.sql](../../supabase/migrations/202607050003_add_inventory_sale_deduction_log_index.sql) | 누락 (D) | index:1 | — |
| [202607050004_add_inventory_low_stock_enabled.sql](../../supabase/migrations/202607050004_add_inventory_low_stock_enabled.sql) | 누락 (D) | table:1, column:1 | 202608060002 [R], 202608220002 [R] |
| [202607060001_classify_keg_replace_as_sale_deduction.sql](../../supabase/migrations/202607060001_classify_keg_replace_as_sale_deduction.sql) | 누락 (D) | function:1 | — |
| [202607090001_add_sales_sync_lookup_indexes.sql](../../supabase/migrations/202607090001_add_sales_sync_lookup_indexes.sql) | 누락 (D) | index:2 | — |
| [202607100001_add_inventory_deduction_receipt_workflow_fingerprint.sql](../../supabase/migrations/202607100001_add_inventory_deduction_receipt_workflow_fingerprint.sql) | 누락 (D) | table:4, column:3, constraint:3, index:2 | 202607130001 [L], 202607230002 [L] |
| [202607100002_reprocess_modified_sales_inventory_deduction.sql](../../supabase/migrations/202607100002_reprocess_modified_sales_inventory_deduction.sql) | 누락 (D) | index:2, function:1 | 202607180005 [L], 202607190002 [L] (dynamic patch candidate) |
| [202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql](../../supabase/migrations/202607130001_complete_sales_receipt_inventory_deduction_lifecycle.sql) | 누락 (D) | table:3, column:8, index:1, constraint:2, function:1, privilege:4 | 202607170001 [L], 202607230002 [L], 202607190002 [L] (dynamic patch candidate) |
| [202607140001_create_bar_zone_management.sql](../../supabase/migrations/202607140001_create_bar_zone_management.sql) | 누락 (D) | table:6, column:28, index:6, data:2, function:2, privilege:4; RLS | 202607150001 [L] |
| [202607150001_add_bar_zone_image_updated_at.sql](../../supabase/migrations/202607150001_add_bar_zone_image_updated_at.sql) | 누락 (D) | table:1, column:1, data:1, function:1, privilege:2 | — |
| [202607150002_create_bar_keeping_management.sql](../../supabase/migrations/202607150002_create_bar_keeping_management.sql) | 누락 (D) | table:2, column:23, index:4, data:1, function:2, privilege:4; RLS | 202607150003 [L], 202607150004 [L], 202607160001 [L], 202607180001 [L], 202608080002 [R] |
| [202607150003_add_bar_keeping_liquor_source.sql](../../supabase/migrations/202607150003_add_bar_keeping_liquor_source.sql) | 누락 (D) | table:2, column:2, constraint:3, index:1, function:2, privilege:5 | 202607150004 [L], 202607160001 [L], 202607180001 [L], 202608080002 [R] |
| [202607150004_add_bar_keeping_use_count_fixed_expiry.sql](../../supabase/migrations/202607150004_add_bar_keeping_use_count_fixed_expiry.sql) | 누락 (D) | table:1, column:1, constraint:1, data:2, function:2, privilege:4 | 202607160001 [L], 202607180001 [L], 202608080002 [R] |
| [202607160001_add_bar_keeping_customer_contact.sql](../../supabase/migrations/202607160001_add_bar_keeping_customer_contact.sql) | 누락 (D) | table:1, column:1, constraint:1, function:2, privilege:4 | 202607180001 [L], 202608080002 [R] |
| [202607160002_add_bar_keeping_atomic_update_move.sql](../../supabase/migrations/202607160002_add_bar_keeping_atomic_update_move.sql) | 누락 (D) | function:1, privilege:2 | 202608080001 [R] |
| [202607170001_add_sales_receipt_financial_overrides.sql](../../supabase/migrations/202607170001_add_sales_receipt_financial_overrides.sql) | 누락 (D) | table:4, column:16, constraint:8, function:1, privilege:5; RLS | 20260928210713 [L] |
| [202607170002_unify_bar_keeping_action_notes.sql](../../supabase/migrations/202607170002_unify_bar_keeping_action_notes.sql) | 누락 (D) | data:1, function:1, privilege:2 | 202608080002 [R] |
| [202607180001_allow_jpeg_bar_keeping_paths.sql](../../supabase/migrations/202607180001_allow_jpeg_bar_keeping_paths.sql) | 누락 (D) | table:1, constraint:4 | — |
| [202607180002_delete_active_bar_keeping.sql](../../supabase/migrations/202607180002_delete_active_bar_keeping.sql) | 누락 (D) | function:1, privilege:2 | — |
| [202607180003_delete_bar_keeping_v2.sql](../../supabase/migrations/202607180003_delete_bar_keeping_v2.sql) | 누락 (D) | function:1, privilege:2 | — |
| [202607180004_add_reactivate_action_note.sql](../../supabase/migrations/202607180004_add_reactivate_action_note.sql) | 누락 (D) | function:1, privilege:2 | 202608080001 [R] |
| [202607180005_fix_reprocess_modified_sales_inventory_deduction.sql](../../supabase/migrations/202607180005_fix_reprocess_modified_sales_inventory_deduction.sql) | 누락 (D) | function:1, privilege:2 | 202607190002 [L] (dynamic patch candidate) |
| [202607190001_create_store_settings_foundation.sql](../../supabase/migrations/202607190001_create_store_settings_foundation.sql) | 누락 (D) | table:6, column:25, index:3, privilege:23, function:7; RLS | 202607240001 [L], 202607250001 [L], 202608070005 [R] |
| [202607190002_archive_cleanup_legacy_pos_processed_lines.sql](../../supabase/migrations/202607190002_archive_cleanup_legacy_pos_processed_lines.sql) | 누락 (D) | index:2, table:9, column:36, privilege:9, data:3, function:1, constraint:3, trigger:1, sequence:1; RLS | — |
| [202607230001_close_attendance_anon_access.sql](../../supabase/migrations/202607230001_close_attendance_anon_access.sql) | 누락 (D) | policy:3, privilege:4 | — |
| [202607230002_lock_down_sales_inventory_keg_public_access.sql](../../supabase/migrations/202607230002_lock_down_sales_inventory_keg_public_access.sql) | 누락 (D) | table:1, privilege:8; RLS | — |
| [202607230003_unify_keg_sales_calculation.sql](../../supabase/migrations/202607230003_unify_keg_sales_calculation.sql) | 누락 (D) | function:3, privilege:6 | — |
| [202607240001_create_attendance_policy_shadow_foundation.sql](../../supabase/migrations/202607240001_create_attendance_policy_shadow_foundation.sql) | 누락 (D) | table:6, column:23, data:1, index:3, privilege:10, function:3; RLS | 202607250001 [L], 202608070005 [R], 202607240003 [L], 20260812162019 [R] |
| [202607240002_add_attendance_staff_direct_leave_marker.sql](../../supabase/migrations/202607240002_add_attendance_staff_direct_leave_marker.sql) | 누락 (D) | table:1, column:1 | 20260812162019 [R] |
| [202607240003_fix_attendance_cancellation_audit.sql](../../supabase/migrations/202607240003_fix_attendance_cancellation_audit.sql) | 누락 (D) | table:2, constraint:4, column:5, index:1, function:1, privilege:2 | 20260812162019 [R], 202607240004 [L], 20260813180226 [R] |
| [202607240004_fix_attendance_cancel_checkout_runtime.sql](../../supabase/migrations/202607240004_fix_attendance_cancel_checkout_runtime.sql) | 누락 (D) | function:1 | 20260813180226 [R] |
| [202607240005_add_attendance_manual_override_marker.sql](../../supabase/migrations/202607240005_add_attendance_manual_override_marker.sql) | 누락 (D) | table:2, column:10, index:2, privilege:6, function:1; RLS | 20261001061230 [L] |
| [202607250001_add_attendance_departure_grace_settings.sql](../../supabase/migrations/202607250001_add_attendance_departure_grace_settings.sql) | 누락 (D) | table:1, column:2, constraint:2, function:3, privilege:4 | 202608070005 [R] |
| [202607270001_create_payroll_shadow_foundation.sql](../../supabase/migrations/202607270001_create_payroll_shadow_foundation.sql) | 누락 (D) | schema:1, table:6, column:38, index:3, privilege:13, data:1, function:2; RLS | 202608010002 [R], 20260728182601 [R], 202607300001 [L], 202608010003 [R], 20260804152308 [R], 202608020001 [L], 202607280001 [L] |
| [202607270002_create_payroll_runs.sql](../../supabase/migrations/202607270002_create_payroll_runs.sql) | 누락 (D) | table:10, column:84, index:6, privilege:9, function:8; RLS | 202607280001 [L], 202607300001 [L], 202607310001 [L], 202608010001 [L], 202608070004 [R] |
| [202607280001_add_employee_lifecycle_and_payroll_schedule.sql](../../supabase/migrations/202607280001_add_employee_lifecycle_and_payroll_schedule.sql) | 누락 (D) | table:8, column:9, constraint:4, index:1, data:2, privilege:8, function:4; RLS | 202607280002 [L], 20260728182601 [R], 202608060001 [R], 202607310001 [L], 202608010001 [L], 20260911102823 [R], 202607300001 [L], 202608070004 [R] |
| [202607280002_add_payroll_eligibility_override.sql](../../supabase/migrations/202607280002_add_payroll_eligibility_override.sql) | 누락 (D) | table:1, column:1 | 20260728182601 [R], 202608060001 [R] |
| [20260728182601_create_employee_level_foundation.sql](../../supabase/migrations/20260728182601_create_employee_level_foundation.sql) | 등록 (본문 미검증) | table:6, column:18, constraint:5, index:3, privilege:4; RLS | 202608060001 [R], 202607300001 [L], 202608010003 [R], 20260804152308 [R], 20260729160628 [R], 202608040001 [L] |
| [20260728184011_add_employee_level_policy_rpcs.sql](../../supabase/migrations/20260728184011_add_employee_level_policy_rpcs.sql) | 등록 (본문 미검증) | function:2, privilege:4 | 202608070007 [R] |
| [20260729114539_simplify_employee_level_profile_save.sql](../../supabase/migrations/20260729114539_simplify_employee_level_profile_save.sql) | 등록 (본문 미검증) | function:1, privilege:2 | 202608070007 [R] |
| [20260729160628_add_manual_owner_levels_and_zero_based_audit.sql](../../supabase/migrations/20260729160628_add_manual_owner_levels_and_zero_based_audit.sql) | 등록 (본문 미검증) | table:2, constraint:4, data:1, function:1, privilege:2 | 202608040001 [L], 20260729162803 [R], 20260729163753 [R], 202608070007 [R] |
| [20260729162803_fix_employee_profile_v3_text_work_times.sql](../../supabase/migrations/20260729162803_fix_employee_profile_v3_text_work_times.sql) | 등록 (본문 미검증) | function:1, privilege:2 | 20260729163753 [R], 202608070007 [R] |
| [20260729163753_remove_password_from_employee_profile_v3.sql](../../supabase/migrations/20260729163753_remove_password_from_employee_profile_v3.sql) | 등록 (본문 미검증) | function:1, privilege:2 | 202608070007 [R] |
| [202607300001_add_payroll_compensation_and_adjustment_ledger.sql](../../supabase/migrations/202607300001_add_payroll_compensation_and_adjustment_ledger.sql) | 누락 (D) | table:4, column:21, constraint:4, index:2, privilege:8, function:2; RLS | 202608010003 [R], 20260804152308 [R], 202607310001 [L], 202608010001 [L], 202608070004 [R], 20260908110641 [R], 20260928122112 [R], 202608070003 [L] (dynamic patch candidate) |
| [202607310001_add_payroll_insurance_v5.sql](../../supabase/migrations/202607310001_add_payroll_insurance_v5.sql) | 누락 (D) | table:11, column:25, constraint:9, index:3, privilege:6, data:1, function:8; RLS | 202608010001 [L], 20260911102823 [R], 202608070004 [R] |
| [202608010001_add_payroll_work_policy_penalties_v6.sql](../../supabase/migrations/202608010001_add_payroll_work_policy_penalties_v6.sql) | 누락 (D) | table:6, column:5, constraint:8, index:2, function:7, privilege:2 | 20260911102823 [R], 202608070004 [R] |
| [202608010002_unify_employee_work_schedule_source.sql](../../supabase/migrations/202608010002_unify_employee_work_schedule_source.sql) | 등록 (본문 미검증) | table:2, constraint:2, function:2, privilege:4 | 202608070007 [R] |
| [202608010003_add_fixed_monthly_payroll_basis.sql](../../supabase/migrations/202608010003_add_fixed_monthly_payroll_basis.sql) | 등록 (본문 미검증) | table:2, constraint:2, function:1, privilege:2 | 20260804152308 [R], 202608020002 [L] (dynamic patch candidate) |
| [202608020001_correct_latest_unused_payroll_contract.sql](../../supabase/migrations/202608020001_correct_latest_unused_payroll_contract.sql) | 누락 (D) | table:2, constraint:2, function:1, privilege:2 | 202608020002 [L] (dynamic patch candidate), 202608070003 [L] (dynamic patch candidate) |
| [202608020002_add_unified_payroll_engine_v7.sql](../../supabase/migrations/202608020002_add_unified_payroll_engine_v7.sql) | 누락 (D) | function:2, privilege:4 | — |
| [202608030001_add_employee_level_program_versions.sql](../../supabase/migrations/202608030001_add_employee_level_program_versions.sql) | 누락 (D) | table:2, column:11, index:2, privilege:9, data:2, function:3; RLS | 202608040001 [L], 202608070007 [R] |
| [202608040001_restore_employee_level_base_date_modes.sql](../../supabase/migrations/202608040001_restore_employee_level_base_date_modes.sql) | 누락 (D) | table:4, column:3, constraint:4, data:2, function:5, privilege:6 | 202608070007 [R], 202608070006 [R] |
| [20260804152308_remove_legacy_payroll_day_basis.sql](../../supabase/migrations/20260804152308_remove_legacy_payroll_day_basis.sql) | 등록 (본문 미검증) | data:2, table:2, constraint:2 | — |
| [202608050001_add_employee_payment_batches.sql](../../supabase/migrations/202608050001_add_employee_payment_batches.sql) | 등록 (본문 미검증) | table:6, column:50, index:2, privilege:9, function:3, trigger:1; RLS | 20260908115312 [R], 20260916090759 [R] |
| [202608060001_add_employee_attendance_and_login_flags.sql](../../supabase/migrations/202608060001_add_employee_attendance_and_login_flags.sql) | 등록 (본문 미검증) | table:3, column:2, constraint:2, function:6, privilege:11, trigger:1 | 20260806175537 [R], 202608070007 [R], 202608070006 [R] |
| [202608060002_enforce_inventory_part_values.sql](../../supabase/migrations/202608060002_enforce_inventory_part_values.sql) | 등록 (본문 미검증) | table:3, column:1, constraint:2 | 202608220002 [R] |
| [202608060003_payroll_owner_by_role.sql](../../supabase/migrations/202608060003_payroll_owner_by_role.sql) | 등록 (본문 미검증) | function:2, privilege:4 | — |
| [20260806175537_fix_initial_work_schedule_effective_from_hire_date.sql](../../supabase/migrations/20260806175537_fix_initial_work_schedule_effective_from_hire_date.sql) | 등록 (본문 미검증) | function:1 | 202608070007 [R] |
| [202608070001_add_payroll_meal_allowance.sql](../../supabase/migrations/202608070001_add_payroll_meal_allowance.sql) | 누락 (D) | table:4, column:15, index:3, privilege:15, function:4, trigger:2; RLS | — |
| [202608070002_payroll_fixed_monthly_by_attendance_tracking.sql](../../supabase/migrations/202608070002_payroll_fixed_monthly_by_attendance_tracking.sql) | 누락 (D) | function:2, privilege:4 | 202608070003 [L], 202608070003 [L] (dynamic patch candidate) |
| [202608070003_fix_fixed_monthly_contract_delegate.sql](../../supabase/migrations/202608070003_fix_fixed_monthly_contract_delegate.sql) | 누락 (D) | function:3, privilege:6 | 20260909231222 [R] |
| [202608070004_remove_legacy_payroll_run_engine.sql](../../supabase/migrations/202608070004_remove_legacy_payroll_run_engine.sql) | 등록 (본문 미검증) | function:21, table:5 | — |
| [202608070005_remove_default_normal_checkout_time.sql](../../supabase/migrations/202608070005_remove_default_normal_checkout_time.sql) | 등록 (본문 미검증) | function:3, privilege:4, table:1, column:1 | — |
| [202608070006_flatten_employee_management_rpcs.sql](../../supabase/migrations/202608070006_flatten_employee_management_rpcs.sql) | 등록 (본문 미검증) | function:3 | — |
| [202608070007_remove_legacy_employee_management_rpcs.sql](../../supabase/migrations/202608070007_remove_legacy_employee_management_rpcs.sql) | 등록 (본문 미검증) | function:13 | — |
| [202608080001_flatten_bar_keeping_rpcs.sql](../../supabase/migrations/202608080001_flatten_bar_keeping_rpcs.sql) | 등록 (본문 미검증) | function:2 | — |
| [202608080002_remove_legacy_bar_keeping_mutation_rpcs.sql](../../supabase/migrations/202608080002_remove_legacy_bar_keeping_mutation_rpcs.sql) | 등록 (본문 미검증) | function:4 | — |
| [202608080003_add_store_holiday_calendar.sql](../../supabase/migrations/202608080003_add_store_holiday_calendar.sql) | 등록 (본문 미검증) | table:4, column:24, privilege:10, index:1, function:1, data:2; RLS | — |
| [202608080004_add_store_holiday_operation_policy.sql](../../supabase/migrations/202608080004_add_store_holiday_operation_policy.sql) | 등록 (본문 미검증) | table:2, column:5, privilege:8, function:1; RLS | — |
| [202608090001_add_store_prepare_holiday_calendar_rpc.sql](../../supabase/migrations/202608090001_add_store_prepare_holiday_calendar_rpc.sql) | 등록 (본문 미검증) | function:1, privilege:4 | — |
| [20260811093311_add_payroll_attendance_bonus.sql](../../supabase/migrations/20260811093311_add_payroll_attendance_bonus.sql) | 등록 (본문 미검증) | table:4, column:18, index:4, privilege:13, function:3, trigger:1; RLS | — |
| [20260811103600_integrate_attendance_bonus_common_settings.sql](../../supabase/migrations/20260811103600_integrate_attendance_bonus_common_settings.sql) | 누락 (D) | function:1, privilege:2 | — |
| [20260812162019_add_unauthorized_absence_attendance.sql](../../supabase/migrations/20260812162019_add_unauthorized_absence_attendance.sql) | 등록 (본문 미검증) | table:3, constraint:3, function:1, privilege:4 | 20260813183928 [R] |
| [20260813180226_add_safe_approved_leave_cancellation.sql](../../supabase/migrations/20260813180226_add_safe_approved_leave_cancellation.sql) | 등록 (본문 미검증) | function:1, privilege:2 | — |
| [20260813183928_make_unauthorized_absence_reason_optional.sql](../../supabase/migrations/20260813183928_make_unauthorized_absence_reason_optional.sql) | 등록 (본문 미검증) | function:1, privilege:2 | — |
| [202608140001_add_inventory_latest_stock_checks_rpc.sql](../../supabase/migrations/202608140001_add_inventory_latest_stock_checks_rpc.sql) | 등록 (본문 미검증) | function:1, privilege:2 | — |
| [202608210001_create_ledger_v1_foundation.sql](../../supabase/migrations/202608210001_create_ledger_v1_foundation.sql) | 등록 (본문 미검증) | table:12, column:60, index:18, data:2, privilege:7, function:1; RLS | 202608210009 [R], 202608210004 [R], 202608210002 [R], 202608210003 [R], 202608210005 [R], 202608210006 [R], 202608210007 [R], 202608210008 [R], 20260929063551 [R] |
| [202608210002_add_ledger_pos_sales_sync.sql](../../supabase/migrations/202608210002_add_ledger_pos_sales_sync.sql) | 등록 (본문 미검증) | table:7, constraint:5, column:9, index:3, privilege:5, data:2, function:1; RLS | 202608210003 [R], 202608210004 [R], 202608210005 [R], 202608210006 [R], 202608210007 [R], 202608210008 [R], 202608210009 [R], 20260929063551 [R] |
| [202608210003_add_inventory_purchase_candidates.sql](../../supabase/migrations/202608210003_add_inventory_purchase_candidates.sql) | 등록 (본문 미검증) | table:16, constraint:4, column:43, index:12, privilege:7, function:2; RLS | 202608210004 [R], 202608210005 [R], 202608210006 [R], 202608210007 [R], 202608210008 [R], 202608210009 [R], 20260929063551 [R], 20260824152518 [R], 202608250002 [R], 20260903155046 [R] |
| [202608210004_add_ledger_payable_payments.sql](../../supabase/migrations/202608210004_add_ledger_payable_payments.sql) | 등록 (본문 미검증) | table:3, constraint:2, column:1, index:1, function:3, privilege:6 | 202608210005 [R], 202608210006 [R], 202608210007 [R], 202608210008 [R], 202608210009 [R], 20260929063551 [R] |
| [202608210005_add_ledger_meal_payroll_sync.sql](../../supabase/migrations/202608210005_add_ledger_meal_payroll_sync.sql) | 등록 (본문 미검증) | table:10, constraint:9, column:3, data:1, function:3, privilege:6 | 202608210008 [R], 202608210006 [R], 202608210007 [R], 202608210009 [R], 20260929063551 [R] |
| [202608210006_add_ledger_card_settlements.sql](../../supabase/migrations/202608210006_add_ledger_card_settlements.sql) | 등록 (본문 미검증) | table:6, constraint:2, data:1, column:18, index:5, privilege:7, function:2; RLS | 202608210007 [R], 202608210008 [R], 202608210009 [R], 20260929063551 [R], 20260915095952 [R], 20260927144325 [R], 20260915103312 [R], 20260927173019 [R] |
| [202608210007_add_recurring_reserves_bep.sql](../../supabase/migrations/202608210007_add_recurring_reserves_bep.sql) | 등록 (본문 미검증) | table:10, constraint:2, data:3, column:40, index:10, privilege:5, function:6; RLS | 202608210008 [R], 202608210009 [R], 20260929063551 [R], 202608270001 [R], 202608280001 [R], 20260916080015 [R], 20260916172211 [R] |
| [202608210008_add_ledger_month_close_corrections.sql](../../supabase/migrations/202608210008_add_ledger_month_close_corrections.sql) | 등록 (본문 미검증) | table:14, column:11, index:3, privilege:6, constraint:11, function:17, trigger:8; RLS | 20260916161512 [R], 202608210009 [R], 20260929063551 [R], 20261001193526 [R], 20260906114438 [R], 20260915095952 [R], 20260916080015 [R], 20261002062405 [R], 20260916172211 [R], 20261003090000 [R] |
| [202608210009_add_owner_settlements.sql](../../supabase/migrations/202608210009_add_owner_settlements.sql) | 등록 (본문 미검증) | table:17, column:68, data:1, constraint:2, index:12, privilege:6, function:10, trigger:1; RLS | 20260929063551 [R], 20260927122430 [R], 20260916150709 [R], 20260916171636 [R], 20260916161512 [R] |
| [202608220001_create_business_partner_master.sql](../../supabase/migrations/202608220001_create_business_partner_master.sql) | 등록 (본문 미검증) | table:6, column:22, index:6, privilege:7, function:2; RLS | 202608230001 [R], 202608230003 [R], 202608240001 [R], 202608240002 [R], 20261001172556 [R] |
| [202608220002_add_inventory_supplier_candidates.sql](../../supabase/migrations/202608220002_add_inventory_supplier_candidates.sql) | 등록 (본문 미검증) | table:5, column:19, index:6, data:1, privilege:7, function:4; RLS | 202608230002 [R], 202608220003 [R] |
| [202608220003_fix_supplier_alias_ignore_behavior.sql](../../supabase/migrations/202608220003_fix_supplier_alias_ignore_behavior.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [202608230001_add_business_partner_settlement_policy.sql](../../supabase/migrations/202608230001_add_business_partner_settlement_policy.sql) | 등록 (본문 미검증) | table:3, column:2, constraint:2, function:6, privilege:6 | 202608230003 [R], 202608240001 [R], 202608240002 [R], 20261001172556 [R] |
| [202608230002_add_supplier_alias_candidate_archive.sql](../../supabase/migrations/202608230002_add_supplier_alias_candidate_archive.sql) | 등록 (본문 미검증) | table:6, constraint:6, function:4, privilege:4 | — |
| [202608230003_add_business_partner_default_fund_account.sql](../../supabase/migrations/202608230003_add_business_partner_default_fund_account.sql) | 등록 (본문 미검증) | table:1, column:1, index:1, function:8, privilege:8 | 202608240001 [R], 202608240002 [R], 20261001172556 [R], 202608230004 [R] |
| [202608230004_fix_business_partner_fund_account_eligibility.sql](../../supabase/migrations/202608230004_fix_business_partner_fund_account_eligibility.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [202608240001_add_business_partner_display_tag.sql](../../supabase/migrations/202608240001_add_business_partner_display_tag.sql) | 등록 (본문 미검증) | table:2, column:1, constraint:1, function:2, privilege:2 | 202608240002 [R], 20261001172556 [R] |
| [202608240002_add_business_partner_subtypes.sql](../../supabase/migrations/202608240002_add_business_partner_subtypes.sql) | 등록 (본문 미검증) | table:3, column:10, index:3, privilege:15, data:1, function:12; RLS | 20260928225900 [R], 20261001172556 [R], 20260824152518 [R] |
| [202608240003_add_business_partner_subtype_delete.sql](../../supabase/migrations/202608240003_add_business_partner_subtype_delete.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [202608240004_update_food_partner_subtypes.sql](../../supabase/migrations/202608240004_update_food_partner_subtypes.sql) | 등록 (본문 미검증) | data:2 | — |
| [20260824152518_auto_link_business_partners_to_ledger.sql](../../supabase/migrations/20260824152518_auto_link_business_partners_to_ledger.sql) | 등록 (본문 미검증) | data:5, function:6, privilege:9, trigger:4 | 20261001172556 [R], 202608250002 [R], 20260903155046 [R] |
| [20260824152948_ledger_category_v1.sql](../../supabase/migrations/20260824152948_ledger_category_v1.sql) | 등록 (본문 미검증) | data:14 | — |
| [20260824153108_seed_august_2026_opening_balances.sql](../../supabase/migrations/20260824153108_seed_august_2026_opening_balances.sql) | 등록 (본문 미검증) | data:3 | — |
| [20260824174814_add_manual_ledger_expense_categories.sql](../../supabase/migrations/20260824174814_add_manual_ledger_expense_categories.sql) | 등록 (본문 미검증) | data:1 | — |
| [202608250002_auto_post_inventory_purchases.sql](../../supabase/migrations/202608250002_auto_post_inventory_purchases.sql) | 등록 (본문 미검증) | function:2, privilege:2 | 20260903155046 [R] |
| [202608250003_rebook_inventory_transaction.sql](../../supabase/migrations/202608250003_rebook_inventory_transaction.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [20260826113239_adjust_open_meal_transactions.sql](../../supabase/migrations/20260826113239_adjust_open_meal_transactions.sql) | 등록 (본문 미검증) | function:2, privilege:2 | 20260917092710 [L], 20261001131334 [R] |
| [20260826123527_shorten_employee_meal_memos.sql](../../supabase/migrations/20260826123527_shorten_employee_meal_memos.sql) | 등록 (본문 미검증) | data:1 | — |
| [202608270001_link_reserve_plans_to_fund_accounts.sql](../../supabase/migrations/202608270001_link_reserve_plans_to_fund_accounts.sql) | 등록 (본문 미검증) | table:2, column:1, constraint:1, index:1, function:4, trigger:1, privilege:7 | 202608280001 [R] |
| [202608280001_add_reserve_recurring_allocation.sql](../../supabase/migrations/202608280001_add_reserve_recurring_allocation.sql) | 등록 (본문 미검증) | table:4, column:18, constraint:2, index:4, privilege:11, function:4; RLS | — |
| [202609030001_reconcile_sales_receipt_payments.sql](../../supabase/migrations/202609030001_reconcile_sales_receipt_payments.sql) | 등록 (본문 미검증) | function:2, privilege:5 | — |
| [20260903154302_allow_inventory_metadata_drift.sql](../../supabase/migrations/20260903154302_allow_inventory_metadata_drift.sql) | 등록 (본문 미검증) | function:4, privilege:4 | 20260906114438 [R] |
| [20260903155046_route_inventory_sync_through_metadata_guard.sql](../../supabase/migrations/20260903155046_route_inventory_sync_through_metadata_guard.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [20260906114438_project_inventory_purchase_logs.sql](../../supabase/migrations/20260906114438_project_inventory_purchase_logs.sql) | 등록 (본문 미검증) | schema:1, privilege:12, function:17, table:3, column:8, index:4; RLS | 20260914161954 [R], 20261009080243 [L], 202609250001 [R] |
| [20260908110641_add_payroll_advance_adjustment.sql](../../supabase/migrations/20260908110641_add_payroll_advance_adjustment.sql) | 등록 (본문 미검증) | table:1, constraint:5 | 20260928122112 [R] |
| [20260908115312_add_payroll_tax_versions.sql](../../supabase/migrations/20260908115312_add_payroll_tax_versions.sql) | 등록 (본문 미검증) | function:16, table:5, column:25, index:3, privilege:17, trigger:2; RLS | — |
| [20260909064418_add_part_time_extra_work_decisions.sql](../../supabase/migrations/20260909064418_add_part_time_extra_work_decisions.sql) | 등록 (본문 미검증) | table:2, column:25, index:2; RLS | 20260912070744 [R] |
| [20260909064505_tighten_part_time_extra_work_privileges.sql](../../supabase/migrations/20260909064505_tighten_part_time_extra_work_privileges.sql) | 등록 (본문 미검증) | privilege:4 | — |
| [20260909064732_add_part_time_extra_work_decision_rpcs.sql](../../supabase/migrations/20260909064732_add_part_time_extra_work_decision_rpcs.sql) | 등록 (본문 미검증) | function:4, privilege:4 | 20260912075601 [R] |
| [20260909231222_fix_contract_correction_payment_snapshot.sql](../../supabase/migrations/20260909231222_fix_contract_correction_payment_snapshot.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [20260911102823_add_director_insurance_tax_mapping.sql](../../supabase/migrations/20260911102823_add_director_insurance_tax_mapping.sql) | 등록 (본문 미검증) | table:4, column:2, data:1, constraint:3 | — |
| [20260912070744_fix_extra_work_after_schedule_compatibility.sql](../../supabase/migrations/20260912070744_fix_extra_work_after_schedule_compatibility.sql) | 등록 (본문 미검증) | table:2, constraint:2 | — |
| [20260912075601_fix_extra_work_decision_rpc_after_schedule.sql](../../supabase/migrations/20260912075601_fix_extra_work_decision_rpc_after_schedule.sql) | 등록 (본문 미검증) | function:3, privilege:2 | — |
| [20260912105916_add_pos_business_day_closures.sql](../../supabase/migrations/20260912105916_add_pos_business_day_closures.sql) | 등록 (본문 미검증) | table:5, column:14, index:2, privilege:8, schema:2, function:16, trigger:4; RLS | 20260927173019 [R] |
| [20260912160056_add_pos_business_day_close_checks.sql](../../supabase/migrations/20260912160056_add_pos_business_day_close_checks.sql) | 등록 (본문 미검증) | table:6, column:23, index:4, privilege:7, trigger:2, function:10; RLS | — |
| [20260914161954_link_inventory_purchase_corrections.sql](../../supabase/migrations/20260914161954_link_inventory_purchase_corrections.sql) | 등록 (본문 미검증) | table:2, column:1, constraint:1, index:1, function:5, privilege:5, trigger:1, data:3 | 20261009080243 [L] |
| [20260915095952_add_card_reconciliation_cancellation.sql](../../supabase/migrations/20260915095952_add_card_reconciliation_cancellation.sql) | 등록 (본문 미검증) | table:2, column:3, index:1, constraint:3, function:8, privilege:8 | 20260927144325 [R], 20260915103312 [R], 20260927173019 [R], 20260916080015 [R], 20261002062405 [R] |
| [20260915103312_prevent_future_card_sale_matching.sql](../../supabase/migrations/20260915103312_prevent_future_card_sale_matching.sql) | 등록 (본문 미검증) | function:2, privilege:2 | 20260927144325 [R], 20260927173019 [R] |
| [20260916080015_preserve_cancelled_recurring_expenses.sql](../../supabase/migrations/20260916080015_preserve_cancelled_recurring_expenses.sql) | 등록 (본문 미검증) | function:2, privilege:4 | 20260916172211 [R], 20261002062405 [R] |
| [20260916090759_auto_group_payroll_payments.sql](../../supabase/migrations/20260916090759_auto_group_payroll_payments.sql) | 등록 (본문 미검증) | table:1, column:1, index:1, function:6, privilege:6 | 20260916091129 [R], 20260916094057 [R], 20260916094323 [R] |
| [20260916091129_auto_sync_payroll_company_cost_on_completion.sql](../../supabase/migrations/20260916091129_auto_sync_payroll_company_cost_on_completion.sql) | 등록 (본문 미검증) | function:4, privilege:4 | 20260916094057 [R], 20260916094323 [R] |
| [20260916094057_payroll_payment_group_ledger_sync.sql](../../supabase/migrations/20260916094057_payroll_payment_group_ledger_sync.sql) | 등록 (본문 미검증) | function:4, privilege:8 | 20260916094323 [R] |
| [20260916094323_restore_safe_payroll_group_projection.sql](../../supabase/migrations/20260916094323_restore_safe_payroll_group_projection.sql) | 등록 (본문 미검증) | function:6, privilege:4 | — |
| [20260916150709_separate_owner_capital_recovery.sql](../../supabase/migrations/20260916150709_separate_owner_capital_recovery.sql) | 등록 (본문 미검증) | table:3, column:3, constraint:3, index:1, function:12, privilege:2 | 20260916161512 [R], 20260916171636 [R] |
| [20260916161512_add_ledger_month_reopen.sql](../../supabase/migrations/20260916161512_add_ledger_month_reopen.sql) | 등록 (본문 미검증) | table:7, constraint:3, column:17, sequence:1, privilege:9, function:6; RLS | — |
| [20260916171636_fix_owner_investment_source_metadata.sql](../../supabase/migrations/20260916171636_fix_owner_investment_source_metadata.sql) | 등록 (본문 미검증) | function:1 | — |
| [20260916172211_ignore_inactive_recurring_expense_plans.sql](../../supabase/migrations/20260916172211_ignore_inactive_recurring_expense_plans.sql) | 등록 (본문 미검증) | function:2 | — |
| [20260916172305_deactivate_misclassified_rent_recurring_plan.sql](../../supabase/migrations/20260916172305_deactivate_misclassified_rent_recurring_plan.sql) | 등록 (본문 미검증) | data:2 | — |
| [20260917092710_count_all_linked_meal_corrections.sql](../../supabase/migrations/20260917092710_count_all_linked_meal_corrections.sql) | 누락 (D) | function:2, privilege:2 | 20261001131334 [R] |
| [20260918091342_backfill_legacy_sheet_payment_notes.sql](../../supabase/migrations/20260918091342_backfill_legacy_sheet_payment_notes.sql) | 등록 (본문 미검증) | data:1 | — |
| [20260921170100_add_inventory_payment_verification.sql](../../supabase/migrations/20260921170100_add_inventory_payment_verification.sql) | 등록 (본문 미검증) |  | — |
| [20260922130901_add_pos_sales_receipt_lines_business_date_id_index.sql](../../supabase/migrations/20260922130901_add_pos_sales_receipt_lines_business_date_id_index.sql) | 등록 (본문 미검증) | index:1 | — |
| [202609250001_allow_same_party_inventory_supplier_metadata_enrichment.sql](../../supabase/migrations/202609250001_allow_same_party_inventory_supplier_metadata_enrichment.sql) | 등록 (본문 미검증) | function:1, privilege:2 | — |
| [20260927122430_add_owner_investment_cash_event.sql](../../supabase/migrations/20260927122430_add_owner_investment_cash_event.sql) | 등록 (본문 미검증) | table:2, constraint:2, function:2, privilege:2 | — |
| [20260927144325_add_card_deposit_auto_allocation.sql](../../supabase/migrations/20260927144325_add_card_deposit_auto_allocation.sql) | 등록 (본문 미검증) | table:2, constraint:4, function:6, privilege:6 | 20260927173019 [R], 20261001193526 [R] |
| [20260927173019_add_card_fee_month_closures.sql](../../supabase/migrations/20260927173019_add_card_fee_month_closures.sql) | 등록 (본문 미검증) | table:4, column:18, index:6, privilege:11, function:15, trigger:3; RLS | 20261001193526 [R] |
| [20260928122112_allow_payroll_sales_menu_incentive_source.sql](../../supabase/migrations/20260928122112_allow_payroll_sales_menu_incentive_source.sql) | 등록 (본문 미검증) | table:2, constraint:2 | — |
| [20260928210713_add_sales_receipt_split_payment.sql](../../supabase/migrations/20260928210713_add_sales_receipt_split_payment.sql) | 누락 (D) | function:2, privilege:2 | — |
| [20260928225900_add_partner_subtype_emoji.sql](../../supabase/migrations/20260928225900_add_partner_subtype_emoji.sql) | 등록 (본문 미검증) | table:1, column:1, function:6, privilege:4, data:4 | — |
| [20260929063551_edit_manual_ledger_display.sql](../../supabase/migrations/20260929063551_edit_manual_ledger_display.sql) | 등록 (본문 미검증) | table:1, column:1, function:1, privilege:2 | 20260929180508 [R] |
| [20260929073431_normalize_september_card_deposits.sql](../../supabase/migrations/20260929073431_normalize_september_card_deposits.sql) | 등록 (본문 미검증) | data:7 | — |
| [20260929090000_add_ledger_payroll_advance_payment.sql](../../supabase/migrations/20260929090000_add_ledger_payroll_advance_payment.sql) | 등록 (본문 미검증) | function:2, privilege:4 | — |
| [20260929115054_correct_september_6_ledger_identity.sql](../../supabase/migrations/20260929115054_correct_september_6_ledger_identity.sql) | 등록 (본문 미검증) | data:4 | — |
| [20260929125839_split_welfare_and_correct_historical_ledger_display.sql](../../supabase/migrations/20260929125839_split_welfare_and_correct_historical_ledger_display.sql) | 등록 (본문 미검증) | data:11 | — |
| [20260929180508_allow_manual_payable_display_edit.sql](../../supabase/migrations/20260929180508_allow_manual_payable_display_edit.sql) | 등록 (본문 미검증) | function:1, privilege:2 | — |
| [20260930063332_edit_manual_transaction_amount.sql](../../supabase/migrations/20260930063332_edit_manual_transaction_amount.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [20261001061230_add_early_leave_admin_selection.sql](../../supabase/migrations/20261001061230_add_early_leave_admin_selection.sql) | 누락 (D) | table:3, column:2, constraint:2, function:6, trigger:3, privilege:9 | — |
| [20261001131334_review_meal_source_drift_without_financial_changes.sql](../../supabase/migrations/20261001131334_review_meal_source_drift_without_financial_changes.sql) | 등록 (본문 미검증) | function:2, privilege:2 | — |
| [20261001143016_add_ad_hoc_ledger_payable_party.sql](../../supabase/migrations/20261001143016_add_ad_hoc_ledger_payable_party.sql) | 등록 (본문 미검증) | data:1 | — |
| [20261001153558_rollback_ad_hoc_payable_to_7c14dbc_baseline.sql](../../supabase/migrations/20261001153558_rollback_ad_hoc_payable_to_7c14dbc_baseline.sql) | 등록 (본문 미검증) | data:4 | — |
| [20261001160005_add_khac_as_regular_business_partner.sql](../../supabase/migrations/20261001160005_add_khac_as_regular_business_partner.sql) | 등록 (본문 미검증) | data:4 | — |
| [20261001172556_support_unspecified_partner_payment_mode.sql](../../supabase/migrations/20261001172556_support_unspecified_partner_payment_mode.sql) | 등록 (본문 미검증) | table:4, constraint:4, function:4, privilege:4, data:1 | — |
| [20261001193526_auto_finalize_closed_month_card_fees.sql](../../supabase/migrations/20261001193526_auto_finalize_closed_month_card_fees.sql) | 등록 (본문 미검증) | table:5, column:19, schema:1, privilege:6, function:10; RLS | — |
| [20261002062405_fix_preflight_inactive_recurring_plans.sql](../../supabase/migrations/20261002062405_fix_preflight_inactive_recurring_plans.sql) | 등록 (본문 미검증) | function:1 | — |
| [20261003090000_close_ledger_before_payroll_payment.sql](../../supabase/migrations/20261003090000_close_ledger_before_payroll_payment.sql) | 등록 (본문 미검증) | function:3, privilege:3 | — |
| [20261007182027_resolve_inventory_purchase_projection.sql](../../supabase/migrations/20261007182027_resolve_inventory_purchase_projection.sql) | 등록 (본문 미검증) | function:6, privilege:5 | 20261009080243 [L] |
| [20261009080243_detect_inventory_purchase_economic_corrections.sql](../../supabase/migrations/20261009080243_detect_inventory_purchase_economic_corrections.sql) | 누락 (D) | function:14, privilege:11 | — |
| [20261009161017_add_inventory_logs_created_at_id_read_index.sql](../../supabase/migrations/20261009161017_add_inventory_logs_created_at_id_read_index.sql) | 누락 (D) | index:1 | — |

## 카탈로그 조회가 가능해졌을 때의 검증

인증된 읽기 전용 권한으로 대상 이름을 제한하여 다음 자료를 확보한다. 테이블 데이터 전체 scan 또는 EXPLAIN ANALYZE로 운영 부하를 만들지 않는다.

- `supabase_migrations.schema_migrations`: version/name 및 접근 가능한 statements. 원격-only 및 이름 불일치 SQL 원본이 없으면 동등성 판정 보류.
- pg_class/pg_namespace/pg_attribute/pg_attrdef: 객체 종류, 컬럼 타입·NULL·default·생성/identity, 소유자와 RLS flags.
- pg_proc: pg_get_function_identity_arguments, pg_get_functiondef, proowner, proacl, prosecdef, proconfig. PUBLIC/anon/authenticated/service_role의 직접 ACL, 역할 상속, schema USAGE 및 실제 실행 권한을 각각 비교.
- pg_index/pg_am/pg_get_indexdef: 키·predicate·include·sort/null·opclass·valid/ready/live 및 기존 중복 인덱스. pg_constraint/pg_get_constraintdef: CHECK/FK/unique/PK, 검증 상태 및 delete/update 동작.
- pg_trigger/pg_get_triggerdef 및 pg_policy: 내부 트리거 여부, tgenabled, 이벤트·시점·연결 함수·WHEN/UPDATE 열, policy command/roles/USING/WITH CHECK. pg_depend는 후속 제거·재연결의 근거 보조.
- 데이터 보정: 당시 실행 로그/감사 또는 제한된 대상별 전후 snapshot이 필요. 함수 본문에만 포함된 DML은 실행 가능한 로직일 뿐 역사적 보정 증거가 아니다.

## 안전한 복구 순서 및 제외 목록

1. 현재는 복구하지 않는다. 인증된 읽기 전용 조회가 가능해진 뒤 우선 3개 버전부터 전체 정의·ACL·의존성을 대조한다. 인덱스 버전은 한 객체라 비교 범위가 작지만 현재 정의 검증을 생략하지 않는다.
2. 181개 SQL의 SHA 및 원격 statements/실행 기록을 기준으로 원본→후속 최종 정의를 비교한다. 원격-only 3건과 이름 불일치 2건을 먼저 대응시켜 중복 이력 등록을 방지한다.
3. 부분 대체·DO patch·backfill이 있는 버전은 실행 증거를 별도로 확보한다. B만으로 원본 버전을 applied 등록하지 않는다. 검증된 A만 이후 별도 승인·대상 목록 보고를 거쳐 이력 복구 후보가 된다.
4. 이후 승인된 이력 복구만 수행하더라도 SQL 재실행/인덱스 재생성/db push/db reset을 섞지 않는다. 이 단계에서 그러한 명령은 실행하지 않았다. 복구 후 이력 목록과 객체 정의/권한 불변 및 운영 데이터 변경 없음 증거를 확인한다.

**복구 제외:** 현재 D70 전체 (위 판정표가 완전한 버전 목록), 원격-only 3건의 로컬 임의 별칭 등록/기존 이력 삭제, 이름 불일치 2건의 임의 재등록, B 관계만 있는 원본, 실행 증거 없는 seed/backfill 및 부분 적용 의심 버전. 기존 Migration 파일과 회계·급여·마감·Milan Food 데이터는 모두 보존한다.

## 검증 결과와 한계

마지막 list_migrations 재조회에서도 114개 버전·이름이 조사 시작 시점과 완전히 동일함을 확인했다. 최종 읽기 결과는 `.tmp/migration-classification-remote-final.json`에 보존했다.

로컬 목록과 70건 판정표의 완전성, 버전 유일성, 181개 원본 SHA 불변, 3개 원격-only 및 2개 이름 불일치를 자동 검증했다. 문서/임시 분석 파일만 작성했으며 소스 테스트·ESLint·build는 이번 읽기 전용 감사의 검증 수단이 아니므로 재실행하지 않았다. 운영 SQL 조회/CLI 목록 검증은 인증·승인 제약으로 완료하지 못했다.

정적 추출은 PostgreSQL AST 파서가 아니다. quoted/dynamic identifier, DO 안 문자열, 인라인 제약, CREATE TABLE AS, 복잡한 default/overload, 권한문의 대상 분해는 수동 검증이 필요하다. 후속 후보가 없다는 결과도 후속 변경 부재를 증명하지 않는다. 본 보고서의 모든 적용 판정은 이 한계를 반영하며 A/B/C를 추측으로 부여하지 않았다.
