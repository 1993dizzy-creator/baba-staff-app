# Entries `base_reads` 간헐 장기 지연 — 최소 진단 계측 설계 — 2026-10-22

설계·보고서 단계다. 제품 코드, DB·Migration, 연결 풀 설정, Git, 배포는 변경하지 않았다. 이번 단계에서 운영 재측정은 하지 않았고, 아래 수치는 모두 기존 기록에서 인용했다.

- 운영 측정: `.tmp/entries-production-ffd8098-20261022/`(results.json, run.log)
- 로컬 읽기 전용 계측: `.tmp/entries-base-reads-20261022/`(route/idle-gap/page/cap/probe ndjson, harness.cjs)

## 1. 3초 이상 지연 표본 정리

### 1.1 운영(배포 ffd8098, 66개 표본 중 표시 3초 초과 4건)

정확한 시각과 요청 ID는 기록되지 않았다. 측정 스크립트가 표본별 절대시각, `x-vercel-id`, Supabase `sb-request-id`를 저장하지 않았기 때문이다.

- 측정 구간은 measure.cjs 수정시각(19:39:03 +07)과 results.json 기록시각(19:41:26 +07) 사이로 좁혀진다. UTC로는 2026-10-22 **12:39:03–12:41:26**이다.
- 아래 순번은 run.log 상 66개 표본 중의 순서다.
- 이 구간에 Vercel cron `sales-sync`(`*/5 10-18 * * *` UTC)의 **12:40:00 UTC 실행**이 포함된다.

| 순번 | 조건 | 표시 | 장부 API TTFB | 서버 total | auth | base_reads | prior | card_alloc | card_fee | inventory_display | 동시 요청 TTFB(payables / investments / month-close) |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 10월 KO 1280 첫 진입 #0 | 4.68s | 3,743 | 3,617 | 201 | 2,646 | 97 | 157 | 37 | 396 | 2,919 / 2,804 / 1,224 |
| 30 | 9월 KO 1280 재진입 #2 | 14.97s | 14,610 | 14,510 | 37 | 10,425 | 461 | 621 | 224 | 2,624 | 564 / 207 / 214 |
| 63 | 10월 VI 1280 월 변경 | 6.48s | 6,222 | 6,051 | 109 | 4,723 | 526 | 190 | 138 | 334 | 5,048 / 3,106 / 2,255 |
| 64 | 10월 VI 390 첫 진입 | 6.65s | 6,113 | 6,006 | 225 | 5,021 | 203 | 150 | 67 | 296 | 5,124 / 3,562 / 432 |
| 기준 | 66개 중앙값 | 1.64s | 1,176 | 1,065 | 42 | 492 | 49 | 91 | 38 | 229 | 415 / 258 / 191 |

단위는 ms이며, 표시 열만 초 단위다. 관찰된 내용:

- **순번 1·63·64:** 같은 시점의 다른 API도 함께 느렸다. `investments` summary는 인증 조회 1회와 작은 조회 2회뿐인데도 TTFB가 2.8–3.6s였다.
- **순번 30:** 동시 요청은 요청 초반에 이미 끝났다. 그런데 이 요청 안의 모든 DB 단계가 중앙값의 5–10배로 느렸다(card_fee 단일 소형 조회 224ms, inventory 2.6s).
- **공통점:** 4건 모두 프런트 렌더(본문 완료→표시 29–60ms)가 원인이 아니다.

### 1.2 로컬 읽기 전용 계측의 지연 기록(상관 분석용 UTC 시각)

시각은 해당 GET의 **종료 시각**이다. 시작 시각은 대략 종료 시각에서 total을 뺀 값이다. 클라이언트는 로컬 Node였고 Vercel이 아니다.

| 구분 | 종료 시각(UTC) | 조건 | base_reads | total | 최대 upstream |
|---|---|---|---:|---:|---:|
| 웜 상태 순간 지연 | 13:20:04.0 | 9월+동시 API(page) | 3,162 | 6,608 | 1,849 |
| 웜 상태 순간 지연 | 13:26:59.8 | 9월 cap 8 | 2,936 | — | 2,082 |
| 프로세스 첫 요청 | 13:03:03.4 / 13:19:11.7 | 8월 | 6,380 / 6,702 | — | 4,122 / 4,547 |
| idle 30s 후 | 13:06:26.7 / 13:13:10.7 | 9월 | 3,370 / 6,428 | 6,277 / 10,942 | 2,070 / 1,488 |
| idle 45s 후 | 13:07:19.3 / 13:14:03.9 | 9월 | 4,532 / 5,129 | 7,614 / 8,132 | 1,573 / 2,447 |
| idle 60s 후 | 13:08:26.3 / 13:15:11.5 | 9월 | 4,589 / 3,708 | 6,977 / 7,668 | 2,929 / 2,112 |
| idle 90s 후 | 13:10:08.2 / 13:16:46.5 | 9월 | 5,171 / 2,937 | 11,906 / 4,969 | 2,574 / 1,197 |
| idle 120s 후 | 13:12:11.9(정상) / 13:18:52.3 | 9월 | 1,569 / 3,193 | 3,726 / 5,809 | 114 / 1,496 |
| idle 45s 후, cap 비교 | 13:28:14 – 13:32:32(6회) | 9월 | 2,192 – 6,039 | — | 550 – 2,085 |

웜 상태 순간 지연 중 13:20:04는 sales-sync 정각 4초 뒤였다. 나머지 지연은 5분 정각과 정렬되지 않았다(+119s, +183s, +251s). 따라서 cron 연관은 **확인 대상 단서**일 뿐 결론이 아니다.

## 2. 현재 자료로 충분해 재측정하지 않는 것

| 항목 | 기존 근거 |
|---|---|
| 웜 상태 임계 경로 | 월 거래 page 0 → page 1 → 식대 정정이 매번 마지막 완료(0.3–0.4s 의존 비용) |
| 동시 형상의 효과 | 전부 동시 0.5–0.9s, 직렬 합 2.3–3.9s |
| 제한 동시성 | 웜 중앙값 cap 없음 755 / cap 8 824 / cap 4 896ms. 콜드에서도 일관된 개선 없음 |
| 형제 API 동시 실행 | 웜 상태 base_reads에 유의차 없음(Supabase 요청 44–46개, 최대 동시 26) |
| idle 효과 | ≥30s idle 후 14회 중 13회 지연 재현 |
| upstream/외부 분포 | 웜 1행 조회 upstream p50 22 / p95 139ms, 외부 p50 127 / p95 360ms |
| 응답 계약 | 모든 실행에서 월별 해시 동일, 건수 464/457/367 |

## 3. 진단 계측 설계 (Entries GET 전용)

### 3.1 원칙

- 대상은 `GET /api/admin/ledger?scope=entries` 하나다. POST·다른 scope·다른 API는 동작과 출력이 바뀌지 않는다.
- 조회 순서, 동시성, 쿼리, 응답 본문은 한 바이트도 바꾸지 않는다. 시간만 관찰한다.
- 저장·전송하는 값은 고정 라벨, 밀리초, 개수, Supabase가 발급한 불투명 `sb-request-id`뿐이다. URL, 필터 값, ID 목록, 금액, 행 내용, 사용자 정보, 키는 다루지 않는다.

### 3.2 수집 방식

요청 단위 수집기를 둔다(`AsyncLocalStorage`). Entries GET 처리를 `run()`으로 감싼다.

- **Supabase 요청 1건마다 기록하는 값:**

  | 값 | 기록 방법 |
  |---|---|
  | `label` | URL로 고정 allow-list에 매핑. 3.4 표 참조 |
  | `page` | offset을 1000으로 나눈 값 |
  | `t0` | 요청 시작 |
  | `th` | 응답 헤더 수신 |
  | `tb` | 본문 수신 완료. `response.text()` 완료 시점 |
  | `up` | `x-envoy-upstream-service-time` |
  | `inflight` | 시작 시점의 동시 진행 수 |
  | `rid` | `sb-request-id` |

  `up`은 순수 SQL 시간이 아니다. 게이트웨이 뒤의 PostgREST 처리, DB 대기·실행, 프록시↔PostgREST 통신을 포함한다.

- **훅 위치는 두 가지 중 택일:**
  - **A안(권장):** `lib/supabase/server.ts`의 client에 `global.fetch` 래퍼를 둔다. 활성 수집기가 없으면 즉시 원래 `fetch`로 위임한다. 공용 파일을 건드리지만 다른 API에서의 동작은 `getStore()` 1회가 늘어나는 것뿐이다.
  - **B안(공용 파일 무수정):** route 안에서 20개 base 작업 Promise와 페이지 콜백만 감싼다. 그룹·페이지 완료 시각은 얻지만 `up`/`rid`/외부 시간은 얻지 못한다. 카드·재고 helper 내부 요청은 그룹 완료 시각으로만 보인다.
- **요청 수준 부가 정보:**
  - `elu`: base_reads 구간의 `performance.eventLoopUtilization()` 변화량. Node 이벤트 루프가 바빠서 생긴 대기를 본다.
  - `inst`: 함수 인스턴스가 처리한 요청 순번과 직전 요청 이후 경과초(모듈 변수). Vercel 콜드 인스턴스와 인스턴스 기준 idle을 본다.

### 3.3 Server-Timing 출력(기존 단계 뒤에 추가, 최대 약 16개)

desc에는 쉼표를 쓰지 않는다(Server-Timing 구분자).

```
bq_mtx;dur=<page 0 시작→마지막 page 완료>;desc="p2 e830 u212 o190"
bq_mcor;dur=<식대 정정 구간>;desc="n1 e1010 u40 o95"
bq_pexp;dur=...   bq_pcor;dur=...   bq_prof;dur=...   bq_card;dur=...
bq_fund;dur=...   bq_ref;dur=...    bq_cand;dur=...
sb;desc="n37 if24"                       # 이 GET의 Supabase 요청 수 / 최대 동시 수
sb_up;dur=<max up>;desc="sum<합> trv<1행급 라벨 max up>"
sb_out;dur=<max (th-t0-up)>;desc="p50<중앙값>"
sb_body;dur=<max (tb-th)>
sb_first;dur=<첫 요청 th-t0>;desc="u<up>"
sb_slow;desc="<label>.<page> <sb-request-id>"
elu;desc="0.18"
inst;desc="r12 g43"
```

- `e`: base_reads 시작 기준 완료 시각.
- `u` / `o`: 그 그룹의 최대 upstream / 최대 외부 시간.

### 3.4 그룹 매핑(고정)

| 토큰 | 포함 요청 |
|---|---|
| `bq_mtx` | 월 거래 상세(TRANSACTION_SELECT, business_date) 전 페이지 |
| `bq_mcor` | 식대 원본 연결 정정(correction_of_id in) |
| `bq_pexp` | paid_expense_roots |
| `bq_pcor` | paid_expense_corrections(전체 정정 이력) |
| `bq_prof` | profit, recognition_profit |
| `bq_card` | card_sales, card_deposits, prior_card_deposits |
| `bq_fund` | movements(당월만), opening, reserve_plans, reserve_entries |
| `bq_ref` | accounts, categories, partners, partner_subtypes, partner_bridge |
| `bq_cand` | pending_inventory_candidates, meal_candidates |

base_reads 밖의 기존 단계(prior_movements, card_allocations_read, card_fee_read, inventory_display)도 같은 수집기로 `sb_*` 집계에 포함한다. 요청별 세부 토큰은 base_reads 그룹만 출력한다.

### 3.5 원인별 판별 방법

| 원인 | 판정 신호 |
|---|---|
| 1. SQL 실행 지연 | 특정 그룹만 `u`가 높고 1행급(`trv`)은 정상. 또는 `sb_slow` 요청 ID를 API 로그 → pg_stat_statements/Postgres 로그와 대조 |
| 2. 연결 획득·재연결 | `sb_first`의 u와 `trv`가 함께 높고 `sb_out`·`elu`는 정상. 같은 시각 Postgres 로그에 연결 생성 급증, `inst` g 값이 30s 이상 |
| 3. API/프록시·네트워크 | `sb_out`이 높고 `sb_up`은 정상 |
| 4. 동시 실행 대기 | 높은 `inflight`에서 시작한 요청만 u·o가 높고 단독 요청은 정상. `if` 값과 비교 |
| 5. 페이지네이션 순차 의존 | `bq_mtx`·`bq_mcor`의 e가 다른 그룹보다 늦고 페이지 수 `p`가 2 이상 |
| (보조) 함수 측 대기 | `elu`가 높거나 `sb_body`가 큼. Vercel 콜드 인스턴스는 `inst` r1 |

순수 SQL 실행시간은 HTTP 경로에서 얻을 수 없다(PostgREST plan 출력 비활성, 406 PGRST107). `rid`를 Supabase 로그와 대조하는 방식으로 보완한다.

### 3.6 로그 발생량

- 기본은 로그 0줄이다. Server-Timing은 응답 헤더로만 전달된다(브라우저/측정 도구).
- 실제 사용자에게 생기는 간헐 지연을 남기기 위해, **서버 total이 3,000ms 이상일 때만** `console.warn` 1줄을 남긴다.
  - 형식: `[ledger-entries-slow] {"v":1,...}`, 약 0.5KB.
  - 내용: 위 숫자, 월, 요청 ID 상위 3개.
- 운영 66개 표본 기준으로 약 6%였으므로, Entries 조회 100회당 6줄 수준이다.

### 3.7 예상 성능 영향

- **Supabase 요청 1건당:** `getStore`, `performance.now` 3회, 헤더 2개 조회, 객체 1개 추가. 수 µs 수준이다. Entries GET 1회의 요청 45건 기준으로 1ms 미만이다.
- **본문 시간 측정:** `text()` 완료 시점만 기록한다. 버퍼링 방식은 바꾸지 않는다.
- **헤더 크기:** 응답 헤더가 약 0.7–0.9KB 늘어난다. 기존 압축 본문은 63–82KB다.
- **ELU와 집계:** 1회 계산과 요청 수(~45개) 정렬 1회. 무시 가능한 수준이다.
- **다른 API(A안):** 요청당 `getStore()` 1회 외에는 변화가 없다.
- **배포 전 검증 항목:**
  1. 8/9/10월 fixture 응답 JSON이 계측 전후 바이트 단위로 동일한지.
  2. 헤더 값이 allow-list 정규식만 통과하는지. URL, 숫자 ID 목록, 금액 패턴 부재를 검사한다.
  3. 수집기가 없을 때 위임하는 경로(다른 route 회귀).
  4. 오류·예외 경로에서 기존 응답이 유지되는지.
  5. 마이크로벤치로 오버헤드 1ms 미만인지.

### 3.8 롤백

- DB·설정 변경이 없으므로 해당 커밋 1개를 되돌려 재배포하면 끝난다.
- 운영 중 즉시 끄려면 환경변수 `LEDGER_ENTRIES_DIAGNOSTICS`(기본 on, `0`이면 비활성)를 둔다. Vercel 환경변수 변경은 재배포 후 반영된다.
- 원인 판정에 충분한 지연 사례(예: 3초 이상 10건)를 모으면 제거 커밋으로 정리한다.

### 3.9 변경 예정 파일(승인 후)

| 파일 | 내용 |
|---|---|
| `lib/ledger/entries-diagnostics.ts`(신규) | 수집기, 라벨 매핑, 집계, Server-Timing·로그 직렬화 |
| `lib/supabase/server.ts`(A안만) | `global.fetch` 위임 래퍼 |
| `app/api/admin/ledger/route.ts` | `entriesOnly`일 때만 수집기 실행·토큰 추가·조건부 로그 1줄 |
| `tests/ledger-entries-diagnostics.test.mjs`(신규) | 형식·민감정보 부재·위임 경로·응답 동일성 |

## 4. 후순위 개선안(이번에 구현하지 않음)

거래 페이지네이션 병렬화는 별도 후순위로 유지한다. 웜 상태 절감 여지는 0.3–0.4s다. 지연 판정 이후 진행한다.

- **(A) 식대 정정 조회를 page 0과 동시에 실행:**
  - 방법: `original:correction_of_id!inner()`와 원본 조건(confirmed, 식대 원본 타입, 해당 월)을 필터로 쓴다.
  - 확인 결과: 8/9/10월에서 현행 2단계 조회와 행 집합·중첩 행 해시가 동일했다(읽기 전용 확인).
  - 남은 위험: 식대 원본이 200개를 넘으면 행 순서가 달라질 수 있다.
- **(B) page 1 선행 요청:** 1000행을 넘는 월에서 150–230ms 절감.

## 5. GPT 운영 DB 확인 항목(읽기 전용)

로그 보존 기간이 짧을 수 있으므로(플랜에 따라 1일) 5.1을 먼저 확인한다. 모든 항목은 SELECT 또는 로그 조회이며 설정 변경·reset을 하지 않는다.

### 5.1 Supabase 로그(get_logs)

대상 구간:
- 운영: 2026-10-22 12:38:30–12:42:00 UTC
- 로컬: 13:02–13:33 UTC, 특히 1.2절의 시각 ±15s

| 서비스 | 확인 내용 |
|---|---|
| `api` | `/rest/v1/` 요청의 timestamp, 테이블 경로, status, origin(upstream) 응답시간. 1s 이상 요청이 몇 초 단위로 몰렸는지, 운영 구간에 모든 테이블이 동시에 느렸는지 |
| `postgres` | 같은 구간의 connection received/authorized 건수 추이, `checkpoint starting/complete`, `duration:` 줄, 락 대기, 오류·FATAL |
| `supavisor`/`pooler`(있는 경우) | 같은 구간의 연결 생성·대기 기록 |

### 5.2 pg_stat_statements(누적, 1행급과 중량 조회 비교)

```sql
select left(regexp_replace(query, '\s+', ' ', 'g'), 160) as q, calls,
       round(mean_exec_time::numeric, 1) as mean_ms, round(max_exec_time::numeric, 1) as max_ms,
       round(stddev_exec_time::numeric, 1) as sd_ms
from pg_stat_statements
where query ilike any (array['%ledger_fund_accounts%', '%business_partner_subtypes%',
  '%business_partner_ledger_parties%', '%ledger_reserve_plans%', '%ledger_month_closures%',
  '%ledger_card_fee_closures%'])
order by max_exec_time desc limit 20;

select dealloc, stats_reset from pg_stat_statements_info;
```

판정: 1행급 조회의 `max_ms`가 수 ms라면 API의 초 단위 upstream은 SQL 실행 밖(연결·PostgREST·대기)에 있다. 1행급도 초 단위라면 DB 전체 정체(CPU/IO/락)를 의심한다. ledger_transactions/ledger_candidates의 최대 4.8–5.3s는 이 비교와 함께 해석한다.

### 5.3 연결 상태(재연결 가설 판별)

```sql
select usename, application_name, backend_type, state, count(*) as n,
       min(now() - backend_start) as newest_age, max(now() - backend_start) as oldest_age,
       max(now() - state_change) as longest_in_state
from pg_stat_activity
group by 1, 2, 3, 4 order by n desc;
```

- 60초 간격으로 2회만 조회한다.
- PostgREST(`authenticator`) 연결의 backend_start가 수 시간 전이고 바뀌지 않는다면, "30초 idle마다 재연결" 가설은 약해진다.
- newest_age가 매번 수십 초라면 연결이 재생성되고 있다는 근거다.

### 5.4 설정(읽기)

```sql
select name, setting, unit from pg_settings where name in (
  'max_connections', 'superuser_reserved_connections', 'idle_session_timeout',
  'idle_in_transaction_session_timeout', 'statement_timeout', 'log_min_duration_statement',
  'log_connections', 'log_disconnections', 'log_lock_waits', 'track_io_timing',
  'checkpoint_timeout', 'max_wal_size', 'shared_buffers');

select rolname, rolconfig from pg_roles
where rolname in ('authenticator', 'service_role', 'authenticated', 'anon', 'postgres');
```

대시보드에서도 확인할 항목: Data API(PostgREST) 풀 크기·max rows, Supavisor 풀 크기, 컴퓨트 크기.

### 5.5 같은 시각의 작업

```sql
select id, source, business_date, status, started_at, finished_at
from pos_sales_sync_runs
where started_at between '2026-10-22 12:30:00+00' and '2026-10-22 13:35:00+00'
order by started_at;

-- pg_cron이 있는 경우
select jobid, schedule, active, left(command, 80) from cron.job;
select jobid, status, start_time, end_time from cron.job_run_details
where start_time between '2026-10-22 12:30:00+00' and '2026-10-22 13:35:00+00'
order by start_time;
```

Vercel cron(UTC): `sales-sync` 10–18시 매 5분, `sales-deductions` 10–18시 매 15분. 12:40 / 13:20 실행과 지연 시각이 겹치는지 확인한다.

### 5.6 DB 부하 신호(누적·대시보드)

- `pg_stat_bgwriter`(PG17은 `pg_stat_checkpointer`): 요청 기반 checkpoint 비율.
- `pg_stat_database`(현재 DB): `temp_files`, `deadlocks`, `blk_read_time`.
- 대시보드 Reports에서 위 구간의 CPU, 디스크 IO 예산(소모율), 메모리, 연결 수. 소형 컴퓨트의 IO 예산 고갈은 간헐적인 전체 지연의 흔한 원인이다.
