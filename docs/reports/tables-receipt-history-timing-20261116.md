# /tables 결제 이력 중복 제거·주문 소요시간 — 2026-11-16

## 기준과 작업 경계

- 브랜치: `codex/tables-receipt-history-timing-20261116`.
- 시작 시 main·Worktree HEAD 모두 `2717a0d92032c77173018d38728f2b654554f5a4`, 미커밋 변경 없음 확인. fetch 후 origin/main은 `a762bd7a65adeb37f9b5be93579a61942df6679e`. 최신 로컬 main에서 독립 브랜치 생성.
- Phase 1~6 및 결제 시간 빨간 타일·기존 급여관리 변경을 보존했다.
- 로컬 구현·격리 검증·Worktree 커밋만 수행했다. main 병합·Push·배포·운영 DB 변경·Migration·Cron·CUKCUK API 변경/추가 호출 없음.

## 확인한 누락 원인

1. 사용 중 이력 1건은 `detail.current.length > 1` 조건에서 제외됐다. 동시에 `detail.latest` 독립 카드가 상태와 관계없이 출력되어 최근 결제와 이력에 같은 영수증을 반복 표시할 수 있었다.
2. 이전 `projectPaidOrderUsage`는 원본 order.tableName의 존재와 카탈로그/영수증 테이블 일치를 필수로 요구했다. POS가 결제 후 원본 테이블명을 지우면 OrderId와 시작/종료가 명확해도 paidUsage가 null이 됐다. UI는 null을 그대로 생략하고 있었으며, 렌더링 오류로 65분이 사라지는 구조는 아니었다.
3. 청소 상세 보정이 더 최신 스냅샷을 읽었을 때 기존 paidUsage.snapshotAt 불일치로 시간을 폐기했다. 이는 오래된 증거를 막는 보호 장치였지만 이미 확보한 새 context로 다시 검증하는 경로가 없어 유효한 시간도 보류할 수 있었다.

원본 tableName=null 및 스냅샷 갱신 사례를 재현해 수정 전 조건과 수정 후 결과를 확인했다. 특정 운영 테이블의 DB 자료를 새로 조회한 것은 아니므로 모든 운영 누락이 위 원인 하나라고 단정하지 않는다. 실제 시작시각/OrderId/연결 증거가 없는 영수증은 여전히 범위를 표시할 수 없다.

## 이력 UI와 중복 정책

| 상태/자료 | 최근 독립 카드 | 최하단 접힘 이력 |
| --- | --- | --- |
| occupied, 0건 | 없음 | 없음 |
| occupied, 1건 | 없음 | 당일 1건, `(1)` |
| occupied, 2/3건 | 없음 | 당일 전체 2/3건, `(2)`/`(3)` |
| paid, 1건 | 최근 1건 유지 | 동일 영수증을 다시 표시하지 않음 |
| paid, 2건 | 최근 1건 유지 | 나머지 1건, `(1)` |
| paid, 3건 | 최근 1건 유지 | 나머지 2건, `(2)` |

접힘 제목의 숫자는 실제 그 영역에 들어가는 고유 영수증 수다. paid의 최근 카드와 이력을 합치면 전체 영수증이 각각 한 번씩 나타난다. 영수증 ID를 기준으로 UI 중복을 제거하며, 같은 OrderId/영수증 번호라는 이유로 취소·재발행 등 다른 ID의 원본 기록을 합치지 않는다.

이력은 합산결제 증거 섹션 뒤, 상세창 최하단에 놓았다. 현재 영업일만 표시하며 이전 영업일 7일 이력을 복원하지 않았다. 원본/API 기록을 삭제하거나 DB 자료를 정리하지 않았다. 금액·상태·메뉴·합산결제 증거는 그대로 유지한다.

## 시간 범위와 헤더의 공통 증거

각 당일 영수증에 읽기 전용 `orderUsage`를 투영한다. 시작은 해당 OrderId의 검증된 원본 `orderDate`, 종료는 해당 유효 영수증 `ref_date`다. `floor((종료-시작)/60,000)`을 사용하며 현재 시각이나 수집시각을 종료로 대체하지 않는다. 결제 후 시간이 흘러도 늘어나지 않는다.

- 같은 현지 달력 날짜: `11.16 20:37 ~ 21:42 · 65분` / `65p`.
- 자정 통과: `11.16 23:50 ~ 11.17 00:55 · 65분` / `65p`.
- 시작/연결 미확인: `결제 11.16 21:42` / VI의 확인된 결제시각만 표시. 범위나 0분을 만들어 넣지 않는다.

시간 범위는 금액 아래 작은 문구로 표시한다. 모든 최신/이력 영수증 카드가 같은 renderer를 사용한다. 원본 영업일과 원본 ref_date의 dateTime/접힘 정보도 유지했다. 달력 날짜 표시는 Asia/Ho_Chi_Minh이며, 적격성은 기존 03:00 영업일 정책을 따른다.

paid 헤더는 최근 영수증의 바로 그 `orderUsage`와 동일한 startedAt/ref_date/receiptId/snapshotAt/분 값을 검증해 사용한다. 헤더와 카드가 별도 기준으로 계산되지 않는다. 오른쪽 수집시각은 그대로이며 계산에 사용하지 않는다. 기존 occupied의 `orderElapsedMinutes`/`verifiedOrderStart` 함수 본문과 사용 경로는 변경하지 않았다.

## 허용·생략 조건

다음이 확인되면 원본 tableName=null이어도 **주문 처리 소요시간**을 표시한다. 물리적인 테이블 점유시간이나 실제 고객 착석시간이라고 확정하지 않으며 기존 KO/VI 접근성 title로 이를 안내한다.

- 정상 중앙 스냅샷, 해당 영업일의 단일 원본 주문과 정확한 OrderId 연결.
- 취소되지 않은 유효 영수증, 기존 단일 활성 결제 정책 통과.
- 유효한 타임존 포함 시작/종료/관측/스냅샷 시각, 시작 ≤ 종료 및 일관된 관측 순서, 미래 시각 아님.
- 시작과 종료가 해당 영업일에 속함. 서로 다른 달력 날짜여도 동일한 03:00 영업일이면 가능.

원본 주문/시작 누락·중복, 비정상/미래/타임존 없는 시각, 종료가 시작 이전, 알려진 테이블명 충돌, 다른 영업일, 취소/미확인·중복 활성 영수증·합산결제/closure 관계는 범위를 생략한다. 취소 원본은 확인된 결제 기준시각만, 정상 단일 재발행본은 자기 증거의 범위를 표시한다. 합산결제에서 여러 주문의 가장 이른 시작을 골라 임의의 하나로 만들지 않는다.

## 상세 보정·기존 기능 영향

기존 청소 상세 보정에서 이미 읽는 atomic context의 주문·영수증·스냅샷으로 시간 필드만 다시 검증한다. 추가 DB 조회 없이 새 스냅샷에 증거를 다시 묶는다. 동일 영수증을 확인할 수 없거나 최신 키/시각이 달라졌으면 헤더 시간을 생략한다. 영수증 금액·상태·메뉴를 다시 계산하거나 청소 저장 기준을 변경하지 않았다.

`paidUsage`는 헤더용이며, 청소/자동 전환/신규 주문으로 paid 상태가 아니면 숨긴다. 영수증별 `orderUsage`는 유효한 과거 주문 기록이므로 이력 카드에 계속 표시할 수 있다. 신규 진행 주문의 경과시간과 과거 결제 주문의 고정 소요시간을 섞지 않는다.

DB·수집기·테이블 상태 판정·완료 집계·매출 KPI·청소 token/저장·관측 기록·30분 전환·Cron은 변경하지 않았다. 읽기 전용 상세 필드와 UI 투영만 변경했다. 영수증별 계산은 기존 조회 자료의 메모리 처리이며 추가 DB/API 호출은 없다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 관련 회귀 19개 파일 | 208/208 PASS, FAIL/skip 0 |
| TypeScript | `tsc --noEmit --incremental false --pretty false` PASS |
| ESLint | 수정 TSX/TS/MJS 9개 파일, 오류/경고 없음 PASS |
| Production Build | 운영 .env/자격 증명 없는 격리 복사본의 `next build --webpack` PASS |
| KO/VI × 320/360/390/430/1280px | 10조합 PASS, 실제 TSX/CSS를 사용한 오프라인 Chrome |
| 모바일 | KO/VI × 320/360/390/430px touch-enabled Chrome에서 이력·메뉴/정보 tap PASS |

검증은 occupied 0/1/2/3건, paid 1/2/3건, 반복 ID 응답, 단일 최신/당일 이력 중복 방지, 최하단 위치와 합산결제 증거 순서, 각 영수증의 독립된 시간 범위, 헤더/최근 카드 일치, tableName=null, 시작 정보 없음, 자정·03:00, 취소·재발행·합산·중복 활성 결제 및 fallback 시각을 포함한다.

격리 SQL-backed 서비스에서 원본 이름 유실과 스냅샷 갱신 후에도 65분이 유지되고, 청소/자동 전환 후 헤더 숨김 및 신규 주문 우선순위를 확인했다. 브라우저의 각 언어/폭에서도 결제완료 → 청소/자동 전환 → 신규 주문, 60초 갱신, 메뉴 언어/옵션/취소/원본 단가·합계, 27개 테이블·빨간 결제 타일 시간·상태 dot·로딩·모달 스크롤/포커스/닫기 회귀를 확인했다.

운영 DB·실제 POS·운영 로그인 E2E는 실행하지 않았다. Build의 다중 lockfile workspace root 감지 경고는 기존 환경 경고이며 종료 코드는 0이다. 화면 검증은 비식별 fixture이며 반복 ID 응답도 주입해 중복 방지를 검증했다. 1건 누락의 변경 전 비교는 실제 1개 응답으로 별도 재현했다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\app\(protected)\tables\tables.module.css`
- `C:\workspace\baba-wt-codex\lib\sales\table-paid-usage.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-detail-display.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-cleaning-server.ts`
- `C:\workspace\baba-wt-codex\lib\text\tables.ts`
- `C:\workspace\baba-wt-codex\tests\tables-paid-usage.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\tests\helpers\tables-cleaning-service-fixture.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-receipt-history-timing-20261116.md`

## 로컬 화면과 증거

Git 제외 경로 `C:\workspace\baba-wt-codex\.local\tables-receipt-history-timing\`에 회귀/TypeScript/ESLint/Build/브라우저 로그, `build-result.json`, `browser-results.json`, `before-history1.log`와 KO/VI 폭별 PNG를 보존했다.

- [320px KO 사용 중 1건 변경 전](../../.local/tables-receipt-history-timing/before-ko-320-occupied-history1.png) / [변경 후](../../.local/tables-receipt-history-timing/after-ko-320-occupied-history1.png)
- [320px KO 최근 결제 범위·65분](../../.local/tables-receipt-history-timing/after-ko-320-paid-range1.png)
- [320px KO 자정 통과·이력 범위](../../.local/tables-receipt-history-timing/after-ko-320-paid-range3.png)
- [320px VI 최근 결제 범위](../../.local/tables-receipt-history-timing/after-vi-320-paid-range1.png) / [시작 없음 fallback](../../.local/tables-receipt-history-timing/after-vi-320-fallback-time.png)

**로컬 구현·검증 PASS.** Worktree 커밋으로 마감하며 운영 반영은 수행하지 않는다.
