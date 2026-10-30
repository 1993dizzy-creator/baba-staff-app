# 보존 기록 — Claude 실청구금액 v1 과거 QA 인계서

> 2026-10-30, 원본 main 직렬 모드에서 사용자 요청으로 보존했다.
> 아카이브 직전 main: `d46f5e942d8609b706a588ceeeaadfb9d5b12e73`.
> 이 문서는 과거 QA의 출처와 이후 중복·대체 판단을 기록한다. 과거 FAIL/SKIP을 PASS로 변경하거나 현재 배포 승인으로 해석하지 않는다.

## 1. 원문과 출처

| 항목 | 보존 값 |
| --- | --- |
| 원래 Worktree | `C:\workspace\baba-wt-claude` |
| 원래 브랜치 | `claude/20261030-billed-amount-verify-01` |
| 기능 보완 커밋 | `0d420e493a9a41001d1e84ea40dd6b8c476a3ecf` |
| 인계서 커밋 및 보존 시 Claude HEAD | `db3de96c871c3456d25923214e3134648eb5e48a` |
| 원래 파일 경로 | `docs/handoffs/claude-20261030-billed-amount-verify-01.md` |
| 원문 작성 시각 | `2026-10-30T09:06:09.763Z` |
| 원문에 적힌 검증 대상 HEAD | `0d420e493a9a41001d1e84ea40dd6b8c476a3ecf` |
| 원문에 적힌 merge-base | `0bcedb60223cfe7397d0f521c23f65eedcc1dfe6` |
| 원본 Git blob | `c48b3ed43eb8bdb4710fa20159de078b47503b91` |
| 원문 크기 | 9,078 bytes |
| 원문 SHA-256 | `ff05e3cd59edfe29816865827add8d1ee35c8c3748a7d30d230eb5f9c16586ed` |

[원문 보존 파일](20261030-claude-billed-amount-verify-01-original.md)은 Claude Worktree 파일 및 `db3de96:docs/handoffs/claude-20261030-billed-amount-verify-01.md`와 바이트 단위로 동일하다. 내용, 줄바꿈, 말미 빈줄을 수정하지 않았다. 원문에 적힌 당시 main 상태·운영 DB 상태·후속 지시는 당시 기록이며 현재 상태나 이번 작업의 실행 지시가 아니다.

보존 전 main의 추적 문서에서 두 SHA·원래 작업 ID·제목을 검색했고, 같은 원문 blob도 대조했다. 기존 동일 기록은 없었다. 원문은 위 파일 한 곳에만 복사하고, 이 파일은 출처·해석·검증 내역을 별도로 남긴다.

## 2. 기능 중복·대체 판단

`0d420e4`는 화면·합계·신규 품목 등록 안전성·관련 테스트를 보완한 11개 파일의 커밋이다. Git 그래프상 이 커밋 자체는 main에 병합되지 않았지만, 기능은 다음과 같이 반영되거나 대체됐다.

- main `60b9bf0e4c3cb52c42804efac2a514f7475c1bef`와 비교하면 11개 중 9개 파일의 blob이 동일하다. snapshots 화면, 재고 화면, 월간 API, 일별·월별 합계 도우미, 실청구금액 브라우저·DB·단위 테스트, 입고 수정 브라우저 테스트가 해당한다.
- 나머지 `app/api/inventory/items/route.ts`와 `tests/inventory-ledger-projection-api.test.mjs`는 main에서 원자적 품목 등록 RPC 방식으로 대체됐다. Claude의 분리 INSERT 후 실패 시 품목 DELETE 방식은 다시 가져오지 않는다. 후속 `c644e5079b15ba4628a35295b195d157a2889d30`에는 중복 등록 방지와 관련 검증이 추가됐다.
- `60b9bf0` 이후 `e93710796c573d9fc95b441a23c329e60c03a292`, `40441f9d43102cf3a8fc31bdee3130ce0f821ee5`, `757360fc47ba7eaa4773e35d4278394c62306851`에서 제약·UI·거래처 선택 권한과 테스트가 후속 변경됐다. 따라서 현재 파일의 차이를 미반영 기능으로 해석하지 않는다.
- 아카이브 기준 main에서도 월간 API, 일별·월별 합계 도우미, 실청구금액 브라우저 테스트와 단위 테스트의 5개 파일은 `0d420e4`와 동일하다. 나머지 변경 파일은 위 후속 변경으로 설명된다.

판정: `0d420e4`는 중복·대체된 과거 기능 보완 기록이며, 기능 코드 merge/cherry-pick은 불필요하다. `db3de96`는 위 원문 인계서만 추가한 고유 문서 커밋이므로 이번 아카이브로 문서를 보존한다. 이 판단은 Git 내용 비교이며 이번 문서 작업에서 앱·DB 테스트를 새로 실행했다는 뜻이 아니다.

## 3. 과거 검증 결과 — 원문 보고 그대로 보존

### 자동 baba-verify 결과

- 실행 시각: `2026-10-30T09:06:08.627Z`.
- 상태 지문: `d28a58aa80befc5b`.
- 원래 보고서 경로: `.tmp-baba/verify/2026-10-30T09-06-08-627Z-0d420e49-de5ca2d4-fb93-4bc6-94c8-c5ffbbeffd37.json`.
- 최종 판정: **FAIL**. 이 판정은 변경하지 않는다.

| 검사 | 원문 결과 | 보존 시 해석 |
| --- | --- | --- |
| 변경 파일 검사 | `passed` | 당시 실행 통과 |
| 회귀 테스트 | `failed-unclassified` | FAIL, 통과로 재분류하지 않음 |
| ESLint | `passed` | 당시 실행 통과 |
| TypeScript | `passed-with-preexisting` | 기존 오류가 남은 조건부 결과, 오류 0건으로 바꾸지 않음 |
| Production Build | `passed` | 오프라인 fixture 빌드 통과. 운영 환경 검증이나 배포 결과가 아님 |

자동 검증의 미검증 목록은 9개 파일이며 원문에 기재된 SKIP 합계는 10건이다: `inventory-billed-amount-browser`, `inventory-billed-amount-postgres`, `inventory-cancelled-purchases-browser`, `inventory-photo-sync-browser`, `inventory-purchase-cases-browser`, `inventory-quick-save-browser`, `inventory-receipt-edit-browser`, `inventory-snapshots-browser` 각각 1건, `keg-safety-p0-browser` 2건. 어느 항목도 자동 실행 PASS로 바꾸지 않는다.

### 별도 수동 실행 보고

아래는 인계서 작성자가 남긴 수동 실행 보고다. 이번 아카이브 작업에서 과거 로그를 재실행하거나 독립 재검증하지 않았다.

| 범위 | 원문 보고 |
| --- | --- |
| 실청구금액 브라우저 | KO/VI × 360/390/PC 6/6 통과. 303,450 → 303,000, 차액 −450, 카드·일자 총 합계 303,000 확인 |
| 그 밖의 통과 브라우저 | `receipt-edit-browser`, `quick-save-browser`, `cancelled-purchases-browser`, `photo-sync-browser` |
| 통과 PostgreSQL | `billed-amount-postgres`, `receipt-edit-postgres`, `safe-correction-postgres` |
| 실패 브라우저 4개 | `purchase-cases-browser`, `purchase-details-browser`, `snapshots-browser`, `keg-safety-p0-browser` |
| 실패 비교 근거 | 기준 `0bcedb6`의 오프라인 빌드에서도 같은 위치로 실패했다고 기록. `snapshots-browser` 캐럿 블록은 실패 지점이 달라지는 불안정 테스트로 기록 |
| 수동 실행 SKIP | 2개로 보고. 원문은 그중 keg-safety P0 warm benchmark 1건을 테스트 자체 SKIP으로 설명하며, 나머지 1건의 상세 사유는 특정하지 않음 |
| 비브라우저 재고·장부 회귀 | 총 822개: PASS 789, FAIL 31, SKIP 2. 실패 31개는 모두 작업 전 기준 실패라고 보고됐지만 FAIL 자체는 유지 |
| 비브라우저 미실행 2개 | `payable-payment-idempotency-db`, `purchase-settlement-concurrency`: 외부 PostgreSQL 포트가 필요해 미실행 |

원문의 “수동 실행으로 신규 실패 0을 확인”했다는 진술은 위 기존 실패·SKIP을 없애거나 자동 baba-verify FAIL을 PASS로 바꾸지 않는다. 운영 환경·인증·DB 연결·운영 Migration 적용은 당시 미검증·미실시로 기록됐으며, 원문 `.next` 산출물은 배포 대상이 아니다. 서로 다른 자동·수동 실행의 건수는 합쳐 하나의 통과율로 만들지 않는다.

## 4. 이번 보존 작업의 범위와 남은 상태

- 실행한 검증: 원문 Git blob·Worktree 파일·아카이브 파일의 바이트 및 SHA-256 대조, 기존 문서 중복 검색, 기능 파일 Git 비교, 자격 증명 의심 패턴·내용 검사, 문서 변경 범위 검사. 비밀값은 발견되지 않았다.
- 소스 코드, SQL, Migration 및 기존 main 커밋은 변경하지 않는다. 이번 커밋 대상은 이 보존 기록과 원문 보존 파일 두 개뿐이다.
- Claude Worktree는 `claude/20261030-billed-amount-verify-01` / `db3de96c871c3456d25923214e3134648eb5e48a`로 보존한다. 기존 기능 커밋 `0d420e4`도 해당 브랜치 이력에 남는다.
- 이 문서 아카이브만으로 기능 커밋 전체가 보존됐거나 브랜치 삭제가 승인됐다고 간주하지 않는다. Worktree 전환·삭제, 브랜치 삭제, 코드 merge/cherry-pick, reset/clean/stash를 수행하지 않는다.
- GitHub Push·Production 배포·운영 DB 작업·Migration 이력 등록은 수행하지 않는다.
