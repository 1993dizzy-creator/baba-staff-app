#!/usr/bin/env node
// Static check that Codex (.agents/skills) and Claude Code (.claude/skills) see the same BABA skills
// and that the agent entry points still point at the single policy document.
// Usage: node scripts/agent/check-agent-skills.mjs [--root <repo>]
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {POLICY_DOC, parseArgs, repoRoot} from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), {root: 'string'});
const root = args.root || repoRoot();
const problems = [];
const passed = [];

function parseSkill(text) {
  if (text.charCodeAt(0) === 0xfeff) return {error: 'UTF-8 BOM이 있다 (frontmatter 인식 실패 위험)'};
  if (text.includes('\r\n')) return {error: 'CRLF 줄바꿈이다 (LF 필요)'};
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return {error: 'YAML frontmatter(---)로 시작하지 않는다'};
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
    else if (line.trim()) return {error: `frontmatter 줄을 해석할 수 없다: ${line}`};
  }
  return {meta, body: m[2]};
}

const skillDirs = dir => (existsSync(join(root, dir)) ? readdirSync(join(root, dir), {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : []);
const canonical = skillDirs('.agents/skills');
const claude = skillDirs('.claude/skills');
if (!canonical.length) problems.push('.agents/skills에 Skill이 없다');

for (const name of canonical) {
  const path = `.agents/skills/${name}/SKILL.md`;
  if (!existsSync(join(root, path))) {
    problems.push(`${path} 없음`);
    continue;
  }
  const skill = parseSkill(readFileSync(join(root, path), 'utf8'));
  if (skill.error) {
    problems.push(`${path}: ${skill.error}`);
    continue;
  }
  const {meta, body} = skill;
  if (meta.name !== name) problems.push(`${path}: name(${meta.name})이 디렉터리 이름(${name})과 다르다`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name || '') || meta.name.length > 64) problems.push(`${path}: name은 소문자·숫자·하이픈 64자 이하여야 한다`);
  if (!meta.description) problems.push(`${path}: description 없음`);
  else if (meta.description.length > 1024) problems.push(`${path}: description이 1024자를 넘는다 (${meta.description.length})`);
  if (/[<>]/.test(meta.description || '')) problems.push(`${path}: description에 꺾쇠괄호가 있다`);
  for (const ref of new Set([...body.matchAll(/`((?:scripts|docs)\/[^`\s*]+\.(?:mjs|md))`/g)].map(m => m[1]))) {
    if (!existsSync(join(root, ref))) problems.push(`${path}: 참조 경로 없음 ${ref}`);
  }
  if (!body.includes(POLICY_DOC)) problems.push(`${path}: 기준 정책 ${POLICY_DOC} 참조 없음`);

  const wrapperPath = `.claude/skills/${name}/SKILL.md`;
  if (!existsSync(join(root, wrapperPath))) {
    problems.push(`${wrapperPath} 없음 (Claude Code 진입점)`);
    continue;
  }
  const wrapper = parseSkill(readFileSync(join(root, wrapperPath), 'utf8'));
  if (wrapper.error) {
    problems.push(`${wrapperPath}: ${wrapper.error}`);
    continue;
  }
  if (wrapper.meta.name !== meta.name) problems.push(`${wrapperPath}: name이 기준 정의와 다르다`);
  if (wrapper.meta.description !== meta.description) problems.push(`${wrapperPath}: description이 기준 정의와 다르다`);
  if (!wrapper.body.includes(path)) problems.push(`${wrapperPath}: 기준 정의 ${path}를 가리키지 않는다`);
  if (wrapper.body.split('\n').length > 25) problems.push(`${wrapperPath}: 진입점이 절차 본문을 중복 보유하는 것으로 보인다(25줄 초과)`);
  passed.push(name);
}
for (const name of claude.filter(name => name.startsWith('baba-') && !canonical.includes(name))) problems.push(`.claude/skills/${name}: 대응하는 .agents/skills 기준 정의가 없다`);

const agentsMd = existsSync(join(root, 'AGENTS.md')) ? readFileSync(join(root, 'AGENTS.md'), 'utf8') : '';
const claudeMd = existsSync(join(root, 'CLAUDE.md')) ? readFileSync(join(root, 'CLAUDE.md'), 'utf8') : '';
if (!agentsMd.includes(POLICY_DOC)) problems.push(`AGENTS.md가 ${POLICY_DOC}를 참조하지 않는다`);
if (!agentsMd.includes('.agents/skills')) problems.push('AGENTS.md가 .agents/skills를 안내하지 않는다');
for (const required of ['## Supabase 운영 DB 안전 규칙', '## BABA 운영 Migration 기본 절차', '## 운영 Migration 반복 금지 사항']) {
  if (!agentsMd.includes(required)) problems.push(`AGENTS.md 기존 정책 섹션 누락: ${required}`);
}
if (!/^@AGENTS\.md\s*$/m.test(claudeMd)) problems.push('CLAUDE.md가 @AGENTS.md를 포함하지 않는다');
for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
  if (existsSync(join(root, file)) && /bypassPermissions/.test(readFileSync(join(root, file), 'utf8'))) problems.push(`${file}에 bypassPermissions 설정이 있다`);
}

console.log(`Skills 정합성 검사: 기준 정의 ${canonical.length}개, Claude 진입점 ${claude.length}개, 통과 ${passed.join(', ') || '없음'}`);
if (problems.length) {
  console.log(problems.map(problem => `- ${problem}`).join('\n'));
  process.exitCode = 1;
} else console.log('문제 없음');
