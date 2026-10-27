# M단계 미적용 Migration 아카이브 / LF 정책 검증

작업: Codex 전용 Worktree, `codex/20261027-aug-sep-ledger-corrections-01`. 사용자 승인 권장안 A에 따른 로컬 정리다. 시작 HEAD는 `4f4188acf3a1efe5bb8b9e817fdc17ef81f0778a`, 확인한 main은 `b73f252cf7c088d02070de8d44f57577182c77c8`이다. main 통합·원격 Push·배포·운영 SQL은 실행하지 않았다.

## 변경과 불변성

`git mv`로 `supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql`을 `docs/history/migrations-retired/`로 이동했다. Git은 **R100**, 이전/이후 blob 모두 **2a6d8344ffe15562ed351935da98cef1303b15fb**로 판정했다. 원본 삭제가 아니라 내용과 이력을 보존한 경로 이동이다.

| 파일 | raw SHA-256 (이동/정책 변경 전후 동일) |
| --- | --- |
| 아카이브 160650 | `185d0b8aec5757c7f569d426a9cdee2153e7f7362abc22fde758244adf05ce6e` |
| 활성 112354 | `1afa18682ea2b407691ff9190e65b3aeaeace98ccfd8ab752e900d1fe1ed9b63` |
| 활성 175537 | `8de4012ac67dd7d7aedeca0fa755db6aef85d0b8006c1924de8422815cca282d` |
| m-stage-install.sql | `b7634d83769b9d7d5e6bce53fa644fd2512468c2235624f7db57ff58debfa7e1` |
| m-stage-register.sql | `4265d1af78adffac59d37e21464248186739d93be4fb78c14f1a6fda8b98d6e7` |

아카이브 README는 운영 미적용·이력 미등록이라는 사용자 확인, 175537 대체 이유, 원본 해시, 운영 실행·활성 경로 복원·거짓 이력 등록 금지를 기록한다. 160650 실패 원인은 함수 정의만 LF로 정규화하고 `v_old/v_new` 문자열은 CRLF로 비교한 비대칭 처리다. 175537은 세 문자열에 같은 정규화를 적용한다.

`.gitattributes`에 `supabase/migrations/*.sql text eol=lf`를 추가했다. 기존 `20261002062405_fix_preflight_inactive_recurring_plans.sql -text` 예외는 `-text !eol`로 유지했다. `!eol`은 새 상위 규칙의 상속만 해제하여 이전의 실효 속성(text unset / eol unspecified)을 보존한다. docs 및 아카이브 SQL의 속성은 그대로다. 별도 fixture에서 `core.autocrlf=true`여도 일반 SQL은 index LF, 개별 예외는 원래 CRLF로 보존되는 것을 검증했다. 기존 SQL 전체 재정규화나 `git add --renormalize`는 실행하지 않았다.

활성 Migration 파일 199개를 파일시스템과 Git index 양쪽에서 조사했다. 160650은 없고 112354/175537은 존재한다. 기존 개별 예외 외 활성 SQL의 raw CR 바이트는 0건이다. 기존 적용 Migration 본문 수정은 없다. 실패 재현 테스트의 legacy 입력 경로만 아카이브로 변경했다.

## 검증 도구의 제한된 지원

기존 `baba-verify`는 모든 기존 Migration 이동을 차단하므로, 이번 사용자 승인 이동에 한정한 읽기 전용 증거 검사를 추가했다. 정확한 source/destination, rename 상태, source 활성 경로 부재, 기준 blob, raw SHA-256, 현재 blob, README 정책을 모두 요구한다. 다른 Migration 이동·수정·삭제, 아카이브 바이트 변경, 원본 경로에 복사 잔존, 기준 blob 불일치는 계속 차단한다. 이 검사는 DB 이력 확인이나 사용자 승인을 대신하지 않는다. 일반 병합 승인·기존 Migration 보호 정책은 유지한다.

신규 아카이브/속성 테스트 6건과 기존 검증 도구 회귀로 이 제한을 확인했다. 공통 도구 변경은 Claude 독립 검토 대상이다.

## 연결 환경과 이력 확인 범위

운영 미적용·이력 0건은 사용자가 제공한 확인 결과를 사용했다. 이번 작업에서는 운영 Supabase에 SQL을 보내지 않았다. 연결 도구 카탈로그에는 알려진 운영 읽기 전용 connector만 있고 별도 비운영 endpoint는 발견되지 않았다. 시작 시 실행 중 PostgreSQL 프로세스와 소유한 보존 테스트 클러스터는 없었고, 접속 관련 프로세스 환경 변수도 이름 기준으로 발견되지 않았다. 자격 증명 파일이나 값은 읽지 않았다.

따라서 확인 가능한 기존 비운영 환경에서 실제 160650 적용 이력을 발견한 것은 없지만, **미연결 원격 환경의 이력은 미검증**이다. 해당 환경에서 적용 이력이 발견되면 아카이브 후속 절차·설치를 중단하고 보고해야 한다. 전체 환경의 이력 부재로 확대 해석하지 않는다.

새 로컬 독립 PostgreSQL 17.6 DB에서 112354 → 175537을 적용하고 두 버전만 등록했다. 각 `statements`는 LF 정규화한 Migration 원문과 SHA-256이 일치하며, 160650 이력은 없다. 의도적으로 160650 이력을 넣는 충돌 차단 테스트는 폐기되는 fixture 음성 대조이며 실제 외부 적용 이력과 다르다.

## 실제 실행 결과

`QA_POSTGRES_BIN`으로 기존 로컬 PostgreSQL 17.6 바이너리를 지정했다. 새 UUID 소유 클러스터/DB, 독립 세션 2개 이상으로 실행했으며 Docker 설정이나 시스템 서비스는 변경하지 않았다. 실행 후 소유 클러스터 정리와 leftovers 0건을 확인했다.

첫 `baba-verify --base main --build` 결과는 **PASS_WITH_PREEXISTING**이다. 관련 테스트 13개 파일, **145 PASS / 0 FAIL / 0 SKIP**이다. 장부 관련 90건(기존 84 + 아카이브 6), 검증 도구 55건이며, 아래 PostgreSQL 집계에는 각 최상위 테스트 1건이 포함된다.

| 검사 | 결과 |
| --- | --- |
| PostgreSQL 17.6 경합·교착 회귀 | 22 PASS (21 독립 시나리오) |
| PostgreSQL 원자적 설치·이력 | 12 PASS (11 시나리오) |
| PostgreSQL 줄바꿈 실패 재현·수정 설치·롤백 | 19 PASS (18 시나리오) |
| PGlite 정정/R1/카드 정규화 | 5 + 4 + 3 PASS |
| 재개방 / 마감 카드 귀속 회귀 | 14 + 5 PASS |
| 아카이브·Git 속성·보호 정책 음성 대조 | 6 PASS |
| 검증 도구 build-env / integrate / tools / safety | 7 + 34 + 7 + 7 PASS |
| ESLint | 신규 오류·경고 0 |
| TypeScript | 신규 오류 0, merge-base에도 존재하는 기존 오류 40 |
| next build | offline-local-fixture PASS, 운영 연결 미검증·배포용 산출물 아님 |

기존 40P01 재현 순서는 `00000`으로 정상 완료했다. 5초 lock_timeout 3건은 각각 `55P03`, 약 5022/5021/5020ms였으며 교착을 통과로 처리하지 않는다. 정정·R1·감사 로그 중간 쓰기 뒤 timeout과 C3 중간 실패를 포함하여 전체 롤백, 중복 0, 원거래·잔액 보존을 검증했다. 테스트 중 40P01 재발은 없다.

LF, Windows CRLF, 혼합 LF/CRLF, CR-only, 원본/후속의 서로 다른 줄바꿈, dollar-quoted old/new 블록만 변환된 경우를 통과했다. legacy 실패는 보존된 아카이브를 사용해 격리 DB에서 재현했다. 원본만 존재하는 미커밋 상태는 외부 세션에서 보이지 않았고, 후속 전/최종 commit 전 실패는 두 DDL 모두 롤백됐다.

최종 함수의 공백 정규화 본문 MD5는 **beebd06ff35eb3eaf0a68dfde8494412**다. 소유자 `postgres`, SECURITY DEFINER, `search_path=pg_catalog, public`, `lock_timeout=5s`, PUBLIC/anon/authenticated EXECUTE 금지, service_role EXECUTE 허용을 확인했다. 원본 금액, R1 50M 계획, 준비금 60M, C1~C3 기준 및 예상 손익은 변경하지 않았다.

## M단계 설치·등록 절차의 정합성

설치/등록 파일과 생성기의 실행·등록 대상 배열은 정확히 **112354 + 175537** 두 버전이다. 160650은 설명·advisory 직렬화·충돌 차단 가드로만 언급되며 실행/INSERT 대상이 아니다. 생성한 문자열과 저장 파일이 일치한다. 두 활성 Migration 원문/해시와 번들은 이번 작업에서 변경하지 않았다.

향후 별도 승인 시 사용자가 `m-stage-install.sql` **전체**를 한 세션/배치에서 실행하는 기존 절차를 유지한다. 하나의 BEGIN/COMMIT 안에서 원본과 후속, 최종 함수 검증이 수행되어 원본 단독 커밋을 허용하지 않는다. 오류 시 해당 세션 ROLLBACK 후 중단하며 조각 실행/이어 실행은 금지한다.

이력 등록은 저장소 정책대로 사용자 설치 완료 확인 및 최종 결과 검증 **후** `m-stage-register.sql` 전체로 별도 수행한다. 두 이력 INSERT는 한 트랜잭션이며, 동일 이력 재등록은 no-op, 다른 원문/이름 충돌·retired 이력 존재·함수/권한 불일치는 오류로 전체 롤백된다. 두 installer/registrar 경합, 설치 진행 중 registrar 대기, 두 번째 이력 실패 시 첫 번째도 롤백되는 것을 확인했다. 과거 이력 일괄 등록·강제 repair·db push는 하지 않는다.

## 독립 검토 및 남은 승인

Claude Code는 R100 원본 보존, 개별 속성 예외, 활성 목록 및 번들의 두 버전, 좁게 한정한 검증 도구 예외와 음성 대조, PostgreSQL 결과를 독립 재검토한다. 커밋 후 최종 상태의 재검증 기록과 코드 SHA는 별도 인계서에 기록한다. 다른 미연결 환경의 이력은 여전히 확인 범위 밖이다.

이번 결과는 로컬 준비·검증 완료이며 운영 설치 승인이 아니다. 실제 main 수동 통합, 원격 Push, Migration 설치/후속 이력 등록, 운영 장부 정정·재마감, Production 배포는 실행하지 않았고 별도 승인 대상이다. Claude에게 외부 메시지는 보내지 않고 저장소 인계서로 전달한다.
