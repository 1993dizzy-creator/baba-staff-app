# /tables 메인화면 UI 개선 2차

판정: **로컬 UI·읽기 전용 증거 투영 PASS**. 단, **영업일 전체 누적 완료 숫자는 현재 데이터로 확정 불가**이며 화면은 `— / 확인 필요`를 표시한다. 숫자 총계 제공을 완료했다고 보고하지 않는다.

브랜치: `codex/tables-main-ui-phase2-20261116`. 시작 시 실제 `git fetch origin main`을 수행했고 로컬 main·origin/main·Worktree HEAD 모두 `ff54f9e736e49e26455b2ff3e9fcd37d83c41eec`, 미커밋 변경 없음이었다. 이 main에서 독립 브랜치를 생성했다. 결과는 Worktree 커밋까지이며 main 병합·Push·배포·운영 DB 쓰기·Migration/Repair·Cron·CUKCUK 호출·운영 환경변수 변경을 하지 않았다.

## UI 변경 전후

| 항목 | 기존 | 변경 |
|---|---|---|
| 주문 시작 | `18:58` | `🕒 18:58`. 기존 verifiedOrderStart와 베트남 HH:mm 계산 그대로, 시각 없으면 아이콘도 없음 |
| 하위 탭 | 테이블 / 예약, Bàn / Đặt bàn | 🍽️ 테이블 / 📅 예약, 🍽️ Bàn / 📅 Đặt bàn. 장식 이모지는 aria-hidden, 링크·aria-current·상단 메뉴 유지 |
| 현황바 | 흰색, 전체/사용 중/완료 | #111827 차콜, 주요 숫자 #FFFFFF, 보조 #CBD5E1, 구분선 #374151, 전체/사용 중/누적 완료. VI는 Tổng/Đang dùng/Lũy kế |
| 기준·새로고침·경고 | 밝은 배경 기준 | 흰색 시각/버튼, 경고 #FBBF24. 일반 주요·보조 텍스트/버튼 대비 4.5:1 이상 확인 |
| 현재 주문 금액 | 없음 | occupied의 검증된 현재 주문 header 예상 합계만 축약, 전체 VND 예상금액을 접근성 라벨/title로 제공 |
| 타일 | 64px, gap 3px | 72/76px 실제 비교 후 **74px**, gap 1px, padding 3px. 모두 동일 높이 |
| 구역 | 10px 6px 16px, 제목 아래 8px | 8px 6px, 제목 아래 6px. BAR 320~359px 4열·360px 이상 6열, PC 3구역 유지 |

74px는 3줄을 수용하면서 76px보다 반복 행의 공백을 줄이고 72px보다 여유를 둔 선택이다. 27개 UUID·순서·BAR 11/1층 8/2층 8, 기존 상태 색상은 유지했다. 실제 고객 착석시각으로 해석하지 않는 안내도 유지한다.

## 누적 완료 정의와 공개 계약

기존 `summary.paid`는 현재 파란 paid 테이블 개수이며 그대로 보존했다. 새 투영은 이를 세거나 TableDetail.usage를 재사용하지 않는다.

- `summary.paidCumulative`: 확정된 영업일 전체 합계용 `number | null`. **현행 GET에는 전체 범위 증거가 없어 현재는 항상 null**이다.
- `summary.paidCumulativeEvidence`: `status`, `reason`, `coverage`, `verifiedObservedCount`, `byTable`을 제공한다. 검증된 관측 자료의 범위와 미확정 이유를 구분한다.
- `coverage='unverified'`, 정상 수집이어도 `reason='coverage_unverified'`. 연결/중복 충돌은 `evidence_conflict`, 수집 실패·지연은 `snapshot_unhealthy`/unavailable로 제공한다.
- `verifiedObservedCount`와 `byTable`은 **이번 기존 GET 자료 안에서 확인된 결제/테이블 이벤트의 부분 집계**이다. 영업일 전체 누계·실제 방문 횟수가 아니며 화면 총계로 표시하지 않는다. 자료가 비어 내부 관측 수가 0이더라도 메인은 `—`이다. 과거 자료가 스냅샷에서 빠지면 부분 집계 자체도 달라질 수 있으므로 영속 누계로 사용하면 안 된다.

관측 집계 규칙:

1. 03:00 경계의 기존 businessDate, 정상 snapshot, source OrderId·원본 테이블·영수증 결제완료/취소 여부·시각·단일 활성 결제 관계를 확인한다. 추가 DB 읽기 없이 이미 받은 orders/receipts/catalog만 사용한다.
2. 같은 OrderId의 반복 입력은 중복 제거한다. 취소된 영수증은 제외하고 유효한 재발행이 있어도 같은 OrderId당 결제 이벤트 하나이다. 복수 활성 영수증/상충하는 중복은 확정하지 않는다.
3. 같은 테이블에서 서로 다른 OrderId에 각기 독립된 유효 결제 증거가 있으면 부분 집계는 각각 증가한다. 이는 결제완료 건수이며 방문 횟수가 아니다. TableDetail.usage의 보수적 이용 횟수는 그대로다.
4. v3 합산 관계가 검증되면 같은 테이블의 여러 합산 구성 주문은 하나로 집계한다. 여러 원본 테이블이면 각 테이블의 완료 증거를 각각 한 건으로 유지한다. #8885는 BAR8/BAR9/BAR11 각각 1, 합계 3의 테이블 완료 증거이며 매출 3건/실제 방문 3회라는 의미가 아니다. 영수증 표기 테이블 2로 이동했다고 추정하지 않는다.
5. 원본 테이블이 없거나 주문/영수증 테이블이 상충하면 임의 배분하지 않는다. source 주문이 없는 receipt-only 자료도 확정 건수에 넣지 않는다.
6. 수동 청소완료·30분 자동 일반 전환·신규 진행 주문은 기존 결제 증거를 삭제하지 않으며 부분 완료 집계도 유지된다. 다음 영업일에는 그 businessDate 자료로 새로 투영한다. 모든 수치는 기존 읽기 자료로 재계산하며 신규 DB 저장은 없다.

### 숫자 총계를 확정할 수 없는 이유와 후속 승인 범위

현재 `/tables` GET의 정상 sync는 최신 수집 성공/신선도를 나타낸다. 영업일 전체 영수증의 완전성과 과거 완료 주문·원본 테이블 관계의 보존 범위를 보증하지 않는다. `fetchAllExactPages`가 성공해도 로컬 DB에 아직 수집되지 않은 자료나 누락된 과거 테이블 연결까지 증명하지 못한다. 실제 운영 자료를 별도 조회해 확인하지 않았다.

숫자 총계를 제공하려면 현 GET에 없는 일별 영수증 수집 완전성 증거 및 완료 주문/테이블 연결의 전체 범위 보증을 연결하는 후속 분석이 필요하다. 기존 source_complete 계열 정보를 사용할 수 있는지, 원본 테이블 이력을 현재 보존하는지부터 확인해야 한다. 추가 상태 조회 또는 기존 RPC 응답 확장의 정확한 쿼리 수·권한·부하·DDL 필요 여부는 아직 확정하지 않았다. **이 추가 조회/RPC/DB/Cron 범위는 별도 승인 대상으로 분리했으며 구현·실행하지 않았다.** 정상 snapshot만 보고 전체 건수나 0을 확정하는 우회는 하지 않았다.

## 금액 표시 정책

`verifiedCurrentOrderAmount`는 기존 `verifiedOrderStart`를 그대로 사용해 occupied/정상 snapshot/현재 영업일·시각 증거를 확인한 뒤, `verifiedOpen` 주문 header 예상금액을 OrderId별 한 번만 합산한다. header와 원본 메뉴·상태는 수정하지 않는다.

불완전 메뉴·detailsNeedReview, 누락 lines, 비정상·음수·소수 VND·unsafe integer, 서로 다른 같은 OrderId 증거, overflow는 금액을 숨긴다. 일반·완료·미확인에는 금액을 표시하지 않는다. 수량/단가/메뉴 합계를 새로 재가격 계산하지 않으며 확정 매출로 표현하지 않는다.

- `450000 → 450k`, `450500 → 450.5k`, `999999 → 999.999k`: 천 단위는 정수 VND까지 정확하다.
- `1000000 → 1M`, `1234000 → 1.234M`, `1234567 → ≈1.234M`, `1999999 → ≈1.999M`.
- 큰 단위는 소수 3자리에서 **절삭**하고 생략한 단위가 있을 때만 `≈`를 붙인다. 단위 경계를 넘어 올림하지 않으며 M 기준 생략분은 1,000 VND 미만이다. 매우 큰 값에는 B/T도 사용한다.
- tile 접근성 라벨에는 `현재 진행 주문 예상금액 450.000 ₫`처럼 전체 금액을 제공한다. 상세창은 기존 전체 VND 숫자를 유지한다. 축약은 표시 전용이다.

## 검증 결과

| 범위 | 결과 |
|---|---|
| 관련 Node/PGlite 회귀 16개 파일 | **167/167 PASS**, fail/skip 0 |
| 최종 순수 투영의 내부 lookup 정리 후 영향 범위 | **52/52 PASS**, 위 회귀의 유효 증거 교체이며 중복 가산하지 않음 |
| KO/VI × 320/360/390/430/1280px | **10/10 조합 PASS**, 변경 전후·72/76px 후보·최종74px·경고 화면 |
| TypeScript noEmit / 변경 TS·TSX·MJS ESLint --max-warnings 0 | PASS, 오류·경고 0 |
| 전체 Production Build | **PASS, exit 0**, Next.js 16.2.1 webpack, 최종 코드 재검증 |
| diff check / React 검토 | PASS. 파생값은 render/순수 함수에서 계산, 추가 effect/조회 없음, 키·접근성·기존 상태 관리 보존 |

화면 검증은 실제 소스를 번들링하고 네트워크를 offline fixture에 제한했다. America/Los_Angeles 브라우저 시간대에서도 베트남 18:58 표기를 확인했다. 27개 순서/구역, 44px 이상 터치 영역, 3줄 시간/이모지/금액과 전체 VND 라벨, BAR 4/6열, 가로 넘침 없음, 차콜 색/대비, 실패 시 시간·금액 숨김과 밝은 경고, 새로고침·60초 갱신·상세/스크롤/닫기/포커스를 검사했다. 각 조합에서 실제 격리 SQL-backed 청소완료 저장·자동 만료·신규 주문 우선순위도 확인했다.

집계 검증은 독립 결제 증가, 반복·재발행, 복수 활성 영수증 충돌, 같은/다른 테이블 합산·#8885·연결 이동 불명확, 실패·지연, 03:00 재집계, 거짓 0 방지, 청소/자동 일반 전환/진행 주문 후 과거 증거 유지 등을 포함한다. 기존 금액 KPI·상태 판정 회귀도 실행했다.

Build는 Worktree `.local`의 격리 복사본에서 수행했다. `.env`를 복사하지 않고 운영 앱 환경변수를 자식 프로세스에서 제외했으며 offline placeholder Supabase URL/key만 주었다. 원본 설정·운영 환경변수·main은 수정하지 않았다. 복사본과 상위 lockfile 때문에 Next가 workspace root 추론 경고를 출력했으나 최종 컴파일·TypeScript·페이지 생성은 성공했다. 본 작업에는 런타임 dev server나 운영 E2E 실행이 없다.

## 운영 영향·미검증 사항

새 DB 조회·테이블·Migration·RPC·Cron·수집기·CUKCUK 호출은 없다. 동일 GET 입력에 순수 CPU 투영만 추가했다. 500개 주문/영수증 합성 자료 5회에서 약 **66~86ms**의 추가 투영 비용을 관측했다. 이는 격리 로컬 계측이며 운영 latency/P99 보증이 아니다.

`summary.paid`, 청소 token/RPC·무효화·OFF→ON 보호, 자동 전환 시각/스위치, 주문 시작 계산, TableDetail.usage, POS/매출 KPI/장부 코드는 보존했다. 영업일 전체 누적 숫자의 확정 불가가 남아 있는 기능 한계이며 이 상태를 총계 PASS로 확대하지 않는다. 운영 데이터·누락/이동 이력·실제 트래픽·배포 E2E는 미검증이다.

증거: `C:\workspace\baba-wt-codex\.local\tables-main-ui-phase2\`의 `regression.log`, `final-projection.log`, `browser.log`, `browser-results.json`, `tsc.log`, `eslint.log`, `build-final.log`, `build-result.json`, `performance.json`, `before-*`, `after-*`, `candidate-72-*`, `candidate-76-*` PNG. 최종 코드·증거 hash는 같은 폴더 manifest에 보존한다.

## 변경 파일 전체 Windows 경로

```text
C:\workspace\baba-wt-codex\app\(protected)\tables\layout.tsx
C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx
C:\workspace\baba-wt-codex\app\(protected)\tables\tables.module.css
C:\workspace\baba-wt-codex\lib\sales\table-overview.ts
C:\workspace\baba-wt-codex\lib\sales\table-paid-cumulative.ts
C:\workspace\baba-wt-codex\lib\sales\table-tile-amount.ts
C:\workspace\baba-wt-codex\lib\text\tables.ts
C:\workspace\baba-wt-codex\tests\tables-main-phase2.test.mjs
C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs
C:\workspace\baba-wt-codex\tests\tables-state-normalization.test.mjs
C:\workspace\baba-wt-codex\docs\reports\tables-main-ui-phase2-20261116.md
```
