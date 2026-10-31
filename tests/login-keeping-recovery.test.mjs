import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { browserFixture } from './login-keeping-browser.mjs';

const options = {skip:!process.env.PLAYWRIGHT_MODULE_PATH};
test('a response or error queued before selection cannot reopen the keeping dropdown, even when abort is ignored', async () => {
  for (const fail of [false,true]) {
    const slots=[], effects=[], timers=new Map(), requests=[];
    let cursor=0, timerId=0;
    const hooks={
      useId:()=> 'fixture-list',
      useRef:value=>{const i=cursor++;return slots[i]??=( {current:value} );},
      useState:value=>{const i=cursor++;if(!(i in slots))slots[i]=value;return [slots[i],next=>{slots[i]=next;}];},
      useEffect:(callback,deps)=>{const i=cursor++;const previous=slots[i];if(!previous||deps.some((v,n)=>v!==previous.deps[n]))effects.push(()=>{previous?.cleanup?.();slots[i]={deps,cleanup:callback()};});},
    };
    const item={id:42,item_name:'위스키',item_name_vi:'Whisky',code:'W42'};
    let selected;
    const imports={
      react:hooks,
      'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
      '@/lib/text/bar-keeping-new':{keepingNewText:{ko:{productSearchError:'retry'}}},
      '@/lib/bar/client-auth':{handleBarApiUnauthorized:async()=>false,fetchBarApi:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))},
    };
    const code=ts.transpileModule(readFileSync('components/bar/keeping/KeepingProductAutocomplete.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
    const mod={exports:{}};
    new Function('require','module','exports','window',code)(name=>{assert.ok(name in imports,name);return imports[name];},mod,mod.exports,{
      setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id),
    });
    const render=()=>{cursor=0;const tree=mod.exports.default({lang:'ko',onSelect:(product,name)=>{selected={product,name};}});while(effects.length)effects.shift()();return tree;};
    const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];
    const input=tree=>nodes(tree).find(n=>n.props?.role==='combobox');
    const runTimer=()=>{const [id,callback]=timers.entries().next().value;timers.delete(id);return callback();};
    input(render()).props.onChange({target:{value:'W'}});render();
    let pending=runTimer();requests.shift().resolve(Response.json({items:[item]}));await pending;
    const option=nodes(render()).find(n=>n.props?.role==='option');assert.ok(option);
    input(render()).props.onChange({target:{value:'위스키'}});render();pending=runTimer();
    // A queued selection handler can run while the old result is settling.
    option.props.onClick();render();
    const request=requests.shift();if(fail)request.reject(new Error('late failure'));else request.resolve(Response.json({items:[{...item,id:99}]}));
    await pending;
    const tree=render();assert.equal(input(tree).props['aria-expanded'],false);
    assert.equal(input(tree).props.value,'위스키');assert.deepEqual(selected,{product:item,name:'위스키'});
    assert.equal(timers.size,0);
    input(tree).props.onChange({target:{value:'new'}});render();assert.equal(timers.size,1);
  }
});
test('login recovers from network, JSON and malformed responses; preserves authentication and destinations', options, async () => {
  const f = await browserFixture();
  try { for (const lang of ['ko','vi']) {
    const page = await f.browser.newPage();page.setDefaultTimeout(4000);
    await page.route('**/*', route => new URL(route.request().url()).origin === f.base ? route.continue() : route.abort());
    const alerts=[];page.on('dialog',async d=>{alerts.push(d.message());await d.dismiss();});
    await page.goto(f.base);
    for (const mode of ['network','json','null','shape','user','failure','owner','staff','attendance','retry']) {
      await page.evaluate(({lang,mode})=>{
        window.mount('login',lang);window.qa.path=null;sessionStorage.clear();
        if(mode==='attendance')sessionStorage.setItem('baba_session_return_path','/attendance/leave?month=2026-10');
        window.fetch=async()=>{
          if(mode==='network')throw new TypeError('Failed to fetch');
          if(mode==='json')return new Response('<html>',{status:502});
          if(mode==='null')return Response.json(null);
          if(mode==='shape')return Response.json({unexpected:true});
          if(mode==='user')return Response.json({ok:true});
          if(mode==='failure')return Response.json({ok:false,message:'Fixture invalid credentials'},{status:401});
          return Response.json({ok:true,user:{id:7,role:mode==='owner'?'owner':'staff'}});
        };
      },{lang,mode});
      await page.getByPlaceholder('Username').fill('fixture');await page.getByPlaceholder('Password').fill('fixture');
      const before=alerts.length;await page.getByRole('button').click();
      if(['network','json','null','shape','user','failure'].includes(mode)) {
        await page.waitForFunction(()=>!document.querySelector('button').disabled,null,{timeout:4000});
        assert.equal(alerts.length,before+1);
        if(mode==='failure')assert.equal(alerts.at(-1),'Fixture invalid credentials');
        else assert.match(alerts.at(-1),lang==='ko'?/다시/:/thử lại/);
        // Retry the same mounted component after the failure.
        await page.evaluate(()=>{window.fetch=async()=>Response.json({ok:true,user:{id:7,role:'staff'}});});
        await page.getByRole('button').click();await page.waitForFunction(()=>window.qa.path==='/inventory');
      } else {
        const destination=mode==='owner'?'/admin':mode==='attendance'?'/attendance/leave?month=2026-10':'/inventory';
        await page.waitForFunction(path=>window.qa.path===path,destination);
        assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('baba_user')).id),7);
      }
    }
    await page.close();
  }} finally {await f.close();}
});

test('keeping selection stays closed, rejects late results, resumes input and preserves KO/VI names and interactions', options, async () => {
  const f=await browserFixture();
  const product={id:42,item_name:'위스키',item_name_vi:'Whisky',code:'W42',category:null,category_vi:null};
  try {for(const lang of ['ko','vi']) for(const interaction of ['mouse','touch','keyboard']) {
    const context=await f.browser.newContext({hasTouch:true});const page=await context.newPage();page.setDefaultTimeout(4000);
    await page.goto(f.base);
    for(const variant of ['partial','exact','late','alternate','code']) {
      const item={...product,...(variant==='alternate'?(lang==='ko'?{item_name:null}:{item_name_vi:null}):variant==='code'?{item_name:null,item_name_vi:null}:{})};
      const name=(lang==='ko'?item.item_name||item.item_name_vi:item.item_name_vi||item.item_name)||item.code;
      await page.evaluate(({lang,item})=>{
        window.qa.calls=[];window.qa.pending=[];
        window.qa.search=(url)=>{window.qa.calls.push(url);return window.qa.hold?new Promise(resolve=>window.qa.pending.push(()=>resolve(Response.json({items:[item]})))):Promise.resolve(Response.json({items:[item]}));};
        window.qa.hold=false;window.mount('keeping',lang);
      },{lang,item});
      const input=page.getByRole('combobox');await input.fill(variant==='exact'?name:'W');
      await page.getByRole('option').waitFor();
      if(variant==='late')await input.fill('Wh'); // Select during the next debounce.
      if(interaction==='touch')await page.getByRole('option').tap();
      else if(interaction==='keyboard'){await page.getByRole('option').focus();await page.keyboard.press('Enter');}
      else await page.getByRole('option').click();
      if(variant==='late')await page.evaluate(()=>window.qa.pending.forEach(release=>release()));
      await page.waitForTimeout(650);
      assert.equal(await input.inputValue(),name);
      assert.equal(await input.getAttribute('aria-expanded'),'false');
      assert.deepEqual(await page.evaluate(()=>window.qa.selected),{item,name});
      assert.equal(await page.evaluate(()=>window.qa.calls.length),1,'selection must not search its display name');
      await input.focus();assert.equal(await input.getAttribute('aria-expanded'),'false');
      await page.evaluate(()=>window.qa.hold=false);await input.fill('new');await page.getByRole('option').waitFor();
      assert.deepEqual(await page.evaluate(()=>window.qa.selected),{item:null,name:''});
    }
    await context.close();
  }} finally{await f.close();}
});
