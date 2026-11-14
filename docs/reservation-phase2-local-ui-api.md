# BABA 예약 관리 Phase 2 — 로컬 UI·API 구현 보고

기준: `7ed1f6f057bcee7d162374e5c07a35e3eb51482f`, 브랜치 `codex/reservation-phase1-hardening-20261114`.
Codex Worktree 안에서만 수정·검증했다. Main 통합·Push·배포·운영 DB 조회/쓰기·Migration 적용은 수행하지 않았다.

## 구현된 사용자 흐름

- `/tables/reservations` 한 페이지에서 오늘 예약 / Zalo 수신함 / 전체 일정. 기존 매장현황의 테이블 / 예약 메뉴 유지. 관리자 예약 페이지 없음.
- 오늘 건수·대기 건수·예정 인원, 시간순 카드, 확정 담당 직원 ID, 방문 날짜와 영업일 구분. 예정 인원은 pending/confirmed/arrived 합계다.
- 수동 등록·수정·상세 모달: 고객명·연락처·방문 날짜/시간·인원·이용 시간·구역/테이블·특별 요청사항. 등록은 pending이며 자동 확정하지 않는다.
- 기존 확정 API 재사용. 다른 전이·수정·배정·연락처 열람은 기존 관리 권한만 허용한다.
- 수정 시 마스킹된 연락처를 원문처럼 저장하지 않는다. 연락처 입력이 없으면 유지하고, 별도 삭제 선택 또는 새 값 입력 때만 변경한다. 전체 연락처 보기는 명시적 버튼과 기존 RPC 열람 감사로 처리한다.
- 등록과 초기 테이블 배정은 기존 RPC 두 번으로 수행한다. 배정 충돌 시 생성된 예약을 삭제하거나 새로 만들지 않고, 상세에 배정 미완료 안내와 재배정 동작을 제공한다. 두 작업이 원자적이라는 보장은 하지 않는다.
- Inbox 기간·상태 조회, 권한 있는 직원의 원문 검토, 수동 후보 등록·원본 연결, 격리 재검토·무시, 중복 수신 및 payload 변경 감지 표시. 일반 메시지 text, 잘못된 JSON raw body, 미지원 형식 raw payload의 표시용 JSON을 지원한다.
- 월간 달력(월요일 시작 42칸), 월 선택, 영업일 선택, 목록 전환, 상태 필터. 조회 상한 도달 시 날짜 범위 축소 안내.
- KO/VI, 모바일 하단 시트·PC 중앙 모달, 네이티브 dialog의 포커스 관리와 ESC, 요청 중 버튼 잠금, 동기 ref로 이중 제출 차단, 20초 타임아웃·요청 취소·401 로그인 이동·403·409·빈 목록·로딩·재시도 상태.

## API와 기존 RPC 연결

모든 경로의 접두사는 `/api/tables/reservations`다. 모든 요청은 `getAuthenticatedActor()`를 실행한다. 브라우저의 actor ID·role은 전달하지 않고 서버 actor만 사용한다. 별도 public DB 함수나 Migration을 만들지 않았다.

| Method / suffix | 기존 RPC | 권한·응답 |
|---|---|---|
| GET `/` | `reservation_list_v1` | 전체 5개 역할. 기간별 목록·당일 요약·서버 권한·27개 카탈로그. 기간 최대 93일, 목록 최대 1000건 경고 |
| POST `/` | `reservation_create_v1` | Leader/Manager/Master/Owner. HTTP requestKey UUID 필수, Inbox 연결 선택, 최소 생성 결과 |
| GET `/[id]` | `reservation_get_v1` | 전체 5개 역할. 역할별 상세·이력 DTO. reveal=1은 관리 역할만, 기존 contact_viewed 기록 |
| PATCH `/[id]` | `reservation_update_v1` | 기존 관리 역할. expectedVersion 필수 |
| POST `/[id]/confirm` | `reservation_transition_v1` | 기존 Phase 1 파일 그대로 재사용. 전체 5개 역할의 pending → confirmed |
| POST `/[id]/transition` | `reservation_transition_v1` | 기존 관리 역할의 확정 외 전이. 취소 사유 필수 |
| POST `/[id]/tables` | `reservation_link_table_v1` | 기존 관리 역할. 27개 검증 UUID에 한정 |
| DELETE `/[id]/tables` | `reservation_release_table_v1` | 기존 관리 역할. expectedVersion·linkId |
| GET `/inbox` | `reservation_inbox_list_v1` | 기존 관리 역할. 최대 93일·500건 경고, 목록에서는 원문 제외 |
| GET `/inbox/[id]` | `reservation_inbox_get_v1`, 연결 시 `reservation_get_v1` | 상세에 필요한 원문·연결 예약·조회 가능한 예약 이력만 반환 |
| POST `/inbox/[id]/dismiss` | `reservation_inbox_dismiss_v1` | 기존 관리 역할 |
| POST `/inbox/[id]/reprocess` | `reservation_inbox_get_v1` → 서버 `buildZaloInboxPlan` → `reservation_inbox_reprocess_v1` 또는 `reservation_inbox_dismiss_v1` | 저장된 원본과 hash만 사용. 클라이언트 entry는 무시. 서버 Allowlist가 없으면 503 |

모든 응답은 `private, no-store`와 `Vary: Cookie`다. RPC 결과를 직접 전달하지 않는다. 오류에는 허용한 코드·현재 버전·충돌 예약 ID만 포함하고 DB 메시지·원문·추가 필드는 반환하지 않는다. 쓰기 JSON은 8KiB로 제한하며 필드 길이·날짜·오프셋·정수·버전·UUID를 검증한다.

## 권한·개인정보·DB 계약 보존

Staff는 고객명·연락처(일부 번호 포함)·메모·취소 사유·Inbox ID를 받지 않는다. 이벤트 changes와 테이블 해제 사유도 공개하지 않는다. 자유 입력을 정규식으로 안전하다고 추정하지 않고 필드 자체를 제외한다. 다른 네 역할의 기존 관리 권한을 유지했으며 이를 최종 운영 개인정보 정책 승인으로 해석하지 않는다.

Staff의 등록·수정·기타 전이·배정·해제·Inbox·전체 연락처 요청은 HTTP에서 차단된다. 직접 RPC 호출 권한도 Phase 1의 service_role 전용 계약이 유지된다. 활성 상태·로그인 허용 상태는 서버와 DB에서 재확인한다.

테이블은 `lib/sales/baba-table-catalog.ts`의 UUID를 사용한다. 클라이언트와 API 모두 선택 목록을 제한하고 최종 DB FK·GiST exclusion·행 잠금·버전 검사에 따른다. 기존 테이블 점유/POS 코드와 영수증 상태는 수정하지 않았다.

두 정식 Migration, 수동 롤백, 기존 Webhook·persist 코드, 인증 코드, 공통 영업일 코드, package/lock 파일, Phase 1 회귀 테스트 및 fixture는 기준 커밋 대비 변경 없음이다. 03:00 영업일·Asia/Ho_Chi_Minh·Inbox 1건당 예약 1건·append-only 이력 계약도 유지한다.

## 검증과 증거

최종 실행:

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/reservation-phase2-api.test.mjs tests/reservation-phase2-client.test.mjs tests/reservation-phase2-browser.test.mjs
```

- **유효한 총 15개 PASS**, 실패·스킵 0. 통합 15개 실행 로그는 `.local/reservation-phase2/final-tests.log`다. 이후 배정 완료 안내를 보완하고 영향받은 브라우저 7개를 `.local/reservation-phase2/browser-tests.log`에서 재실행해 모두 통과했다(약 28.8초). 변경 없는 API·클라이언트 8개는 기존 실행 증거를 재사용한다.
- API 통합 6개: 실제 서명 세션 인증 함수와 두 정식 Migration을 실행한 PGlite를 연결. 5개 역할 목록·상세, Staff 필드 제한·권한 확대 차단, 위조 actor 무시, 연락처 열람 감사, 생성·수정·배정·해제·취소, 중복 Inbox, 재처리 원본 신뢰 경계, 입력·날짜·버전·실제 UUID·409·DB 오류 차단.
- 클라이언트 2개: private no-store, 요청 취소·타임아웃 결합, KO/VI 오류 메시지와 원문 비노출.
- 브라우저 7개(Node 부모 1 + 시나리오 6): Chrome에서 실제 페이지 → 실제 Next API → loopback PostgREST 형태의 테스트 전송 계층 → PGlite → 화면. 예약 API 응답을 가짜 성공 값으로 대체하지 않고 실제 RPC를 실행한다. 로딩·빈 목록·오류의 표시 검증에만 의도적으로 응답을 대체했다.
- 실제 테이블 배정 충돌과 부분 생성 상태, stale version 409 후 새 상태 확인, Staff 확정·다음 요청 로그인 차단, 원문→후보→연결, 격리 JSON 원문·재검토·무시를 검증했다. 브라우저 예외 0.
- KO/VI × 320/390/430/1280px에서 등록 모달·달력의 가로 넘침, 모바일 하단·PC 중앙 배치를 검증했다. Staff KO/VI 상세는 320px에서 추가 확인했다. `ko-*.png`, `vi-*.png`, `staff-*.png`, `ko-conflict.png`가 `.local/reservation-phase2/`에 있다.
- **예약 범위의 Next 16.2.1 production build PASS** (`.local/reservation-phase2/preview-build.log`). 실제 예약 페이지·컴포넌트·기존 테이블 메뉴·API를 격리 Next 앱으로 빌드했다. 기존 보호 레이아웃 전체와 다른 업무 페이지의 full-repository Build를 검증한 것은 아니다.
- 변경 페이지·컴포넌트·라이브러리·API 의존성의 TypeScript PASS (`.local/reservation-phase2/types.log`). 변경 소스·테스트의 ESLint PASS (`.local/reservation-phase2/lint.log`).
- 기존 **61개 Phase 1 PASS는 재사용**했다. 기준 `7ed1f6f0` 대비 해당 SQL·API·인증·Webhook·공통 영업일·의존성·테스트 파일에 diff가 없음을 확인했다. 증거는 기존 `.local/reservation-phase1/final-tests.log`(59 PASS), `.local/reservation-phase1/final-db-concurrency.log`(19 PASS, 중복 제외 누적 61개)이며 실제 PostgreSQL 잠금 경쟁 8개도 포함한다. 이번 단계에 동일 61개를 다시 실행했다고 보고하지 않는다.

테스트는 고객정보 대신 합성 데이터를 사용했다. 브라우저 테스트는 `.local/reservation-phase2/preview` 안에 환경 파일 없는 앱을 생성하고 가짜 키·테스트 세션과 loopback DB 전송 서버만 사용한다. 브라우저 프로필·캐시·임시 파일·스크린샷도 Worktree `.local/`에 둔다. 서버·브라우저·DB는 테스트 종료 시 닫는다. 운영 Supabase/POS에 접근하지 않는다.

브라우저 테스트 의존성은 기존 `.local/browser-qa/node_modules/playwright`와 설치된 Chrome이다. 필요 시 Worktree 안에만 설치한다.

```powershell
npm.cmd --cache .local/npm-cache install --prefix .local/browser-qa --no-audit --no-fund playwright@1.65.0
```

## 남은 기능·운영 정책과 Main 통합 전 확인

1. **Inbox 개별 처리 담당자·이력은 미제공**: 기존 inbox RPC는 reviewed_by/reviewed_at 및 inbox 이벤트를 반환하지 않는다. 화면은 제한 안내, 수신/재검토 횟수·상태·검토 메모와 연결 예약의 등록/확정 이력을 제공한다. 이를 Inbox 전체 처리 이력이라고 표시하지 않는다. 추가 제공은 별도 RPC 계약 변경 승인 범위다.
2. **직원 이름·별도 배정 담당자 필드 없음**: 현재 RPC의 actor/confirmedBy ID를 직원 번호로 표시한다. 상세 등록 담당은 reservation_created 이벤트에서 확인한다. 오늘 카드의 담당은 확정 담당이며 pending은 확정 전이다. 추가 인사정보 조회나 DB 필드를 임의로 도입하지 않았다.
3. 개인정보 열람 범위·보존기간, PRIVATE/출처 불명 메시지 저장, Zalo 재전송·장애 복구 정책, 복수 예약 정책은 기존 미확정 상태다. 권한이나 공개 범위를 확대하지 않았다.
4. 실제 Zalo·POS·운영 Supabase, 운영 Migration·배포·외부 인증 환경은 검증하지 않았다. 운영 상태 확인·적용 승인은 별도다. 특히 후속 Phase 1 Migration은 기존 데이터가 있으면 중단하는 계약이다.
5. 등록과 배정은 별도 트랜잭션이다. 이 구분은 UI와 API 결과에 반영했다. 원자적 일괄 처리나 다중 예약 정책을 추가하려면 별도 DB 계약이 필요하다.
6. 작업 중 Main은 직원 생성 작업을 `ee24f73ff8502686d3e297b89b434f0fdc224c29`에 커밋해 깨끗한 상태가 됐다. 해당 변경과 Phase 2 경로 교집합은 0개이며 인증·테이블·카탈로그·package 파일도 겹치지 않았다. Main을 수정하거나 통합하지 않았다. Claude는 `bf68261e`와 기존 미추적 6개를 유지한다.
7. Main 통합 직전 실제 최신 HEAD·경로 충돌·인증/API 계약을 다시 확인하고, 필요한 승인 범위에서만 진행해야 한다. 아직 실제 병합 결과는 검증하지 않았다. 전체 앱 Build·보호 레이아웃 통합은 필요 범위에서 추가 확인한다.

판정: 위 제한을 명시한 Phase 2 로컬 UI·API 기반은 검증 완료. Main 통합·운영 적용은 Owner 승인 단계로 남긴다.

## 변경 파일 전체 경로

```text
C:\workspace\baba-wt-codex\app\(protected)\tables\reservations\page.tsx
C:\workspace\baba-wt-codex\app\api\tables\reservations\[id]\route.ts
C:\workspace\baba-wt-codex\app\api\tables\reservations\[id]\tables\route.ts
C:\workspace\baba-wt-codex\app\api\tables\reservations\[id]\transition\route.ts
C:\workspace\baba-wt-codex\app\api\tables\reservations\inbox\[id]\dismiss\route.ts
C:\workspace\baba-wt-codex\app\api\tables\reservations\inbox\[id]\reprocess\route.ts
C:\workspace\baba-wt-codex\app\api\tables\reservations\inbox\[id]\route.ts
C:\workspace\baba-wt-codex\app\api\tables\reservations\inbox\route.ts
C:\workspace\baba-wt-codex\app\api\tables\reservations\route.ts
C:\workspace\baba-wt-codex\components\reservations\client.ts
C:\workspace\baba-wt-codex\components\reservations\ReservationDetail.tsx
C:\workspace\baba-wt-codex\components\reservations\ReservationDialog.tsx
C:\workspace\baba-wt-codex\components\reservations\ReservationForm.tsx
C:\workspace\baba-wt-codex\components\reservations\ReservationInbox.tsx
C:\workspace\baba-wt-codex\components\reservations\ReservationRows.tsx
C:\workspace\baba-wt-codex\components\reservations\reservations.module.css
C:\workspace\baba-wt-codex\docs\reservation-phase1-inbox-foundation.md
C:\workspace\baba-wt-codex\docs\reservation-phase2-local-ui-api.md
C:\workspace\baba-wt-codex\lib\reservations\dto.ts
C:\workspace\baba-wt-codex\lib\reservations\policy.ts
C:\workspace\baba-wt-codex\lib\reservations\server-api.ts
C:\workspace\baba-wt-codex\lib\reservations\types.ts
C:\workspace\baba-wt-codex\lib\text\reservations.ts
C:\workspace\baba-wt-codex\tests\reservation-phase2-api.test.mjs
C:\workspace\baba-wt-codex\tests\reservation-phase2-browser.test.mjs
C:\workspace\baba-wt-codex\tests\reservation-phase2-client.test.mjs
```
