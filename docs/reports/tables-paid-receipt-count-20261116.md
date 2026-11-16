# /tables 상단 완료 영수증 집계 — 2026-11-16

## 결과와 작업 범위

- 브랜치: `codex/tables-paid-receipt-count-20261116`.
- 시작 시 로컬 main·origin/main: `a762bd7a65adeb37f9b5be93579a61942df6679e`. 양쪽 및 Codex Worktree 미커밋 변경 없음 확인 후 최신 main에서 독립 브랜치 생성. 기준 UI 커밋 `eab869a76788eed8299498292c8e2bd7259e305b` 포함 확인. 이후 급여관리 변경을 보존했다.
- 상단 KO `누적 완료` → `완료`, VI `Lũy kế` → `Hoàn tất`. 기존 차콜 현황바·흰색 숫자·타일·시간·금액·레이아웃 유지.
- 기존 `summary.paid`는 현재 파란 테이블 수. 상단은 별도 `summary.paidCumulative`를 사용하며, 이번부터 테이블별 이용이 아닌 영수증 건수를 뜻한다. 내부 필드명은 호환성을 위해 유지했다.
- 로컬 구현·검증·Worktree 커밋만 수행. main 병합·Push·배포·운영 DB 쓰기·Migration·Cron 변경·CUKCUK 호출 없음.

## 계산식과 예외

정상 조회된 현재 영업일의 영수증 중 `payment_status = 3`, `is_canceled = false`이며 기존 단일 활성 결제 정책을 통과한 고유 영수증 ID의 개수다. 영수증 TableName·주문 tableName·원본 주문 존재·합산결제 테이블 복원·영업일 전체 수집완료 별도 증명은 요구하지 않는다. 정상 조회 결과 유효 결제가 없으면 0이다.

1. 영수증 ID를 중복 제거한다. 같은 ID의 결제 상태·OrderId·영업일·취소 여부·기준시각이 다르면 전체 숫자를 숨긴다.
2. 기존 `singlePaidOrderReceipt`를 재사용한다. 같은 OrderId의 취소/반품 상태(4/5) 또는 취소된 원본은 활성 후보에서 제외한다. 취소 원본과 유효 재발행본은 1건이다. 활성 영수증이 두 개 이상이면 임의로 선택하지 않고 `count = null`/확인 필요로 처리한다. 결제완료+미완료 중복도 동일하다.
3. 결제 후보의 OrderId 누락·취소 여부 미확인·비정상 ID/상태·잘못된/미래 기준시각·영업일 불일치도 확인 필요다. 서로 다른 OrderId로 재발행되었으나 취소/연결 증거까지 유실된 경우는 현재 자료만으로 식별할 수 없다.
4. Asia/Ho_Chi_Minh 03:00 경계 및 기존 businessDate 정책을 유지한다. 기존 조회에 포함되는 다음 날 자료는 같은 OrderId의 활성 중복 검사에만 사용하고, 현재 영업일 영수증만 집계한다. `ref_date`는 기존 영업일/시각 적격성 검사에만 사용하며 실제 결제완료 시각이나 자동 전환 타이머로 해석하지 않는다.
5. 기존 스냅샷 신뢰 조건을 유지한다. 수집 오류·지연·조회 실패·중앙 자료 충돌 시 0을 만들어 내지 않고 `count = null`을 반환한다. 테이블명 누락이나 테이블 연결 미확인만으로 영수증 숫자를 숨기지는 않는다.
6. #8885 유형의 복수 테이블 합산결제도 영수증 1건이면 완료 1건이다. 고객 방문 횟수, 물리적 사용 테이블 수, 상세창의 보수적 `usage`와 구분한다.

`paidCumulativeEvidence`는 `count`, `status`, `reason`, `coverage: queried_receipts`를 반환한다. 기존 테이블별 추정 보조 값과 항상 미확정이던 coverage 제한을 제거했다. 이 숫자는 현재 DB에서 정상 조회·검증된 건수이며, POS의 아직 미수집된 영수증까지 수집 완료되었다는 보증은 아니다. 별도 완료 원장이나 수집 기능은 추가하지 않았다.

## 서버 경로·부하·기존 기능

`table-overview-server.ts`와 `table-cleaning-server.ts`가 이미 함께 사용하는 `buildTableOverview`의 순수 투영만 변경했다. 두 서버 파일 자체를 수정하거나 별도 집계를 중복 구현하지 않았다. 기존 페이지 조회/RPC/영수증 exact paging을 그대로 이용하므로 추가 DB 조회·CUKCUK 호출·쓰기·Cron은 없다. 메모리에서 ID 및 OrderId별로 묶어 검사한다.

청소 저장·중복 요청·token·세대 보호·최초 결제 관측 기록·30분 전환 판정·신규 진행 주문 우선순위·주문/매출 금액 계산은 변경하지 않았다. 수동 청소/자동 일반 전환이 갱신하는 `summary.paid`와 상단 완료 영수증 수는 독립적이다. 새 진행 주문도 이전 유효 결제 영수증을 제거하지 않는다. 결제 취소는 적격성이 바뀌므로 건수가 감소할 수 있다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| 관련 회귀 17개 파일 | 175/175 PASS, 실패/건너뜀 0 |
| 운영 조사 형태 재현 | 유효 영수증 3건·원본 주문 tableName null 2건 → 3; 영수증 TableName 전부 null도 3 |
| 정상 빈 조회 / 수집·조회 실패 | 각각 0 / null PASS |
| 취소·재발행·ID 중복·동일 OrderId 중복 활성·#8885 | PASS |
| 일반 GET와 청소 ON 경로 | 실제 서비스 모듈+격리 PGlite로 두 경로 3 확인; 수동 저장·31분 경과·신규 주문 뒤에도 3 유지 |
| 추가 쿼리 없음 | 일반 GET 6회에 기존 영수증 조회 6회 확인 |
| 03:00 영업일 변경 | 02:59:59 → 이전 영업일 건수 유지, 03:00 → 새 영업일로 재집계 PASS |
| 기존 청소/자동 전환 DB·서버/상태·메뉴·매출 KPI 회귀 | 위 175개 검사에 포함, PASS |
| TypeScript | `tsc --noEmit --incremental false --pretty false` PASS |
| ESLint | 수정 TS/MJS 7개 파일, 오류/경고 없음 PASS |
| Production Build | 운영 .env/자격 증명 제외한 격리 복사본에서 `next build --webpack` PASS, 77개 정적 페이지 생성 |
| KO/VI × 320/360/390/430/1280px | 10조합 PASS, 실제 TSX/CSS와 합성 API 자료로 오프라인 Chrome 검증 |

브라우저 검증: 상단 완료 3 및 실패 시 확인 필요, 차콜 대비 4.5 이상, 가로 넘침 없음, 27개 정체성/순서 및 11/8/8 구역, 320px BAR 4열/그 외 6열, 74px 타일, 시간·금액·상태별 숨김, 상세창 주문·옵션·취소·정확한 금액, 닫기·포커스·스크롤, 60초 갱신을 확인했다. 화면별 격리 SQL-backed 서비스에서 청소 저장·자동 전환·신규 주문 후 완료 건수가 유지됨도 확인했다.

이전 조사에서 확인한 운영 3건의 구조를 비식별 오프라인 fixture로 재현했다. 이번 작업에서 운영 자료를 새로 조회하거나 운영 E2E/실제 POS 결제를 실행하지 않았다. Build의 다중 lockfile workspace root 감지 경고는 기존 환경 경고이며 빌드는 종료 코드 0이다.

로컬 증거: `C:\workspace\baba-wt-codex\.local\tables-paid-receipt-count\`의 `regression.log`, `tsc.log`, `eslint.log`, `build.log`, `build-result.json`, `browser-results.json`, KO/VI before/after 및 warning PNG. 임시 검증 파일은 Git 제외 상태다.

## 수정 파일 전체 경로

- `C:\workspace\baba-wt-codex\lib\sales\table-paid-cumulative.ts`
- `C:\workspace\baba-wt-codex\lib\sales\table-overview.ts`
- `C:\workspace\baba-wt-codex\lib\text\tables.ts`
- `C:\workspace\baba-wt-codex\tests\tables-main-phase2.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-paid-receipts.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-state-normalization.test.mjs`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-paid-receipt-count-20261116.md`

로컬 구현과 검증을 완료했다. 운영 반영은 수행하지 않았으며 Owner의 다음 지시를 기다린다.
