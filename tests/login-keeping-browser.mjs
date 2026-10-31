import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import ts from 'typescript';

const require = createRequire(import.meta.url);

// Mount the actual two components with React DOM. Only framework context and
// transport are fixtures; no Next server, credentials or production API runs.
export async function browserFixture() {
  const modules = [], ids = new Map();
  const stubs = {
    '@/lib/language-context': 'exports.useLanguage=()=>({lang:window.qa.lang});',
    'next/navigation': 'exports.useRouter=()=>({replace:path=>window.qa.path=path});',
    'next/image': 'module.exports=()=>null;',
    '@/lib/styles/ui': 'exports.ui={};',
    '@/lib/bar/client-auth': 'exports.fetchBarApi=(...args)=>window.qa.search(...args);exports.handleBarApiUnauthorized=async()=>false;',
  };
  function add(name, parent = import.meta.url) {
    const file = name in stubs ? name : name.startsWith('@/')
      ? require.resolve('../' + name.slice(2) + '.ts')
      : createRequire(parent).resolve(name);
    if (ids.has(file)) return ids.get(file);
    const id = modules.length;
    ids.set(file, id); modules.push('');
    let code = file in stubs ? stubs[file] : readFileSync(file, 'utf8');
    if (/\.tsx?$/.test(file)) code = ts.transpileModule(code, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    code = code.replace(/require\(["']([^"']+)["']\)/g, (_, dep) => `load(${add(dep, file)})`);
    modules[id] = `function(module,exports,load){${code}\n}`;
    return id;
  }
  const react = add('react'), dom = add('react-dom/client');
  const login = add('../app/login/page.tsx'), keeping = add('../components/bar/keeping/KeepingProductAutocomplete.tsx');
  const bundle = `const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(',')}],cache={};
    function load(id){if(!cache[id]){const m=cache[id]={exports:{}};modules[id](m,m.exports,load);}return cache[id].exports;}
    const React=load(${react}),root=load(${dom}).createRoot(document.getElementById('root'));
    window.qa={lang:'ko',path:null,selected:null,search:()=>Promise.resolve(new Response(JSON.stringify({items:[]})))};
    window.mount=(kind,lang)=>{window.qa.lang=lang;root.render(React.createElement(kind==='login'?load(${login}).default:load(${keeping}).default,{key:Math.random(),lang,onSelect:(item,name)=>window.qa.selected={item,name}}));};`;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/fixture.js' ? bundle : '<div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({headless:true, executablePath:process.env.QA_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  return {browser, base:`http://127.0.0.1:${server.address().port}`, async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
}
