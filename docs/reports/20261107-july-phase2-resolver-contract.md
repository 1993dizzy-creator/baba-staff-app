# 7월 33행 SQL — 운영 resolver 해시 보완

**READY — 별도 오너 운영 실행 승인 전에는 적용하지 않는다.** 기준 `ceb649c5`. 이번 작업의 운영 HTTP·SQL·DML 호출은 모두 0회다.

## 불일치 원인과 호환성

렌더러가 최초 Migration `202608210003`의 함수 본문만 해시해 이후 동적 패치를 누락했다.

- 최초 정규화 SHA-256: `71fe505c58e76dfbf33eec4a3adc98472521c14adb522e731c51990fd8f3ffa3`.
- `20260906114438`은 공개 resolver의 후보 잠금 앞에 `inventory_ledger_private.lock_sources` 호출을 추가했다.
- `20260921170100`은 `verification_pending` 분기·감사를 추가하고, 일반 분기의 snapshot에서 `paymentVerification` 표시를 제거하도록 변경했다.
- 기존 원문에 해당 패치를 정확히 재현한 본문 SHA-256이 사용자가 2026-11-07 운영에서 확인한 **`edcfb9d5429307c6fa0690d8d89cfa005b02b8fd13749fab480793b32ed7c4d5`**와 일치한다. 정규화는 `replace(prosrc,E'\r\n',E'\n')`다. 변경 내용을 추측하거나 운영 해시를 다시 조회한 결과가 아니다.

재현한 본문과 실제 소스 잠금 함수, 기존 월마감 가드를 로컬 DB에 설치해 동작을 확인했다. Owner/Master 확인, `immediate` 전표·지정 계좌 출금 각 1건, pending→confirmed, 후불 미생성, 이미 확정된 후보 재처리 차단, pending source-key 중복 차단이 유지된다. 33행 배치가 새로 만드는 snapshot에는 `paymentVerification` 표시가 없으므로 새 분기의 표시에 따른 차이가 없다. 기존 단일 트랜잭션·7월 마감·8월 이후 원장·카드 보호·롤백과 호환된다.

## 변경 범위와 불변 증거

- 대상 `.local/july-restore/phase2-final-20261107-r2/next-batch-REQUIRES-OWNER-DB-APPROVAL.sql`은 **40행의 기대 함수 해시 1곳만 변경**했다. 함수 검사·정규화 방식·예외는 그대로다.
- `scripts/ledger/july-restore-phase2-plan.mjs` 8~10행/34행: 검증된 운영 해시를 고정해 재렌더링 시 최초 본문 해시로 되돌아가지 않게 했다. payload 생성 로직과 SQL template은 변경하지 않았다.
- `tests/july-restore-phase2.test.mjs`: 실제 패치가 반영된 함수 fixture와 해시·권한·즉시 지급·중복·마감 계약 검증을 보완했다.
- `bundle.json` 파일 SHA-256, 33개 action, 원본 행번호·source_key, 7,152,000₫ 및 계정별 증감이 모두 불변이다. bundleDigest는 `101b386b75d1e2be4fc05c604e42dfacc8f910975f4efc79b535d5d58c1491a0`으로 유지했다. 승인 payload·승인 해시를 재생성하지 않았다.
- `__ACTOR_USER_ID__`, `__OWNER_APPROVAL__`은 그대로다. 기존 49행/#395 제외, #1190/#3804/기존 지급배분, 8~10월 마감, −6,102,347₫ 카드 배치 차단은 바꾸지 않았다.

변경 전 SQL·bundle·검증 메타데이터, 한 줄 diff 및 새 검증 증거는 `.local/july-restore/resolver-contract-review-20261107`에 보존했다. 최종 폴더의 `verification.json`은 SQL 파일 해시와 후속 검증 이력만 갱신했다.

## 영향 범위 검증

`node --experimental-strip-types --test --test-name-pattern='resolver|last row' tests/july-restore-phase2.test.mjs` — **5/5 PASS**.

운영 해시와 재현 본문의 일치, 권한/즉시 지급/후보/고유키/7월 마감 계약, 2행 배치 재실행 멱등성, 승인·경계·본문 변경 차단, 마지막 행 오류 및 재고·기존/신규 카드배분 변조의 전체 롤백을 확인했다. 기존 33행 전수 매핑·금액·보호 PASS는 재사용했고 전수조사·전체 회귀는 반복하지 않았다.

최종 SQL과 저장된 기존 payload의 재렌더링 결과가 동일하며, 이전 SQL과의 차이는 40행의 해시 한 곳뿐이다. Main 수정·병합·Push·배포·운영 함수 변경·운영 DB 실행은 하지 않았다. 로컬 커밋 SHA는 종료 응답에 기록한다.
