# 2026-10-15 POS 재고차감 누락 복구 결과

실행 계정: HAN (`admin`, 활성 master). 실행 ID: `c42e964e-306b-4b1b-8372-fa267059eb93`.

기존 소스를 메모리에서 로드하여 `buildUnifiedInventoryDeductionPreview` 및 `executeUnifiedInventoryDeductions`를 사용했다. 관리자 웹 세션을 생성하거나 위조하지 않았으며, 서버용 Supabase 클라이언트로 공식 함수의 배치 저장·검증·적용 RPC 경로를 호출했다. 별도 재고 UPDATE 또는 사용자 정의 복구 SQL은 사용하지 않았다.

## 실행 전 검증

- 대상 8241, 8243, 8246, 8249, 8251, 8256 모두 2026-10-15 영수증이며 관리자 수정 건이 아니다.
- 공식 미리보기에서 6건 모두 `initial_apply`, 실행 가능, 활성 기존 차감 0건, 차단 사유 0건이었다.
- 직접매핑 8개 판매행, 총 17단위이며 6개 재고 품목 모두 합산 차감 후 재고가 충분했다.
- 정책상 중립으로 분류되는 미완성 레시피 행은 차감 대상에 포함하지 않았다. 매핑과 기존 정책은 변경하지 않았다.
- 영수증 fingerprint·inventory hash·updated_at, 기존 차감 5건 및 관련 로그, 재고 수량, 마감 34의 전체 행 해시와 원본 fingerprint를 기록했다.
- 실행 직전 공식 미리보기를 다시 생성하여 최초 결과와 비교하고 보호 대상 테이블 해시도 재검증했다.
- 중복 실행 방지용 로컬 실행 표식을 배타적으로 생성했다. 공식 실행 함수는 1회 호출했으며 재시도하지 않았다. 영수증별 expected fingerprint·inventory hash·updated_at을 전달했다.

## 영수증별 결과

| 영수증 ID | 차감 행 | 차감 단위 | 배치 ID | 처리 기록 ID | 결과 |
|---|---:|---:|---:|---:|---|
| 8241 | 2 | 2 | 987 | 1115 | applied |
| 8243 | 1 | 4 | 988 | 1116 | applied |
| 8246 | 1 | 1 | 989 | 1117 | applied |
| 8249 | 1 | 1 | 990 | 1118 | applied |
| 8251 | 2 | 5 | 991 | 1119 | applied |
| 8256 | 1 | 4 | 992 | 1120 | applied |
| 합계 | 8 | 17 | | | 실패 0건 |

## 재고 전후

| 코드 | 품목 | 차감 전 | 차감 | 차감 후 |
|---|---|---:|---:|---:|
| O1 | Sprite | 123 | 4 | 119 |
| N1 | Chamisul | 77 | 3 | 74 |
| N2 | Sero | 79 | 4 | 75 |
| O4 | Soda Schweppe 320ml | 22 | 1 | 21 |
| O5 | Soda Schweppe tonic vàng 320ml | 48 | 4 | 44 |
| P1 | Black label 750ml | 2 | 1 | 1 |

## 실행 후 검증

17개 검증 항목 모두 통과했다.

- 신규 차감 ID 1707–1714, 재고 로그 ID 13455–13462: 각각 8건, 합계 -17단위, 처리자 `admin`, 날짜 2026-10-15, 차감 행과 로그 연결 정상.
- 6개 처리 기록과 배치 모두 `applied`. 중복 판매행·재고 조합 없음. 생성된 신규 재고 로그도 전체 8건으로 일치.
- 공식 미리보기 재조회에서 6건 모두 `no_op`, current fingerprint와 마지막 처리 fingerprint 일치. 재실행하지 않았다.
- 대상 재고 수량 모두 예상과 일치. 다른 재고 품목은 행 해시 및 전체 개수 보존.
- 기존 차감 5건(ID 1690–1694), 기존 처리 기록 및 관련 재고 로그의 전체 행 해시 보존.
- 대상 6건의 fingerprint 및 `updated_at` 모두 불변. 10월 15일 전체 영수증·결제·판매행·수정 이력과 관리자 수정 3건도 불변.
- 마감 ID 34의 전체 행 해시 불변: `2bb478649f09c90c416129f46d34ef8afbc2f6da5f80fc4ff4ddca7a4162281d`.
- 마감 34의 `source_fingerprint` 불변: `fd87731ecd2fe1108e3ba63aa5692b5d80dbacadf88d19bf9ebd2d0a6fa8e7d5`.
- 조회한 10월 14·16일 인접 영수증·결제, 10월 15일 장부, 카드정산 및 마감 기록 해시 불변.

영업마감, Migration, 배포, commit/push는 실행하지 않았다.

상세 비교 기록은 로컬 `.tmp/pos-oct15-inventory-recovery/`의 `preflight.json`, `result.json`, `verification.json`, `existing-log-hashes.json`, `mutation-audit.jsonl`에 보관했다. 인증정보와 고객 개인정보는 기록하지 않았다.
