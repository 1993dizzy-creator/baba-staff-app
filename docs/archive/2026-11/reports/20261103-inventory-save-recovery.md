# 재고 빠른 저장·카테고리 수정 개선

- 작업 위치: `C:\workspace\baba-wt-codex`
- 브랜치: `codex/inventory-save-recovery-20261103`
- 기준: 배포된 main `aa30e49e`. main 파일·이력은 변경하지 않는다.
- DB 함수·스키마·Migration 변경 및 운영 쓰기: 없음.

## 원인과 수정

빠른 저장은 `InventoryPageContent` → items PATCH → 기존 원자적 RPC 순서다. 기존 클라이언트는 HTTP 500을 일반 저장 실패로 처리했고, 네트워크·JSON 응답 유실은 결과 확인 없이 잠금만 해제했다. 성공 후에도 전체 재고와 최근 로그 조회를 기다렸고, 전체 재고 조회의 Keg/POS 부하가 저장 버튼의 대기 시간에 포함됐다. journal 모드의 전송 오류 재호출도 빠른 저장에서는 결과 확인 전에 일어날 수 있었다.

현재는 한 폼이 최초 저장 요청과 확인 상태를 보유한다. HTTP 5xx·408·전송 실패·유효하지 않은 응답이면 인증된 `GET /api/inventory/items?itemId=…&saveCheck=true`로 해당 품목과 최근 감사로그 최대 20개만 읽는다. 전체 재고·거래처 마스터·POS/Keg 조회 또는 쓰기 RPC는 호출하지 않는다. 확인 중 및 미확정 상태에서는 입력·닫기·다시 저장을 차단하고, 별도 상태 확인 버튼은 같은 원요청에 대한 조회만 수행한다. journal 모드에서도 빠른 저장·자동 입고 정정의 전송 오류 자동 재호출을 끈다.

완료 판정에는 이전 버전 이후의 감사 시각, 인증된 작업자, 품목, 변경 전후 수량·차이, 사유·출처, 입고 거래처 ID·이름·단가, 실청구 모드·금액이 필요하다. 일치하는 로그가 하나이며 최신 로그여야 하고 현재 품목의 수량·갱신 버전도 맞아야 한다. 버전 누락·다른 작업자·여러 후보·조회 실패·중간 변경·잘린 확인 구간은 미확정으로 남긴다. 요청 UUID를 새로 DB에 저장하거나 기존 감사 내용을 바꾸지 않는다. 따라서 증거가 불충분한 사례는 관리자 확인이 필요하다.

PostgreSQL `57014` 오류는 해당 쓰기 트랜잭션이 취소된 경우로 구분한다. 그래도 현재 품목이 원래 버전·수량 그대로임을 조회한 뒤에만 미저장을 확정하고 직접 재시도할 수 있게 한다. 연결 오류에는 이 판단을 적용하지 않는다. 권한·필수 RPC·잠금 충돌·timeout·미확정 결과는 KO/VI 메시지로 안내한다. 복구로 재고 저장을 확인해도 장부 상태까지 추측해 확정 표시하지 않는다.

정상 성공은 기존 원자적 저장 응답을 받아 모달을 닫고 해당 카드에 적용한다. 전체 재고·최근 로그 재조회를 제거하고, 완료와 독립된 품목 1건 조회만 수행한다. 늦게 도착한 이전 저장의 조회가 새 저장을 덮어쓰지 않도록 세대를 확인한다. PATCH 성공 응답의 `Server-Timing`은 `inventory-write`(RPC 응답까지), `inventory-patch`(처리 전체)를 구분한다.

카테고리 수정 오류는 현재 언어의 `itemName`만 필수로 검사한 것이 원인이다. 두 언어 중 하나가 있으면 수정 가능하고 둘 다 없으면 기존 필수 검증으로 막는다. 비어 있는 번역을 자동 복사하지 않는다. 변경하지 않은 수량·단가·거래처·단위를 payload에서 제외하므로 분류 수정 때문에 표시용 거래처명이나 정규화된 단위가 원본 값을 덮어쓰지 않는다.

## 운영 읽기 전용 증거

2026-11-03에 제한된 SELECT만 수행했다. 자격 증명은 출력·저장하지 않았고 테스트/개발 서버에 전달하지 않았다. 조회 대상은 품목 111, 로그 14768, 해당 품목의 09:13~09:15 UTC 입고로그, 해당 로그의 projection 상태다.

| 항목 | 조회 결과 |
| --- | --- |
| 품목 111 | quantity 1.5, 단가 30,000, 단위 Kg, 거래처 ID 12 |
| 품목 updated_at | `2026-11-03T09:14:38.894149+00:00` |
| 로그 14768 created_at | `2026-11-03T09:14:38.592457+00:00` = 베트남 16:14:38 |
| 감사 내용 | quick_save / purchase, 0 → 1.5, 차이 +1.5, 단가 30,000, 자동 실청구 |
| 자동 계산 | 1.5 × 30,000 = 45,000₫ |
| 장애 구간의 해당 품목 빠른 입고 | 로그 14768 한 건. 앞선 두 실패 시각에 추가 입고로그는 조회되지 않음 |
| 장부 projection | `synced / PROJECTED` |

사용자가 제공한 16:13:35·16:14:11 HTTP 500과 같은 구간의 PostgreSQL timeout·POS HTTP 500은 장애 증거로 사용했다. 이 세션에서는 운영 PostgreSQL 원본 오류 로그·실행계획·자원 지표를 새로 취득하지 않았으므로 POS 부하가 timeout의 직접 원인이라고 확정하지 않는다.

## DB 성능 조사와 별도 개선 범위

코드에서 원자적 저장은 품목 행을 잠그고 CAS를 검사하며, 품목·감사·가격 이력과 신규 입고 장부 projection을 같은 트랜잭션으로 유지한다. 이 계약은 변경하지 않았다. 따라서 실제 DB timeout을 UI 수정만으로 해소했다고 볼 수 없다.

기존 전체 품목 조회는 Keg progress에서 POS 영수증·라인을 읽을 수 있다. 배포 기준에는 `e471e02a`의 business_date 하한 및 `1acdf722`의 매출 raw_json 선택 축소가 이미 포함되어 있고 이 작업은 재구현하지 않는다. 이 공유 조회·저장 경로는 DB CPU/IO·연결 자원을 함께 사용할 수 있지만 같은 시각의 500만으로 인과를 입증할 수 없다. 일반 SELECT가 직접 품목 쓰기 행 잠금을 보유했다고도 단정하지 않는다.

추가 DB 개선은 다음 읽기 전용 조사 결과에 따라 별도 결정한다.

1. 09:13~09:15 UTC의 원본 PostgreSQL/API 로그에서 query·SQLSTATE·duration·호출 경로를 맞춘다. 당시 설정은 실제 role/function의 timeout 설정으로 확인한다. 현재 `pg_stat_activity`만으로 과거 대기를 복원할 수는 없다.
2. 실패·성공 RPC의 잠금 대기와 실행 시간을 구분하고 ledger projection·트리거 및 POS 읽기의 비용을 비교한다. 집계 통계는 reset 시각을 같이 확인한다.
3. 품목별 최근 로그의 `item_id` 필터와 `(created_at,id)` 정렬, POS의 날짜 범위·조인 계획을 확인한다. 저장소의 일반 created_at 정렬 인덱스만 보고 품목별 복합 인덱스의 실제 설치 여부·효율을 가정하지 않는다.
4. 계획상 병목이 확인되면 필요한 인덱스·중복 POS 조회 제거·범위 축소를 별도 제안한다. 쓰기 원자성이나 timeout 값을 먼저 완화하지 않는다. 쓰기 RPC에 `EXPLAIN ANALYZE`를 실행하지 않는다.

[Supabase timeout 공식 문서](https://supabase.com/docs/guides/database/postgres/timeouts)는 설정 수준과 query timeout 로그 확인 방법의 참고다. 문서의 기본값을 이 운영 DB의 실제 설정으로 간주하지 않는다.

## 검증

- `inventory-items-final-validation.test.mjs` + `inventory-atomic-edit-db.test.mjs`: **84/84 PASS**, skip 0. 정상/500/전송 timeout/JSON 유실, 응답만 유실된 입고, 미확정 시 조회만 반복, journal 1회 호출, 중복 클릭, CAS 충돌, DB 롤백, 수량·가격·장부 불변성, 분류 수정 및 누락 번역을 포함한다.
- `inventory-quick-save-browser.test.mjs`: **PASS**, skip 0. 실제 앱 컴포넌트에서 KO/VI × desktop/mobile 4조합. 모든 API를 가로채며 운영에 쓰지 않는다. 두 이름 모두 빈 경우의 검증도 유지한다.
- API 쓰기 응답을 100ms 지연하고 후속 품목 조회를 차단한 브라우저 완료 시간: KO desktop 256ms, KO mobile 249ms, VI desktop 252ms, VI mobile 248ms. 이는 로컬 UI 응답 경계 측정이며 운영 DB 저장 시간이나 SLA가 아니다.
- 변경 소스 ESLint PASS. 앱 코드 TypeScript PASS(테스트 파일을 제외한 app/components/lib, 임시 설정 사용). 전수 테스트·Production Build는 실행하지 않았다.
- 기존 필수 RPC 누락 테스트 3곳의 오래된 HTTP 500 기대값은 기준 main의 기존 HTTP 503 계약과 맞췄다. RPC fallback을 허용하거나 실제 오류를 성공으로 바꾸지 않았다.
- 로컬 Next webpack, Google font 테스트 mock, API 전송 mock, 기존 PGlite fixture만 사용했다. 새 테스트 인프라·운영 Migration은 없다.

main 병합·Push·Production 배포는 수행하지 않는다.
