# Keg P0 Migration 실행기 원자성 최종 검증 — 2026-10-21

**Supabase CLI 2.81.3의 검증된 `db push --db-url` 경로에서 DDL·권한·Migration history 원자성 통과. 운영 적용 전 실행기 호환성 차단 사유는 해소됐다. 실제 운영 적용 및 배포 승인은 별도다.**

운영 DB에 접속하거나 변경하지 않았다. Git 명령, 운영 Migration 적용, Push·배포는 실행하지 않았다. 사용자가 요청한 실제 CLI 적용 검사는 소유한 임시 loopback PostgreSQL의 `qa_case_N` DB에서만 실행했다. 원본 초안은 보존했다.

## 정확한 변경 범위 및 해시

정식 파일 `supabase/migrations/20261020120000_keg_safety_p0.sql`의 최상위 `begin;` 한 줄과 마지막 `commit;` 한 줄만 삭제했다. PL/pgSQL 본문 BEGIN/END, 주석, 공백, 함수 정의·로직·RLS·GRANT/REVOKE는 모두 보존했다. 원본의 해당 두 줄을 제거한 바이트와 정식 파일이 정확히 일치하는 것을 회귀 테스트로 검증했다. 운영 미적용 버전이므로 파일명/버전은 유지했다. 같은 버전·동일 내용 Migration은 각 1개다.

| 파일 | 상태 | SHA-256 |
| --- | --- | --- |
| `supabase/drafts/keg_safety_p0.sql` | 원본 208행, 변경 없음 | `39b13e6911a83782e0e207f0ab8cee00efd8073fbf517d82aec5c5e3d67cbc31` |
| `supabase/migrations/20261020120000_keg_safety_p0.sql` | 수정본 206행 | `80f63d9d5aefa4e85ef2e67365c3e10de799c938822239cf132794a02015eb19` |

트랜잭션은 검증한 CLI가 파일의 모든 문장과 후속 history INSERT를 포함해 소유한다. 최상위 BEGIN/COMMIT을 다시 추가하거나 SQL Editor에서 문장별로 실행하는 것은 이번 검증 계약에 포함되지 않는다. 사용자 요청대로 다른 주석도 변경하지 않았으므로 적용 방식은 이 보고서의 계약을 따른다.

## 실제 사용한 실행기와 격리 조건

- 실제 실행 버전: **Supabase CLI 2.81.3**, 실행 파일 `.qa-review/keg-p0/cli-2.81.3/supabase.exe`.
- 공식 v2.81.3 release의 Windows amd64 archive와 checksums 파일을 받아 검증했다. archive SHA-256: `35090b0eafd12706f1b4836857f0dd38a667a48471fe51473d04e51336212da3`.
- 실제 EXE SHA-256: `6bd15b0436293e65a4b06798f26c18dd0ecfa58f08fa9cb514901ebea62d1445`.
- `--version` 및 `db push --help`를 먼저 확인했고 테스트도 2.81.3 이외 버전이면 적용 전에 실패한다. CLI 출력의 업데이트 권고에 따라 다른 버전으로 자동 교체하지 않았다.
- 실제 PostgreSQL 18.4를 새 소유권 표식/임의 포트로 생성했다. CLI의 임시 config는 프로젝트의 기존 실행기 검증과 같이 `major_version=17`을 사용하며 컨테이너를 시작하지 않는다. 실제 연결 서버는 위 PostgreSQL 18.4다.
- 각 시나리오는 새 `qa_case_N` 데이터베이스, 별도 `supabase/config.toml` 및 migrations 디렉터리를 쓴다. 기존 Keg 스키마·운영 RPC의 로컬 원본 정의와 최소 데이터, 기존 prerequisite history 1행을 준비하고 이번 파일만 pending으로 만들었다. 성공 경로에서는 수정본 SQL 바이트를 그대로 복사했다.
- CLI 시작 전에 host가 `127.0.0.1`, DB명이 `qa_case_N`, 임의 포트가 1024 초과인지 assert한다. root 프로젝트 연결 설정·`.env`·운영 자격 증명을 읽지 않는다. 자식 환경은 필수 OS 경로만 복사하고 `USERPROFILE`/`DOCKER_CONFIG`를 임시 디렉터리로 지정한다.
- `PGSSLMODE=disable`은 TLS가 없는 해당 로컬 CLI 자식에만 지정한다. 운영 연결 설정은 바꾸지 않는다. CLI의 일반 출력인 “Connecting to remote database”는 실제 대상이 운영이라는 의미가 아니며, URL 검증으로 loopback만 허용했다.
- 테스트 종료 후 소유한 클러스터를 정지하고 소유권 확인 절차에 따라 정리했다. 다른 서버/이력을 수정하지 않았다.

실제 명령 형태:

```text
<검증된 supabase.exe 2.81.3> db push \
  --db-url "postgresql://postgres@127.0.0.1:<임의 포트>/qa_case_N?sslmode=disable" \
  --workdir <소유한 격리 작업 디렉터리> --yes
```

이 명령은 보고서에 적은 로컬 검사 명령이다. 운영 대상 URL이나 운영 적용 명령을 실행한 것이 아니다. 테스트 파일은 `tests/keg-safety-p0-cli.test.mjs`, 상세 증거는 `.qa-review/keg-p0/cli-atomicity-evidence.json`의 `actualCliInvoked: true`다. 이전 단순 SQL protocol 재현과 구분된다.

## 실제 CLI 성공·오류·가시성·재실행 결과

| 시나리오 | 검증한 결과 |
| --- | --- |
| 수정본 그대로 적용 성공 | audit 테이블 1개·새 RPC 2개·해당 Migration history 1행이 함께 생성. 기존 prerequisite history 및 기존 RPC/ACL/설정/트리거/재고/세션/로그 보존. 새로운 history statements에 최상위 transaction 문장 없음. 읽기 전용 Postflight도 성공 |
| 실행기가 추가하는 마지막 history INSERT 실패 | 임시 history 트리거에서 해당 version INSERT만 오류 발생. CLI exit 1. 신규 테이블 0·RPC 0·해당 history 0. 기존 이력 전체와 기존 데이터/ACL/정의 보존 |
| SQL 실행 도중 실패 | 임시 Migration 복사본에 table/preview 함수 생성 뒤 `select 1/0` 주입. CLI exit 1. 신규 테이블·RPC·연결 ACL 및 해당 history가 모두 제거되고 baseline 보존 |
| 외부 연결 가시성 | 아래 두 advisory gate에서 실제 CLI를 정지. 별도 연결에서 신규 table/function/history 모두 0이고 함수 signature 조회도 NULL. 완료 후에는 table 1/function 2/history 1과 최종 ACL이 함께 관찰됨 |
| 성공본 재실행 | 같은 CLI가 “Remote database is up to date”로 exit 0. 신규 적용 로그가 없고 기존/신규 객체·ACL·데이터·전체 history가 그대로이며 중복 history 없음 |

### 임시 PUBLIC EXECUTE 노출 검증

첫 gate는 preview 함수 CREATE 뒤, apply 함수 CREATE 및 최종 함수 REVOKE 전에 삽입했다. PostgreSQL 기본 function ACL에 PUBLIC EXECUTE가 있음을 먼저 확인한 환경에서 CREATE의 기본 권한이 아직 회수되지 않은 시점이다. CLI는 별도 연결이 잡은 advisory lock에서 실제 대기했고 `pg_locks`로 대기를 확인했다. 외부 연결에는 해당 함수의 catalog/signature 자체가 보이지 않아 PUBLIC 역할이 호출할 수 있는 신규 함수가 없었다.

두 번째 gate는 모든 최종 GRANT/REVOKE 뒤, 실행기의 history INSERT 전에 삽입했다. 여기서도 외부 연결은 audit table 0/RPC 0/해당 history 0이었다. gate를 해제한 뒤에만 객체 및 history가 함께 보였고 anon/authenticated EXECUTE=false, service_role EXECUTE=true, PUBLIC ACL 없음, audit RLS=true 및 service_role 직접 SELECT만 허용을 확인했다. owner의 고유 권한은 그대로다.

gate와 오류 주입은 임시 파일·임시 DB에만 들어가며 등록 Migration이나 원본에는 저장하지 않았다. 단순 삭제 사실이나 함수 성공만으로 통과 판정하지 않고, 실제 실행기의 마지막 history INSERT 실패와 두 지점의 외부 MVCC 가시성까지 확인했다. 현재 조건에서는 대체 적용 경로가 필요하지 않다.

## 기능·권한·일반 진입 회귀

기능 fixture의 기본 SQL 로드를 정식 Migration으로 바꿔 현재 수정본을 검증하도록 했다. 원본 초안의 독립 트랜잭션 검증은 보존했고, 등록 계약 검사는 원본 해시/수정 해시와 정확한 두 줄 차이를 검사하도록 갱신했다. API 명명 인자/JSON 반환 계약, 기존 교체 RPC/재고 -1 처리, 중복 요청·2인 경합·시각 수정 경합, 중간/감사 오류 롤백, 실제 권한도 다시 통과했다.

| 실행 | 통과 / 실패 / 생략 |
| --- | --- |
| 기능·SQL·API·I/O·native 동시성·등록 계약·실제 CLI 검사 | 104 / 0 / 0 |
| P0 및 품목로그 KO/VI × PC/모바일 브라우저 회귀 | 3 / 0 / 0 |
| 중복 없는 전체 합계 | **107 / 0 / 0** |

CLI 단독 선행 실행 6건은 위 104건에 포함되므로 중복 합산하지 않았다. 실제 CLI 검사 6건은 상위 테스트 1개와 사용자 요청 시나리오 5개다.

- 최초 20L 세션 수정에서 종료 요약 null·20L 로스 미표시, 베트남 03:00 경계 및 영업일 불일치 차단, 합성 L3 #141 지연 6잔 +1,980mL의 stale/기존 불일치 저장 차단 유지.
- 신규 RPC는 service_role 실행 전용이며 PUBLIC/anon/authenticated 실행 불가. audit의 RLS 및 직접 SELECT 외 권한 차단 유지. 기존 RPC 정의·owner/config/ACL/재고 차감 로직 및 기존 테이블 권한·트리거 불변.
- 일반 `/inventory` 최초 진입은 PC·모바일 각 버전 10회에서 **API 3·DB 읽기 16·그중 POS 읽기 4**, telemetry 제외 응답 **11,909B** 동일. 신규 요청·조회 0건. 실제 GET 코드를 로컬 read fixture로 실행한 I/O 검증이며 운영 DB/네트워크 성능 실측은 아니다. 이번 SQL 변경으로 모달 구조나 초기 렌더 코드를 바꾸지 않았다.
- 변경 테스트/fixture ESLint 통과. 루트 Production Build와 브라우저용 Production Build 모두 exit 0. 제품 TS/TSX는 바꾸지 않았고 전체 tsc는 이번에 반복하지 않았다. 이전 전체 tsc의 기존 오류 40건을 해소했다고 주장하지 않는다.
- 주요 로그: `.qa-review/keg-p0/runner-final-regression.txt`, `runner-final-browser.txt`, `runner-final-eslint.txt`, `runner-final-root-build.txt`, `runner-final-harness-build.txt`, `cli-atomicity.txt`, `cli-atomicity-evidence.json`, `runner-final-io-smoke.json`.

## 최종 판정·남은 위험·필요 승인

**이 수정본은 검증한 CLI 2.81.3 경로로 운영 적용을 검토할 수 있는 로컬 준비 상태다. 기존 history 원자성 차단 사유는 해소됐다. 운영에 적용됐거나 배포가 승인됐다는 판정은 아니다.**

1. 운영에는 새 해시 `80f63d9d…2015eb19`의 정식 파일만 사용해야 한다. 보존한 초안의 구 해시 `39b13e69…67cbc31`와 혼동하면 이전 문제가 다시 생긴다. 실제 운영 적용은 새 SQL/해시와 적용 대상에 대한 별도 명시적 승인이 필요하다.
2. 운영 실행기도 검증한 2.81.3/명령 경로로 고정하고, 다른 버전·실행기·SQL Editor 사용 시 별도 검증한다. root 프로젝트에 운영 CI/CLI 버전 고정이 새로 추가된 것은 아니다.
3. 운영 pending/history와 실제 대상의 prerequisite 정의·권한·트리거를 유지보수 창에서 대조해야 한다. 이번에는 운영 조회를 추가하지 않았다. 다른 pending/누락/부분 적용이 있으면 중단하고 임의 repair/include-all로 우회하지 않는다.
4. 구버전 PATCH가 혼재하지 않도록 Keg 쓰기를 잠시 멈추고 SQL→API/UI를 일관되게 전환한다. 신규 RPC 없이 앱만 먼저 전환하면 저장이 503으로 차단된다.
5. 적용 전 baseline을 저장하고 적용 후 준비한 `supabase/verification/20261020120000_keg_safety_p0_postflight.sql`을 읽기 전용으로 실행해 이력 1건·RPC 인자/정의·역할별 권한·RLS·기존 객체/데이터 불변을 비교한다. 기존 과거 불일치의 운영 보정이나 이후 지연 POS 자동 보정은 이번 범위 밖이다.

이전 차단 보고서 `20261021-keg-safety-p0-predeploy.md`는 구 해시의 이력으로 보존한다. 현재 판단은 이 보고서를 기준으로 한다. [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-db-push).
