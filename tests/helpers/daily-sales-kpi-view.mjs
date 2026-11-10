// Offline rendering of the actual page and notice; no auth, network or production env.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildDailySalesKpi } from '../../lib/sales/daily-kpi.ts';
import { salesText } from '../../lib/text/sales.ts';
import { commonText } from '../../lib/text/common.ts';
import { ui } from '../../lib/styles/ui.ts';

function load(path, dependencies) {
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, mod, mod.exports);
  return mod.exports;
}
const notice = load('components/sales/OpenOrdersPanel.tsx', { 'react/jsx-runtime': jsxRuntime });
const container = load('components/Container.tsx', { 'react/jsx-runtime': jsxRuntime });
const nav = load('components/SubNav.tsx', { 'react/jsx-runtime': jsxRuntime,
  'next/link': { __esModule: true, default: ({ children, ...props }) => jsxRuntime.jsx('a', { ...props, children }) } });

export function renderDailySales(data, { lang = 'ko', live = true, loading = false } = {}) {
  let hook = 0;
  const state = [data.businessDate, data, loading, false, 0, false, live, '', ''];
  const hooks = { ...React, useState() { return [state[hook++], () => {}]; },
    useEffect() {}, useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
    useRef(initial) { return { current: initial }; } };
  const page = load('app/(protected)/admin/sales/page.tsx', {
    react: hooks, 'react/jsx-runtime': jsxRuntime,
    'next/navigation': { usePathname: () => '/admin/sales', useRouter: () => ({}),
      useSearchParams: () => new URLSearchParams({ businessDate: data.businessDate }) },
    '@/components/sales/PosBusinessDayClosePanel': { __esModule: true, default: () => null },
    '@/components/sales/OpenOrdersPanel': notice,
    '@/lib/sales/daily-kpi': { buildDailySalesKpi },
    '@/components/Container': container, '@/components/SubNav': nav,
    '@/lib/language-context': { useLanguage: () => ({ lang }) },
    '@/lib/styles/ui': { ui }, '@/lib/supabase/auth': { getUser: () => null },
    '@/lib/text': { commonText, salesText },
  });
  return renderToStaticMarkup(page.default());
}

export function dailyCards(html) {
  return html.match(/<section style="display:grid;grid-template-columns:repeat\(2, minmax\(0, 1fr\)\);gap:8px">(.*?)<\/section>/s)?.[1] ?? '';
}
