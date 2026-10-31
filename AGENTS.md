<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
## Supabase 운영 DB 안전 규칙

- BABA Supabase는 운영 데이터베이스로 취급한다.
- 기본 DB 작업은 읽기 전용 조사로 제한한다.
- SELECT 조회와 스키마·함수·권한·Migration 이력 확인은 가능하다.
- INSERT, UPDATE, DELETE, TRUNCATE 및 운영 데이터 변경은 사용자의 명시적 승인 없이 실행하지 않는다.
- CREATE, ALTER, DROP, CREATE OR REPLACE FUNCTION 등 DDL 작업은 사용자의 명시적 승인 없이 실행하지 않는다.
- `supabase db push`, `supabase db reset`, `supabase migration repair` 및 Migration 적용은 사용자의 명시적 승인 없이 실행하지 않는다.
- 사용자가 “Migration을 적용해줘”, “운영 DB에 반영해줘”처럼 명확하게 요청한 경우에만 변경 작업을 실행한다.
- Migration 적용 전에는 대상 파일, 변경되는 함수·테이블·제약·권한, 데이터 변경 여부를 먼저 보고한다.
- 기존에 적용된 Migration 파일을 수정하지 않고 후속 Migration을 추가한다.
- 운영 데이터 backfill 또는 일괄 수정이 포함되면 대상 행 수와 rollback 방법을 먼저 보고한다.
- 테스트 목적으로 운영 데이터를 변경해야 한다면 가능한 경우 트랜잭션 안에서 실행하고 반드시 ROLLBACK한다.
- 운영 DB 변경 후에는 다음을 다시 확인한다.
  - Migration history
  - 함수 정의와 인자
  - PUBLIC, anon, authenticated, service_role 권한
  - 데이터 행 수와 예상하지 않은 변경
  - 감사 로그 생성 여부
  - 보안 및 성능 Advisor
- SQL Editor에서 수동 실행한 Migration은 원격 Migration history에 자동 등록되지 않는다는 점을 고려한다.
- 로컬 Migration과 원격 Migration 버전의 불일치는 아래 SQL Editor 수동 적용 정책을 고려해 판단한다. 단순 불일치만으로 전체 과거 이력 조사를 요구하지 않는다. 검토 대상 신규 Migration의 중복 버전, 적용 SQL 불일치, 필수 객체 충돌 등 구체적인 위험이 발견된 경우에만 관련 범위의 원인을 조사하고 근거를 보고한 뒤 중단한다. 임의의 `db push`나 Migration history repair로 해결하지 않는다.
- 운영 DB 자격 증명, access token, database password, service role key를 코드·로그·문서·Git에 기록하지 않는다.

## BABA 운영 Migration 기본 절차

운영 Migration은 아래 수동 적용 절차를 기본으로 한다. 개발 에이전트의 담당 범위는 로컬 SQL 작성·테스트·검증까지이며, 사용자의 SQL 적용 승인을 에이전트의 운영 직접 실행 승인으로 확대 해석하지 않는다. 직렬 모드에서는 현재 작업 중인 에이전트(Codex·Claude Code 구분 없음)가 담당하고, 격리·병렬 모드의 로컬 SQL 담당은 Codex로 유지한다. 기존 운영 DB 안전 규칙의 명시적 승인 및 자격 증명 보호 조건은 유지한다.

1. 개발 에이전트는 로컬 SQL 작성·테스트·검증까지만 담당한다.
2. 사용자가 승인된 SQL을 Supabase SQL Editor에서 직접 실행한다.
3. 사용자가 적용 완료를 알리면 GPT가 연결된 Supabase 도구로 운영 결과를 검증한다.
4. 검증 통과 후 GPT가 해당 신규 Migration의 적용 이력을 확인하고, 누락되었다면 안전하게 등록한다. 등록은 사용자가 승인·실행한 해당 신규 Migration에 한정하며, 실제 실행 SQL·대상 버전·기존 이력을 대조하고 중복 등록을 방지한다.
5. 이후 앱 배포를 진행한다.

## 운영 Migration 반복 금지 사항

- 과거 Migration 불일치를 이유로 전체 이력 조사를 다시 요구하지 않는다.
- CLI, `db push`, DB 비밀번호 설정을 기본 절차로 요구하지 않는다.
- 과거 수동 적용 Migration을 자동으로 재실행하거나 일괄 이력 등록하지 않는다.
- 실제 충돌이나 안전상 위험이 발견된 경우에만 구체적인 근거와 함께 중단한다.

## 개발 모드 공통 절차 (Codex · Claude Code)

- 개발 모드, Worktree 소유권, 작업 브랜치, 영향 범위·충돌 검사, 병합·배포 승인, 검증 기준, 인계서 규칙은 `docs/agents/baba-agent-workflow.md`를 따른다. 위 운영 DB·Migration 규칙이 그 문서보다 우선한다.
- 개발 모드는 에이전트 종류가 아니라 실제 실행 중인 Git 작업 경로로 정한다.
- 원본 폴더(`C:\workspace\baba-staff-app`)의 `main`은 **직렬 모드**가 기본이다. Codex·Claude Code 모두 별도 선언 없이 직접 수정·테스트·커밋하며 `baba-start`·`baba-integrate`는 사용하지 않는다. 현재 실행 중인 에이전트가 SQL·Migration·RPC·코드·테스트를 모두 담당한다. 다른 에이전트 프로세스(PID)가 존재한다는 이유만으로 작업을 차단하거나 종료를 요구하지 않으며, 원본 main을 실제로 동시에 수정하는 충돌이 확인될 때만 중단한다. 검증·에이전트 교체 규칙은 기준 문서 §12를 따른다.
- 전용 Worktree(`baba-wt-codex`, `baba-wt-claude`)는 **격리·병렬 모드**다. 새 개발 요청은 자기 Worktree에서 `.agents/skills/baba-start/SKILL.md`를 읽고 `baba-start`부터 실행한다. 읽기 전용 조사로 작업명·수정 예정 파일을 정한 뒤 실행하며, 기록된 동일 작업은 재개한다. 차단이면 수정하지 않는다.
- 격리·병렬 모드는 `baba-start`(내부 `baba-preflight`) → 개발(범위 변경 시 Preflight 재실행) → `baba-verify` → `baba-handoff` 절차를 사용한다.
- 고위험 기능의 개발 착수 게이트, 검토 범위, 검증 중단 게이트는 기준 문서 §13을 따른다. 범위가 커지는 개발은 착수 전 사용자 승인을 받고, 사용자가 요청하지 않은 교차 검토는 반복하지 않는다. 위 운영 DB·Migration 보호 규칙은 그대로 유지한다.
- GPT와 지정 에이전트의 역할 분담, 수정 지시 전달, 작업 종료 시 임시 산출물 점검·정리는 기준 문서 §14를 따른다.
- 검증 실행 조건·PASS 증거 재사용·형식 오류 처리는 기준 문서 §8, 안전 중단 조건은 §13.3, 로컬 종료와 배포 검증 분리는 §15를 따른다.
