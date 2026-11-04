# 8/2 Dabaco 126,000₫ 단건 정정 — 실행 가이드 (운영 미실행)

정본: Notion「2026년 8월 미해결 23칸 — 재조사 방지 원장」› Codex 단건 작업지시: Dabaco 126,000₫.
기존 조사 결과를 그대로 쓰며 재조사하지 않는다.

## 대상과 처리

| 대상 | 현재 | 정정 후 |
| --- | --- | --- |
| TX #30 (8/2 Schweppes gừng 12×10,500, 로그 #8223·후보 #24 공급처 Dabaco) | party 15 Ok Mart, 현금이동 없음 | party 2 Dabaco. 금액·분류·인식월·원천 스냅샷 불변 |
| 후불 #15 (126,000) | paid (배분 #6) | cancelled, 배분 없음 |
| 배분 #6 (#15 ← #1090, 126,000) | 있음 | 삭제 → #1090 미배정 정산분 126,000 |
| 정정 A (신규, 8/2, correction_of #30) | – | 매장현금 −126,000 (기인식 비용의 현금 지급 복원, 새 비용 아님) |
| 정정 B (신규, 8/31, correction_of #1057) | – | 매장현금 +126,000 (역사 기말 기술재기준화, 실입금 아님) |

보존: #1090(8/21 법인 −8,487,500, 시트 K288)·#1094 실제 지급과 이동, #1090의 다른 24개 배분, #1094 36개 배분,
후불 #107(#1090 636k + #1094 514k, 완납), 재고 로그·후보·원가, 8월 경제비용 465,830,399·매출 734,736,553,
Ok Mart 미지급 14,653,500, 8·9월 reopened rev4.

선례: 미배정 지급 `okmart-payable-reallocation-20261103`(#1978), 거래처 연결 `tx2415-thuy-nam-party.sql`,
현금 복원 정정 #4048/#4056/#4057, 8/31 재기준화 #4051/#4059/#4062.

## 파일

- `scripts/ledger/aug02-dabaco126-20261104-preflight-READONLY.sql` — 21개 사전 조건 (읽기 전용)
- `scripts/ledger/aug02-dabaco126-20261104-EXECUTION-BLOCKED.sql` — 단일 SERIALIZABLE 트랜잭션. 승인값 2줄이 주석이라 그대로는 쓰기 전에 `DABACO126_BLOCKED_APPROVAL_REQUIRED`로 중단
- `scripts/ledger/aug02-dabaco126-20261104-postflight-READONLY.sql` — 16개 사후 조건 (읽기 전용)
- `tests/ledger-aug02-dabaco126-db.test.mjs` — 합성 PGlite 픽스처로 세 파일을 그대로 실행

## 운영 실행 순서 (별도 명시 승인 후에만)

1. preflight 실행 → 21행 모두 `ok = true`. 하나라도 false면 중단·보고.
2. EXECUTION 파일의 두 줄 주석 해제: `baba.correction_actor_user_id`(승인자), `baba.dabaco126_approval = 'APPROVED:aug02-dabaco126-20261104'`. 같은 트랜잭션으로 실행 → `DABACO126_OK` 알림.
3. postflight 실행 → 16행 모두 `ok = true`.
4. 월마감은 실행하지 않는다(8월 최종 게이트에서 별도).

## 예상 결과

- 8/2 현금 일계 −606,600 → −732,600 (APP−시트 +126,000 → 0)
- 8/31 현금 일계 7,859,990 → 7,985,990 (기술재기준화)
- 8/31·9/30·10/31·11월 현재 4계좌(현금·법인·Cho·Vượng) 기말 변화 0
- 8/21 법인 실출금 변화 0, #1090 배분 25 → 24건(8,361,500) + 미배정 126,000

## 안전장치

- 실행 전 차단: 승인 토큰·승인자·SERIALIZABLE 확인 → 월 잠금(`ledger_month_close:2026-08`)·대상 행 잠금 → 월 열림 확인.
- 고정값 지문: #30·후보 #24·로그 #8223·#1057 행 md5, #1090/#1094 배분·거래·이동 md5, #107, 마감 상태, 4계좌 월말·일계·8월 손익·Ok Mart 미지급.
- 재실행: 완료 상태면 `DABACO126_ALREADY_APPLIED`(변경 0), 일부만 있으면 `DABACO126_PARTIAL_OR_FOREIGN_STATE`. 실패 시 전체 롤백.
- 트리거·RLS 비활성화, 마이그레이션, 함수 변경, 기존 RPC 우회 호출 없음. 감사 로그 1행에 before/after 전체 스냅샷.
- 운영 읽기 전용 preflight 결과(2026-11-04, audit max #7306): 21/21 PASS.

## 되돌리기 (필요 시 별도 승인)

감사 행 before 스냅샷 기준: 정정 A/B 전표를 `cancelled` 처리(또는 반대 정정), #30 party 15 복원, #15 paid 복원, 배분 #6 동일 값 재삽입.
