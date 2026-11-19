# Coca-Cola 11/17 Owner 확인 기준잔액 구현

## 결과 및 적용 경계

기존 지급·채무·입고를 바꾸지 않는 단건 기준점 기능을 구현했다. 기준점 등록 후 Coca-Cola(party 5)의 2026-11-17 미지급금은 **4,982,000₫**이며, 실제 개별 채무 잔액 **4,647,952₫**과 별도의 **+334,048₫ Owner 확인 기준잔액 조정**으로 구성된다. 공급처 독립 잔액명세서가 없고 차이 원천은 미확인이라는 상태를 저장·표시한다.

**개발·격리 검증 완료. 운영 DB 미적용, 기준점 미등록, main 병합·Push·배포 미실행.** 현재 운영 APP의 금액이 이미 바뀌었다는 의미가 아니다. 기존 조사 커밋 `edf0aeb2465544e3ac3c9a77ab675e6238058619`과 그 보고서·운영 읽기 전용 증거를 재사용했으며 운영 DB를 새로 조회하거나 수정하지 않았다.

## 시작 상태

세 폴더 모두 CLEAN. Codex Worktree와 브랜치를 유지했다.

| 폴더 | 브랜치 | 시작 HEAD |
| --- | --- | --- |
| `C:\workspace\baba-staff-app` | `main` | `d032c0d9764a2822e3cbbceb1097759521748bab` |
| `C:\workspace\baba-wt-codex` | `codex/pos-sync-1700-tables-stability-20261117` | `edf0aeb2465544e3ac3c9a77ab675e6238058619` |
| `C:\workspace\baba-wt-claude` | `claude/legacy-cleanup-p1-20261117` | `d032c0d9764a2822e3cbbceb1097759521748bab` |

Codex만 조사 커밋 1건이 로컬 main보다 앞선 상태였다. 새 Worktree·브랜치는 만들지 않았다. main 담당자의 실제 작업 종료와 main 병합 승인은 이번 범위에서 확인하지 않았다.

## 기능과 회계 계약

기존 기능을 조사 결과대로 재검토했다. 수동 시재 조정은 현금 이동을 요구하고, 일반 지급은 신규 지급·배분·출금을 만들며, 전표 수정은 지급금액 정정에 사용할 수 없다. 따라서 기존 **채무 계산·지급 선택·상세 화면**은 재사용하고 기준점만 별도 구조로 추가했다.

- `ledger_payable_balance_anchors`는 거래처 5 / 2026-11-17 / Owner 잔액 4,982,000 / APP 잔액 4,647,952 / 원천 미확인 상태만 허용한다. `(party_id,business_date)` UNIQUE로 중복을 금지한다. 다른 거래처용 범용 정정 도구로 확대하지 않았다.
- 조정액은 두 잔액의 차이로 DB가 생성한다. `ledger_transactions`, `ledger_payables`, `ledger_movements`, 배분, 비용·재고에는 조정 전표를 만들지 않는다.
- 등록 함수 `ledger_register_coca_owner_balance_anchor_v1(text,text,bigint)`는 service_role 전용이며 내부에서 활성 Owner/Master를 확인한다. 근거 참조·사유가 필수이며 등록과 감사 INSERT는 원자적이다. 동일 기준점 재호출은 `already_registered`로 반환하고 감사도 중복 생성하지 않는다.
- 신규 테이블은 RLS를 켜고 public/anon/authenticated 권한을 제거했다. service_role에는 SELECT만 허용한다. 직접 INSERT/UPDATE/DELETE와 sequence 권한은 주지 않았다. 앱에 등록·수정·삭제 HTTP 경로를 추가하지 않았다.
- 지급 #5097의 ID·operation·금액 6,215,888₫, 기존 배분 ID 2191~2199의 9건, movement #2854의 계정 2 / −6,215,888₫을 등록 전 확인한다. 전체 11/17 APP 기준도 4,647,952₫인지 검사한다. 불일치는 강제로 맞추지 않고 중단한다.
- 감사 `owner_payable_balance_anchor_registered`에 기존 지급·배분·movement·지급 감사 스냅샷, Owner 확인 지급액 6,582,000₫, 미확인 차이 700,160₫·366,112₫을 기록한다. 기존 지급금액이나 감사 #9061은 변경하지 않는다.

## 날짜와 이후 계산

활성 기준점 이후 계산은 **기존 확정 채무·배분 계산 +334,048₫**이다. 기준일의 원래 계산액이 4,647,952₫인지 매번 검증하므로 다음과 같다.

`잔액 = 4,982,000 + 기준점 이후 발생 채무 − 기준점 이후 지급 배분·선결제 충당`

기준점 이전 채무에 대한 후속 지급도 지급일이 이후이면 차감한다. 지급 총액과 배분 합계를 각각 차감하지 않고 배분을 한 번만 집계한다. 미배분 선결제금은 기존 선결제 자산으로 남고, 실제 채무에 충당될 때 채무를 줄이는 기존 계약을 유지한다. 8/24 미배분 2,545,032₫을 이 기준점이나 선결제금으로 전용하지 않는다.

기준일 이전 선결제금이 **기준점 등록 뒤 과거 채무에 새로 충당**되면, 해당 배분의 생성 시각을 Vietnam 영업일로 변환해 충당일에 한 번 반영한다. 기존 지급의 날짜·금액은 바꾸지 않는다. 이때도 Asia/Ho_Chi_Minh의 03:00 경계를 사용한다. 일반 신규 입고에 대한 선결제 충당은 기존 `max(지급일,입고일)` 계약을 따른다.

- 11/16 이전: 기존 결과 유지.
- 11/17: Owner 기준점 4,982,000₫.
- 예: 11/18 입고채무 1,000,000₫, 이후 지급 300,000₫이면 **5,682,000₫**. 지급이 과거 채무와 신규 채무로 나뉘어도 같은 결과다.
- 11월은 `periodBalanceAdjustment=334048`을 외상 발생·지급과 구분한다. 12월부터는 전월 이월에 포함하고 매월 조정액을 다시 더하지 않는다.
- 정확한 영업일 조회는 기존 미지급 API에 `?asOf=2026-11-17`을 추가했다. 월과 함께 지정하면 같은 월의 유효한 날짜만 허용한다.
- 과거 입고 원금·확정 여부나 기준일 이전 지급 배분이 나중에 바뀌어 기준이 달라지면 `PAYABLE_BALANCE_ANCHOR_BASELINE_DRIFT`로 조회·월마감 계산을 중단한다. 자동 재기준화는 하지 않는다.

## 화면·대시보드·마감 일치

미지급 현황과 거래처 상세·과거월 상세·월마감 스냅샷은 공통 `calculatePayableBalances`를 사용한다. 월마감 DB preflight도 기존 함수의 일반 미지급 경고 지점에 Coca-Cola 기준점 계산만 추가한다. 기존 다른 거래처의 preflight 계산과 나머지 검사·해시 알고리즘은 보존한다. 알려진 SQL 지점이 정확히 한 번 발견되지 않으면 Migration 전체를 중단한다.

상세에는 “Owner 확인 기준잔액 조정”, 조정액, 확인 잔액, 기준 영업일, 원천 미확인·공급처 명세 미확보, 개별 채무 결제 대상 제외 안내를 표시한다. 기존 정산기간·개별 입고 목록은 실제 채무만 보여준다. 따라서 실제 채무 목록 합계와 전체 잔액의 차이 334,048₫은 명시적인 별도 항목이며 합계 누락이 아니다. 날짜별/부분 지급의 선택·최대 금액은 실제 채무 목록에서만 계산한다.

## 검증 결과

**107개 고유 영향 테스트 PASS**: 5개 파일의 106개 테스트 PASS 후 DB 테스트에 Migration 원자적 중단 사례 1개를 추가했다. 변경된 DB 파일의 최종 6개 테스트도 모두 PASS. 유효한 앞선 API·회귀 PASS는 재사용했다. 격리 PGlite, 메모리 API query double, 실제 TS/TSX 함수 렌더를 사용했으며 운영 자격증명·운영 접속은 테스트에 제공하지 않았다.

| 요구 범위 | 결과 |
| --- | --- |
| 11/17 기준 잔액 4,982,000₫ | PASS — 실제 API·공통 계산·DB preflight |
| 이후 입고 및 과거 채무 후속 지급 / 분할 배분 | PASS — 5,682,000₫ 예시, 중복 차감 없음 |
| 이전 선결제의 나중 충당 / 03:00 / 다음 달 이월 | PASS |
| 중복 등록 방지·권한·감사 실패 원자성 | PASS |
| 기존 지급·9건 배분·법인 출금·재고·비용 불변 | PASS — 등록 전후 전체 기존 테이블 행 비교 |
| 다른 거래처 잔액 및 8~10월 마감 행 불변 | PASS |
| 미지급 현황·상세·과거월·월마감 API 합계 일치 | PASS |
| 신규 구조 미적용 DB 호환 | PASS — 정확한 missing-table 오류에만 기존 계산으로 복귀 |
| 기준 드리프트·권한 오류 시 원금으로 조용히 복귀하지 않음 | PASS |
| 알 수 없는 preflight 본문에서 Migration 부분 설치 방지 | PASS — 전체 ROLLBACK |
| TypeScript `tsc --noEmit --pretty false --incremental false` | PASS |
| 변경 앱 파일·테스트 ESLint / Git diff 공백 검사 | PASS |

Build·개인 브라우저·운영 UI·실제 Production 등록 후 검증은 실행하지 않았다. 검증 대상은 정식 Migration 파일이며 운영에 적용했다는 뜻이 아니다. 새 패키지·컨테이너·브라우저 프로필·빌드 캐시를 만들지 않았고 PGlite는 종료했다. 로그·실패 원인 자료는 `.local/`에 보존한다.

## 운영 적용 시 주의사항

1. main 통합·Push·배포는 기존 승인 조건을 만족한 뒤 진행한다. 이 작업에서는 독립 브랜치 로컬 Commit까지만 수행한다.
2. 앱 배포와 정식 Migration 설치는 기존 DB에 기준점이 없는 상태와 호환된다. **Migration은 구조·함수만 설치하며 기준점 데이터는 등록하지 않는다.**
3. 기준점 등록 전에는 새 앱이 모든 미지급·월마감 경로에서 배포됐는지 확인한다. Supabase schema cache에서 테이블과 SELECT 권한이 정상 인식되는지도 확인한다. 구버전 앱이 남은 상태에서 등록하면 그 앱은 조정 전 금액을 표시하므로 등록하지 않는다.
4. 운영 Migration 적용과 기준점 등록은 GPT가 GitHub 정본을 검수하고 Owner 승인 범위에서 별도 주관한다. 로컬 에이전트가 실행하지 않는다. 실제 승인된 Owner/Master 사용자 ID와 **Owner 확인 근거 참조**, “공급처 독립 명세 미확보·차이 원천 미확인” 사유를 넣어 등록 함수를 한 번 호출하는 경로다. 다른 지급·배분·매입을 함께 재구성하지 않는다.
5. 기준일 APP 잔액이나 #5097·9건 배분·movement가 달라졌거나 11월이 마감됐으면 함수가 거부한다. 마감을 재개방하거나 보호 데이터를 바꿔 통과시키지 않는다. 적용 시 preflight SQL 형태가 달라진 경우도 우회하지 않는다.
6. 등록 후 동일 기준점 1건, 조정액 334,048₫, 원천 미확인 상태 및 신규 감사 1건을 확인한다. `?asOf=2026-11-17` Coca-Cola 합계 4,982,000₫, 이후 현재 잔액의 실제 거래 반영, 월마감 preflight·스냅샷 합계 일치를 확인한다. 기존 지급·배분·movement·비용·재고·8~10월 마감·8/24 미배분은 전후 비교한다.
7. 활성화 후에는 기준점 미지원 앱으로 임의 롤백하거나 기준점 행을 삭제해 해제하지 않는다. 필요한 후속 정정·복귀 방식은 별도 검토한다. 이번 기능은 700,160₫·366,112₫의 개별 원천이 밝혀졌다는 판단을 하지 않는다.

## 변경 파일 전체 Windows 경로

- `C:\workspace\baba-wt-codex\supabase\migrations\20261119071107_coca_cola_owner_payable_balance_anchor.sql`
- `C:\workspace\baba-wt-codex\lib\ledger\payables.ts`
- `C:\workspace\baba-wt-codex\lib\ledger\payable-balance-anchor-data.ts`
- `C:\workspace\baba-wt-codex\lib\ledger\month-close.ts`
- `C:\workspace\baba-wt-codex\app\api\admin\ledger\payables\route.ts`
- `C:\workspace\baba-wt-codex\app\api\admin\ledger\payables\[partyId]\route.ts`
- `C:\workspace\baba-wt-codex\app\(protected)\admin\ledger\entries\page.tsx`
- `C:\workspace\baba-wt-codex\tests\ledger-payable-payments.test.ts`
- `C:\workspace\baba-wt-codex\tests\ledger-payable-balance-anchor-db.test.mjs`
- `C:\workspace\baba-wt-codex\tests\ledger-payable-balance-anchor-api.test.mjs`
- `C:\workspace\baba-wt-codex\docs\reports\20261119-coca-cola-owner-balance-anchor.md`
- `C:\workspace\baba-wt-codex\docs\reports\20261119-coca-cola-owner-balance-anchor-verification.json`

Supabase CLI 3.1.0의 `migration new coca_cola_owner_payable_balance_anchor`로 정식 파일을 생성했다. 기존 적용 Migration은 수정하지 않았다. 검증 로그 전체 경로:

- `C:\workspace\baba-wt-codex\.local\coca-cola-anchor-20261119\tests.log`
- `C:\workspace\baba-wt-codex\.local\coca-cola-anchor-20261119\database-final.log`
- `C:\workspace\baba-wt-codex\.local\coca-cola-anchor-20261119\database-fixture-setup-failure.log`
- `C:\workspace\baba-wt-codex\.local\coca-cola-anchor-20261119\typescript.log`
- `C:\workspace\baba-wt-codex\.local\coca-cola-anchor-20261119\test-lint.log`
- `C:\workspace\baba-wt-codex\.local\coca-cola-anchor-20261119\test-lint-initial-failure.log`
- `C:\workspace\baba-wt-codex\.local\coca-cola-anchor-20261119\api-final.log`

실패 로그는 추가 테스트 Fixture의 SQL 함수 인자명과 테스트 변수명 lint를 수정하기 전 기록이다. 최종 DB 6개·API 5개 테스트 및 테스트 ESLint에서 해소됐다.
