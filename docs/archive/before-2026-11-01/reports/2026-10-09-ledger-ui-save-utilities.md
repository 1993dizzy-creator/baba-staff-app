# 장부 공과금 필터 및 저장 UX 검증 — 2026-10-09

## 범위와 수정 파일

로컬 소스와 격리 테스트만 수행했다. Production 데이터 조회·변경, Migration 적용, 배포, Git 명령은 수행하지 않았다. DB Migration은 추가하지 않았다. 기존 회계·월마감·급여·감사 저장 API와 SQL은 변경하지 않았다.

소스:

- `lib/ledger/entry-list-filter.ts`
- `lib/ledger/entry-save-refresh.ts` (신규)
- `app/(protected)/admin/ledger/entries/page.tsx`
- `app/(protected)/admin/ledger/entries/ManualDisplayEditor.tsx`

관련 테스트:

- `tests/ledger-entry-list-filter.test.ts`
- `tests/ledger-entry-edit-refresh.test.mjs`
- `tests/ledger-manual-display-editor.test.mjs`
- `tests/ledger-entry-status-meal-validation.test.mjs`

이 보고서와 `.tmp/ledger-ui-*` 검증 산출물도 작성했다.

## 원인과 변경 흐름

기존 일반 `load()`는 장부·미납·월마감·투자금 네 API를 조회한다. 일부 수정 저장이 이를 그대로 호출하거나 상세 재조회까지 기다려 저장 대기 시간이 길어졌다. silent refresh는 전체 페이지 로딩 표시를 줄이지만 네 조회 자체를 줄이지 않았다. 10월 2일 돼지고기 수정 당시의 실제 DB 지연·네트워크 기록은 조회하지 않았으므로 그 사건의 원인을 특정하지는 않는다.

React state의 `saving`만으로는 같은 렌더의 연속 클릭을 즉시 차단하기 어렵다. 상세가 닫히거나 월이 바뀐 뒤 돌아오는 저장 응답도 별도로 차단해야 한다.

수정 후 저장 흐름은 즉시 ref 잠금 → 기존 POST와 감사 저장 완료 응답 대기 → 필요한 기존 GET만 조회 → 서버 금액으로 목록·상세 갱신 → 성공 안내·편집 종료다. 상세창은 유지된다. POST 실패 시 입력값을 유지한다. POST 성공 후 조회 실패는 “저장했지만 화면을 갱신하지 못했습니다”로 구분하고 입력값을 유지한다. 이 경우 새로고침 후 실제 반영 상태를 먼저 확인한다.

수기 제목·메모만 변경할 때는 장부 GET 하나, 금액 변경·입고 수정·식대 정정은 장부와 미납 GET 두 개를 사용한다. 입고 수정은 기존 API가 반전·재기장할 수 있어 메모 수정도 두 조회를 유지한다. 월마감 재조회는 생략한다. 금액 변경에서는 기존 투자금 상세 무효화 신호를 유지한다. 목록 전체의 서버 결과를 한 번 받아 날짜 합계·필터·관련 반전 거래까지 일관되게 갱신하며, 단일 거래 금액을 클라이언트에서 임의로 계산하지 않는다.

기존 `loadRequestSequenceRef`와 요청 취소를 유지했다. 추가로 월·선택 거래·화면 세대 검사와 상세 unmount 검사를 적용하여 응답 역전, 월 이동 후 되돌아오기, 상세 닫기를 방어한다. 저장 중 버튼과 편집 입력을 비활성화하며 수기 신규 등록에도 즉시 클릭 잠금을 적용했다.

공과금은 기존 배열·라벨·판별·헤더 구조에 추가했다. 실제 조인된 `ledger_categories`의 정식 이름 `전기료`, `수도료`, `가스비`만 사용한다. 메모·이모지·화면 제목·스냅샷 이름으로 추정하지 않는다. 지출 방향만 포함하고 결제·이체·카드·조정·직원 비용은 제외한다. 날짜 헤더는 기존 지출 subtotal 함수를 재사용한다. 전체/수입/지출의 기존 분기는 유지했다.

## 성능 측정

운영 실측이 아닌 **로컬 HTTP fixture의 7회 중앙값**이다. POST 20ms, 장부 40ms, 미납 60ms, 월마감 120ms, 투자금 110ms의 고정 지연과 동일한 합성 응답을 사용했다. DB 요청 자체의 실행 시간은 측정하지 않았다. 실제 저장 RPC와 감사 기록 비용은 그대로다.

| 경로 | POST 포함 HTTP 요청 | 응답 bytes | POST 중앙값 | 조회 중앙값 | 전체 중앙값 |
|---|---:|---:|---:|---:|---:|
| 기존 | 5 | 20,533 | 29.9ms | 125.2ms | 155.4ms |
| 제목·메모 수정 | 2 | 5,164 | 31.3ms | 46.9ms | 78.2ms |
| 금액·입고·식대 수정 | 3 | 10,287 | 31.5ms | 63.3ms | 94.6ms |

조회 요청은 4→1 또는 4→2, 합성 응답량은 약 75% 또는 50% 감소했다. 운영에서 동일한 속도 개선을 보장하는 수치는 아니다. 저장 RPC 내부의 DB 호출 수는 변경하지 않았다.

근거: `.tmp/ledger-ui-save-benchmark.mjs`, `.tmp/ledger-ui-save-benchmark.json`.

## 검증

- 집중 테스트: 53 통과 / 0 실패. 공과금 포함·제외·날짜 합계·기존 필터, 수기/입고/식대 성공·실패, 클릭 중복, 저장 후 상세 유지, stale 응답·월 변경·unmount, KO/VI 안내를 검증했다.
- 격리 Chrome: 8 통과 / 0 실패. 실제 390px 및 1280px viewport × KO/VI × 저장 성공/실패. 기존 필터 JSX와 실제 수기 편집 컴포넌트·CSS를 번들링하고 가짜 API만 사용했다. 가로 스크롤, 문서 넘침 없음, 저장 중 비활성화, POST 한 번, 성공 후 상세 유지, 실패 시 입력 유지를 확인했다. 운영 APP 전체 인증·서버 통합 테스트는 아니다.
- 변경 소스·테스트 ESLint: 오류 0 / 경고 0.
- 전체 소스 ESLint (`app components lib tests scripts`): 기존 오류 4 / 경고 4. 오류는 `mypage/page.tsx`, `lib/language-context.tsx`, `tests/ledger-manual-amount-edit-db.test.mjs`; 경고는 기존 급여 근태 hook 및 이미지·mypage hook이다. 무관한 파일은 변경하지 않았다.
- Production build (`npm.cmd run build`): 성공. TypeScript 검사와 정적 페이지 생성 완료. 배포하지 않았다.

전체 회귀 최종 결과: **3,700건 중 3,651 통과 / 49 실패 / 신규 실패 0**. 기존 기준 3,683건(3,634 통과 / 49 실패) 대비 테스트 17건이 추가되었으며 기존 실패 파일별 건수가 동일하다. 최초 실행의 새 실패 2건은 JSX prop 순서와 기존 소스 정규식의 코드 인접 순서 차이였으며, 테스트를 완화하지 않고 소스 순서를 복원했다.

| 기존 실패 파일 | 건수 |
|---|---:|
| `inventory-category-groups.test.ts` | 1 |
| `ledger-card-auto-fee-db.test.mjs` | 1 |
| `ledger-card-auto-fee.test.mjs` | 1 |
| `ledger-deployed-qa.test.mjs` | 42 |
| `ledger-owner-settlements.test.ts` | 1 |
| `ledger-payroll-advance.test.ts` | 1 |
| `partner-subtype-emoji.test.ts` | 1 |
| `payroll-overview-waterfall-performance.test.ts` | 1 |

카드 자동 수수료 2건은 기존 참조 Migration 파일 부재, deployed QA 42건은 기존 mock의 `InventoryProjectionResolution` 의존성 누락이다. 다른 5건도 기존 기준과 동일한 실패다. 무관한 복구·급여·계정 로직이나 Migration을 수정하여 실패를 숨기지 않았다. 전체 회귀에는 격리 DB의 #12655 복구·멱등성, 월마감 보호, 전량 취소 0₫ 처리 검증도 포함되어 통과했다. 운영 복구는 재실행하지 않았다.

근거 로그: `.tmp/ledger-ui-focused-final.log`, `.tmp/ledger-ui-full-final.log`, `.tmp/ledger-ui-eslint-changed-final.log`, `.tmp/ledger-ui-eslint-source-final.log`, `.tmp/ledger-ui-build-final2.log`, `.tmp/ledger-ui-browser-results.json`. 모바일 저장 화면: `.tmp/ledger-ui-mobile-ko-saving.png`, `.tmp/ledger-ui-mobile-vi-saving.png`.

## 배포 전 확인

신규 Migration은 없다. 이번 작업의 운영 적용은 소스 검토 이후 별도 승인된 배포 절차로 진행한다. Production 데이터 수정은 필요하지 않다. 승인된 스테이징에서 실제 관리자 인증과 저장 API를 포함한 통합 확인, 공과금 카테고리 정식 이름 확인, 실제 응답 시간을 측정해야 한다. 기존 전체 회귀 실패와 ESLint 오류도 릴리스 판단에 포함한다. 마감된 9월 Revision 3 및 사용자 지정 보호 거래의 수정·정정·재계산은 수행하지 않았다.
