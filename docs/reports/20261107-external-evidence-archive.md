# baba-evidence 이관 기록 — 2026년 10월 증거

이번 작업은 파일 조사·보존·이관만 수행했다. 앱 코드 변경, DB 접속·SQL 실행, 기존 회계 검산 재실행, Main/다른 Worktree 변경은 없다.

## 조사 결과와 보관 분류

- 원본: `C:\workspace\baba-evidence\20261031`, **15파일 / 120,428바이트**(약 117.6 KiB). 생성일은 2026-10-31, 원본 수정일과 파일별 크기·SHA-256은 보관 manifest에 남겼다.
- 내용: 10월 직원 식대 20건 통합 준비, 일별 자금 120칸 대조 중 108칸 PASS 자료, Supabase 읽기 전용 handoff, 식대 apply/preflight/postflight SQL, NOT_READY/PASS_LOCAL_PREPARATION 이력, 입고 #12848 공급자 확인 SQL이다. 7월 복원과 별개의 장기 회계·감사 증거다.
- 원본 내부에서 SHA-256이 같은 파일은 **0그룹**이다. 6파일은 이 Worktree의 기존 Git 추적 사본과 정확히 같으며, 나머지 9파일은 그 경로에 없는 추가 증거다. 서로 다른 준비/최종 버전 및 실행 가능 SQL은 중복으로 취급하거나 삭제하지 않았다.
- 원본 `manifest.json`의 5개 파일 해시, 후속 validation의 기존 증거 해시, 최종 SQL `.sha256`도 확인했다. 해당 선언 해시 검사 16개 모두 일치했다. 이는 파일 무결성 검사이며 회계/운영 실행 결과 검증을 새로 수행한 것이 아니다.

## 이관 위치와 검증

최종 위치는 **현재 Worktree의 `.local/evidence-archive/20261031`**다. 원본 15개 파일의 이름·구조·바이트는 그대로 유지하며 `.local`은 이미 Git 추적 제외 대상이다.

원본 15파일을 복사한 뒤 개수·크기·SHA-256을 확인하고, 외부 원본을 제거하기 직전에 원본/이관본을 다시 비교했다. 원본 내부에 `.git`, `.env`, reparse point가 없음을 확인했다. 검증된 파일을 개별 제거하고 빈 디렉터리만 제거해 외부 `baba-evidence` 폴더를 정리했다. 고유 자료 삭제는 0개다.

장기 보존용 portable ZIP을 `.local/evidence-archive/_archive-metadata/20261031-original-evidence.zip`에 추가했다. ZIP의 **15개 entry**도 원본과 SHA-256을 비교했다. ZIP 크기는 36,185바이트이며 SHA-256은 `673a1485f54f52ae990eb81f95b41b923b174702926800ee304583033384fb60`이다. 원본 목록·원래 생성/수정일·개별 해시는 같은 metadata 폴더에 보관한다. ZIP은 같은 디스크의 보존 패키지이며 독립 백업을 만들었다는 뜻이 아니다.

## 경로 참조

Main, Claude/Codex Worktree, 현재 Worktree, bacninh 프로젝트와 최상위 실행/작업공간 설정을 읽기 전용으로 검색했다. 활성 소스·스크립트에 외부 `baba-evidence` 경로를 사용하는 코드는 발견되지 않았다. 따라서 Main/다른 Worktree의 코드를 수정할 필요가 없다.

외부 경로는 원본의 readiness/validation JSON 및 checksum 관련 보관 메타데이터에서 과거 경로로 나타난다. 이 파일들은 증거 해시 보존을 위해 고치지 않았으며, archive README에 이전 prefix → 새 archive 위치 대응을 명시했다. 기존 cleanup 보고서의 “당시 보존” 기록에는 이번 후속 이관 링크를 추가했다. 오래된 QA 임시 복제본에서 발견된 문서명 참조는 실행 코드의 외부 경로 의존성이 아니다. 광범위 검색 중 기존 QA fixture의 끊어진 경로를 발견했으나 다른 Worktree를 수정/정리하지 않았다.

## 보존·확인 사항

`FINAL` SQL과 `PASS_LOCAL_PREPARATION` JSON만으로 운영 적용 완료를 확정할 수 없다. 이 폴더에 실행 후 실제 DB 결과가 충분히 있는지도 확정하지 않았다. 운영에 사용되었을 수 있는 SQL, 읽기 전후 조사 자료, NOT_READY 버전 모두 보존하고 파일 정리 과정에서 실행하지 않는다.

기존 6파일은 이미 Git으로 보존된다. 추가 9개 원본과 전체 ZIP은 장기 보존 대상이지만 private 금융자료이므로 이번에 Git에 새로 올리지 않았다. 이 Worktree를 폐기하기 전에 portable archive를 별도 영구 보관소로 이전해야 한다. 이번에 외부 저장소/클라우드로 전송하지 않았다.

이관/정리 완료 결과는 `.local/evidence-archive/_archive-metadata/cleanup-result.json`에 기록했다. 기존 `C:\workspace`의 다른 디렉터리는 대상이 아니다. 신규 최상위 임시 디렉터리는 만들지 않았다. Git 변경은 이 기록과 이전 정리 보고서의 후속 링크뿐이며 private 원본은 새로 추적하지 않는다.
