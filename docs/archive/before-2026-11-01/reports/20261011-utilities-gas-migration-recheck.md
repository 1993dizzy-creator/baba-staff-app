# 공과금·가스 migration 재검증 — 2026-10-11

## 결론

**현재 상태에서 migration 포함 배포는 보류 권고.**

수정된 원본 migration을 사용하는 기존 회귀 506건은 493건 통과·13건 실패다. 실패한 13건은 가스 격리 DB 테스트이며, Production MD5 핀과 기존 로컬 fixture 함수 정의의 MD5가 달라 새 버전 검증에서 차단된다. 이를 금융 로직 자체의 실패와 혼동하면 안 되지만, 원본 테스트 체계가 모두 통과한 상태도 아니다.

독립적인 EOL 계약 검증에서 **CRLF SQL 파일 + LF 함수 본문** 조합이 실패했다. 현재 SQL 파일은 LF이며 LF SQL + CRLF 본문 조합은 로컬 함수 해시를 정확히 대입한 조건에서 성공했다. 전체 LF/CRLF 조합 호환성을 보장하는 상태는 아니다.

애플리케이션 소스, migration, 기존 테스트 파일은 수정하지 않았다. 신규 테스트 파일도 만들지 않았다. 기존 fixture와 테스트 모듈을 메모리에서 재사용했다. 결과 로그·JSON과 이 보고서만 기록했다. Production DB 조회/수정, migration 적용, Git 명령, Vercel 배포는 실행하지 않았다.

## 기존 506건 재실행

명령:

```text
node --experimental-strip-types --test tests/business-partner*.test.ts tests/business-partner*.test.mjs tests/ledger-inventory*.test.ts tests/ledger-inventory*.test.mjs tests/inventory-ledger-projection*.test.ts tests/inventory-ledger-projection-api.test.mjs tests/inventory-ledger-projection-db.test.mjs tests/inventory-purchase-repair-api.test.mjs tests/purchase-economic-db.test.mjs tests/ledger-payable-payments.test.ts tests/ledger-month-close-corrections.test.ts lib/ledger/manual-entry-policy.test.ts tests/utilities-partner-policy.test.mjs tests/utilities-gas-purchase-db.test.mjs
```

- **506건 실행, 493건 통과, 13건 실패.**
- 기존 장부·입고·거래처·결제 배분·후불 결제·월마감·수동 수정·Ledger reversal/rebook 및 권한 보호 회귀는 통과했다.
- 실패한 13건은 모두 `tests/utilities-gas-purchase-db.test.mjs`에 있다. 일반 경로는 migration 설치 단계의 `GAS_PURCHASE_FUNCTION_VERSION_MISMATCH`로 중단된다.
- 함수 변조 테스트는 기존 `GAS_PURCHASE_CATEGORY_CONTRACT_MISMATCH`를 기대하지만, 새 코드에서는 더 이른 MD5 검증이 `GAS_PURCHASE_FUNCTION_VERSION_MISMATCH`를 반환한다. 기존 기대 오류 계약도 갱신이 필요한 상태다.

실패한 테스트 범위: 새 가스 구매·기타 품목·거래처 변경·ID 없는 gas 이름·다른 품목·원입고 이후 마스터 변경·레거시 배치·과거 지급/마감 보존·비공개 권한/함수 계약·기존 pending 보존·감사/actor 실패 롤백·후불 지급·03:00 영업일 경계.

### MD5 비교

| 함수 | 원본 migration의 Production 핀 | 기존 로컬 fixture MD5 |
|---|---|---|
| inventory_ledger_private.sync_candidate(jsonb,bigint) | fe28c88c30a1a3a55f756018a25eeec9 | c13b0bd679656e05063a93eba922df19 |
| public.ledger_sync_inventory_candidates_core_v1(jsonb,bigint) | 3a5059d9faf63b73d9c116414d538a17 | 02272b54de79b83eccf5071c48b500d1 |

이번 검증은 로컬 전용이며, 위 Production 핀이 현재 운영 함수의 실제 MD5와 일치하는지는 별도로 조회하지 않았다. 로컬 fixture는 운영 함수 정의와 동일하다고 가정하지 않았다.

## 기존 격리 테스트의 별도 기능 검증

기존 `utilities-gas-purchase-db.test.mjs`를 메모리 모듈로 실행했다. 수정 사항은 테스트 실행 메모리에만 존재한다:

1. 원본 SQL을 읽은 뒤 Production 핀 2개만 해당 로컬 fixture의 실제 MD5로 대입.
2. 함수 변조 테스트의 기대 오류 코드만 새 VERSION_MISMATCH로 조정.

**13/13 통과.**

가스 구매의 비용 #23·원입고 거래처 #21·후불 미납·무출금, 일반 기타 매핑, 실제 지급 RPC 정산, 지급 후 변경 차단, 과거 #1611/#2487/#2488/#2489·미납 #705/#1162 및 9월 closed/revision 3 보존, 감사 원자성·재시도·03:00 경계를 확인했다.

이 결과는 기능 검증이며 원본 Production 핀을 사용한 506건의 실패를 지우거나 대체하지 않는다.

## LF/CRLF 호환성 및 계약 검증

기존 fixture의 두 함수 본문을 각각 LF/CRLF로 구성하고, SQL 파일 내용을 LF/CRLF로 구성하여 4개 조합을 실행했다. 줄바꿈 검증은 각 조합의 **실제 로컬 함수 MD5만 메모리에서 대입**해 버전 검증과 anchor 검증의 원인을 분리했다.

| SQL 파일 줄바꿈 | 함수 본문 줄바꿈 | 결과 |
|---|---|---|
| LF | LF | 통과 |
| LF | CRLF | 통과 |
| CRLF | LF | **실패: GAS_PURCHASE_CATEGORY_CONTRACT_MISMATCH** |
| CRLF | CRLF | 통과 |

성공한 3개 조합에서는 함수 본문의 실제 결과가 의도된 category/party 삽입만 반영한 예상 본문과 정확히 같았다. 기존 보호 정책과 무관한 함수 텍스트가 변경되지 않았다.

실패 원인: 파일이 CRLF이면 dollar-quoted `anchor`도 CRLF다. 현재 코드는 이를 LF로 먼저 정규화하지 않고 `replace(anchor, chr(10), chr(13)||chr(10))`만 수행한다. 따라서 대체 anchor에 CRCRLF가 생기며 LF 본문을 매칭하지 못한다. 위치는 첫 migration의 `matched_anchor` 선택부(88~99행)다.

권장 보완 방향(이번에는 수정하지 않음): **anchor와 addition만 먼저 CRLF→LF로 정규화한 뒤 LF/CRLF 두 형태를 만든다. 배포된 함수 정의 자체는 정규화하지 않고 원본 MD5 검증을 유지한다.**

추가 계약 검증 4개 모두 통과:

- 첫 번째 함수 MD5 불일치 → 거부·DDL/규칙/보조 함수 전체 롤백.
- 첫 함수 변경 후 두 번째 함수 MD5 불일치 → 첫 함수 변경까지 전체 롤백.
- 정확한 로컬 MD5지만 anchor가 중복됨 → 거부·전체 롤백.
- 정확한 로컬 MD5지만 anchor가 누락됨 → 거부·전체 롤백.

기존 두 함수의 MD5 복원과 신규 규칙 테이블/보조 함수 부재를 실제 격리 DB에서 확인했다.

## ESLint·TypeScript·Production 빌드

- 변경 애플리케이션 소스 및 신규 거래처/가스 테스트의 **ESLint 통과**.
- `next build --webpack` **종료 코드 0**. 컴파일·빌드 타입 검사·72개 정적 페이지 생성 완료. 검사 우회 옵션이나 설정을 추가하지 않았다.
- 전체 TypeScript는 빌드가 생성 타입 파일을 재생성하는 간섭을 피하도록 빌드 종료 뒤 `tsc --noEmit --pretty false --incremental false`로 다시 실행했다.
- **기존 오류 40건, 신규 오류 0건, 전역 생성 파일 오류 0건.** 기존 감사 목록의 파일·TS 코드·메시지와 대조했다.
- 기존 오류: TS5097 32건, TS2322 4건, TS2339 1건, TS18048 3건. 전체 tsc 명령은 기존 오류 때문에 실패한다.

## 배포 가능 여부

앱의 Production 빌드는 가능하다. 그러나 **이번 요청의 전체 검증 기준으로는 migration 포함 배포 준비가 완료되지 않았다**.

배포 전 남은 사항:

1. CRLF SQL + LF 함수 조합의 anchor 호환성 보완 및 재검증.
2. Production MD5 검증을 유지하면서 기존 격리 fixture의 별도 테스트 해시 바인딩 또는 검증된 운영 정의 fixture를 구성하고, 새 VERSION_MISMATCH 기대 계약을 반영해 원본 테스트 체계를 정상화.
3. 적용 직전 운영 함수 MD5·권한·migration history를 읽기 전용으로 대조. 현재 로컬 성공 결과로 운영 함수 일치를 대신 판단하지 않음.

## 증거

- `.qa-review/utilities-recheck-regression.txt` — 원본 506건 재실행, 493 통과/13 실패.
- `.qa-review/utilities-recheck-isolated-adapted.txt` — 기존 격리 테스트 메모리 바인딩 13/13 통과.
- `.qa-review/utilities-recheck-eol-contract.json` — 4개 줄바꿈 조합.
- `.qa-review/utilities-recheck-md5-contract.json` — 버전/anchor 거부 및 전체 롤백.
- `.qa-review/utilities-recheck-local-functions.json` — 실제 로컬 함수 정의·MD5.
- `.qa-review/utilities-recheck-eslint.txt` — ESLint.
- `.qa-review/utilities-recheck-tsc.txt`, `utilities-recheck-types.json` — 안정된 최종 전체 타입 검사와 기존 오류 대조.
- `.qa-review/utilities-build-final.txt` — 이번 재실행 빌드, NEXT_BUILD_EXIT_CODE=0.
