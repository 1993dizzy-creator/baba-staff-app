# 직원관리 5차 급여 지급 배치 안전성 보완 — 2026-11-14

판정: **READY — 이번 변경 범위의 로컬 구현·격리 검증 완료.** 운영 Migration, Push, 배포는 별도 Owner 승인 전 실행하지 않는다. 기준 HEAD는 `db54b5c6c12def739ed8b06684dda95e8e49206e`, 작업 위치는 원본 로컬 `main`이다. 운영 DB·운영 자격 증명을 사용하지 않았다. 테이블 현황 Production HOLD는 변경하지 않았다.

1. **API 검증 경로**

   `POST /api/admin/payroll/payments`는 배치 유무와 관계없이 현재 overview를 다시 계산한다. 선택 직원의 유효 계약 수와 계약 스냅샷, 계산 상태, blocking 사유, 세금 상태/경고, 안전한 정수 지급액을 확인한다. 지급 스냅샷을 기존 함수로 만들고 최신 해시를 클라이언트 해시와 대조한다. 기존 배치는 최초 명단 포함 여부·이미 지급 여부·완료 여부도 검사한다. 실패 시 RPC를 호출하지 않는다.

   `isPayable`/`failureCodes`는 실제 검증 결과로 구성한다. 최초 요청은 문제 직원을 포함한 전체 대상 명단을 전달하고 선택 직원만 거절한다. 이후 요청은 저장된 최초 명단을 그대로 사용한다. 현재 계산 목록에서 사라진 다른 직원도 `MISSING_SNAPSHOT`인 미지급 대상으로 남긴다. 새 직원이 나중에 나타나도 최초 명단에 추가하지 않는다. 다른 직원의 오류는 정상 직원의 지급을 막지 않는다.

2. **DB 지급 함수**

   실제 호출 체인 `payroll_pay_employee_v3 → v2 → v1`을 유지한다. v1에서 전체 대상의 지급 가능 여부를 일괄 거절하던 조건을 선택 직원 검사로 바꿨다. 배열 형식, 양의 정수 직원 ID, 중복 ID, 누락된 선택 직원, 필수 필드 형식, null/음수 금액을 검증한다. 시작된 배치의 명단과 전달 명단은 정확히 일치해야 한다.

   첫 지급 시 전체 명단을 생성하며, 실패하면 생성까지 롤백된다. 직원·배치 유일 제약, 중복 지급 차단, 지급 잠금, 스냅샷·해시·감사, v2 세금 합계, v3 전표 투영과 마지막 직원 지급 시 비용 인식은 유지한다. 최초 대상 전체가 지급되기 전에는 `completed`가 되지 않는다. 기존 배치 명단이나 지급 자료를 Migration에서 재작성하지 않는다.

3. **정식 Migration**

   - 버전: `20261114132205`
   - 전체 경로: `C:\workspace\baba-staff-app\supabase\migrations\20261114132205_payroll_selected_employee_payment_safety.sql`
   - Supabase CLI `migration new payroll_selected_employee_payment_safety`로 생성한 정식 파일이다.
   - 함수 변경만 포함한다. 테이블·운영 데이터·금액·기존 해시 변경이나 backfill은 없다.
   - 새 내부 함수 `payroll_lock_months_v1(date[])`의 직접 실행 권한은 public/anon/authenticated/service_role 모두 회수한다. 기존 함수의 SECURITY DEFINER, search_path 및 ACL 보존을 검사했다.
   - 기존 함수 본문의 교체 지점이 정확히 한 번 존재해야 적용한다. 정의가 예상과 다르거나 재실행하면 실패하며 전체 트랜잭션이 롤백된다. 임의의 다른 함수 본문을 덮어쓰지 않는다.
   - 기존 `20261114124930`은 수정하지 않았다. SHA-256: `B397FF6C287CCF6AB997784E59CBB26557B5DE53A1E61722691AEBA66881049B`.

4. **회계 마감 경쟁 조건과 잠금 순서**

   공통 순서는 관련 월의 `82118, YYYYMM` 잠금을 오름차순으로 모두 획득 → 관련 월의 `ledger_month_close:YYYY-MM` 잠금을 오름차순으로 모두 획득 → 기존 전역/개별 직원/행 잠금이다. 정책 등록·계약 연결·입사일 정정, 지급 v3·취소 v3, 최종 마감·재개방 함수가 공통 월 잠금에 참여한다. 취소는 사전 조회한 지급 장부월을 잠근 뒤 실제 잠금 조회 결과와 다시 대조한다.

   최종 마감/재마감 정의는 `20260916161512_add_ledger_month_reopen.sql` 기준이다. 이 함수와 재개방 함수의 기존 `ledger_month_close_serial`, 기존 두 정수 월 잠금, revision·history·이전 월 재개방 보호는 그대로 두고 공통 잠금을 앞에 추가한다. 초기 fixture가 이전 마감 정의를 사용한 문제를 발견해 최종 정의로 교체했으며, 아래 최종 PGlite·네이티브 결과는 교체 후 재검증 결과다.

   급여 대상월과 실제 지급일 장부월을 따로 잠근다. 잠금 획득은 월 마감 자체가 아니다. 정상 활성 정책은 급여 대상월이 마감돼도 기존대로 지급할 수 있다. 실제 지급일의 장부월이 마감됐으면 현금 전표 처리는 기존 규칙으로 거절한다. 정책이 먼저 완료되면 마감은 그 커밋 이후 진행한다. 마감이 먼저 완료되면 정책은 마감 상태를 확인해 변경을 거절한다.

5. **정상 직원 우선 지급·보존 증거**

   PGlite에서 10명 중 active 9명/pending 1명으로 검증했다. pending 첫 요청은 거절되고 배치도 남지 않는다. 정상 직원 첫 지급 후 명단 10명, `paying` 상태가 유지된다. 정상 9명 지급 후에도 완료되지 않는다. 마감 전에 pending을 해결한 뒤 급여월을 마감하고 마지막 직원을 지급하면 같은 배치가 완료된다.

   격리 예시: 8월 16일 입사, 원액 8,000,000₫, 재직 16/31일 → 1인 기본 지급액 4,129,032₫. 10명 현금 순변동은 −41,290,320₫이다. 첫 직원 지급 행 전체(스냅샷·해시 포함)가 후속 지급 후에도 동일함을 비교했다. `employee_paid` 10개, `batch_completed` 1개, 최종 비용 인식 1개를 확인했다. 중간 현금 전표 역분개·재생성, 취소 감사의 원래 해시, 취소 후 현금 순합계 0, 재지급을 검증했다. 증거 불일치·비용 동기화 실패·마감된 지급 장부월에서 지급 행/스냅샷/감사/현금이 함께 롤백된다.

   계산 엔진, 계약 원액·공제 단가, 지급 스냅샷/해시 생성 함수, 레벨·복리후생, 기존 지급/취소 이력과 월말 비용 인식 함수는 수정하지 않았다.

6. **최종 테스트 결과**

   | 검사 | 결과 |
   | --- | --- |
   | API 실행 테스트: 최초/기존 배치, 계약·계산·blocking·세금·금액·해시·대상 검증 | 23/23 PASS |
   | 최종 정식 Migration + PGlite: 지급·롤백·이력·권한·정의 불일치·재개방/재마감 | 7/7 PASS |
   | 네이티브 PostgreSQL 17.12 Windows 동시성 | 9개 시나리오 PASS, Node 집계 10/10(상위 테스트 포함) |
   | 관련 직원관리·계약·레벨·복리후생·계산·해시·전표 회귀 | 466건 중 462 PASS / 기존 4 FAIL |
   | TypeScript `tsc --noEmit --incremental false --pretty false` | PASS |
   | 변경 TS/MJS 파일 ESLint | PASS, 오류·경고 0 |
   | 기준 커밋 전체 `npm run build` | PASS, 종료 코드 0 |
   | 변경본 전체 `npm run build` | PASS, 종료 코드 0 |
   | 실제 생성 UI, KO/VI × 320·390·430·1280px | 8개 조합 PASS; 저장·새로고침·응답 유실·pending 복구 포함 |
   | `git diff --check` | PASS |

   회귀 466건 실행 후 최종 마감 fixture·Migration이 변경된 부분은 최종 DB 7건과 네이티브 테스트로 재검증했다. 앱 TS 코드는 Build 이후 변경하지 않았다. 검사 합계는 중복 범위가 있어 단순 합산하지 않는다.

   기존 실패 4건은 동일 기준 커밋 `db54b5c6`의 원본 테스트를 동일 조건으로 실행해 모두 동일하게 재현했다(33건 중 29 PASS / 4 FAIL). 실패를 PASS로 처리하거나 무관한 UI를 수정하지 않았다.

   - `payroll-employee-payment-policy.test.ts`: bilingual payment flow의 이전 UI 문자열 기대.
   - `payroll-overview-policy.test.ts`: salary 그룹 스타일 기대, resolved insurance 섹션 기대 2건.
   - `payroll-tax-integration.test.ts`: 이전 taxBurdenMode UI 문자열 기대.

7. **실제 PostgreSQL 동시성 검증 범위**

   운영과 분리한 PostgreSQL **17.12, x86_64 Windows** 서버에서 별도 세션/트랜잭션으로 실행했다. `pg_stat_activity`/`pg_blocking_pids`로 실제 잠금 대기를 관찰했고, DB deadlock 수 0을 확인했다. 데이터 디렉터리는 테스트 전용 identity 검사 후 정상 종료·삭제했다. 운영 연결 정보는 사용하지 않았다.

   시나리오: 동일 직원 동시 지급 1회만 성공; 서로 다른 직원 동시 첫 지급의 최초 명단·합계 보존; 마지막 지급/취소의 양방향 경합; 정책 연결/마감의 양방향 경합; 마감 이후 늦은 정책 등록 롤백; 실제 입사일·정책 정정과 지급 경합 시 오래된 증거 거절; 실제 미사용 계약 정정과 지급 경합 시 오래된 증거 거절.

   PGlite를 동시성 PASS 근거로 사용하지 않았다. 두 DB fixture 모두 실제 지급 v3/v2/v1, 최종 close/reclose/reopen, 정책 RPC/트리거, 전표·비용 인식 본문과 정식 Migration을 실행한다. 무관한 카드 수수료 권한 함수와 마감 사전 점검 데이터만 로컬 stub이다. 전체 운영 DB 복제나 실제 Supabase 배포 환경 검증을 수행한 것은 아니다.

8. **남은 항목과 마감 후 pending 복구**

   이번 요청 범위에서 확인된 필수 미해결 결함은 없다. 기존 정적 UI 검사 실패 4건은 남아 있다. 운영 적용 후 실제 PostgREST 권한·스키마 캐시 및 운영 역할 구성 확인은 미수행이다. 부하 테스트는 수행하지 않았다.

   마감 후 pending을 자동 복구하는 새 경로는 만들지 않았다. 해당 직원은 미지급으로 남고 다른 정상 직원은 지급 가능하지만, 최초 명단 전체 지급 전에는 배치 완료·최종 비용 인식이 지연된다. 해당 급여월의 기존 예상 비용 표시 정책은 유지한다.

   복구는 별도 Owner 승인 아래 기존 owner/master `ledger_reopen_month_v1` 절차를 사용할 수 있는지 먼저 검토한다. 허용되면 사유·마감 history를 남겨 재개방 → 미사용/입사일/최초 계약·원액 검토 → 기존 연결 RPC로 pending 해결 → 최신 사전 점검·스냅샷으로 재마감 → 같은 배치에서 미지급 직원만 지급한다. PGlite에서 기존 snapshot_hash history 보존과 revision 1→2, 재마감 후 지급을 확인했다. 지급·취소 사용 이력 잠금은 완화하지 않는다.

   더 늦은 월이 마감돼 있으면 기존 재개방 RPC가 `later_month_closed`로 거절한다. 이때 자동 순회나 직접 상태 수정으로 우회하지 않는다. 최신 월부터의 재개방 및 과거 월부터의 재마감을 포함한 회계 영향·승인 범위를 별도 검토해야 한다. 명단 제외, 전액 지급 우회, 마감 기록 삭제, 이미 사용한 정책 정정은 복구 방법으로 사용하지 않는다.

9. **검증·작업 증거 경로**

   모든 임시 산출물은 `C:\workspace\baba-staff-app\.local\` 아래에 있다. 주요 로그: `payroll-batch-api.log`, `payroll-batch-db.log`, `payroll-batch-native.log`, `payroll-batch-regression.log`, `payroll-batch-regression-files.txt`, `payroll-batch-baseline-failures.log`, `payroll-batch-types.log`, `payroll-batch-eslint.log`, `payroll-batch-eslint-final.log`, `payroll-batch-baseline-build.log`, `payroll-batch-candidate-build.log`, `payroll-batch-ui.log`.

   전체 Build는 `.env*`를 제외한 기준/변경본의 격리 소스 복사본에서 각각 `npm ci` 후 실행했다. 자식 프로세스 환경은 허용 목록만 전달했고, Supabase에는 연결 불가능한 로컬 URL·격리용 가짜 키를 사용했다. 네이티브 동시성 재현은 `.local`에서 `QA_POSTGRES_BIN`을 격리 실행파일 디렉터리로 지정하고 `node --test ../tests/payroll-batch-safety-postgres.test.mjs`로 실행한다.

10. **변경 파일 전체 Windows 경로와 Git 보호**

    - `C:\workspace\baba-staff-app\app\api\admin\payroll\payments\route.ts`
    - `C:\workspace\baba-staff-app\lib\payroll\payment-preflight.ts`
    - `C:\workspace\baba-staff-app\supabase\migrations\20261114132205_payroll_selected_employee_payment_safety.sql`
    - `C:\workspace\baba-staff-app\tests\helpers\payroll-batch-safety-fixture.mjs`
    - `C:\workspace\baba-staff-app\tests\payroll-batch-safety-api.test.mjs`
    - `C:\workspace\baba-staff-app\tests\payroll-batch-safety-db.test.mjs`
    - `C:\workspace\baba-staff-app\tests\payroll-batch-safety-postgres.test.mjs`
    - `C:\workspace\baba-staff-app\tests\payroll-employee-payment-policy.test.ts`
    - `C:\workspace\baba-staff-app\docs\payroll-batch-safety-20261114.md`

    시작 시 main은 지정 HEAD이고 작업 트리는 clean이었다. 이번 파일만 로컬 커밋 대상으로 하며, 다른 Worktree·기존 이력·기존 Migration은 변경하지 않는다. 최종 로컬 커밋 SHA와 작업 트리 상태는 커밋 후 완료 보고에 기록한다.

11. **운영 적용 권장 순서 — 이번에는 실행하지 않음**

    Owner의 운영 DB 적용 승인 후, 기존 `20261114124930` 적용 여부와 대상 최종 함수 정의·ACL을 읽기 확인하고 정식 순서로 신규 Migration `20261114132205`를 적용한다. 예상과 다른 정의이면 Migration 전체가 거절되므로 현장에서 원래 정의를 임의로 덮어써서 통과시키지 않는다. 적용 후 기존 건수·스냅샷/해시 불변, 함수 권한, PostgREST 호출 가능 여부를 확인한다. 이후 별도로 승인받은 범위에서 Push·코드 배포·실제 화면 확인을 진행한다.

    구 API와 신 DB 조합의 첫 지급은 기존의 전체 사전 검사로 차단된다. 구 API가 남아 있는 동안 기존 배치의 API 검증 누락까지 해결된 것으로 간주하지 않는다. 신 API를 신 DB보다 먼저 배포하면 구 DB가 문제 직원을 포함한 첫 지급을 거절하므로 DB를 먼저 적용하고 API까지 배포해야 보완이 완료된다. 신규 일할 정책 활성화는 기존 기능 플래그 운영을 유지하며 Migration·API·권한 준비 확인 후 진행한다. 기존 정책의 조회·지급 검증을 무효화하거나 기존 직원을 일괄 등록하지 않는다.
