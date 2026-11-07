# 3차 SQL — lock_sources 운영 계약 해시 보완

**호환 PASS, 별도 운영 승인 전 미실행.** 기준 `9230fbb6e19bae8abddd32302cd205e32052778a`. 이번 작업의 운영 HTTP·SQL·쓰기 호출은 0회다. 경제 데이터·입고 조사·다른 RPC 계약은 변경하지 않았다.

## 원인과 호환성

계약 재현 코드가 `20260906114438`의 최초 잠금 본문만 사용하고, `20260914161954_link_inventory_purchase_corrections.sql`의 동적 패치를 누락했다. 후속 패치는 correction 로그 키를 원구매 키로 정규화한 다음 중복 제거·C 정렬·source/월/장부 잠금을 수행한다. 추가 월 및 기존 후보/확정 전표 잠금 순서는 유지된다.

해당 패치를 원문 그대로 적용해 얻은 정규화 SHA-256이 사용자가 운영에서 확인한 값과 정확히 일치한다.

- 이전: `603de3acaa74d144e10203d6c28c63ed9267343dd53cff5dc2a119b994e32226`
- 현재: `df9b3ce8ceb8a3f754ca504aeaef6f3274c51ab997c899fe3fb9c76dc2556739`

로컬 DB에서 correction 자식 키와 원구매 키가 같은 원구매 advisory lock을 공유하고, 독립 source·추가 월·기존 확정 전표 잠금이 유지되는 것을 `pg_locks`로 확인했다. correction 자식의 다른 날짜로 불필요한 월 잠금을 추가하지 않으며 데이터는 변경하지 않는다. 실제 62행 원자 배치의 실행·멱등 재실행·실패 롤백도 호환된다. Migration이나 운영 함수는 수정/적용하지 않았다.

## 승인 번들 갱신 및 불변 증거

대상은 기존 경로 `.local/july-restore/phase3-final-20261107-r2/next-batch-REQUIRES-OWNER-DB-APPROVAL.sql` 그대로다. SQL template은 변경하지 않았다. 렌더 결과의 변경 행은 **9행(payload), 14~15행(외부 승인 SHA-256 비교)**뿐이다.

`bundle.rpcContracts`의 `lock_sources` 해시 하나만 변경한 뒤 `bundleCanonical`, `bundleDigest`, 전체 payload canonical SHA-256을 일관되게 다시 계산했다.

- 새 bundleDigest: `20d38996d498bbcf49cec574048842107fb0178769b4383d35392bf0ec8979ad`
- 새 외부 canonical/승인 SHA-256: `467783d1a2738e9a5922f32a38195855464f959563ecdf2794532c95734cbb1b`
- `__ACTOR_USER_ID__`, `__OWNER_APPROVAL__` 유지. 이전 승인 해시로는 통과하지 않는다.
- 다른 RPC 4개와 모든 경제 action 객체·행별 actionHash·원입고 매핑은 변경 전후 deep equality로 확인했다.
- **62행 / 신규 비용 전표 110건 / 원입고 ID 163개 / 총 실지급 63,821,342₫ 불변**.
- 계정 증감 불변: 매장현금 −20,267,000₫ / Vượng −4,110,000₫ / Cho −14,952,000₫ / 법인 −24,492,342₫.
- 95행 근거 CSV·312행 상태표·일별 영향표 파일 SHA-256 불변. 해시 검증 및 기존 장부/마감/카드/롤백 보호는 유지했다.

같은 폴더의 `bundle.json`, `summary.json`, `verification.json`, RPC 읽기 전용 preflight도 함께 갱신했다. 변경 전 원본·승인 해시·diff 범위와 검증 이력은 `.local/july-restore/phase3-lock-contract-review-20261107`에 보존했다. 기존의 62행 경제 PASS와 사용자 운영 읽기 PASS를 재사용했다.

## 영향 범위 테스트

`node --experimental-strip-types --test --test-name-pattern='lock_sources production|actual 62-row|last component' tests/july-restore-phase3.test.mjs` — **3/3 PASS**.

운영 관측 해시와 재현/설치 본문의 일치, correction-origin 잠금·추가 월·기존 전표 잠금, 실제 62행 실행/재실행·경제 합계 불변, 마지막 component 오류 및 보호 자료 변조의 전체 롤백을 검증했다. PGlite는 단일 backend의 PID를 0/NULL로 표시하므로 해당 표현을 구분해 실제 advisory lock의 classid/objid도 확인했다. 운영 연결·자격 증명·전체 회귀는 사용하지 않았다.

변경은 로컬 계약 재현 helper·관련 테스트·보고서와 Git 제외 자료에 한정된다. Main 수정·병합·Push·배포·운영 DB 실행은 없다. 최종 로컬 커밋 SHA는 종료 응답에 기록한다.
