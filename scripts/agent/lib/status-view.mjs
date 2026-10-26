// Terminal view for baba-status. Formatting only: it never inspects Git or changes the report.
// Colors follow NO_COLOR/FORCE_COLOR and are off for CI, redirected output and dumb terminals.
// Text labels (PASS/WARN/FAIL, CLEAN/DIRTY) are always printed so color is never the only signal.

const CODES = {green: 32, yellow: 33, red: 31, cyan: 36, bold: 1, dim: 2};
export const stripAnsi = text => text.replace(/\x1b\[[0-9;]*m/g, '');

// East Asian Wide/Fullwidth ranges (Hangul, CJK, fullwidth forms, emoji) take two cells.
const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd]];
const ZERO = [[0x0300, 0x036f], [0x1160, 0x11ff], [0x200b, 0x200f], [0xfe00, 0xfe0f]];
const inRanges = (code, ranges) => ranges.some(([from, to]) => code >= from && code <= to);

export function displayWidth(text) {
  let width = 0;
  for (const char of stripAnsi(String(text))) {
    const code = char.codePointAt(0);
    if (code < 0x20 || inRanges(code, ZERO)) continue;
    width += inRanges(code, WIDE) ? 2 : 1;
  }
  return width;
}
const fill = (text, width, right = false) => {
  const gap = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return right ? gap + text : text + gap;
};

export function detectTerminal({stream = process.stdout, env = process.env, platform = process.platform} = {}) {
  const tty = Boolean(stream.isTTY);
  let color;
  if (env.NO_COLOR) color = false;
  else if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false') color = true;
  else color = tty && !env.CI && env.TERM !== 'dumb' && (typeof stream.hasColors === 'function' ? stream.hasColors() : false);
  // Legacy Korean console fonts draw box characters double-width; use ASCII borders there.
  const unicode = platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM);
  return {color, unicode, columns: tty && stream.columns ? stream.columns : null};
}

const BORDERS = {
  unicode: {h: '─', v: '│', top: ['┌', '┬', '┐'], mid: ['├', '┼', '┤'], bottom: ['└', '┴', '┘']},
  ascii: {h: '-', v: '|', top: ['+', '+', '+'], mid: ['+', '+', '+'], bottom: ['+', '+', '+']},
};

// Cells are [text, style]. Width is measured on plain text, color is applied after padding.
function table(head, rows, {paint, unicode, align = []}) {
  const b = BORDERS[unicode ? 'unicode' : 'ascii'];
  const cell = value => (Array.isArray(value) ? value : [String(value), null]);
  const widths = head.map((title, i) => Math.max(displayWidth(title), ...rows.map(row => displayWidth(cell(row[i])[0]))));
  const rule = ([left, joint, right]) => `${left}${widths.map(w => b.h.repeat(w + 2)).join(joint)}${right}`;
  const line = (cells, header) => `${b.v}${cells.map((value, i) => {
    const [text, style] = cell(value);
    return ` ${paint(header ? 'bold' : style, fill(text, widths[i], !header && align[i] === 'right'))} `;
  }).join(b.v)}${b.v}`;
  return [rule(b.top), line(head, true), rule(b.mid), ...rows.map(row => line(row)), rule(b.bottom)];
}

const short = sha => (sha ? sha.slice(0, 7) : '-');
const VERDICT = {PASS: ['PASS', 'green'], WARN: ['WARN 검토 필요', 'yellow'], FAIL: ['FAIL', 'red']};

function treeState(t) {
  if (!t.exists) return ['경로 없음', 'red'];
  if (t.conflicted.length) return ['CONFLICT', 'red'];
  if (t.operation) return ['진행 중 작업', 'red'];
  return t.clean ? ['CLEAN', 'green'] : [`DIRTY(${t.changed.length + t.untracked.length})`, 'yellow'];
}

function syncText(g) {
  return {
    equal: ['동기화됨', 'green'], 'local-ahead': [`Push 대기 ${g.ahead}커밋`, 'yellow'],
    'remote-ahead': [`원격이 앞섬${g.behind ? ` ${g.behind}커밋` : ''}`, 'red'],
    diverged: [`갈라짐(로컬 +${g.ahead} / 원격 +${g.behind})`, 'red'], unknown: ['판단 불가', 'yellow'],
  }[g.relation];
}

function remoteCheck(g) {
  if (g.verified) return ['성공', 'green'];
  return g.reason === '--offline' ? ['생략(--offline), 마지막 fetch 기준', 'yellow'] : [`실패(${g.reason}), 마지막 fetch 기준`, 'yellow'];
}

function pushReady(r) {
  const g = r.github;
  if (r.verdicts.git === 'FAIL') return ['FAIL Git 상태 먼저 해결', 'red'];
  if (g.relation === 'diverged') return ['FAIL 갈라짐', 'red'];
  if (g.relation === 'remote-ahead') return ['Push 불가(원격이 앞섬)', 'red'];
  if (!g.verified) return ['검토 필요(원격 미확인)', 'yellow'];
  if (g.relation === 'equal') return ['대기 커밋 없음', 'green'];
  return [`검토 필요(${g.ahead}커밋, 테스트/보안 확인 후 사용자 승인)`, 'yellow'];
}

function stamp(iso) {
  const at = new Date(iso), pad = n => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function renderStatus(r, {color = false, unicode = true, columns = null, branches = false} = {}) {
  const paint = (style, text) => (color && style ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text);
  const tag = level => paint({FAIL: 'red', WARN: 'yellow', INFO: 'cyan'}[level], `[${level}]`);
  const modeName = {serial: '직렬 모드', parallel: '병렬 모드'}[r.location.mode];
  const out = [`${paint('bold', 'BABA Git 상태')}  ${paint('dim', `읽기 전용 · ${stamp(r.generatedAt)}`)}`,
    `실행 위치  ${r.location.tree ? `${paint('cyan', `${r.location.tree} / ${r.location.branch}`)}${modeName ? ` → ${modeName}` : ''}` : 'BABA Worktree 밖'}`, ''];

  const rows = r.trees.map(t => {
    const agent = Boolean(t.unintegrated);
    const pending = agent ? t.unintegrated.length : null;
    return [[t.label, 'bold'], [t.exists ? short(t.head) : '-', 'cyan'], [t.branch, 'cyan'], treeState(t),
      agent ? [String(pending), pending ? 'yellow' : 'green'] : ['-', 'dim'],
      agent ? [String(t.behind), t.behind && pending ? 'yellow' : null] : ['-', 'dim']];
  });
  const options = {paint, unicode, align: [null, null, null, null, 'right', 'right']};
  const grid = table(['Worktree', 'HEAD', '브랜치', '상태', '미통합', 'main 대비 뒤처짐'], rows, options);
  const compact = columns && displayWidth(grid[0]) > columns;
  if (compact) {
    // Narrow terminals: two short lines per worktree instead of a table.
    for (const [t, [name, head, branch, state, pending, behind]] of r.trees.map((t, i) => [t, rows[i]])) {
      out.push(`${paint('bold', fill(name[0], 7))}${paint(state[1], state[0])} ${paint('cyan', head[0])}${t.unintegrated ? `  미통합 ${paint(pending[1], pending[0])} · 뒤처짐 ${behind[0]}` : ''}`);
      out.push(`       ${paint('cyan', branch[0])}`);
    }
  } else out.push(...grid);

  const details = [];
  for (const t of r.trees.filter(t => t.exists)) {
    const files = [...t.changed, ...t.untracked.map(path => `?? ${path}`)];
    if (files.length) {
      details.push(`  ${paint('bold', t.label)} 미커밋 변경 (수정 ${t.changed.length} / 미추적 ${t.untracked.length})`);
      details.push(...files.slice(0, 10).map(file => `    ${paint('yellow', file)}`));
      if (files.length > 10) details.push(`    … 외 ${files.length - 10}개 (--json으로 전체 확인)`);
    }
    if (t.unintegrated?.length) {
      details.push(`  ${paint('bold', t.label)} main에 없는 커밋`);
      details.push(...t.unintegrated.slice(0, 5).map(c => `    + ${paint('cyan', short(c.sha))} ${c.subject}${c.equivalent ? paint('dim', '  (main에 같은 변경 있음)') : ''}`));
      if (t.unintegrated.length > 5) details.push(`    … 외 ${t.unintegrated.length - 5}개`);
    }
  }
  if (details.length) out.push(...details);

  const g = r.github;
  const sync = syncText(g), check = remoteCheck(g), ready = pushReady(r);
  const github = [['로컬 main', [short(g.local), 'cyan']], ['원격 main', [short(g.remote || g.tracking), 'cyan']], ['원격 확인', check], ['동기화', sync]];
  const results = [['통합 검사', VERDICT[r.verdicts.integration]], ['Git 상태', VERDICT[r.verdicts.git]], ['Push 준비', ready],
    ['배포 승인', ['별도 필요', 'yellow']], ['테스트/보안 검증', ['이 도구 범위 아님(별도 실행)', 'dim']]];
  const pairs = (title, items) => {
    out.push('', paint('bold', title));
    if (compact) {
      const width = Math.max(...items.map(([key]) => displayWidth(key)));
      for (const [key, [text, style]] of items) out.push(`  ${fill(key, width)}  ${paint(style, text)}`);
    } else out.push(...table(['항목', '값'], items, {paint, unicode}));
  };
  pairs('GitHub', github);
  pairs('결과', results);

  const issues = r.findings.filter(f => f.level !== 'INFO');
  const notes = r.findings.filter(f => f.level === 'INFO' && f.target !== '로컬 브랜치');
  if (issues.length) {
    out.push('', paint('bold', '문제'));
    for (const f of issues) out.push(`${tag(f.level)} ${paint('bold', f.target)}: ${f.cause}`, `       조치: ${f.action}`);
  }
  const parked = r.parked || [];
  if (notes.length || parked.length) {
    out.push('', paint('bold', '참고'));
    for (const f of notes) out.push(`${tag('INFO')} ${f.target}: ${f.cause}`);
    if (parked.length) {
      out.push(`${tag('INFO')} Worktree 밖 main 미통합 브랜치 ${parked.length}개${branches ? '' : ' (목록: baba-status --branches)'}`);
      if (branches) out.push(...parked.map(branch => `       ${paint('cyan', branch)}`));
    }
  }
  return out.join('\n');
}
