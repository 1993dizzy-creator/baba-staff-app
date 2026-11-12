# 전 직원 매장현황 `/tables` 1차

기준: 원격 `main` `d9a22d24c6a8bf9839cef14459582c27fa161de8`.
개발 브랜치: `codex/shared-tables-overview-20261113`.
요청에 적힌 `e34e3fbd` 이후 원격 변경을 확인하고 최신 원격 main에서 분기했다. 원본 main은 수정하지 않았다.

## 구현

- `app/(protected)/tables/page.tsx`: 전 직원 공용 상황판. 관리자 레이아웃/역할 검사 없이 기존 protected 레이아웃을 사용한다.
- `GET /api/tables`: 기존 `getAuthenticatedActor()`가 서명 세션, 현재 users의 `is_active` 및 `app_login_enabled`를 재검사한다. master/owner/manager/leader/staff를 제한하지 않는다. 응답은 private/no-store이며 인증 실패 시 원천 데이터를 읽지 않는다.
- 하단 기존 🏪 아이콘·크기·위치를 유지하고 `운영/Vận hành`을 `매장/Cửa hàng` Link로 변경했다. `/tables` 및 하위 경로에서 활성화한다. 관리자 노출 정책은 그대로다.
- 모바일 BAR → 1층 → 2층 타일, PC 3열. API가 제공한 실제 테이블 UUID/이름/구역만 표시한다. 인식되지 않은 구역명도 원문을 별도 구역으로 표시하며 임의 층으로 추정하지 않는다.
- 타일 상세는 native modal dialog로 구성했다. 원본 OrderId별 주문·메뉴·수량·단가·메뉴 합계·예상금액·수집 시각을 표시한다. Escape/닫기, 모달 포커스 제한, 열었던 타일로 포커스·스크롤 복귀를 확인했다.
- TableName과 MapObjectName의 NFC/대소문자/양끝 공백만 정규화한다. 전체 목록에서 유일한 정확한 이름만 자동 연결한다. 복합 이름을 분할하지 않으며 같은 주문번호를 가진 별도 OrderId는 합치지 않는다. BAR도 정확히 하나의 실제 테이블과 매칭될 때만 연결한다. 나머지는 접힌 미연결 주문 영역에서 확인한다.

## 원천과 미확인 경계

중앙 수집기·Cron·기존 RPC·DB를 수정하지 않았다. 기존 `pos_open_orders_read`와 영수증 OrderId 증거를 읽고 기존 분류 정책을 재사용한다. 영업일은 `resolveConfiguredBusinessDate()`로 계산한다. 결제완료 영수증이 연결된 주문은 유효한 진행 주문으로 취급하지 않으며, 별도 매출 합계를 만들지 않는다.

신선한 정상 주문 스냅샷·테이블 목록·유일한 이름 매칭이 있고, 해당 주문들이 모두 유효한 진행 주문이며 Tables 가용성 값과 충돌하지 않을 때만 초록 사용 중으로 표시한다. 최신 시도 오류, vanished/incomplete, 10분 초과 지연, 미래 시각, 오래된 개별 주문, 이름 충돌은 미확인이다. 메뉴 불일치는 원문을 보존하면서 별도 상세 확인 표시를 한다. 메뉴 상세가 없는 주문은 정상 진행 상태로 확정하지 않는다.

[CUKCUK Tables 공식 계약](https://graphapi.cukcuk.vn/document/api/tables.html)은 `GET /api/v1/tables/{branchID}`, `Data.ListTable` 및 `AllowMergeTable`을 설명하며 **Offline 동기화에서 테이블 상태 오류가 있을 수 있음**을 명시한다.

이번 작업에서는 **운영 CUKCUK API 호출 0회, 운영 DB 조회·변경 0회**다. 실제 BABA 테이블 수·명칭·구역·예약·결제완료 현재 상태·빈자리의 정확성을 실증하지 않았다. 앱에 샘플 테이블이나 추정 번호를 넣지 않았다. 테스트의 QA 이름은 `tests`/`.local`에서만 사용한다.

- `POS_TABLES_READ_ENABLED` 기본 OFF: 로그인/운영 GET도 호출하지 않는다. 실제 목록이 없으면 총 테이블은 `—`이며 가짜 타일을 표시하지 않는다. 기존 중앙 주문은 미연결로 확인할 수 있다.
- 승인 후 활성화할 수 있는 server-only reader는 기존 로그인·헤더 생성 코드를 재사용한다. 인스턴스 내 single-flight 및 5분 캐시/실패 cooldown을 사용하고, 테이블 요청에는 15초 제한과 재시도 0회를 적용한다. CUKCUK 원문·토큰·고객 정보는 응답/로그에 넣지 않는다.
- `POS_OPEN_ORDERS_READ_ENABLED` 기존 플래그도 존중한다. 주문 목록을 브라우저에서 직접 수집하거나 Cron을 호출하지 않는다.
- 예약·현재 테이블 결제완료·빈자리 판정은 **비활성**이다. 해당 집계는 `null`/`—`이며 0이나 빈자리로 해석하지 않는다. 상태 색상 범례는 Owner 지정 초록/파랑/보라를 사용한다. 미확인은 회색 점선 타일과 문구로 구분한다.

## 검증

- Node 관련 테스트: `table-overview`, `tables-api`, `tables-navigation`, `pos-open-orders-core`, `sales-daily-kpi` **57/57 PASS**.
- 실제 서명 세션 검사 + 모의 users 저장소: 전 역할 허용, 비로그인/위조/비활성/로그인 차단 거부. 공급자 로그인/헤더/테이블 호출은 주입한 모의 함수로만 검증했다.
- 기존 매출/중앙 분류 회귀: 영수증 변환 중복 방지, 불완전 주문 제외, 객단가 보호, 03:00 경계 유지. 그 외 변경 없는 DB·수집기 PASS는 재사용한다.
- 실제 페이지·BottomNav 코드의 오프라인 브라우저 실행: KO/VI × 320/390/430/1280px × 정상/목록 비활성/지연 **24개 조합 PASS**, 역할별 하위 경로 네비 **5개 PASS**. 타일 수/미확인 구분/가로 넘침/복수 주문 상세/Tab/Escape/닫기/포커스·스크롤 복귀 검사. API 응답은 합성 fixture로 대체했으며 운영 자격 증명은 제공하지 않았다.
- TypeScript noEmit, 변경 파일 ESLint, diff 검사 수행. 전체 빌드·실제 로그인된 운영 end-to-end·실제 Tables API 검증과는 구분한다.
- 브라우저 스크립트·캡처·결과는 Worktree `.local/tables-ui-qa/`에만 보관한다.

## main 통합·운영 활성화 전에 필요한 일

1. main 병합/Push/배포 승인은 별도로 받는다. DB/Migration 변경은 없다.
2. 실제 목록 실증은 별도 승인 후 **직렬 로그인 1회 + 테이블 GET 1회, 자동 재시도 0회**로 범위를 정해 수행한다. 현재 BranchID와 실제 구역 매핑을 확인한다. 기존 Cron과 겹치면 공급자 102/동시 로그인 영향이 생길 수 있으므로 Cron 수집과 겹치지 않도록 일정을 정한다.
3. 이 단건 실증 승인과 다수 직원 화면의 상시 Tables 읽기 플래그 활성화 승인은 구분한다. 인스턴스별 캐시는 분산 캐시가 아니어서 서버리스 cold start가 많으면 로그인/GET 횟수가 늘 수 있다. 상시 활성화 전 실제 요청량과 Cron 영향 범위를 Owner와 확정한다.
4. Offline 환경 `IsAvailable`을 현장 점유와 대조하고, 예약·현재 테이블 결제완료 출처/시간 의미를 별도로 검증한다. 이 근거가 확보되기 전 해당 상태를 활성화하지 않는다.

현재 커밋은 Worktree 개발·검증 산출물이다. 운영 현황 실증 완료나 운영 빈자리 안내 승인으로 해석하지 않는다.
