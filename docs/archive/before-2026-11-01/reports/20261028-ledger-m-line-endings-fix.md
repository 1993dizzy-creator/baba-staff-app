# BABA M단계 SQL Editor 설치 실패 — 줄바꿈 비교 수정

## 결과와 범위

PostgreSQL 17.6에서 수정 전 SQL을 CRLF로 전송해 운영 보고와 동일한 **P0001 / RECLOSE_LOCK_ORDER_PATCH_NOT_FOUND / inline_code_block line 59**를 재현했다. LF/CRLF 혼합과 LF 원본+CRLF 후속도 동일하게 실패했다. 원인은 함수 정의만 LF로 바꾼 비대칭 비교다. 수정 후 LF·CRLF·혼합·CR-only 및 달러 인용 블록만 바뀐 입력에서 설치·최종 함수·권한·이력 저장이 일치했다.

운영 Supabase에는 접속하거나 SQL을 실행하지 않았다. 함수/이력/정정 0건, 8·9월 closed/revision 3은 **사용자가 제공한 운영 확인 결과**이며 Codex가 재조회한 결과가 아니다. 로컬 신규 SQL의 설치/이력 등록 성공은 운영 적용을 뜻하지 않는다. main 통합·push·배포·운영 설치/정정/재개방/재마감은 미실행이다.

## 정확한 코드 원인

실패한 `20261027160650`의 처리 순서는 다음과 같다.

1. `md5(regexp_replace(prosrc,'\s+','','g'))`로 원본 함수 본문을 검사한다. CR/LF는 whitespace이므로 CRLF 본문도 원본 MD5 **5429554141424f2fa75aa3492350eb2c**에 일치한다.
2. `v_definition := replace(pg_get_functiondef(v_oid), E'\r\n', E'\n')`로 **정의만** LF로 바꾼다.
3. `v_old`와 `v_new`는 `$old$...$old$`, `$new$...$new$`의 원문 상수다. 이 달러 인용 문자열에는 SQL Editor/Windows 붙여넣기의 CRLF 또는 혼합 줄바꿈이 그대로 들어간다.
4. `strpos(v_definition,v_old)`는 byte/문자열의 정확한 연속 일치를 찾으므로 LF 정의 안에서 CRLF 패턴을 찾지 못해 0을 반환한다. line 59에서 예외를 낸다.

실제 PostgreSQL 진단값은 세 실패 입력 모두 `old_position=0`, 양쪽을 같은 줄바꿈 규칙으로 처리했을 때 `normalized_position=1333`이었다. 원본 본문 해시 가드가 실패한 것이 아니다. 위치 59와 SQLSTATE까지 일치하는 재현으로 이 코드 결함을 확인했다. 운영에 실제 붙여넣은 원문 바이트는 제공받지 않았으므로 운영 입력의 정확한 EOL 배열을 읽었다고 주장하지 않는다.

이전 테스트는 migration read 및 install artifact read에서 CRLF를 LF로 바꾼 뒤 DB에 전송했다. 따라서 LF만 통과한 결과로 실제 CRLF 붙여넣기까지 검증했다고 볼 수 없었다. 새 테스트는 의도한 raw CRLF/혼합 문자열을 `pg.Client.query()`로 그대로 전송한다.

## 정책 및 활성 버전 변경

`AGENTS.md`는 적용된 Migration을 수정하지 않도록 규정하고, 저장소 `baba-preflight`/`baba-verify` 구현은 적용 여부와 무관하게 **기준선의 모든 Migration 파일 수정**을 차단한다. 사용자 요청의 미설치 상태를 전제로 하되 이 검증기를 고치거나 Git 이력을 재작성하지 않았다.

- 원본 **20261027112354**: 원문/버전 보존.
- 실패한 미적용 **20261027160650**: 재현용 역사적 증거로 원문 보존. **현재 설치/등록 대상에서 제외**한다. 적용한 것처럼 history를 추가하지 않는다.
- 새 대체 **20261027175537_reclose_patch_line_endings.sql**: CLI migration new로 생성한 수정본. 원본 20261027112354 다음에 **160650 대신** 실행한다. 이 숫자는 CLI가 생성한 UTC 시각이며 보고서 날짜는 사용자 Asia/Bangkok 날짜다.

활성 설치 및 등록 버전은 **20261027112354 + 20261027175537 두 개**다. 160650을 건너뛴다는 것은 과거 적용 이력을 삭제/수정하는 것이 아니다. 사용자 제공 상태에서 해당 이력 자체가 0건이며, 실패해서 실행 완료되지 않은 SQL을 등록하지 않는 처리다. 기존 history에 160650이 있으면 새 설치/등록본은 중단하고 관련 범위만 조사하도록 가드했다.

이 대체는 승인된 SQL Editor 수동 경로용이다. 보존된 실패 파일을 포함해 폴더 전체를 자동 순차 실행하거나 db push/reset/repair하는 경로는 제공·승인하지 않는다. Claude 독립 검토에서 **대체 버전 선택 및 retired 파일의 제외가 명확한지** 반드시 확인한다.

## 수정 내용

새 대체 Migration에서 정의·검색 패턴·대체 패턴 모두 다음과 같이 처리한다.

```sql
replace(replace(value, E'\r\n', E'\n'), E'\r', E'\n')
```

CRLF를 먼저 LF로 바꾸고 남은 단독 CR도 LF로 바꾼다. `strpos`와 `replace`는 각각 `v_old_normalized`와 `v_new_normalized`를 사용한다. 공백/들여쓰기/SQL 리터럴을 임의로 정리하거나 본문 해시 가드를 완화하지 않았다. 예기치 않은 본문은 계속 drift로 거부한다.

함수의 최종 본문 MD5는 기존 교착 수정본과 같은 **beebd06ff35eb3eaf0a68dfde8494412**다. 수정 대상은 설치 DO의 비교 처리이며 함수 회계 로직이 아니다. C1~C3, R1 50M, 준비금 60M, 원거래·movement·감사·중복 방지·5초 lock_timeout·마감 가드·기존 교착 수정 순서는 유지한다. 예상 손익도 8월 267,236,765.578₫, 9월 70,507,820.4₫ 그대로다.

생성기 `m-stage-bundles.mjs`도 같은 CRLF→LF/CR→LF 규칙으로 원문을 읽고, 실제 활성 두 버전에서 설치본/등록본을 재생성한다. 이력 등록 시 달러 인용 source 문자열을 **DB 안에서도 동일 규칙으로 정규화**한 뒤 statements에 넣는다. 따라서 등록 SQL 자체가 CRLF/혼합으로 붙여넣어져도 LF 원문과 SHA-256이 일치한다. LF 등록본으로 재실행해도 mismatch 없이 no-op다.

## 설치·등록 검토본과 SHA-256

모두 UTF-8/LF 정규화 기준이다. 생성 SQL 주석의 원문 hash, 실제 Migration, DB에 저장한 statements의 hash를 교차 검증한다.

| 파일 | SHA-256 |
|---|---|
| 원본 20261027112354 | 1afa18682ea2b407691ff9190e65b3aeaeace98ccfd8ab752e900d1fe1ed9b63 |
| 보존/retired 20261027160650 | 185d0b8aec5757c7f569d426a9cdee2153e7f7362abc22fde758244adf05ce6e |
| 활성 대체 20261027175537 | 8de4012ac67dd7d7aedeca0fa755db6aef85d0b8006c1924de8422815cca282d |
| 재생성 m-stage-install.sql | b7634d83769b9d7d5e6bce53fa644fd2512468c2235624f7db57ff58debfa7e1 |
| 재생성 m-stage-register.sql | 4265d1af78adffac59d37e21464248186739d93be4fb78c14f1a6fda8b98d6e7 |

이전 b73f252 설치본·등록본 및 이전 통합 receipt는 이번 실패 전의 역사적 자료이며 **재사용하지 않는다**. 수정본도 Claude 독립 검토 및 사용자 별도 승인 전 운영 실행하지 않는다.

## PostgreSQL 17.6 재현·검증

기존 native 바이너리를 사용해 자기 Worktree의 독립 local-only UUID 클러스터를 만들었다. Docker/서비스/시스템 설정이나 다른 Worktree는 변경하지 않았다.

| 입력 | 수정 전 | 수정 후 |
|---|---|---|
| 전체 LF | 성공 | 성공 |
| 전체 CRLF | P0001 / line 59 | 성공 |
| 전체 LF/CRLF 혼합 | P0001 / line 59 | 성공 |
| 원본 CRLF + 후속 LF | 성공 | 성공 |
| 원본 LF + 후속 CRLF | P0001 / line 59 | 성공 |
| CR-only | 수정 전 판정 범위 밖 | 성공 |
| 달러 인용 old/new만 CRLF·혼합 | 수정 전 판정 범위 밖 | 성공 |

새 EOL suite는 19개(상위 1 + 재현 5 + 수정 후 7 + rollback 6)다. 수정 전 실패 3개는 **동일 오류가 실제 발생해야 통과하는 음성 대조**이며, 수정 후 실패를 성공으로 처리하는 것이 아니다.

- 수정 후 7조건 모두 최종 MD5 일치, postgres owner/SECURITY DEFINER/search_path/5초 설정 보존, anon/authenticated 실제 호출 42501, service_role 실행권한 확인.
- 각 조건에서 설치→활성 두 버전 등록→정확한 statements 및 hash 대조→다른 EOL의 등록본 재실행 no-op→설치 재적용 차단을 확인했다. retired 160650은 생성되지 않는다.
- CRLF/혼합/CR-only 각각 수정 직전 및 COMMIT 직전에 22012 실패를 주입했다. 함수/이력 0건으로 rollback되고 원거래·movement·감사·8·9월 closed/revision 3 fixture가 보존됐다.
- 기존 atomic suite는 retired 이력 충돌 검사까지 확대해 12개이며, 두 번째 history INSERT 실패 시 첫 등록도 rollback, 무관한 이력 보존, 원본 함수 외부 미노출·동시 설치/등록 직렬화를 계속 검증한다.
- 기존 교착 native 22개와 관련 회귀 31개를 전부 재실행한다. 최종 전체 수는 **84개**이며 실제 최종 결과는 인계서에 기록한다. 40P01과 55P03은 기존 테스트에서 구분한다.

직접 재현 증거: `.qa-review/pg-native-logs/pg-native-test-4829fa8c-95e2-4de9-8e3f-d9405d856172-1GpTMU/`(수정 전), `pg-native-test-affdb99f-b3b1-4869-9f5d-872f055d1ffd-UwetSQ/`(수정 전/후/EOL/rollback). `.tmp-baba/m-line-endings/results.json`에는 실행마다 버전·오류 line/SQLSTATE·검색 위치·권한·등록 원문 hash·정리 결과를 기록한다. 각 실행의 원본 server.log/diagnostics는 UUID별로 보존한다.

## Claude Code 독립 검토 인계

다른 에이전트에게 메시지를 보내거나 그 Worktree를 변경하지 않았다. 다음 담당은 이 보고서·최종 인계서·수정 SHA를 기준으로 독립 검토한다.

1. 원본/retired 파일이 b73f252 대비 byte/blob 불변이고 Git 이력 재작성이 없는지 확인한다.
2. 기존 오류를 raw CRLF/혼합 입력으로 재현하고 MD5 통과→strpos 0→line 59 실패를 확인한다.
3. 새 대체본의 세 텍스트 정규화 규칙과 strict 본문 가드, 최종 MD5·보안 설정 불변을 확인한다.
4. 활성 두 버전이 112354/175537이고 160650이 실행/등록되지 않는 정책 및 새 파일 제외/선택이 명확한지 검토한다. 자동 전체 migration 적용은 하지 않는다.
5. 생성기 재생성 diff 0, 각 EOL에서 source/hash/DB statements 동일, 충돌/재실행/rollback을 확인한다.
6. 기존 native 교착 22개·atomic 12개·EOL 19개·관련 회귀 31개를 독립 PostgreSQL에서 실행한다. 운영 SQL은 별도 승인 전 실행하지 않는다.

재현 명령:

```powershell
$env:QA_POSTGRES_BIN='C:/workspace/baba-staff-app/.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin'
node --import ./scripts/agent/lib/offline-guard.mjs --test --test-concurrency=1 tests/ledger-m-line-endings-postgres.test.mjs tests/ledger-m-atomic-install-postgres.test.mjs tests/ledger-aug-sep-reclose-postgres.test.mjs
```

이 명령은 실제 운영 연결이 아닌 도우미가 생성한 임시 local-only DB를 사용한다. 운영 전체 스키마·RLS·실제 앱 preflight/summary/UI/Advisor와 운영 붙여넣기 원문의 정확한 바이트는 미검증이다.
