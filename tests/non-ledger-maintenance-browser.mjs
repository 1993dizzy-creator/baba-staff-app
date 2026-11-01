import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import ts from 'typescript';

// Same isolated React DOM approach as login-keeping-browser.mjs: actual page,
// fixture contexts and deferred transport, no Next server or production data.
export async function maintenanceFixture(pagePath, extraStubs = {}) {
  const require = createRequire(import.meta.url);
  const modules = [], ids = new Map();
  const stubs = {
    'next/link': 'module.exports=({children,...props})=>require("react").createElement("a",props,children);',
    'next/navigation': `const React=require('react');
      exports.useRouter=()=>window.qa.router;
      exports.usePathname=()=>window.qa.pathname;
      exports.useSearchParams=()=>{const [query,setQuery]=React.useState(window.qa.query);window.qa.setQuery=setQuery;return React.useMemo(()=>new URLSearchParams(query),[query]);};`,
    '@/lib/language-context': 'exports.useLanguage=()=>({lang:window.qa.lang});',
    '@/lib/styles/ui': 'exports.ui={};',
    '@/components/bar/keeping/KeepingBasics': `const React=require('react');exports.KeepingSkeleton=()=>null;
      exports.KeepingListCard=({item})=>React.createElement('div',{'data-item':item.id},item.id);`,
    '@/components/bar/keeping/KeepingUi': 'exports.primaryButtonStyle={};exports.secondaryButtonStyle={};',
    '@/lib/bar/client-auth': 'exports.fetchBarApi=(...args)=>window.qa.fetch(...args);exports.handleBarApiUnauthorized=async()=>false;',
    ...extraStubs,
  };
  function add(name, parent = import.meta.url) {
    const resolver = createRequire(parent);
    const file = name in stubs ? name : name.startsWith('@/')
      ? require.resolve('../' + name.slice(2) + '.ts') : resolver.resolve(name);
    if (ids.has(file)) return ids.get(file);
    const id = modules.length; ids.set(file, id); modules.push('');
    let code = file in stubs ? stubs[file] : readFileSync(file, 'utf8');
    if (/\.tsx?$/.test(file)) code = ts.transpileModule(code, {compilerOptions:{
      module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX, esModuleInterop:true,
    }}).outputText;
    code = code.replace(/require\(["']([^"']+)["']\)/g, (_, dep) => `load(${add(dep, file in stubs ? import.meta.url : file)})`);
    modules[id] = `function(module,exports,load){${code}\n}`;
    return id;
  }
  const react = add('react'), dom = add('react-dom/client'), component = add('../' + pagePath);
  const bundle = `const process={env:{NODE_ENV:'production'}},modules=[${modules.join(',')}],cache={};
    function load(id){if(!cache[id]){const m=cache[id]={exports:{}};modules[id](m,m.exports,load);}return cache[id].exports;}
    const React=load(${react}),root=load(${dom}).createRoot(document.getElementById('root'));
    window.qa={lang:'ko',pathname:'/',query:'',requests:[],router:{replace:path=>{
      window.qa.query=path.split('?')[1]||'';window.qa.setQuery(window.qa.query);
    }}};
    window.qa.fetch=(url,init)=>new Promise((resolve,reject)=>window.qa.requests.push({url,init,resolve,reject}));
    window.mount=()=>root.render(React.createElement(load(${component}).default));
    window.unmount=()=>root.unmount();`;
  const server = createServer((req,res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/fixture.js' ? bundle : '<div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH);
    browser = await chromium.launch({headless:true, executablePath:process.env.QA_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page = await browser.newPage(); page.setDefaultTimeout(4000);
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    return {page, async close(){await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);}};
  } catch(error) {
    await browser?.close(); await new Promise(resolve=>server.close(resolve)); throw error;
  }
}
