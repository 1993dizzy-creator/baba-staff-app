# /tables 영업 전 상세 UI 최종 정리

## 작업 기준과 범위

- 시작 Worktree HEAD: `0256f3ee659abfe39d35bf3811621b506296c2f3`, 미커밋 변경 없음.
- 시작 main HEAD: `2aec6e63bfe10de910c6c195a89b88fa7c6a8c83`, 미커밋 변경 없음.
- 브랜치: `codex/tables-preopening-final-ui-20261117`. 기존 `be39411e` 상세 최적화와 `0256f3ee` 오류 분류를 보존한 후속 변경이다.
- 사용자가 기존 모달 유지를 선택했다. native modal은 열린 동안 바깥 상단 버튼을 차단하는 기존 동작을 유지한다. 실제 사용자 복구 흐름은 닫기 → 상단 테이블현황 새로고침 → 상세 재진입이다.
- 범위: Worktree 최소 UI 수정·격리 검증·정식 보고서/캡처 생성·로컬 커밋. main 병합·Push·배포·운영 DB·Migration·Cron·CUKCUK API 변경 없음. 급여 및 다른 병행 작업은 수정하지 않았다.

## 수정

1. 상세 헤더에 추가했던 새로고침 버튼을 제거했다. 닫기(X), 결제완료 상태의 청소 버튼은 그대로 유지한다. 상단 `load(true)` 처리, 선택 상세 재조회 및 오류 복구 경로는 변경하지 않았다.
2. 기존 `neutralDetailFailure` 조건, 즉 정상 영업 전 대기·주문/결제 상태 없음·보유 이력/불확실성 없음·영수증 메뉴 실패 아님에 해당하면, 보조 오류 문구를 화면에 표시하지 않는다. `hidden` 진단 요소에 안전한 `data-code`, `data-stage`, `data-status`만 남긴다. 중앙 시계 이모지와 KO `현재 영업전입니다.` / VI `Hiện tại cửa hàng chưa mở cửa.`를 유지한다.
3. 정상 0건 응답에는 진단 요소도 생성하지 않는다. 조회 실패를 결제 이력 0건이나 빈자리로 확정하지 않는다. 실제 이력·결제/취소/재발행/합산 불확실성, 관련 영수증이 존재하는 메뉴 조회 실패, 영업 중 수집 장애 및 청소 오류 경고는 기존대로 표시한다.
4. 기존 영업시간 판정·표시 조건, API 호출 key/effect, 60초 타이머, 요청 취소/역순 응답 방어, 결제 이력, 청소 증거 검증은 변경하지 않았다. KO/VI는 기존 번역 문자열을 사용한다.

실제 제품 소스 수정은 `page.tsx` 한 파일의 버튼 삭제와 중립 실패 표시 요소 변경뿐이다. 회귀 테스트에는 숨겨진 진단 및 헤더 버튼 구성을 검사하는 항목을 추가했다.

## 수정 전후 화면

동일한 격리 데이터와 상세 GET 503으로 비교했다. 수정 전에는 헤더 새로고침 및 상세 미확인 보조 문구가 보이고, 수정 후에는 닫기와 중앙 안내만 보인다. 이때 실패 코드 자체는 DOM 내부 진단에 남아 있다.

| 화면 | 수정 전 | 수정 후 |
| --- | --- | --- |
| KO PC 1280px | [수정 전 캡처](assets/tables-preopening-final-ui-20261117/ko-1280-before.png) | [수정 후 캡처](assets/tables-preopening-final-ui-20261117/ko-1280-after.png) |
| VI 모바일 320px | [수정 전 캡처](assets/tables-preopening-final-ui-20261117/vi-320-before.png) | [수정 후 캡처](assets/tables-preopening-final-ui-20261117/vi-320-after.png) |

## 검증

- 관련 회귀 **219건: 216 PASS / 0 FAIL / 3 SKIP**. tables 전체, store-settings business-time/adapter, admin-sales-business-time, pos-business-day-source 포함.
- SKIP 3건은 기존 `QA_POSTGRES_BIN` 미설정에 따른 native PostgreSQL 자동 관찰·청소 동시성·P0 안전성 검사다. PGlite 기반 결제·청소·30분 자동 전환 검사는 실행하여 통과했다.
- UI 회귀 42 PASS. KO/VI에서 정상 empty 및 일반/context/snapshot/receipts/timeout/response/stale 실패의 화면 문구 제거와 내부 진단 보존, lines/기존 이력/미확인 관계/실제 장애의 경고 유지, 헤더 X/청소 버튼 유지, 상세 새로고침 버튼 없음 및 상단 새로고침 1개를 확인했다.
- KO/VI × 320/360/390/430/1280px: 11:53 정상 대기·0건·503·실제 AbortSignal timeout 경로·복구·유효 이력·불확실한 합산/재발행·영업 중 실제 수집 장애를 확인했다. 모바일 입력은 tap을 사용했으며 가로 넘침 없음과 스크롤 유지 및 중앙 정렬을 확인했다.
- 변경 전후 모두 최초 진입 + 60초 × 5회에서 **목록 GET 6회 / 동일 증거 상세 GET 1회**. 실패/지연 중 추가 5회 목록 갱신에도 상세 GET이 추가되지 않았다. 신규 주문/실제 메뉴 증거 변경 시 상세 GET 1회 추가 및 메뉴 펼침·결제 이력 펼침·포커스·스크롤 보존을 확인했다.
- 실제 사용자 동작인 닫기 → 상단 새로고침 터치/클릭 → 상세 재진입으로 정상 재조회와 오류 복구를 확인했다. 별도로 열린 상세의 선택 상태를 유지한 상단 onclick 이벤트 주입 테스트로 기존 `load(true)`의 선택 상세 재조회 연결도 확인했다. 이 이벤트 주입은 native modal 바깥 버튼에 대한 실제 터치라고 주장하지 않는다.
- 15:59 → 16:00 신규 주문, 17:30, 00:59 → 01:00, 02:59 → 03:00 영업일 전환을 기존 목록 타이머로 확인했다. 지연 OLD 응답이 최신 NEW 영수증을 덮지 않음을 확인했다.
- 최신 collection snapshot과 상세가 달라지면 청소 버튼 비활성화, 갱신 후 청소 POST 1회 및 idle 전환을 확인했다. 서버 결제·취소·재발행·합산·청소·30분 전환 계약은 기존 회귀로 검증했다.
- TypeScript `npx.cmd tsc --noEmit --incremental false` PASS.
- 변경 TSX/MJS 2개 파일 ESLint PASS. 전체 저장소 lint PASS를 주장하지 않는다.
- Production Build: `.local/tables-preopening-final-ui/full-build`의 현재 소스 복제본에서 실제 .env/운영 자격 증명 없이 fake build 전용 설정으로 `next build --webpack`, child exit 0. 배포 없음.
- `git diff --check` 및 보고서 UTF-8/한글 검사 PASS.

검증 로그·bundle·호출 측정 JSON·전체 화면별 캡처는 `C:\workspace\baba-wt-codex\.local\tables-preopening-final-ui\`에 보관한다. 위 비교 캡처 4개는 최종 보고서 자산으로 별도 Git 추적 경로에 보관했다. 모든 재현은 격리된 테스트 응답 및 로컬 DB fixture로 수행했으며 운영 장애 원인이나 실제 운영 이력 0건을 확정한 결과가 아니다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\app\(protected)\tables\page.tsx`
- `C:\workspace\baba-wt-codex\tests\tables-compact-ui.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\tables-preopening-final-ui-20261117.md`
- `C:\workspace\baba-wt-codex\docs\reports\assets\tables-preopening-final-ui-20261117\ko-1280-before.png`
- `C:\workspace\baba-wt-codex\docs\reports\assets\tables-preopening-final-ui-20261117\ko-1280-after.png`
- `C:\workspace\baba-wt-codex\docs\reports\assets\tables-preopening-final-ui-20261117\vi-320-before.png`
- `C:\workspace\baba-wt-codex\docs\reports\assets\tables-preopening-final-ui-20261117\vi-320-after.png`
