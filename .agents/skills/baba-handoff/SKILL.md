---
name: baba-handoff
description: BABA 관리자 앱 작업 완료 시 표준 인계서를 작성한다. 작업명·작업 ID·담당 AI·브랜치·Git SHA·변경 파일과 기능·baba-verify 검증 결과·DB/Migration 변경 여부·push/병합/배포 여부·미완료 사항과 후속 작업을 docs/handoffs에 기록하고 형식을 검사한다.
---

# baba-handoff

기준 정책: `docs/agents/baba-agent-workflow.md` §10.

## 언제

- 작업을 마치고 사용자에게 결과를 넘길 때 작성한다. 중단하고 다른 에이전트나 세션에 넘길 때도 작성한다.

## 절차

1. 최종 코드를 커밋한 상태에서 `baba-verify`를 실행한다. 인계서는 상태 지문이 일치하는 최신 결과를 사용한다.
2. 초안을 만든다.

   ```
   node scripts/agent/baba-handoff.mjs --task-name "<작업명>"
   ```

   - 기본 출력은 `docs/handoffs/<agent>-<작업 ID>.md`다. 작업 ID는 브랜치 이름에서 접두사를 뺀 부분이다.
   - 기존 파일은 덮어쓰지 않는다. 경로를 바꾸려면 `--out`, 의도적으로 갱신하려면 `--force`를 쓴다.
   - 저장 없이 보기만 하려면 `--stdout`을 쓴다.
3. `<!-- TODO ... -->` 항목을 **사실만으로** 채운다.
   - **기능 요약**: 사용자 관점의 변경과 이유
   - **수동 확인**: 실제로 수행한 확인만 적는다. 없으면 "없음"
   - **Migration 적용 상태**: 사용자가 알려준 사실만 적는다.
   - **미완료 사항, 후속 작업**: 승인 필요 항목(병합·배포·Migration 적용)을 포함한다.
   - 자동 기록된 SHA·검증·push 상태를 수정해 실제와 다르게 만들지 않는다.
4. 형식을 검사한다.

   ```
   node scripts/agent/baba-handoff.mjs --check docs/handoffs/<파일>.md
   ```

   - 통과해야 완료로 본다. TODO 잔존, 검증 결과 불일치, 필수 섹션·SHA 누락은 실패다.
5. 인계서를 작업 브랜치에 커밋한다. 인계서의 SHA는 인계서 커밋 직전 코드 상태를 가리킨다.
6. 사용자에게 인계서 경로와 핵심 내용을 보고한다. push·병합·배포는 사용자가 따로 요청할 때만 한다.
