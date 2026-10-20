# /inventory 품목로그 로딩·Keg 조회 개선 검증

2026-10-20. 로컬 코드 수정 및 테스트만 수행했다. 운영 DB 조회·변경, RPC 변경, Migration, Git 명령, Push·배포는 실행하지 않았다.

수정한 제품 파일:

- `components/inventory/InventoryPageContent.tsx`: 공통 `InventoryLoadingCard`로 품목로그 로딩 표시. 제목·품목명·닫기 유지. 오류·빈 상태 분리 및 재시도. 모달 요청별 AbortController와 요청 객체 확인으로 닫기·품목 전환 후 이전 응답 반영 차단. Keg 상세 중복 요청 방지.
- `app/api/inventory/items/[id]/logs/route.ts`: `/inventory`는 `includeKegSalesBreakdown=false`를 보내 저장된 종료 세션 요약만 조회. `kegLogId` 지정 시 인증 후 품목 ID·로그 ID·keg_replace 출처를 함께 확인하고 해당 기록만 기존 계산 함수로 상세 조회. 다른 화면에서 사용하는 기본 전체 응답은 유지.
- `components/InventoryLogGroupCard.tsx`: 기록별 선택적 상세 영역 추가. 해당 prop이 없는 기존 사용처는 기존 렌더링 유지.
- `lib/text/inventory.ts`: KO/VI 상세 조회·미확인·실패·빈 구성·재시도 문구 추가.

추가한 테스트 파일:

- `tests/inventory-item-logs-lazy-keg.test.mjs`
- `tests/inventory-item-logs-browser.test.mjs`
- `tests/helpers/inventory-item-logs-fixture.mjs`

`lib/inventory/keg-replacement-summary.ts`는 수정하지 않았다. 기존 저장 요약 함수와 전체 상세 함수를 재사용한다. 저장된 판매량·용량·잔량·로스율·초과량·사용 기간은 그대로 표시한다. 잔/타워 판매 구성·평균·불일치 판정의 기존 수식, 2700/3000ml 매핑 설정, 판매 제외 규칙은 변경하지 않았다. 상세 조회 전에는 저장 판매량과 구성의 일치 여부가 미확인임을 표시한다. 조회 후 기존 불일치 경고를 그대로 표시하며 실패를 0 판매로 처리하지 않는다.

측정은 운영 측정이 아닌 로컬 모의 데이터 실측이다. L3/L4 각각 교체 50건, 종료 세션 50건, 영수증 500건, 판매행 1,000건을 사용했다. DB 클라이언트를 메모리 모형으로 대체하고 각 SELECT 완료에 최소 3ms 지연을 설정했다. Windows 타이머·스케줄링으로 실제 누적 지연은 설정치보다 크다. 아래 시간은 단일 실행값이며 평균·운영 응답시간을 의미하지 않는다.

| 초기 API 지표 | L3 기존 → 개선 | L4 기존 → 개선 |
| --- | --- | --- |
| SELECT 수 | 230 → 2 | 230 → 2 |
| 모의 DB 읽기 누적 시간 | 3,482.5 → 31.9ms | 3,491.8 → 23.9ms |
| 핸들러 응답 시간 | 3,538.1 → 33.7ms | 3,526.8 → 26.0ms |
| UTF-8 JSON 크기 | 47,244 → 30,052B | 47,244 → 30,052B |
| 초기 HTTP 요청 수 | 1 → 1 | 1 → 1 |

초기 POS 조회는 228회에서 0회로 줄었다. 상세 기록 하나를 선택하면 HTTP 요청 1회가 추가된다. 이 모형에서 선택 상세는 SELECT 9회, 응답 617B이며 L3 137.9ms / L4 127.1ms였다. 모든 상세를 선택하면 각 기록의 POS 계산 비용은 발생한다. 계산 자체를 축약하거나 캐시해 과거 불일치를 감추지 않는다.

브라우저는 수정 전 컴포넌트 사본과 수정 후 실제 컴포넌트를 같은 로컬 테스트 앱에서 실행했다. 모든 API를 가로채 위와 동일한 데이터의 별도 측정 핸들러 시간을 응답 지연으로 재현했다. KO 데스크톱에서 버튼 클릭부터 저장 요약 첫 표시까지 L3 3,932.8 → 187.3ms, L4 3,969.5 → 192.4ms였다. 이 측정 역시 실제 운영 API 네트워크·DB 측정은 아니다.

검증 결과:

- 관련 회귀 32개 통과: 기존 Keg 계산·요약·보안·로그·스냅샷 검사와 신규 API 테스트 2개 포함.
- 추가 조회 I/O 회귀 16개 중 10개 통과·6개 실패. 실패한 6개는 이번에 수정하지 않은 `/api/inventory/logs`를 불러오는 기존 테스트의 모의 의존성 `@/lib/inventory/daily-effective-purchases` 누락(`Unexpected dependency`)으로 발생했다. 해당 테스트와 API는 변경하지 않았다.
- 신규 브라우저 테스트 통과: KO/VI × 1280px PC·360px 모바일. 일반 품목, Keg 50건, 스피너·reduced-motion, 제목/품목명/닫기 유지, 빈 상태, HTTP 오류·네트워크 실패·잘못된 JSON·재시도, 상세 오류·재시도, 저장 불일치 경고, 중복 클릭, 늦은 L3 로그·상세가 L4에 혼입되지 않음 확인. API 요청은 모두 가로채며 외부 요청도 차단.
- 변경 파일 ESLint 통과.
- 전체 `app components lib tests` ESLint는 기존 6개 오류·4개 경고로 실패. 변경 파일에서는 오류 없음.
- `tsc --noEmit --incremental false`는 기존 오류 40개로 실패. 수정 전후 진단이 텍스트 단위로 동일하며 신규 오류 없음.
- Production Build 통과: 컴파일, TypeScript 빌드 검사, 정적 페이지 72개 생성 완료.

운영 L3·L4 실제 세션/판매량 및 운영 속도는 사용자 제한에 따라 조회·검증하지 않았다. 제공된 모의 이력에서는 50건 모두 보존되고 상세 결과가 기존 전체 응답과 일치했다. 원격 DB에 대한 성능 개선 수치는 주장하지 않는다.

검증 산출물: `.qa-review/keg-logs/api-benchmark.json`, `.qa-review/keg-logs/browser-benchmark.json`, `.qa-review/keg-logs/browser/` 스크린샷. API 테스트는 운영 연결 없이 실행 가능하다. 브라우저 회귀는 `PLAYWRIGHT_MODULE_PATH`, `QA_UI_BASE_URL`을 설정해 실행한다. 수정 전 UI 비교를 추가하려면 동일 원본 컴포넌트를 제공하는 테스트 경로를 `QA_INVENTORY_BEFORE_PATH`에 지정한다.
