# [보존·사용 종료] Keg I/O P0 외부 적용 패키지 README

> **상태: 사용 종료 (역사 자료).** 이 문서의 스크립트·SQL을 다시 실행하거나 운영 DB에 적용하지 않는다.
> 정식 반영본: 커밋 `46c1d63c`(코드·테스트·Migration), `cce485ac`(Migration 주석 정정),
> 정식 Migration `supabase/migrations/20261112091707_keg_receipt_item_lookup.sql`.

- 원본 출처: `C:\workspace\BABA_keg_IO_optimization_P0_20261112\README_BABA_KEG_IO_KO.md`
- 원본 SHA-256: `a0e687dfb602798cd5456e849913a54509e22ba5294a1b59fac6c337140eac9e` (4,286 bytes, 수정 2026-11-12 08:04 +07)
- 보존 작업: BABA-WORKSPACE-CLEANUP-01 (2026-11-17)
- 보존 이유: 패키지의 코드·SQL은 Git 정식본으로 대체됐으나, 이 README의 적용 당시 관찰치(영수증 행 수, 느린 쿼리 통계, Log Query 사용량·Disk I/O 원인 미확정 주의)는 Git에 다른 형태로 남아 있지 않다.
- 함께 있던 `baba_keg_io_prepare.py`, `baba_keg_io_index.sql`은 Git 정식본으로 대체·초과되어 복사하지 않았다.
  - `baba_keg_io_index.sql` SHA-256 `074c6bd8ac6150030579f84148e831c0cc1b7760dff428e82d9f0d375ca74119` — 정식 Migration과 인덱스 DDL 동일, 정식본은 `set local` + `statement_timeout` 추가.
  - `baba_keg_io_prepare.py` SHA-256 `5c7eb579d118cad6acbfa993df56991c2ee4f1a940890bf08018bcc9600ac1af` — 대상 기준 blob이 `46c1d63c^`와 일치, 생성 결과는 `46c1d63c`에서 Node로 이식·확장 반영(조기 return 제거, 동작 회귀 테스트 추가).

---

아래는 원본 README 전문이다(수정 없음).

---

# BABA Supabase Disk I/O / Keg progress P0 — 적용 패키지

작성 기준: 2026-11-12, GitHub `1993dizzy-creator/baba-staff-app` `main` (원격 HEAD `4e359d0c4...`).

## 상태

- 운영 Supabase: **읽기 전용 조회만 수행.** SQL 실행/DDL/데이터 정정 없음.
- GitHub/로컬 소스: **아직 변경하지 않음.** 사용자 PC `C:\workspace\baba-staff-app`에 직접 접근할 수 없어 로컬 커밋이 수행되지 않았음.
- 이 ZIP: **로컬에서 실행할 안전한 변경 준비 도구**와 적용 대상 SQL 내용, 검증 기록.
- CLI가 실제 수정 시 마이그레이션 파일 이름을 생성함. 임의 날짜로 정식 Migration 경로를 만들어두지 않음.

## 실제 관찰

- `public.pos_sales_receipt_lines`: 약 32,153행. `item_code` 인덱스는 있지만 `item_id` 인덱스 없음.
- 느린 영수증 상세 조회 중 한 쿼리 계열: 평균 약 1.51초, 누적 10,506회(`pg_stat_statements` 장기 누적 통계).
- 반복 전체 영수증·날짜 OR 조회 발생 코드: `lib/inventory/keg-progress.ts`.
- 활성 Keg 7개, 연결된 POS 상품 10개. 기준일이 매우 오래된 활성 Keg가 있어 조회 범위가 길어짐.
- 운영 DB 영수증–판매상품 연결 무결성: orphan 0, 영업일 불일치 0, 영업일 NULL 0.
- 실제 후보 집합 비교(읽기 전용): 기존 587개, 새 방식 612개, **기존 후보 누락 0개**. 추가 25개는 기존 Keg 계산기의 시간·상태 규칙으로 걸러짐. **계산 결과 전체 E2E 일치까지 주장하지 않음.**

## 제안 변경

1. 케그 판매량 계산은 `payment_status=3`인 **매핑된 POS 상품 행부터 날짜로 좁혀 페이지 단위 조회**.
2. 그 행에 연결된 **영수증 ID만 최대 500개씩 읽음**. 전체 유료 영수증 조회와 별도의 timestamp OR 조회 제거.
3. **계산 함수는 그대로 유지**하므로 수량·상태·취소·제외·시간 fallback 로직은 변경하지 않음.
4. 누락된 `item_id` 인덱스를 `payment_status=3` 조건부 인덱스로 **정식 Migration을 CLI로 생성**하여 준비만 함.
5. 기존 해당 부분 정적 회귀 테스트 두 개를 새 쿼리 형태에 맞춰 교체함.

## 로컬 Windows에서 실행 (Codex/Claude에게 전달 가능)

패키지를 압축 해제하고 다음 순서로 실행:

```powershell
cd C:\workspace\baba-staff-app
python "<압축해제한 폴더>\baba_keg_io_prepare.py"
```

1차는 **읽기 전용 사전점검**이며, 코드나 DB를 변경하지 않음. `CHECK PASS`가 확인되고 Supabase CLI가 사용 가능할 때만 다음 명령:

```powershell
python "<압축해제한 폴더>\baba_keg_io_prepare.py" --apply
```

위 명령은 **로컬 `main`의 대상 코드·테스트를 수정**하고, `supabase migration new keg_receipt_item_lookup`으로 정식 Migration 파일을 만든 뒤 그 SQL을 작성함. **커밋, Push, 배포, 운영 SQL 실행은 하지 않음**.

`BLOB SHA` 또는 기존 변경 상태가 다르면 중단하므로 무리하게 재시도하지 말고 최신 코드와의 diff를 검토할 것.

## 필수 검증과 완료 기준

```powershell
node --experimental-strip-types --test tests/inventory-keg-progress-query-performance.test.ts
npx eslint lib/inventory/keg-progress.ts tests/inventory-keg-progress-query-performance.test.ts
npx tsc --noEmit --incremental false
git diff --check
git status --short
```

- `tsc`가 기존 오류로 실패한다면 수정 전후 오류 목록을 비교해 **신규 오류 0**임을 증명할 것.
- SQL 적용 전 `CREATE INDEX` 시간/잠금, 중복 인덱스, 운영 정책 호환성 확인.
- 로컬 `main` 커밋은 적용 주체가 테스트·diff를 확인한 뒤 수행.
- 운영 SQL과 Deployment는 **서로 별도의 오너 승인** 필요.
- 이후 `Server-Timing`에서 `receipt_lines`, `receipts`, `total`과 운영 DB 장기 누적치가 아닌 동일 시간 구간 측정치를 비교.

## 문제 범위 주의

`Log Query` 135.2GB / 100GB는 조직 합계와 별도 사용량 항목이므로 위 Keg 조회 성능 수정만으로 자동 해소되지 않음. Supabase Disk I/O 경고 또한 장기 누적 `temp_bytes`나 Postgres 쿼리 통계만으로 원인 확정 불가. 단계별 운영 성능 측정 후 추가 조치할 것.
