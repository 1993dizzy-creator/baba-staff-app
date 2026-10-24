// Standard handoff format shared by baba-handoff (writer and --check) and its tests.
export const TODO = '<!-- TODO';

export const REQUIRED_SECTIONS = [
  '## 1. 작업 정보', '## 2. Git 상태', '## 3. 변경 파일과 기능', '## 4. 검증 결과', '## 5. DB·Migration',
  '## 6. Push·병합·배포', '## 7. 미완료 사항', '## 8. 후속 작업',
];

export function checkHandoff(text) {
  const problems = [];
  for (const section of REQUIRED_SECTIONS) if (!text.includes(section)) problems.push(`필수 섹션 누락: ${section}`);
  if (!/HEAD SHA: [0-9a-f]{40}\b/.test(text)) problems.push('HEAD SHA(40자리)가 없다');
  if (!/작업 ID: \S+/.test(text)) problems.push('작업 ID가 없다');
  if (!/담당 AI: (Claude Code|Codex)/.test(text)) problems.push('담당 AI가 Claude Code/Codex로 기록되지 않았다');
  const todos = text.split('\n').filter(line => line.includes(TODO)).length;
  if (todos) problems.push(`작성되지 않은 TODO ${todos}건`);
  if (/현재 상태와 일치: \*\*아니오/.test(text)) problems.push('검증 결과가 현재 상태와 다르다 — baba-verify 재실행 필요');
  if (/baba-verify 결과 없음/.test(text)) problems.push('baba-verify 결과가 없다');
  return problems;
}
