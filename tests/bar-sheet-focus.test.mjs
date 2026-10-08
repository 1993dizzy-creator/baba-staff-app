import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Minimal hook runtime: refs persist across renders and effects re-run only when a dependency
// changes (Object.is), matching React's commit semantics closely enough to observe focus moves.
function harness(visualViewport) {
  const document = { activeElement: null, body: { style: { overflow: '' } } };
  const listeners = new Set();
  const viewportProperties = new Map();
  const viewportElement = { style: { setProperty: (key, value) => viewportProperties.set(key, value) } };
  const element = name => ({ name, focus() { document.activeElement = this; } });
  const closeButton = element('close'), amountInput = element('amount'), trigger = element('trigger');
  let hooks = [], cursor = 0, pending = [];
  const react = {
    useRef(initial) { const i = cursor++; hooks[i] ??= { current: initial }; return hooks[i]; },
    useId() { return 'id'; },
    useEffect(effect, deps) {
      const i = cursor++, previous = hooks[i];
      if (!previous || !deps || deps.length !== previous.deps.length || deps.some((dep, n) => !Object.is(dep, previous.deps[n]))) pending.push({ i, effect, deps });
      else previous.fresh = true;
    },
  };
  const runtime = { jsx: (type, props) => { if (props?.ref) props.ref.current = type === 'button' ? closeButton : viewportElement; return { type, props }; } };
  runtime.jsxs = runtime.jsx;
  const sheetModule = { exports: {} };
  const code = ts.transpileModule(readFileSync('components/bar/keeping/KeepingUi.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const deps = { react, 'react/jsx-runtime': runtime, './KeepingUi.module.css': { default: {} } };
  const window = { visualViewport, innerHeight: 740, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  new Function('require', 'module', 'exports', 'document', 'window', code)(name => { assert.ok(name in deps, name); return deps[name]; }, sheetModule, sheetModule.exports, document, window);
  function render(props) {
    cursor = 0; pending = [];
    sheetModule.exports.BarSheet({ kind: 'full', title: 'T', closeLabel: 'close', footer: null, children: null, returnFocusRef: { current: trigger }, ...props });
    for (const { i, effect, deps: nextDeps } of pending) { hooks[i]?.cleanup?.(); const cleanup = effect(); hooks[i] = { deps: nextDeps, cleanup }; }
  }
  const stableReturnFocus = { current: trigger };
  return {
    document, listeners, viewportProperties, closeButton, amountInput, trigger,
    render: props => render({ returnFocusRef: stableReturnFocus, ...props }),
    unmount() { for (const hook of hooks) hook?.cleanup?.(); hooks = []; },
    escape() { for (const fn of [...listeners]) fn({ key: 'Escape' }); },
  };
}

test('BarSheet focuses the close button once when opened', () => {
  const sheet = harness();
  sheet.trigger.focus();
  sheet.render({ onClose() {} });
  assert.equal(sheet.document.activeElement, sheet.closeButton);
  assert.equal(sheet.document.body.style.overflow, 'hidden');
  assert.equal(sheet.listeners.size, 1);
});

test('typing in a sheet input with an inline parent onClose never moves focus to the close button', () => {
  const sheet = harness();
  sheet.render({ onClose: () => {} });
  sheet.amountInput.focus();
  // Card deposit modal: every keystroke rerenders the page, which passes a fresh inline onClose.
  for (let keystroke = 0; keystroke < 3; keystroke++) sheet.render({ onClose: () => {} });
  assert.equal(sheet.document.activeElement, sheet.amountInput);
  assert.equal(sheet.listeners.size, 1, 'the keydown listener is not re-registered on rerender');
  sheet.render({ onClose: () => {}, saving: true });
  sheet.render({ onClose: () => {}, saving: false });
  assert.equal(sheet.document.activeElement, sheet.amountInput, 'saving toggles do not steal focus either');
});

test('Escape uses the latest onClose and respects the latest saving flag', () => {
  const sheet = harness(), calls = [];
  sheet.render({ onClose: () => calls.push('first') });
  sheet.render({ onClose: () => calls.push('latest'), saving: true });
  sheet.escape();
  assert.deepEqual(calls, [], 'Escape is ignored while saving');
  sheet.render({ onClose: () => calls.push('latest'), saving: false });
  sheet.escape();
  assert.deepEqual(calls, ['latest']);
});

test('closing the sheet restores body scroll, removes the listener and returns focus', () => {
  const sheet = harness();
  sheet.document.body.style.overflow = 'auto';
  sheet.trigger.focus();
  sheet.render({ onClose() {} });
  sheet.amountInput.focus();
  sheet.render({ onClose() {} });
  sheet.render({ onClose() {}, open: false });
  assert.equal(sheet.document.activeElement, sheet.trigger);
  assert.equal(sheet.document.body.style.overflow, 'auto');
  assert.equal(sheet.listeners.size, 0);
  const unmounted = harness();
  unmounted.trigger.focus();
  unmounted.render({ onClose() {} });
  unmounted.unmount();
  assert.equal(unmounted.document.activeElement, unmounted.trigger, 'conditionally rendered sheets return focus on unmount');
});

test('centered mobile sheet follows visual viewport resize and scroll and removes its listeners', () => {
  const handlers = new Map();
  const viewport = {
    height: 500, offsetTop: 50,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type, fn) { if (handlers.get(type) === fn) handlers.delete(type); },
  };
  const sheet = harness(viewport);
  sheet.render({ mobileCentered: true, onClose() {} });
  assert.equal(sheet.viewportProperties.get('--sheet-viewport-height'), '500px');
  assert.equal(sheet.viewportProperties.get('--sheet-viewport-top'), '50px');
  viewport.height = 240;
  viewport.offsetTop = 80;
  handlers.get('resize')();
  handlers.get('scroll')();
  assert.equal(sheet.viewportProperties.get('--sheet-viewport-height'), '240px');
  assert.equal(sheet.viewportProperties.get('--sheet-viewport-top'), '80px');
  sheet.render({ mobileCentered: true, open: false, onClose() {} });
  assert.equal(handlers.size, 0);
  assert.equal(sheet.listeners.size, 0);
});
