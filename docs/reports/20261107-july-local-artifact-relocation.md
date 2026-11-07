# 7월 로컬 자료 이동 및 운영 적용 이력

사용자가 49행 운영 등록 완료를 확인했다. 신규 전표 **#4227~#4275**, **49/49 PASS**. 이번 정리 작업에서는 운영 DB 접속·SQL 실행·재검증을 하지 않았다. 이 결과는 사용자 제공 사실이며 새 DB 조회 결과가 아니다.

## 운영 사용본과 개발 커밋의 차이

기준 개발 커밋은 `eac8d1f296e967310eb02a37ace70d9bf7691e42`다. 실제 운영에 사용한 버전은 사용자에 따르면 다음 두 부분을 바꿨다.

| 부분 | 개발 커밋의 초안 | 실제 운영 사용본(사용자 확인) |
| --- | --- | --- |
| 기존행 보호 스냅샷 | 전체 기존행 JSON 집계 | MD5 집계로 경량화 |
| statement_timeout | 120초 | 90초 |

실제 운영 SQL 원문은 제공된 로컬 자료에서 확인되지 않았다. 따라서 정확한 실행본 해시나 원문 diff를 만들어 내지 않았고, 개발 초안을 실행본으로 간주하지 않는다. 원문이 추후 제공되면 증거로만 보관한다. 이 49행은 **재실행 금지**다.

## 자료 위치와 보존

- 이전 위치: `C:\workspace\baba-july-inputs-2026`.
- 현재 위치: 이 Worktree의 `.local/july-restore`.
- 기존 47개 파일은 이동 전후 크기·SHA-256을 전부 비교했다. 원본 시트, 395행 매핑, Dry-run, 카드/DB 관측, 각 회차 SQL을 보존했다.
- 원본 다운로드 ZIP 1개는 압축 내 4개 원본과 이동된 파일을 대조하고, ZIP 자체 SHA-256도 확인한 후 `.local/july-restore/archives`로 이동했다.
- 49행 SQL 초안 6개는 `safe-subset-REQUIRES-SEPARATE-DB-APPROVAL.DO-NOT-RERUN.sql`로 이름만 바꿨다. 원문 바이트는 동일하며 `_relocation/sql-name-map.json`에 대응표를 남겼다.
- 이동 검증 이력은 `.local/july-restore/_relocation`에 보관한다. 동일 내용의 회차별 증거도 삭제하지 않았다. 중복 ZIP은 없었다.

외부 자료 폴더가 이 세션에서 생성된 것을 대화·파일 목록으로 확인했고, 이동본의 모든 해시를 재검증한 뒤 이전 위치만 제거했다. 원본 Main·다른 Worktree·`.git`·`.env`·커밋된 보고서는 삭제하지 않았다.

`C:\workspace`의 나머지 출처/정리 권한이 불명확한 항목(`baba-evidence`, `bacninh`, 8월 rebuild patch, `start-baba-codex.cmd`, `worknow.code-workspace`)은 그대로 두었다. 작업 Worktree도 삭제하지 않았다.

후속 지시에 따라 `baba-evidence`는 10월 장기 증거임을 조사하고 별도 `.local/evidence-archive`로 이관했다. 이는 7월 자료와 분리되며 [별도 이관 기록](20261107-external-evidence-archive.md)을 따른다.

## 이후 생성 경로

`.local/`을 Git 추적에서 제외하고 AGENTS.md에 Worktree 내부 임시자료 원칙 및 49행 재실행 금지를 기록했다. 7월 개발 스크립트의 외부 자료 경로를 모듈 위치 기준 `.local`로 바꿨으며, 신규 출력이 Worktree의 `.local` 밖으로 나가는 경우 거절한다. 과거 보고서와 테스트의 보존 파일 참조도 새 위치/이름으로 갱신했다.

정리 검증은 파일 해시·개수·경로·Git ignore·스크립트 구문 및 출력 경로 검사만 수행했다. 운영/격리 DB SQL 테스트와 이전 Dry-run/금액 검산은 재실행하지 않았다.
