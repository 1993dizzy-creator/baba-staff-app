# 2026-10-18 지급 V2 배포 전 최종 점검

## 결론 및 범위

현재 배포 대상인 C:/workspace/baba-membership의 API·UI·Cron·기타 서버 코드에는 V1 직접 지급 호출이 없다. V2 내부 호출은 유지했다. 비정상 요청 기록 차단과 KO/VI 428 새로고침 안내만 보완했다. 운영 DB 데이터/DDL/Migration, Google Sheets, Git Push, Vercel 배포는 수행하지 않았다.

로컬 검증은 완료했지만 **운영 V1 권한 회수는 아직 실행하면 안 된다.** 운영 DB 함수 소유자·배포 밖 호출자·pg_cron 확인이 선행 조건이다. 해당 읽기 전용 조회는 Supabase MCP가 승인 정책 never로 차단하여 이번 세션에서 확인하지 못했다.

## 1. V1 호출 경로 조사

app/lib/scripts/supabase와 설정의 717개 소스·SQL·설정 파일을 조사하고 TypeScript AST로 RPC 호출115곳을 분류했다. 동적으로 이름을 선택하는5곳도 확인했다. 추가로 Git 제외/숨김 디렉터리까지 no-ignore 검색했다. 환경변수·자격증명 값은 출력하지 않았다.

| 영역 | 조사 결과 |
| --- | --- |
| 지급 HTTP API | app/api/admin/ledger/payables/pay/route.ts가 V2만 호출 |
| 일반 거래처 UI | PayablePartySheet의 선택 일자 지급·부분지급 모두 sendPayablePayment → 기존 HTTP API → V2 |
| 결제 미확인 UI | 개별·일괄 지급 모두 같은 공통 클라이언트 → HTTP API → V2 |
| 등록 Cron10개 | vercel.json 등록 경로 및 서버 의존 코드에서 V1 호출 없음 |
| 기타 서버·스크립트 | 현재 소스의 직접 V1 호출 없음 |
| SQL | 신규 V2 함수 안의 V1 내부 호출1곳 유지. 나머지 V1 참조는 원래 함수 정의/권한 및 과거 ad-hoc 변경·복원 Migration |
| 테스트 | V1 위험 재현·기존 호환성·기초 지급 회귀용 의도적 호출 유지. 운영 호출자가 아님 |
| 문서·감사 SQL | 주석·기존 계약 설명만 존재 |
| 과거 임시 복사본 | .tmp/deploy-early-leave/repo/app/api/admin/ledger/payables/pay/route.ts에는 V1 호출 존재 |

과거 복사본은 10/6 생성된 별도 임시 배포본이며 Git 제외 디렉터리다. git worktree list에는 현재 main 작업 트리 하나만 등록돼 있다. 임시 복사본은 현재 APP 빌드의 소스/의존 경로가 아니므로 기존 자료로 보존했다. **이 복사본에서 배포하면 안 되며, 운영 전환은 현재 루트의 검토된 소스로 진행해야 한다.** 과거 복사본을 별도로 되살려 배포해야 한다면 V2 Migration·공통 지급 클라이언트·전체 UI/API 전환을 함께 가져와 재검증해야 한다. API 한 줄만 바꾸는 것은 키 없는 UI를 남기므로 안전하지 않다.

동적 RPC5곳:
- ledger/candidates: candidate_type에 따라 ledger_resolve_inventory_candidate_v1 또는 ledger_resolve_candidate_v2.
- ledger/inventory-projection resolve: 정정 V1/V2 중 선택.
- bar/keepings actions: bar_update_and_move_keeping 또는 서버 상수 bar_mutate_keeping_v5.
- sales/pos-business-day-close: sales_close_business_day_after_sync_v1 / sales_close_business_day_v1.
- sales/pos-business-day-final: claim/release/finalize sales RPC의 고정 이름만 전달.

Cron 경로:
inventory/snapshot, sales-sync, sales-sync-final, sales-deductions, sales-deductions-final, ledger-meal-auto-post, ledger-meal-source-sync, ledger-reserve-schedule, sales-close-final, payroll-quyen-menu-incentive. 이 중 어느 경로도 지급 V1을 호출하지 않는다.

따라서 현재 운영용 소스에서 추가로 V2로 바꿀 호출자는 없었다. 검색 증거는 .qa-review/october-settlement/predeploy-caller-audit.json에 보존했다. 원격 DB에만 등록된 함수/pg_cron, 외부 서비스·수동 service_role 호출, 이미 운영 배포된 이전 버전의 트래픽까지 없다고 주장하지 않는다.

## 2. 최소 안전성 보완

### 비정상 완료 기록

수정 파일: supabase/migrations/20261018105936_add_payable_payment_idempotency_v2.sql.

이전 단계에서 운영 미적용으로 남긴 로컬 신규 Migration에 기존 요청 검사만 추가했다. 적용 완료된 과거 Migration은 수정하지 않았다.

동일 actor·동일 정규화 요청인 기존 기록이라도 다음 상태면 idempotency_state_invalid를 반환한다.

- result IS NULL
- completed_at IS NULL
- result가 JSON null/배열 등 객체가 아닌 값
- result에 status가 없거나 빈 문자열

API는 이를 HTTP409 / IDEMPOTENCY_STATE_INVALID로 전달한다. UI는 기술 코드를 표시하지 않고 관리자에게 기록 확인을 요청하는 KO/VI 안내를 표시한다.

이때 기존 기록을 삭제/완료 처리하거나 V1을 다시 실행하지 않는다. 지급·이동·배분·감사 기록 및 잔액을 변경하지 않는다. 클라이언트는 해당 오류를 “지급 거절 확정” 코드로 취급하지 않아 원 키를 유지하고, 변경된 새 지급 요청을 보내지 않는다. actor/본문 불일치 검사는 기존과 같이 먼저 수행한다.

### 428 안내

키 없는 정상 형식 요청은 기존과 같이 RPC 호출 없이 HTTP428이다. 응답에 action:refresh와 KO/VI message를 추가했다. 서버와 UI는 lib/ledger/payable-payment-messages.ts의 같은 문구를 사용한다.

일반 선택 일자·부분지급·결제 미확인·기존 요청 재확인 UI 모두 428일 때 안내문과 “화면 새로고침 / Tải lại trang” 버튼을 제공한다. 버튼은 페이지를 다시 불러오며 sessionStorage의 원 키/본문을 지우지 않는다. 인증403·428·결과 불확실 오류에서 키를 보존하는 기존 구현도 유지했다.

**검증 범위:** 현재 UI의 전송에서 키를 제거하여 실제 API에 구버전 요청을 전달하는 방식으로 호환 분기를 검증했다. 이미 열린 과거 JS 번들에 새 문구/버튼을 소급 주입하는 기능은 아니다. 예전 번들은 일반 오류만 표시할 수 있으므로 운영 전환 시 해당 화면은 수동 새로고침/재접속이 필요하다. HTTP428 응답만으로 오래된 fetch 클라이언트가 자동 갱신된다고 주장하지 않는다.

## 3. V1 권한 회수 후 내부 호출 검증

격리 PostgreSQL에서 다음을 수행했다.

1. 기존 V1 정의/권한과 신규 V2를 로드.
2. V1의 service_role EXECUTE를 REVOKE.
3. has_function_privilege(service_role,V1,EXECUTE)=false 확인.
4. SET ROLE service_role 상태에서 직접 V1 호출 → permission denied.
5. 같은 role에서 V2 호출 → 지급 성공.
6. 동일 키 V2 재시도 → 같은 전표 반환, 이동/배분/감사 추가 없음.
7. 직원 actor 요청 → forbidden.
8. 전표·이동·배분·감사·요청 기록은 성공1건씩만 생성.

권한 회수는 테스트 DB에서만 실행했다. 권한 제어는 호출자 service_role과 V2 함수 소유자를 구분한다. 현재 격리 모델에서 V1·V2 소유자는 postgres이며, V2 SECURITY DEFINER가 소유자 권한으로 V1을 실행하므로 service_role 직접 권한이 없어도 작동한다.

운영에서도 V2 SECURITY DEFINER와 고정 search_path를 유지하고, V2 소유자가 회수 이후에도 V1을 실행할 수 있어야 한다. **V2 소유자가 service_role이거나 회수할 권한에 의존한다면 이 결론을 그대로 적용할 수 없다.** 승인된 사전 조회로 확인하고, 필요한 소유권/내부 실행 권한 변경은 별도 검토된 후속 Migration으로 다뤄야 한다. 이번 Migration에 무조건적인 V1 권한 회수를 넣지 않았다.

## 4. 데이터 불변성

읽기 전용 비교 시각: 이전 최신 스냅샷 UTC11:11:30 → 이번 UTC11:37:15.

| 테이블 | 기존/현재 건수 | 수정·삭제 | 추가 |
| --- | ---: | ---: | ---: |
| ledger_transactions (11/1 이전) | 2,839 / 2,839 | 0 | 0 |
| ledger_payables | 1,367 / 1,367 | 0 | 0 |
| ledger_payable_allocations | 1,086 / 1,086 | 0 | 0 |
| ledger_movements | 1,389 / 1,389 | 0 | 0 |

원금·기존 지급·배분·source_snapshot의 수량/단가·기존 조정 기록이 모두 동일하다. 전 단계에 추가됐던 직원 식대 #2920도 동일하게 포함한 스냅샷 기준이며, 이번 재검증 중에는 새로운 전표가 없었다.

10월678전표 / 422채무 / 유효 원입고402건을 다시 계산했다.

| 검증 항목 | 변경 전 = 변경 후 |
| --- | ---: |
| 조정9건 원매입 | 497,100₫ |
| 기존 비현금 조정 | -7,100₫ |
| 인정금액 / 실제 지급 | 490,000₫ / 490,000₫ |
| 조정9건 최종 미지급 | 0₫ |
| 10월 발생 채무 잔액(확인 대기 포함) | 71,755,950₫ |
| 일반 월말 채무(이월 포함, 확인 대기 제외) | 121,593,180₫ |
| 확인 대기 | 29건 / 8,404,650₫ |
| 10월 비용 / 손익 | 166,907,119₫ / 272,434,301₫ |
| 매장 현금 / 법인계좌 | 46,313,406₫ / 286,990,544₫ |
| CHO / Vuong | 26,405,081₫ / 5,413,910₫ |

카테고리38개와 거래처별 잔액이 같고, 기존 #2911~2919는 중복 집계되지 않으며 정산 완료9건은 결제 미확인에서 제외된다. 보호 대상 잔액76,300₫·40,000₫과 10/11 돼지고기1,968,000₫ 보류를 유지한다. 10/16 이후 및 급여·마감·입고 정정 V3를 수정하지 않았다.

근거: predeploy-live-invariance.json, predeploy-snapshot.json, predeploy-audit/comparison.json, predeploy-audit/per-receipt.csv. 모두 .qa-review/october-settlement 아래이며 Git 제외 자료다.

## 5. 테스트 결과

| 항목 | 결과 |
| --- | --- |
| 정산/API/UI/키 검증/클라이언트/네이티브 DB | 201/201 통과 |
| 지급 검증 DB·입고 정정·월마감·급여·식대·시스템조정 | 108/108 통과 |
| 비브라우저 합계 | **309/309 통과**, 실패/skip0 |
| 네이티브 DB 부분집합 | 22/22 통과 |
| 전체 원입고 독립 SQL 계산 | 402건 전건 일치, 원본 해시 유지 |
| 신규 지급 브라우저 | KO/VI × PC/모바일 × 일반/확인 대기 =8조합 통과 |
| 기존 통합 조회 브라우저 | KO/VI × PC/모바일 =4조합 통과 |
| 브라우저 합계 | **2개 테스트 / 12개 조합 통과** |
| 변경 파일 ESLint | 오류0·경고0 |
| 전체 tsc --noEmit | 이전과 동일한 기존 테스트 오류40건, 새 오류0 |
| Production Build | 통과, Next16.2.1, TypeScript 및 정적 페이지72개 생성 |
| git diff --check | 통과 |

네이티브 DB는 loopback 전용 PostgreSQL18.4이고 운영17.6 직접 실행 검증은 아니다. 브라우저는 실제 컴포넌트와 실제 API 핸들러, 격리 PGlite의 실제 V1/V2를 연결하고 인증을 fixture로 대체했다. 운영 API 쓰기는 모두 가로챘다.

- 동일 키12회 연속/12세션 동시, 서로 다른 정상 부분지급12개 동시, 초과지급 경합 유지.
- 커밋 후 응답 유실504·권한403·새로고침·오래된 키·키 내용 변경 검증 유지.
- NULL/잘못된 result7종 각각12회 연속+12세션 동시 요청에서 추가 지급/감사0, 원 기록 동일.
- V1 직접 실행 권한 회수 후 service_role의 V2 지급/재시도 성공, 직접 V1은 실패.
- 이동/배분/감사 강제 실패와 트랜잭션 abort 전체 롤백.
- 키 없는 API428에서 RPC0회, KO/VI 안내, 실제 새로고침, 원 키 보존까지 브라우저8조합 확인.
- 관리자 권한·RLS·월마감·비현금 조정 완료 채무의 재지급 차단 유지.

로그: predeploy-regression.log, predeploy-protection.log, predeploy-native.log, predeploy-browser.log, predeploy-display-browser.log, predeploy-eslint.log, predeploy-types.txt, predeploy-build.log.

## 6. 운영 전환 순서

운영 반영은 별도 승인 후 진행한다.

1. 현재 루트의 검토된 소스를 배포 원본으로 확정한다. 과거 .tmp 복사본은 배포에서 제외한다. 지급 진행 요청·과거 V1 응답 불확실 건을 먼저 확인하고, 전환 중 새 지급 요청이 들어오지 않게 운영상 통제한다.
2. [읽기 전용 사전 조회](../ledger-payable-v2-preflight.sql)로 Migration 이력·함수/소유자·권한·서버 함수 호출자·pg_cron을 확인한다. 외부 서비스·수동 스크립트·과거 배포 API의 V1 호출도 조사한다. 이번 세션에서 이 운영 확인은 완료되지 않았다.
3. 승인된 신규 V2 Migration을 먼저 적용한다. V1 권한은 아직 유지해 이전 API를 즉시 깨뜨리지 않는다. backfill/기존 지급·조정 데이터 변경은0행이다.
4. V2 API와 지급 UI를 함께 전환하고, 키 없는 구버전 요청은428로 차단한다. 이전 화면을 새로고침하고, 불확실한 이전 V1 요청을 새 키로 무작정 보내지 않는다.
5. APP 외부 호출자를 V2+고유 키로 전환하고 기존 V1 진행 요청 종료/재시도 잔존 여부를 확인한다. 원격 Cron·외부 호출자 확인이 빠졌다면 권한 회수는 보류한다.
6. V2가 SECURITY DEFINER이며 함수 소유자의 V1 EXECUTE가 회수 후에도 유지됨을 확인한다. 직접 V1 호출이 더 이상 필요하지 않다는 근거를 갖춘 뒤, **별도 승인된 후속 권한 Migration**으로 아래 호출자 권한을 제한한다.

```sql
revoke execute on function public.ledger_pay_payables_v1(
 bigint,bigint,timestamptz,numeric,jsonb,text,bigint
) from public,anon,authenticated,service_role;
```

위 SQL은 보고용이며 실행하지 않았다. V1 함수 자체를 DROP하거나 V2 소유자의 내부 실행 권한을 회수하지 않는다. 이미 적용한 V2 Migration을 나중에 수정하지 않고 별도 Migration으로 관리한다.

7. service_role 직접 V1 권한=false, V2 소유자의 V1 권한=true, V2 인자/정의·PUBLIC/anon/authenticated/service_role 권한·RLS·요청 완결성·감사·행 수·Migration 이력·Advisor를 확인한다. 승인 없는 운영 지급 테스트는 실행하지 않는다.
8. 장애 시 지급 쓰기를 중지하고 요청·전표를 조회한다. 요청 키 기록을 삭제하거나 V1으로 돌아가 무작정 재시도하지 않는다. 기존 키/지급/감사를 보존한 상태에서 후속 수정으로 대응한다.

## 7. 이번 점검 변경 파일

- supabase/migrations/20261018105936_add_payable_payment_idempotency_v2.sql — 불완전 기존 요청 가드.
- app/api/admin/ledger/payables/pay/route.ts — 428 KO/VI 안내·refresh action, 비정상 요청409.
- lib/ledger/payable-payment-messages.ts — 공통 사용자 안내.
- components/ledger/PayablePaymentRecovery.tsx — 에러 안내·새로고침 버튼.
- app/(protected)/admin/ledger/entries/page.tsx, PaymentVerificationSection.tsx — 지급 오류 코드에 맞는 안내·새로고침 버튼.
- tests/payable-payment-idempotency-db.test.mjs — 비정상 완료 기록/권한 회수 후 호출 검증.
- tests/payable-payment-idempotency.test.mjs — API428/비정상409/키 보존/다국어 안내.
- tests/payable-payment-idempotency-browser.test.mjs — 구버전 요청 형태428·새로고침 검증.
- tests/ledger-payment-verification-ui.test.mjs — 공통 문구 모듈을 사용하는 렌더링 fixture.
- docs/ledger-payable-v2-preflight.sql — 조건별 실행하는 읽기 전용 사전 조회.
- 이 보고서와 이전 후속 보고서의 최신 점검 링크.

기존 지급 계산·요청 키/잠금/원자적 처리·승인·차단·해결 모달·원입고 중심 조회 구조는 유지했다.

## 8. 428 안내 화면

| 환경 | 일반 부분지급 | 결제 미확인 |
| --- | --- | --- |
| KO PC | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-desktop-partial-428.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-desktop-verification-428.png) |
| KO 모바일 | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-mobile-partial-428.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/ko-mobile-verification-428.png) |
| VI PC | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-desktop-partial-428.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-desktop-verification-428.png) |
| VI 모바일 | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-mobile-partial-428.png) | [보기](../../.qa-review/october-settlement/idempotency-screenshots/vi-mobile-verification-428.png) |

운영 메타데이터 조회 제한: Supabase MCP execute_sql의 SELECT 요청이 “requires approval, but approval policy is never”로 차단됐다. 데이터 테이블은 기존 연결의 REST SELECT로 대조했지만, 공개되지 않은 pg_catalog/pg_cron/Migration 이력을 우회 조회하기 위한 DB 함수나 구조를 만들지 않았다.