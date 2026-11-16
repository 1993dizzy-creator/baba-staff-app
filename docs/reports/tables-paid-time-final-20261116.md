# /tables 최종 마감 — 결제 시간 색상·고정 사용시간, 2026-11-16

## 기준과 작업 경계

- 브랜치: `codex/tables-paid-time-final-20261116`.
- 시작 시 Worktree HEAD는 Phase 6 `c02f2698ce18d69c5686855cf16cb1a56bdf10b3`, main은 급여관리 변경을 포함한 `bd65666c2c6e552082d2b53d0d346c5d7189a9ba`. 양쪽 미커밋 변경 없음 확인. fetch 후 origin/main은 `a762bd7a65adeb37f9b5be93579a61942df6679e`.
- main에는 Phase 6이 아직 없었으므로 별도 Worktree 브랜치에서만 두 이력을 통합했다(`0d2ee5cd`). Phase 1~6과 급여관리 이력을 모두 보존했다. main 자체는 변경하지 않았다.
- 확인한 로컬 코드에는 결제완료 타일 시간 표시가 없었다. Owner의 추가 지시대로 기존 서버 lastPaidAt을 사용하는 표시를 이번에 포함했다.
- 로컬 구현·격리 검증·Worktree 커밋만 수행. main 병합·Push·배포·운영 DB 변경·Migration·Cron·CUKCUK API 변경/추가 호출 없음.

## UI 결과

| 항목 | 결과 |
| --- | --- |
| 사용 중 타일 | 기존 시작시각·초록 배경/테두리·시간 색상·60px 높이·배치 유지 |
| 결제완료 타일 | paid+정상 스냅샷에서 기존 lastPaidAt 표시, 시간 글씨만 #B91C1C, 🕒 유지 |
| 파란 타일/번호 | 기존 #ECF3FF 배경·#3B82F6 테두리·#111827 번호 글씨 유지 |
| 결제완료 상세 헤더 | 기존 파란 8px dot·차콜 헤더·수집 기준시각에 `· 65분` / `· 65p` 등 추가 |
| 일반/미확인/사용 중 전환 | 결제 타일 시간과 결제 사용시간 숨김; 기존 현재 주문 경과시간은 별도 유지 |

타일 시간은 lastPaidAt의 값 자체를 바꾸거나 역산하지 않는다. 정상 paid 상태, 유효한 타임존 포함 시각, 현재 영업일, 미래가 아닌 값일 때만 표시한다. 상세창 오른쪽 시각은 기존 수집 기준시각이며, 결제 사용시간의 종료 시각으로 사용하지 않는다.

접근성 title에 주문 시작부터 영수증 기준시각까지의 경과시간이고 실제 고객 착석시간을 확정하지 않는다고 KO/VI로 안내한다. 60분 이상도 기존 정책대로 전체 분 단위를 표시하며, 불완전한 마지막 분은 내림한다.

## 계산·검증 기준

`floor((해당 최신 유효 영수증 ref_date - 원본 중앙 주문 orderDate) / 60,000)`을 표시한다. 현재 시각·synced_at·status_changed_at·최초 관측시각을 종료 시각으로 대신 사용하지 않는다. 결제 후 시간이 지나도 값이 증가하지 않는다.

순수 투영 `projectPaidOrderUsage`가 기존 상세 조회에서 이미 확보한 자료만 검증한다.

1. 현재 테이블은 paid이고 스냅샷은 정상이어야 한다. 현재 진행 주문이 있으면 표시하지 않는다.
2. 최신 유효 영수증은 현재 영업일이며 취소/미확인이 아니어야 한다. 해당 시각은 테이블 lastPaidAt과 일치해야 한다.
3. 영수증 OrderId와 원본 중앙 주문 OrderId를 정확히 연결하며 원본 주문은 한 건이어야 한다.
4. 원본 주문의 실제 tableName이 남아 있어야 하고, 고유 카탈로그 테이블 ID 및 영수증 tableName과 일치해야 한다. TableOrder.tableName의 영수증 기반 fallback은 근거로 사용하지 않는다.
5. 시작·종료·원본 주문 관측·중앙 스냅샷 시각이 유효해야 한다. 시작 ≤ 종료, 시작 ≤ 관측 ≤ 스냅샷 ≤ 서버 기준 현재 시각, 종료 ≤ 현재 시각을 확인한다. 시작/종료는 기존 03:00 영업일 정책에 속해야 한다.
6. 기존 단일 활성 영수증 정책을 재사용한다. 취소 원본+정상 재발행은 유효한 한 건으로 처리하고, 중복 활성 영수증은 생략한다.
7. 합산결제/closure 관계가 있으면 여러 주문의 사용시간을 합치거나 가장 이른 시작시각을 추정하지 않고 생략한다. #8885 유형도 생략 대상이다.

정상 연결인 독립 결제가 여러 번 있었으면 최신 유효 결제에 연결된 그 주문만 사용한다. 예전 주문의 시작시각을 섞지 않는다.

## 표시 불가능한 상황

원본 주문 누락·중복, 원본 tableName 유실·불일치, 시작시각 누락/비정상/타임존 불명, 결제가 시작보다 이르거나 미래인 경우, 이전 영업일, 취소·중복 활성 결제·연결 충돌, 합산결제 관계, 스냅샷 오류/지연은 경과시간을 생략한다. 따라서 운영 POS가 결제 후 원본 tableName을 지운 주문에는 시간이 나오지 않을 수 있다. 임의의 테이블 복원이나 신규 수집으로 이를 보충하지 않았다.

## 데이터 경로와 기존 기능 영향

상세 응답에 선택적인 읽기 전용 `paidUsage` 필드(분·영수증 ID·기준시각·스냅샷)를 추가했다. 기존 자료로 메모리에서 계산하므로 추가 DB 조회/쓰기/테이블/권한은 없다. 영수증·주문·매출 값을 변경하지 않는다.

청소 상세 보정에서는 새 필드만 상태·영수증 키·시각·스냅샷에 다시 묶어 검증한다. 청소/자동 전환/영수증 세대가 바뀌면 해당 필드를 제거한다. 기존 청소 token·저장·중복 요청·자동 전환 판정은 수정하지 않았다. 클라이언트도 최신 상세 증거와 paid 상태가 맞을 때만 표시한다. 새 상세 응답을 기다리는 갱신 순간에는 경과시간을 생략한다.

기존 `orderElapsedMinutes`/`verifiedOrderStart` 함수 본문은 변경하지 않았다. 사용 중 메뉴·예상금액·타일 시간 경로를 유지했고, 완료 집계·KPI·상태 판정·30분 관측 기록·Cron·SQL 파일은 변경하지 않았다. 결제 이력 카드의 기존 영수증 기준시각은 일반 전환 후에도 이력 정보로 유지된다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| 관련 회귀 19개 파일 | 204/204 PASS, FAIL/skip 0 |
| TypeScript | `tsc --noEmit --incremental false --pretty false` PASS |
| ESLint | 수정 TSX/TS/MJS 8개 파일, 오류/경고 없음 PASS |
| Production Build | 운영 .env/자격 증명 없는 격리 복사본의 `next build --webpack` PASS |
| KO/VI × 320/360/390/430/1280px | 10조합 PASS, 실제 TSX/CSS를 사용한 오프라인 Chrome |
| 모바일 | KO/VI × 320/360/390/430px touch-enabled Chrome에서 메뉴·상세 정보 tap PASS |

검증 내용:

- 정상 주문 65분, 시작=종료 0분, 59초/60초 내림 경계, 종료가 시작 이전인 경우, 현재 시각이 20분 지나도 65분 고정.
- 잘못된/미래/누락/타임존 없는 시각, 원본 이름 유실과 TableOrder fallback 구분, 원본 테이블/카탈로그 충돌, 원본 주문 누락·중복.
- 취소·재발행·중복 활성 결제·#8885형 closure, 최신 독립 결제의 자체 시작시각 선택, 02:59:59/03:00 영업일 경계.
- 일반/미확인/사용 중/수집 오류에서 결제 표시 숨김, 새 영수증·스냅샷으로 증거가 달라질 때 이전 시간 무효화.
- 격리 SQL-backed 실제 서비스 모듈에서 65분 → 자동 일반 전환/수동 청소 후 필드 제거 → 신규 진행 주문 우선 확인. 각 화면 폭/언어의 브라우저에서도 청소 저장·자동 전환 후 결제 타일 시간 및 사용시간 숨김, 상단 완료 건수 유지 확인.
- 사용 중 타일의 배경·테두리·번호 색·시간 색·높이·시각 텍스트를 변경 전후 직접 비교. 결제 타일 RGB(185,28,28), 파란 배경/테두리, 검은 번호, 60px 높이 확인.
- 27개 테이블/순서, Phase 1~6의 한 줄 메뉴·이름 분리·원본 중복 제거·옵션/취소·영수증 카드·상태 dot·접힘 영업일·로딩/오류·60초 갱신·모달 스크롤/포커스/닫기 회귀.

화면과 경계 사례는 비식별 오프라인 fixture로 검증했다. 운영 DB·실제 POS·운영 로그인 세션 E2E는 실행하지 않았다. Build의 다중 lockfile workspace root 감지 경고는 기존 환경 경고이며 종료 코드는 0이다.

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
- `C:\workspace\baba-wt-codex\docs\reports\tables-paid-time-final-20261116.md`

## 로컬 화면·증거

Git 제외 경로 `C:\workspace\baba-wt-codex\.local\tables-paid-time-final\`에 회귀/TypeScript/ESLint/Build/브라우저 로그, `build-result.json`, `browser-results.json` 및 폭/언어별 PNG를 보존한다.

- [320px KO 결제 시간](../../.local/tables-paid-time-final/after-ko-320-paid-time-overview.png)
- [320px KO 변경 전 헤더](../../.local/tables-paid-time-final/before-ko-320-paid-65min.png) / [변경 후 65분](../../.local/tables-paid-time-final/after-ko-320-paid-65min.png)
- [320px VI 65분](../../.local/tables-paid-time-final/after-vi-320-paid-65min.png)
- [1280px VI 결제 시간](../../.local/tables-paid-time-final/after-vi-1280-paid-time-overview.png)

**판정: /tables UI 최종 마감 대상 로컬 검증 PASS.** 운영 반영 없이 Worktree 커밋 상태로 마감한다.
