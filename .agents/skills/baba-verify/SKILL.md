---
name: baba-verify
description: BABA 관리자 앱 코드 변경 후 실행하는 검증. 변경 파일 검사(충돌 표식·자격 증명·기존 Migration 수정), 관련 회귀 테스트(자격 증명 제거·오프라인 가드), ESLint, TypeScript, 필요 시 Production Build를 실행하고 merge-base 기준선과 비교해 기존 오류와 신규 오류를 구분하며 실제 실행 항목과 미검증 항목을 분리해 보고한다.
---

# baba-verify

기준 정책: `docs/agents/baba-agent-workflow.md` §8.

## 언제

- 코드·SQL·설정을 변경한 뒤, 커밋·인계 전에 실행한다.
- 인계서를 쓰기 직전에 최종 상태로 한 번 더 실행한다. 인계서는 상태 지문이 일치하는 결과만 신뢰한다.

## 절차

1. 저장소 루트에서 실행한다.

   ```
   node scripts/agent/baba-verify.mjs [--build] [--tests "<추가 테스트>"] [--all-tests]
   ```

   - **`--build`**: 다음 경우에 붙인다. 출력 「미검증 항목」에 Build 권장이 나오면 함께 붙인다.
     - 설정·의존성·layout 변경
     - page/route 추가·삭제, CSS, `proxy.ts`
     - 병합 준비 단계
   - **`--tests`**: 자동 선택이 놓친 테스트를 추가한다. 출력의 「도메인 테스트 후보」를 참고한다.
   - **`--all-tests`**: 전체 회귀가 필요한 큰 변경에만 쓴다. 시간이 오래 걸린다.
   - 결과는 `.tmp-baba/verify/latest.json`(Git 제외)에 저장된다. 종료 코드 1은 FAIL을 뜻한다.
2. 판정을 해석한다.
   - **FAIL**: 신규 오류가 있다. 「상세」의 신규 오류·신규 실패 테스트를 수정하고 다시 실행한다.
     - 기존 테스트의 기대값을 바꿔 통과시키지 않는다. 확정 정책 보호, 기준 정책 §9.
     - `failed-unclassified`는 기준선 비교를 하지 못한 경우다. 기존 오류로 간주하지 않는다.
   - **PASS_WITH_PREEXISTING**: 기준선에도 있던 오류만 있다. 기존 오류 수를 보고하고, 범위 밖이면 고치지 않는다.
   - **PASS**: 실행한 검사가 모두 통과했다.
3. 보고할 때는 다음을 구분한다.
   - 「실제 실행」이 `예`인 검사 결과
   - 「미검증 항목」: 실행하지 않은 검사, 테스트 미참조 파일, UI, 운영 DB 적용
   - 미검증 항목을 통과로 표현하지 않는다.
   - 오프라인 가드가 외부 연결을 차단한 테스트가 있으면 별도로 보고한다. 운영 연결을 시도한 코드일 수 있다.

## 안전 장치

- 테스트·빌드 자식 프로세스에서 Supabase·CUKCUK·POS·cron·세션·DB 계열 환경 변수를 제거한다.
- `scripts/agent/lib/offline-guard.mjs`를 preload해 loopback 외의 연결을 막는다.
- 기준선은 OS 임시 폴더에 merge-base 스냅샷을 만들어 비교한다. 별도 index 파일을 쓰므로 Worktree·브랜치·공유 index를 변경하지 않는다.
- 운영 DB, Vercel, GitHub에 접속하지 않는다. 운영 데이터가 필요한 검증은 미검증으로 남긴다.
