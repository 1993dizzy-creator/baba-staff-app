# 4차 SQL — 가불 RPC 운영 계약 해시 보완

기준 커밋 `6354be78d8f387888f95d4d70669e1ecafa4638e`. 오너가 제공한 2026-11-07 운영 `pg_get_functiondef` 본문의 정규화 SHA-256을 재계산해 **`fb74a29c46a1ac9bb1739fa7f32842a5fc6ac16a9f11596d9875a1ff331eee98`와 정확히 일치**함을 확인했다. 기존 기대값은 `5448e85692dbd737685283ac00db2b7e47232e34225004679dfb18fe34542590`이다. 다른 3개 RPC는 오너의 운영 읽기 PASS를 재사용했다. 이번 작업의 운영 HTTP·SQL·RPC 호출은 모두 0회다.

## 원인과 호환성

가불 함수는 주석 제거와 공백·줄바꿈 포맷 때문에 원문 해시가 달랐다. SQL 문자열 리터럴과 단어/연산자 토큰을 보존하고 주석·문자열 밖 공백만 제외한 실행 토큰이 **전부 동일**하다. 해시를 그냥 교체하지 않고, 제공 본문의 실제 SHA와 실행 계약 동등성 검사를 `july-restore-phase4-advance-contract.mjs`에 고정했다. 원래 Migration이나 운영 함수는 수정하지 않았다. 보존된 본문은 실행기 없는 데이터이며 Migration이 아니다.

Owner/Master·활성 로그인 권한, 지급대상 직원 적격성, request UUID 및 고유키, 요청 잠금/월마감 잠금 순서, 업무일 03시 경계, 확정 급여의 adjustment 차단, 단일 가불 adjustment·`payroll_payment` 전표·출금 movement·감사 생성이 유지된다. 손익 인식 월/카테고리는 NULL이고 미지급금을 생성하지 않는다. 같은 요청의 재실행은 duplicate, 다른 금액은 request_conflict, 이미 급여 지급된 직원은 payroll_locked를 반환하며 실패 쓰기는 롤백된다. 로컬 메모리 DB에서 제공 본문의 실제 prosrc 해시도 검증했다.

## 최소 변경 및 불변 증거

- 최종 SQL 경로 유지: `.local/july-restore/phase4-final-20261107-r2/next-batch-REQUIRES-OWNER-DB-APPROVAL.sql`.
- 번들 경제 객체·9개 action 전체와 모든 actionHash는 이전 파일과 deep equality PASS. **9행·324,100,000₫**, 순이동 **−303,300,000₫** 그대로다.
- 4계정 증감 불변: 매장현금 **−10,100,000**, Vượng **−5,000,000**, Cho **+11,800,000**, 법인계좌 **−300,000,000₫**.
- RPC 계약 중 advance.hash 한 필드만 변경하고 bundleCanonical → bundleDigest → 외부 canonical 승인 SHA를 재생성했다. SQL의 변경은 payload 삽입 1줄과 승인 SHA 비교 2줄뿐이다. SQL 템플릿 및 실행/보호 절차는 바이트 동일하다.
- `__ACTOR_USER_ID__`, `__OWNER_APPROVAL__` 그대로 유지. 이전 승인 SHA는 새 SQL을 통과할 수 없다.
- 기존 임대료 지급 #1을 그대로 전환/재사용하며 지급 행 총 2건·계약 지급 합계 600M 유지. 새 임대료 비용 없음. 9전표·14 movement·가불 adjustment 2건과 메뉴 비용 1건만 생성하는 기존 계약 유지.

최신 bundleDigest: `0f68ef17a7b66eacbb2c670d554de69f056b127ec2c6b7c6040c2b97d1958776`.
외부 canonical/승인 SHA-256: `a4b94095d620efcc7e5b1b3b3477c1b9f15bf494e73c86e755c53ffb34602581`.
최종 SQL raw SHA-256: `ee9ab1abfccf6cb4cbe434b1b238a8e94e6d1bd6f5c814310d1315be89d7b846`.

## 영향 범위 검사

`node --experimental-strip-types --test --test-name-pattern='production advance|single batch|approval placeholders|late row failure|final artifacts' tests/july-restore-phase4.test.mjs` — **6/6 PASS**. 운영 자격 증명 없이 PGlite 메모리 DB에서만 실행했다. 변경된 운영 본문은 기존 fixture wrapper로 설치해 로컬 동작을 검증했으며, 제공된 DDL을 운영에 실행하지 않았다.

검사 범위는 실제 운영 본문 해시/실행 토큰 동일성, 가불 권한·동일 요청 재실행·요청 충돌·급여 지급 잠금, 9행 실제 배치/재실행 무쓰기, 임대 #1 재사용 및 기존 원장 보호, 승인/번들/계약 해시 변조 차단, 마지막 행 오류 시 앞선 임대 링크와 가불을 포함한 전체 롤백, 7월 마감 차단, 산출물/CSV/번들 무결성이다. 기존 나머지 PASS는 재사용하며 전체 회귀나 원자료 재조사는 하지 않았다.

변경 전 6개 파일과 각 raw SHA, 현재 비교 결과·테스트 출력은 `.local/july-restore/phase4-advance-contract-review-20261107/`에 보존했다. 현재 `bundle.json`, `verification.json`, 읽기 전용 RPC preflight와 상태 메타데이터도 함께 갱신했다. 근거 CSV·250행 상태표·124칸 검산 자료는 바이트 불변이다.

판정: **호환 PASS, 별도 Owner DB 승인 대기**. Main 수정·병합·Push·배포·운영 DB 쓰기는 하지 않았다. 최종 커밋 SHA는 Git 이력과 완료 응답으로 식별한다.
