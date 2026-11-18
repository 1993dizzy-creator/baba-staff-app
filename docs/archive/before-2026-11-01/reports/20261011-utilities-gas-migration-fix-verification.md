# 가스비 migration 호환성 수정 및 최종 검증

검증일: 2026-10-11. 운영 적용·Git 명령·배포 없이 로컬에서 검증했다.

## 수정 파일

- `supabase/migrations/20261010180457_scope_gas_inventory_purchase_category.sql`: migration의 anchor/addition을 CRLF에서 LF로 먼저 정규화하고, 대상 anchor 형식에 맞춰 삽입한다. legacy 거래처 삽입 블록도 같은 형식을 따른다. 운영 함수 전체의 줄바꿈과 운영 MD5 핀 두 개는 변경하지 않았다.
- `tests/utilities-gas-purchase-db.test.mjs`: 기존 migration으로 구성한 실제 fixture 함수 본문을 운영과 같은 CRLF로 저장하고 운영 MD5 핀과 정확히 일치하는지 검증한다. migration 해시의 임시 치환은 없다. 손상된 함수의 기대 오류를 `GAS_PURCHASE_FUNCTION_VERSION_MISMATCH`로 수정했다. 기존 13건 안에서 줄바꿈 및 롤백 검증을 확장했다.
- 이 보고서.

두 번째 migration과 다른 기능은 수정하지 않았다. 추가 테스트 파일은 생성하지 않았다.

## 결과

| 검사 | 결과 |
|---|---|
| 기존 관련 회귀 테스트 | 506/506 통과 |
| 기존 격리 DB 테스트 단독 실행 | 13/13 통과 |
| SQL LF/CRLF × 함수 본문 LF/CRLF 구조적 치환 | 4/4 통과 |
| 운영 핀을 그대로 사용하는 전체 migration, SQL LF 및 CRLF | 2/2 통과 |
| 첫 번째/두 번째 함수 버전 불일치, anchor 누락/중복 | 모두 차단 및 롤백 통과 |
| anchor 누락/중복의 구조적 검증 | 계약 오류와 함수 본문 롤백 통과 |
| ESLint | 통과 |
| Production build (`next build --webpack`) | 실제 종료 코드 0 |
| 전체 TypeScript (`--noEmit --pretty false --incremental false`) | 기존 40건, 신규 0건; 종료 코드 1 |

LF 함수 본문은 CRLF 운영 본문과 전체 MD5가 다르므로 운영 migration의 버전 검증을 통과해서는 안 된다. 따라서 네 줄바꿈 조합은 기존 테스트 파일에서 추출한 구조적 치환 블록을 격리 DB에서 실행하여 검증하고, MD5 게이트는 원본 전체 migration으로 별도 검증했다. Production SQL에는 테스트 분기나 대체 해시를 추가하지 않았다. 각 성공 조합에서 변경 대상 외 함수 정의가 정확히 유지되고 CRCRLF가 발생하지 않는지 확인했다.

버전 불일치 및 누락/중복 시 두 함수의 해시가 변경 전과 같고 신규 규칙 테이블·helper가 생성되지 않았음을 확인했다. 두 번째 함수의 버전 불일치는 첫 번째 함수 치환 이후에도 전체 롤백된다.

기존 테스트가 신규 #342/#21 입고만 category 23으로 기록하는지, 일반 기타 품목·다른 거래처·이름의 gas 문자열은 영향을 받지 않는지 확인했다. 원입고 거래처 식별자 유지, 후불 미납 생성, 기존 결제 RPC 정산, 지급 이후 수정 차단, 기존 거래·지급·미납·9월 마감 revision 보존, 감사 실패 롤백도 통과했다.

TypeScript 기존 오류 구성: TS5097 32건, TS2322 4건, TS2339 1건, TS18048 3건. 기존 `.qa-review/type-audit.json`과 파일·오류 코드·메시지 기준 비교 결과 추가 및 소멸 오류가 없다.

## 명령 및 근거

회귀 명령:

```text
node --experimental-strip-types --test tests/business-partner*.test.ts tests/business-partner*.test.mjs tests/ledger-inventory*.test.ts tests/ledger-inventory*.test.mjs tests/inventory-ledger-projection*.test.ts tests/inventory-ledger-projection-api.test.mjs tests/inventory-ledger-projection-db.test.mjs tests/inventory-purchase-repair-api.test.mjs tests/purchase-economic-db.test.mjs tests/ledger-payable-payments.test.ts tests/ledger-month-close-corrections.test.ts lib/ledger/manual-entry-policy.test.ts tests/utilities-partner-policy.test.mjs tests/utilities-gas-purchase-db.test.mjs
```

격리 명령: `node --test tests/utilities-gas-purchase-db.test.mjs`.

ESLint는 기존 수정 라이브러리 5개와 utilities 테스트 파일 3개를 검사했다.

로그:

- `.qa-review/gas-fix-regression.txt`
- `.qa-review/gas-fix-isolated.txt`
- `.qa-review/gas-fix-eslint.txt`
- `.qa-review/gas-fix-tsc.txt`
- `.qa-review/gas-fix-types.json`
- `.qa-review/utilities-build-final.txt`

## 배포 판단

확인된 두 문제는 해결했고 로컬 검증 기준으로 배포 준비가 가능하다. 전체 TypeScript 검사의 기존 40건 실패는 남아 있다. 현재 배포 보류는 유지한다. 실제 운영 적용 직전 함수 MD5·권한·migration 이력을 읽기 전용으로 확인해야 하며, 기존 코드 배포 및 보호된 거래처 이동 순서를 준수해야 한다. 이번 작업에서는 운영 접속·migration 적용·배포를 실행하지 않았다.
