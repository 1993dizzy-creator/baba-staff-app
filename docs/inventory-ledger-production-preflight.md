# Production Preflight — PASS WITH MANUAL SMOKE TEST REQUIRED

최종 판정일: 2026-09-08 (Asia/Bangkok)

운영 migration, 운영 DML, Vercel 배포, commit/push는 수행하지 않았다. 제품 코드, SQL 구조, lock 및 기존 migration 파일도 변경하지 않았다.

## 판정

구현·격리 DB/API/unit/concurrency 검증에서 확인된 기술적 차단 사유는 모두 해소됐다. 외부에서 완료한 최신 운영 대조 결과를 이번 판정의 근거로 반영했다. 남은 미검증은 실제 인증 브라우저 업무 흐름뿐이며, 이는 코드 결함이 아니라 안전한 비운영 인증/DB 환경이 없는 실행 환경 제약이다.

따라서 현재 판정은 다음과 같다.

```text
Production Preflight: PASS WITH MANUAL SMOKE TEST REQUIRED
```

실제 인증 브라우저 핵심 흐름을 통과하기 전에는 `PASS`로 올리지 않는다. 새로운 코드 문제나 정합성 문제가 발견되면 `BLOCKED`로 되돌린다.

## 해소된 기존 차단 사유

사용자가 2026-09-08 외부에서 확인한 결과:

- GitHub 원격 `main`: `3c0b896e684cae82c207eb6a68d2a54ec5c33688`
- 현재 local HEAD와 원격 `main` 일치
- 운영 migration history에 `20260906114438_project_inventory_purchase_logs` 미적용 확인
- 기존 Inventory Ledger 관련 migration history 정상
- 기존 핵심 Ledger RPC의 signature, `owner=postgres`, `SECURITY DEFINER`, `search_path=pg_catalog, public` 정상
- 기존 핵심 Ledger RPC의 EXECUTE 권한은 `postgres`, `service_role`에만 있고 `PUBLIC`, `anon`, `authenticated`에는 없음
- 신규 Inventory purchase projection/lock helper 계열과 충돌하는 운영 함수 없음

후속 lock 수정과 격리 동시성 재검증 결과는 [inventory-ledger-deadlock-fix.md](inventory-ledger-deadlock-fix.md)에 있다. 최초 preflight의 교착 재현 및 해소 전 기록은 Git 이력에서 확인한다.

## 이번 브라우저 검증 시도와 환경 제약

- 프로젝트에 Playwright 설정, E2E 스크립트, 저장된 browser auth state가 없다.
- 같은 작업 디렉터리의 Next.js 16.2.1 개발 서버가 `http://localhost:3000`에서 실행 중임을 확인했다.
- `agent-browser` 0.37.0을 준비했지만 로컬 Chrome 실행 시 CDP response channel이 두 번 종료되어 페이지 자동화가 시작되지 않았다.
- 현재 `.env.local`은 운영 Supabase를 가리킨다. 따라서 신규 입고, 추가 구매, 동기화, 로그 정정은 모두 운영 DML이 되므로 실행하지 않았다.
- Docker Desktop daemon이 실행 중이지 않고 `supabase/config.toml`도 없다. 저장소 migration은 기존 운영 schema를 전제로 하며 `users`, `inventory`, `inventory_logs`의 기반 CREATE migration을 포함하지 않아, 저장소만으로 동일한 로컬 Supabase/Auth 환경을 안전하게 재구성할 수 없다.
- 운영 계정 비밀번호 변경, 임시 backdoor, 인증 우회 코드, 운영 데이터 DML은 사용하지 않았다. API mock 테스트도 실제 인증 브라우저 검증으로 간주하지 않았다.

환경상 미검증인 항목은 신규 구매 등록, `existing_stock`, 기존 품목 quick-save, 일간재고 표시정보 동기화, 과거 단가/거래처 보호, 명시적 단가/거래처 수정, projection `review_required`/`failed` 표시의 실제 인증 브라우저 흐름이다.

## 운영 적용 직후 최소 수동 smoke test

아래 절차는 migration과 호환 애플리케이션이 별도 승인 절차로 운영에 적용된 직후, 승인된 직원 계정과 실제 업무 건 또는 사전에 승인된 smoke-test 품목으로 수행한다. 각 단계에서 브라우저 Network 응답의 `ok`, `data`/`mode`, `ledgerSync`와 UI 알림을 함께 기록한다. 인위적인 실패 주입이나 운영 데이터 직접 수정은 하지 않는다.

### 1. 신규 구매 등록

1. 직원 권한 계정으로 로그인한다.
2. `재고 → 신규 입고`에서 등록 유형 `new_purchase`를 선택해 1건 저장한다.
3. Inventory가 저장되고 별도 `inventory_log`가 생성되는지 확인한다.
4. 응답의 `ledgerSync.status`가 `synced` 또는 정상 정책에 따른 `pending`인지 확인한다.
5. UI가 저장 성공으로 끝나며 직원에게 일반 Ledger 관리 권한 오류가 노출되지 않는지 확인한다.

### 2. existing_stock

1. 등록 유형 `existing_stock`으로 1건 저장한다.
2. Inventory와 재고 로그가 정상 생성되고 UI 오류가 없는지 확인한다.
3. 응답에 구매 projection 결과가 없고 구매 Ledger 지출/candidate/transaction이 생성되지 않는지 확인한다.

### 3. 기존 품목 추가 구매와 멱등성

1. 기존 품목에서 구매 사유로 quick-save를 한 번 실행하고 응답의 신규 inventory log ID를 기록한다.
2. 이전 구매 로그와 합쳐지지 않고 별도 로그가 생성되는지 확인한다.
3. 새 log ID를 source로 하는 Ledger projection만 처리되는지 확인한다.
4. 같은 source 요청이 재전송된 경우에도 해당 log ID의 활성 구매 Ledger 거래가 중복 생성되지 않는지 확인한다. 브라우저에서 임의의 동시 요청을 만들지 말고, 실제 재시도 발생 시 또는 승인된 운영 점검 도구로만 확인한다.

### 4. 표시정보 동기화와 경제정보 불변

1. 구매 로그가 있는 품목의 품목명, 베트남어명, 재고 카테고리 등 표시정보를 변경한다.
2. 해당 일간재고에서 `동기화`를 실행한다.
3. 일간재고와 Ledger 구매내역에 최신 표시정보가 노출되는지 확인한다.
4. 동기화 전후 구매금액, movement, payable, 회계 category가 변하지 않았는지 확인한다.

### 5. 과거 구매정보 보호

1. 서로 다른 단가/거래처를 가진 두 번의 실제 구매가 있는 품목을 사용한다.
2. 과거 일간재고에서 `동기화`를 실행한다.
3. 과거 로그의 단가와 거래처가 현재 Inventory master 또는 최신 구매 값으로 덮어써지지 않았는지 확인한다.

### 6. 명시적 단가/거래처 수정

1. UI가 제공하는 구매 로그 수정 경로에서 단가 또는 거래처를 명시적으로 수정한 뒤 동기화한다.
2. pending 건은 기존 source의 candidate가 최신 값으로 갱신되고 거래가 새로 생기지 않는지 확인한다.
3. confirmed 건은 원거래의 경제정보가 silent UPDATE되지 않고 reversal과 replacement가 한 쌍으로 생성되는지 확인한다.
4. 지급 완료, 일부 지급, 마감 월의 보호 정책도 기존 상태를 침범하지 않는지 확인한다.

### 7. 실패 표시

자연스럽게 `review_required` 또는 `failed`가 반환되는 승인된 격리/운영 사례가 있을 때만 확인한다. Inventory 저장 성공은 유지되어야 하며 UI/API는 다음을 분리해 표시해야 한다.

```text
재고 정보는 저장되었습니다.
장부: 관리자 확인 필요
```

또는

```text
재고 정보는 저장되었습니다.
장부: 동기화 실패 · 관리자 재동기화 가능
```

직원에게 Ledger 관리 화면 권한이나 일반 Ledger 관리 권한을 부여해 이 항목을 시험하지 않는다.

## 수동 smoke 완료 판정

1~6이 모두 통과하고, 7은 안전하게 재현 가능한 경우 기대한 분리 표시까지 확인하면 다음으로 변경한다.

```text
Production Preflight: PASS
```

7을 안전하게 만들 수 없으면 실패 주입 없이 미재현 사유와 실제 응답 관측 계획을 기록한다. 1~6에서 저장 실패, 중복 거래, 과거 경제정보 덮어쓰기, silent economic UPDATE, 직원 권한 오류가 하나라도 발견되면 `BLOCKED`로 변경한다.

## 적용 후보와 postflight

별도 운영 승인 후 적용할 migration은 정확히 다음 1개다.

1. `supabase/migrations/20260906114438_project_inventory_purchase_logs.sql` 전체를 단일 transaction으로 적용한다.
2. [inventory-ledger-production-preflight.sql](inventory-ledger-production-preflight.sql)의 read-only postflight로 migration history, 함수 정의/인자/owner/security/search_path/ACL, 테이블·인덱스·RLS, 데이터 행 수와 예상하지 않은 변경, 감사 로그를 확인한다.
3. Supabase Security/Performance Advisor를 확인한 뒤 호환 애플리케이션 배포를 별도 승인 절차로 진행한다.
4. 위 실제 인증 수동 smoke test를 수행한다.

이미 적용된 `202608250002`, `202608250003`, `20260903154302`, `20260903155046`는 재적용하지 않는다. SQL Editor 수동 실행만으로 원격 migration history가 등록된 것으로 간주하지 않는다.
