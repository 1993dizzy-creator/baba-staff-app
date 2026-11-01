# BABA 관리자 앱

장부·POS 매출·재고·직원·근태·급여를 관리하는 Next.js 16 / React 19 / TypeScript 프로젝트입니다.

## 프로젝트 구성

- `app/`: 관리자 화면, API, 레이아웃
- `components/`, `lib/`: 화면 컴포넌트와 업무 로직
- `supabase/migrations/`: 데이터베이스 Migration SQL
- `tests/`, `scripts/`: 회귀 테스트와 개발·검증 도구
- `docs/`: 업무 문서와 검토 기록. 과거 보관 자료는 `docs/archive/before-2026-11-01/`에 있습니다.
- `public/`: 정적 자산

## 로컬 실행

개발 경로는 `C:\workspace\baba-staff-app`입니다. 필요한 로컬 환경 설정이 준비된 상태에서 실행합니다.

```powershell
cd C:\workspace\baba-staff-app
npm ci
npm run dev
```

기본 접속 주소는 <http://localhost:3000>입니다.

## 연결 서비스

- GitHub: [1993dizzy-creator/baba-staff-app](https://github.com/1993dizzy-creator/baba-staff-app) — 소스와 Git 이력 관리
- Supabase: PostgreSQL 데이터와 SQL/RPC 처리
- Vercel: Next.js 앱 배포와 `vercel.json`에 정의된 Cron 실행
