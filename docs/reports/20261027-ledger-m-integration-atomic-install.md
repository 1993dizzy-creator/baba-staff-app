# BABA M단계 통합 후보 및 원자적 설치 절차

## 보존하는 Git 이력

- 기준 main: `823af4e601661641658e62f29e4f7917f544eed9`.
- 공통 조상: `8e281d5feedaf5b816110d040098a373facd1381`.
- main 단독 커밋: `823af4e`(7월 카드 귀속 정리 문서).
- 기존 Codex 단독 커밋: `5eab47e` → `a9435a6` → `36d2355` → `020ecc8`.
- 기존 두 Migration `20261027112354` 및 `20261027160650`은 수정하지 않는다. 이력 재작성·rebase·cherry-pick·강제 전환 없이 원래 SHA와 내용을 보존한다.

두 브랜치는 분기돼 있어 현재 Codex HEAD를 main에 바로 ff-only 병합할 수 없다. 승인된 **로컬 통합 준비** 범위에서 자기 Worktree 내부의 독립 Git 저장소에 main과 Codex를 fetch하고, main에서 시작한 통합 브랜치에 Codex를 두 부모 merge한다. 두 부모를 가진 후보는 main `823af4e`를 조상으로 포함하므로 사용자가 나중에 원본 main을 **ff-only**로 이동할 수 있다. 이 준비는 원본 main/index/작업 파일/다른 Worktree를 변경하지 않는다.

최종 후보의 정확한 branch/SHA/parents/tree, 포함 커밋 검사, 검증 JSON 위치·digest, main/원격 시작·종료 대조는 담당 Worktree의 `.tmp-baba/m-stage-integration/latest.json`에 기록하고 최종 응답으로 보고한다. 이 파일은 자동 main 승인서가 아니며 독립 수동 승인과 구별한다.

## 검토한 설치 대상과 최종 함수

실행 순서는 원본 `20261027112354_aug_sep_reclose_corrections.sql` → 잠금 수정 `20261027160650_fix_aug_sep_reclose_lock_order.sql`이다. 원본만 설치하고 COMMIT하거나 원본 함수로 회계를 실행하는 절차는 금지한다.

최종 signature는 `public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint)`, 인자명은 `p_month,p_rent_plan_id,p_actor_user_id`, 반환형은 jsonb다. 최종 본문은 whitespace 제거 MD5 **beebd06ff35eb3eaf0a68dfde8494412**여야 한다.

- owner postgres / SECURITY DEFINER.
- search_path=`pg_catalog, public`, 함수 범위 lock_timeout=`5s`.
- PUBLIC·anon·authenticated EXECUTE 금지, service_role EXECUTE 허용. 예상 밖 역할의 EXECUTE도 설치 검증에서 거부한다.
- 전체/월 마감 잠금 → closure → 계획 prefix/계획 집합 고정·검증 → R1 월 prefix → 거래 table lock 순서.
- 원본의 C1~C3, R1 50M, 원거래/자금/준비금 60M, 감사·중복 방지·원자적 rollback과 예상 손익은 그대로다.

최종 함수는 두 번째 Migration 적용 결과다. 이력 등록을 위해 옛 함수로 되돌리거나 원본 CREATE를 다시 실행하지 않는다.

## 설치 검토용 산출물

1. `scripts/ledger/m-stage-bundles.mjs`: 두 원본 SQL을 UTF-8/LF로 읽어 검토용 파일을 생성한다. DB에 연결하는 코드가 없다.
2. **`scripts/ledger/m-stage-install.sql`**: 두 DDL 전체를 BEGIN/COMMIT 하나로 묶은 설치본. 마지막에 최종 본문·owner·인자·보안·권한·5초 설정을 검사하며 실패하면 COMMIT까지 진행하지 않는다.
3. **`scripts/ledger/m-stage-register.sql`**: 적용 완료 통지 및 검증 후 실행하는 별도 이력 등록본. 함수 DDL/회계 DML은 실행하지 않고 승인 SQL 두 개를 각 statements 배열에 정확히 보존한다.
4. `tests/ledger-m-atomic-install-postgres.test.mjs`: 생성 SQL의 원본 일치와 실제 PostgreSQL 다중 세션 원자성·노출 방지·등록 충돌을 검증한다.

검토본은 `node scripts/ledger/m-stage-bundles.mjs --write`로 재생성할 수 있다. 테스트는 체크인된 두 SQL 파일이 생성 결과와 바이트 단위(LF 정규화)로 같은지 비교한다. 원본의 LF SHA-256은 `1afa18682ea2b407691ff9190e65b3aeaeace98ccfd8ab752e900d1fe1ed9b63`, 수정본은 `185d0b8aec5757c7f569d426a9cdee2153e7f7362abc22fde758244adf05ce6e`다.

## SQL Editor 원자적 설치와 재적용 차단

**현재는 검토·로컬 시험만 승인됐으며 운영 실행 승인은 없다.** 이후 별도 승인 시 다음 순서를 따른다.

1. 실제 승인본 두 SQL·두 버전·해시와 운영 history 컬럼/대상 함수 존재 여부를 이 두 버전 범위에서만 확인한다. 운영 전체 과거 이력 조사/repair/db push는 하지 않는다. 표준 history `version/name/statements` 형식이 다르면 중단하고 실행본을 다시 검토한다.
2. 사용자가 **m-stage-install.sql 전체를 한 세션/한 배치**로 실행한다. BEGIN → 5초 lock/30초 statement timeout → 공통 설치 advisory와 버전 advisory 두 개 → 사전 조건 → 원본 전체 → 수정본 전체 → 최종 메타데이터 검사 → COMMIT 순서다. 조각 실행이나 중간 COMMIT은 금지한다.
3. 함수가 이미 있으면 `M_STAGE_FUNCTION_ALREADY_EXISTS`, 대상 이력이 하나라도 있으면 `M_STAGE_HISTORY_ALREADY_EXISTS`로 설치를 거부한다. 함수 있음/이력 없음은 재설치하지 않고 검증·등록 단계로 간다. 이력 있음/함수 없음은 자동 repair하지 않는다.
4. 어느 위치든 오류가 나면 같은 세션에서 **ROLLBACK**하고 멈춘다. 오류 뒤 COMMIT을 강행하거나 수정본만 임의 재시작하지 않는다. 설치 함수 호출을 설치본에 덧붙이지 않는다.
5. 사용자가 적용 완료를 알리면 GPT가 실제 실행 증거와 최종 함수/owner/인자/권한/설정 및 예상치 못한 회계 행 변경 없음 여부를 검증한다. 이 시점까지 history는 자동 등록되지 않으며 함수 재실행도 하지 않는다.
6. 검증 통과 뒤 **m-stage-register.sql 전체**를 한 트랜잭션으로 실행해 두 버전을 등록한다. 설치와 같은 공통 advisory 및 오름차순 버전 잠금을 사용한다. 최종 함수 메타데이터를 먼저 다시 검사하고, 각 기존 row의 name/statements를 승인본과 비교한다. 동일 row는 그대로 두고 없는 row만 ON CONFLICT DO NOTHING으로 넣으며, 삽입 뒤도 다시 비교한다.
7. 두 번째 버전의 충돌/INSERT 실패는 첫 번째 버전 등록까지 모두 rollback한다. 같은 등록본을 다시 실행하면 내용이 정확히 같은 두 행만 유지하고, 기존 내용을 UPDATE하거나 다른 과거 버전을 변경하지 않는다. 마지막에 두 버전이 각각 정확히 1행이고 최종 함수가 수정본인지 재검증한다.

두 트랜잭션은 정책상 **사용자 설치 → 적용 완료 통지 → GPT 검증 → 누락된 해당 이력 등록**을 유지한다. 함수 설치는 이미 원자적이며, history 등록도 두 버전끼리 원자적이다. 자동으로 운영에 연결하거나 임의 승인 플래그를 설정하는 실행기는 만들지 않았다.

## 실제 PostgreSQL 검증

PostgreSQL 17.6의 독립 local-only 클러스터, 시나리오별 DB, 서로 다른 PID의 실행 A/B 및 관찰 세션을 사용했다. 확대 설치 검증 **11 PASS / 0 FAIL / 0 SKIP**를 직접 확인했다.

- 원본 CREATE 후 미커밋 상태에서 다른 세션은 함수 자체를 찾지 못했고 호출은 42883으로 거부됐다. 수정+최종 검사 COMMIT 뒤 처음 보이는 함수의 hash는 수정본이었다. 원본만 외부에 노출되지 않았다.
- 수정 직전 및 최종 COMMIT 직전 실패를 주입해 두 DDL 모두 rollback, 함수 부재/회계 및 이력 원상태를 검증했다.
- 두 installer가 겹치면 두 번째는 실제 advisory wait 후 첫 설치의 수정 함수만 보고 재설치를 거부했다.
- 두 registrar는 직렬화돼 두 버전이 한 번씩만 남았다. unfinished installer와 registrar가 겹쳐도 registrar는 수정본 COMMIT 뒤에만 진행했다.
- 이력만 있고 함수가 없는 불일치는 설치가 거부됐다. 두 번째 버전 내용 불일치와 두 번째 INSERT 실패는 첫 등록도 rollback했다. 무관한 기존 history row는 변하지 않았다.
- 함수 없음 또는 최종 권한 변조 상태에서는 등록을 거부했다. 원본/수정 statements의 정확한 내용과 동일 재등록 no-op를 검사했다.
- 설치만으로 거래·movement·정정/R1 감사 행이 생기지 않았고 기존 자료가 동일함을 비교했다.

직접 확대 실행 증거는 `.qa-review/pg-native-logs/pg-native-test-afd32c1e-2735-4d5c-80f3-3c3ba479ffa7-Vpxjv0/`에 있다. 생성한 자기 클러스터는 정상 종료·소유권 확인 후 데이터만 정리했고 로그를 보존했다. Docker·서비스·사용자 시스템 설정 변경 없음.

핵심 최종 검증 목록은 기존 회귀 31개 + 교착 수정 native 22개 + 원자적 설치 native 11개, 총 64개다. 통합 코드에서 동일 목록을 다시 실행하고 Production Build도 offline fixture로 확인한다. 최종 실제 결과는 인계서와 통합 receipt에 기록한다. 원본 회계 금액/evidence 및 두 Migration 자체는 변경하지 않았다.

## 수동 Fast-forward 승인 경계

기준 정책은 `docs/agents/baba-agent-workflow.md` §7과 `docs/agents/baba-integrate.md`다. 도구의 main 실행은 비활성화돼 있고 SQL/DB 스키마에는 별도 검토 게이트가 있다. 게이트를 수정하거나 PASS로 위조하지 않는다. 로컬 독립 저장소의 기술 후보 작성·시험과 실제 main 이동 승인은 별개다.

사용자는 최종 receipt의 main SHA가 여전히 823af4e인지, candidate/merge SHA·parents·tree·검증 digest와 모든 필수 검사의 실제 실행/skip 0을 검토한다. 승인 후 사용자 터미널에서만 독립 통합 저장소의 **검증된 SHA**를 별도 로컬 review ref로 fetch하고, 그 SHA가 현재 main을 조상으로 포함하는지 확인한 뒤 `git merge --ff-only <검증된 review ref>`로 main을 이동한다. main이나 후보가 바뀌면 이전 receipt는 무효이며 새 기준으로 다시 준비·검증한다. 실제 명령에 사용할 저장소/branch/SHA는 최종 receipt와 응답에 명시한다.

이번에는 main 병합·원격 push·Production 배포·운영 Supabase DDL/DML·정정·재개방·재마감·Migration 이력 등록을 실행하지 않는다. 승인 전 설치/등록 SQL은 모두 검토용 산출물이다.
