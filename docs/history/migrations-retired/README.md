# 미적용 Migration 아카이브

이 디렉터리는 운영 Migration 실행 대상이 아니다. 보존된 SQL을 `supabase/migrations/`로 복원하거나 운영에서 다시 실행하지 않는다. 실제 적용 이력이 발견되면 이동/정리 절차를 중단하고 사용자에게 보고한다. 임의 이력 삭제·수정·강제 등록으로 해결하지 않는다.

## 20261027160650_fix_aug_sep_reclose_lock_order.sql

- 이전 경로: `supabase/migrations/20261027160650_fix_aug_sep_reclose_lock_order.sql`
- 현재 경로: `docs/history/migrations-retired/20261027160650_fix_aug_sep_reclose_lock_order.sql`
- 상태: **운영 미적용·Migration 이력 미등록**. 사용자 제공 운영 읽기 전용 확인(실패 트랜잭션의 함수/이력/정정 0건)을 전제로 승인된 아카이브다. 이번 작업에서 운영 DB를 변경하지 않는다.
- 사유: 함수 정의만 LF로 바꾸고 달러 인용 `v_old`/`v_new`는 CRLF 그대로 비교해 SQL Editor 조건에서 P0001/line 59 실패가 발생한다. 대칭 줄바꿈 정규화와 원문 이력 보존을 구현한 **20261027175537_reclose_patch_line_endings.sql**로 대체했다.
- 원본 Git blob: **2a6d8344ffe15562ed351935da98cef1303b15fb**.
- 원본 raw SHA-256: **185d0b8aec5757c7f569d426a9cdee2153e7f7362abc22fde758244adf05ce6e**.
- 이 blob/SHA-256은 git mv 전후 완전히 같아야 한다. 역사적 실패 증거이므로 파일 내용·줄바꿈을 바꾸지 않는다.
- 파일은 git mv로 이동했고 원본 내용과 Git 이력을 보존한다. 적용한 것처럼 `20261027160650`을 history에 등록하지 않는다.

활성 M단계 설치/등록 대상은 **20261027112354 → 20261027175537** 두 버전뿐이다. 설치 검토본 `scripts/ledger/m-stage-install.sql`, 등록 검토본 `scripts/ledger/m-stage-register.sql`도 이 조합만 실행/등록한다. `160650`이 해당 파일에서 언급되는 것은 retired 이력 충돌 차단/설명용이며 실행·등록 항목이 아니다.

## 이력 확인 범위

운영 상태는 사용자 제공 확인 결과다. 현재 연결 도구에서 별도 비운영 Supabase endpoint는 발견되지 않았고, 로컬의 실행 중 PostgreSQL 프로세스/보존된 소유 클러스터도 없었다. 미연결 환경 전체에 적용 이력이 없다고 단정하지 않는다. 신규 독립 PostgreSQL 17.6 DB에서 활성 두 버전만 설치·등록하고 160650 부재를 검사한다. 테스트에서 의도적으로 만든 충돌 이력은 rollback/폐기되는 음성 대조이며 실제 적용 환경 이력이 아니다.

기존 모든 적용 Migration 파일은 수정하지 않는다. 활성 파일의 LF 정책은 `.gitattributes`에서 관리하되 기존 `-text` 개별 예외는 `!eol`로 상속된 eol 값까지 해제해 유지한다. `git add --renormalize` 등 기존 SQL 전체 재정규화는 하지 않는다.
