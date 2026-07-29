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
- 로컬 Migration과 원격 Migration 버전이 불일치하면 임의로 `db push`하지 말고 먼저 원인을 조사한다.
- 운영 DB 자격 증명, access token, database password, service role key를 코드·로그·문서·Git에 기록하지 않는다.
