import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTs } from './helpers/sales-auth-harness.mjs';
import { layoutText } from '../lib/text/layout.ts';

const auth = loadTs('lib/supabase/auth.ts');
function render(pathname, role, lang) {
  const mod = { exports: {} };
  const deps = {
    react: { ...React, useSyncExternalStore: (_, getSnapshot) => getSnapshot() }, 'react/jsx-runtime': jsx,
    'next/navigation': { usePathname: () => pathname },
    'next/link': { __esModule: true, default: props => jsx.jsx('a', props) },
    '@/lib/language-context': { useLanguage: () => ({ lang }) }, '@/lib/text/layout': { layoutText },
    '@/lib/supabase/auth': { getUser: () => ({ role }), canAccessAdmin: auth.canAccessAdmin },
  };
  const code = ts.transpileModule(readFileSync('components/BottomNav.tsx','utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('require','module','exports',code)(name => { assert.ok(name in deps, name); return deps[name]; }, mod, mod.exports);
  return renderToStaticMarkup(jsx.jsx(mod.exports.default, {}));
}

for (const lang of ['ko','vi']) test(`${lang}: store link, nested activation and unchanged admin/other navigation for all roles`, () => {
  for (const role of ['master','owner','manager','leader','staff']) for (const pathname of ['/tables','/tables/detail','/inventory','/attendance','/bar','/admin']) {
    const html = render(pathname,role,lang), t=layoutText[lang];
    assert.ok(html.includes(t.operation)); assert.ok(html.includes('🏪'));
    for (const path of ['/tables','/inventory','/attendance','/bar']) assert.ok(html.includes(`href="${path}"`));
    assert.equal(html.includes('href="/admin"'), role !== 'staff');
    const store = html.match(/<a href="\/tables"[^>]*>/)[0];
    assert.equal(store.includes('aria-current="page"'), pathname.startsWith('/tables'));
    assert.equal(store.includes('background:#1f2937'), pathname.startsWith('/tables'));
    assert.doesNotMatch(store,/disabled/);
    assert.match(html,/height:60px/);
  }
});

test('shared page remains inside protected layout; admin authorization and global session checks are unchanged', () => {
  const page = readFileSync('app/(protected)/tables/page.tsx','utf8');
  assert.doesNotMatch(page,/requireRole|canAccessAdmin|\/admin\/tables/);
  assert.match(page,/fetch\("\/api\/tables"/);
  const layout = readFileSync('app/(protected)/layout.tsx','utf8');
  assert.match(layout,/isLoggedIn/); assert.match(layout, /UserSessionRefresher/);
});
