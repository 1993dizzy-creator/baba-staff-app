# 직원 레벨 2026-10 소급 정정 — 실행 준비 기록

운영 미실행. 정식 실행 파일은 `supabase/migrations/20261110091705_employee_level_october_2026_correction.sql`이다. Supabase CLI 3.1.0의 `migration new employee_level_october_2026_correction`으로 생성했다. Owner의 운영 적용 승인은 별도이며, 정식 파일은 외부 파일 참조·수동 치환·actor 세션 설정 없이 단독 실행한다.

## 정식 Migration과 변경 범위

- `supabase/migrations/20261110091705_employee_level_october_2026_correction.sql`: 최종 실행 파일. BEGIN/COMMIT 안에 모든 검증과 정정·사후 검증을 포함한다.
- 아래 `docs/sql` 파일은 최초 초안과 별도 읽기 전용 검사 자료로 보존한다. 정식 운영 적용의 제출물은 위 Migration이다.

- `sql/employee-level-october-correction-preflight.sql`: 읽기 전용 사전 검사 및 버전/사용자 미러 출력.
- `sql/employee-level-october-correction-execute-draft.sql`: 단일 트랜잭션 실행 초안.
- `sql/employee-level-october-correction-postflight.sql`: 읽기 전용 사후 검사 및 정정 감사 스냅샷 출력.

직원 2,3,4,5,6,7,8,10,14,18,19의 기존 버전 effective_to 및 이미 등록된 신규 버전 effective_from을 각각 2026-12-01에서 2026-10-01로 바꾼다. 새 기준월과 버전 ID는 Owner 표에 고정했다. 6번 직원의 신규 기준월은 **2026-02**다. 사용자 미러는 신규 정책으로 맞추고, 자동 기준은 override를 NULL로 둔다. hire_date는 변경하지 않는다.

정정 이유 코드는 `employee_level_october_correction_20261110_v1`이다. 기존 감사 로그는 수정하지 않고 직원별 11건을 추가한다. 각 감사 행은 이전/이후의 두 버전 전체와 사용자 레벨·재직 미러 스냅샷, 실제 승인된 actor, 시각을 담는다. 사용자 비밀번호 등 계정 비밀 값은 감사 스냅샷에 담지 않는다.

## 운영 실행 전 필수 조건

1. Owner가 이 11명의 운영 소급 정정을 별도로 승인해야 한다. 정식 Migration은 지문으로 고정된 신규 월 정책 11개의 공통 생성자 ID를 조회하고, 모두 같은 ID/username인지 및 해당 계정이 활성 owner/master·비시스템 계정인지 검증한다. 외부 actor 설정이나 파일 수정은 하지 않는다. 감사 actor의 출처는 `pinned_month_policy_cohort_creator`이며, Migration 실행의 `current_user`·`session_user`도 감사 스냅샷에 따로 보존한다. 원래 생성자와 실제 DB 실행자를 혼동하지 않는다.
2. 사전 SQL과 실제 실행 파일을 각각 **동일 파일 전체를 한 연결에서** 실행한다. SQL 실행기는 오류 즉시 중단해야 한다. 오류가 나면 해당 연결에서 ROLLBACK 후 원인을 확인한다. 일부 문장만 실행하거나 실패 후 COMMIT하지 않는다.
3. 기존 22개 정책 버전 전체 행 지문, 현재 재직·레벨 미러 지문이 준비 시점과 같아야 한다. 버전 ID/직원 ID/기간/기준월/모드/ON/급여 반영/revision, 종료·시스템·비활성 여부와 추가 정책 충돌도 검사한다. 현재 원본 자료는 `.local/level-october-readonly-source.json`에만 보관했다.
4. 대상 직원의 **모든** 지급 행이 22건이고, 그중 paid 22건이며 아래 식의 지문이 `6a3013ee9ab4288f07fcb3d361d889bc`여야 한다. paid 행으로 먼저 필터링하지 않는다. 2026-11-10 읽기 전용 조회 원본에서도 이 세 조건이 일치했다.

```sql
MD5(COALESCE(STRING_AGG(MD5(TO_JSONB(p)::text), ',' ORDER BY p.id), ''))
-- FROM payroll_employee_payments p
-- WHERE p.user_id IN (2,3,4,5,6,7,8,10,14,18,19)
```

5. 직전 상태와 다르면 재실행하지 말고 재점검한다. 지문 상수를 운영 최신 값으로 임의 교체하지 않는다. RLS로 일부 행이 가려지지 않는 승인된 실행 권한이 필요하다. UTC에서 전체 행 지문을 계산한다.

## 원자성과 보호

SERIALIZABLE 트랜잭션, 고정 작업 advisory lock, 사용자/버전/감사 테이블 쓰기 배제 잠금 및 지급 테이블 SHARE 잠금을 사용한다. 잠금 대기는 5초, 문장 실행 제한은 60초다. 동시 변경·잠금·직렬화 충돌은 실패로 취급한다.

이전 버전 11건, 신규 버전 11건, 사용자 미러 11건의 변경 수를 확인한다. 지급 지문을 쓰기 전후 모두 검사한다. 기존 감사 행의 전체 지문, 버전의 허용 날짜 외 필드, 사용자의 레벨 미러 외 필드도 같은 트랜잭션에서 확인한다. 기존 트리거가 다른 사용자 필드까지 바꾸면 이 검사로 중단되므로 승인 없이 검사를 완화하지 않는다.

급여·근태·계약·지급·장부 원본에는 DML을 하지 않는다. 지급 스냅샷/해시/금액은 그대로 두고, 이 SQL에서 급여 재계산이나 소급 지급은 하지 않는다. 이미 정정된 상태·정정 감사 코드 존재·부분 정정 상태는 거부한다. 실패한 감사 INSERT가 시퀀스 번호를 소비할 수 있지만 행은 전체 롤백된다.

## 검증과 한계

- PGlite 격리 DB: 정상 정정/감사 전후 이미지/지급 불변/재실행 차단, 지급 지문·건수·상태 불일치, 버전·미러·부분 적용·추가 정책 충돌, actor 오류, 감사 INSERT 실패 전체 롤백 **10/10 PASS**.
- 별도 Supabase PostgreSQL 17.6 컨테이너: 정상 정정, 재실행, 지문·건수·버전·미러·부분 상태·actor 오류 및 감사 실패 롤백 **8/8 PASS**. 운영 연결이나 운영 자격 증명 없이 합성 fixture로 실행했다.
- 합성 fixture 테스트는 기대 지문만 fixture 지문으로 치환한다. 배포할 SQL 파일의 운영 지문은 고정되어 있다. 실제 읽기 전용 버전 원본 22개도 PostgreSQL 타입 기반 전체 행 지문을 재현했다.
- 실제 운영 SQL 실행·운영 잠금/트리거·급여 재계산은 미검증이다. 운영 승인 후 사전 검사 → 전체 실행 → 사후 검증 순서를 지킨다. 별도 Migration·Push·배포는 하지 않는다.

## 정식 Migration 최종 파일 검증

- 파일: `C:\workspace\baba-staff-app\supabase\migrations\20261110091705_employee_level_october_2026_correction.sql`
- SHA-256: `5098fdd430d9045f0f6efd38d8aa496d3bbe34fa932b3bf74ab81ec7623e7e6c`
- 별도 PostgreSQL 17.6 컨테이너에서 최종 파일을 **바이트 그대로, 지문 치환 0건**으로 실행해 **11/11 PASS**를 확인했다. 앞선 합성 fixture PASS는 변경 없는 보호 계약의 증거로 재사용했다.
- 과거 읽기 전용으로 확보한 정책/재직 미러·지급 JSON을 격리 fixture에 재구성했다. Migration에 고정한 원본 지문을 그대로 만족하도록 타입 기반으로 적재했고 운영 연결이나 운영 자격 증명은 사용하지 않았다. 지급 행은 전체 JSONB 이미지와 동일한 지문을 재현했으며 운영 지급 테이블의 모든 타입·트리거를 복제한 것은 아니다.
- 확인 범위: 외부 actor 설정 없는 단독 실행, 임의 actor 세션 설정 무시, 같은 파일 재실행 차단, actor 역할/username/활성 상태 거부, 지급/버전 불일치 거부, 기존 버전 갱신 후·두 버전 갱신 후·감사 추가 중·COMMIT 직전 사후 검증 실패의 전체 롤백. 지급 22건 전체 행, 근태 및 계약/장부 fixture 행 불변을 대조했다.
- 최종 파일은 모든 사후 검증을 COMMIT 전에 실행한다. 이전 초안의 외부 actor 설정 요구를 제거하고 감사에 실행 맥락을 추가했으며 날짜/미러 사후 비교를 NULL-safe로 보강했다.
- 실제 운영 트리거/잠금/CLI 적용 이력 기록은 미검증이다. 운영 DB 실행·Push·배포·기존 Migration 이력 변경은 하지 않았다. 로컬 테스트 컨테이너는 종료한다.
