import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { groupManualEntryPartners } from '../lib/ledger/manual-entry-policy.ts';
const read = path => readFileSync(path,'utf8');
const source = read('app/(protected)/admin/ledger/entries/page.tsx');
const ast = ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function visit(node) { if(!found && predicate(node)) found=node; if(!found) ts.forEachChild(node,visit); }
  visit(ast);assert.ok(found,'Expected candidate editor node');return found;
}
const resolveNode = find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='resolveCandidate');
const editorNode = find(node=>ts.isConditionalExpression(node)&&node.condition.getText(ast)==='candidateDraft'&&node.whenTrue.getText(ast).includes('<h3>{candidateDraft.item.name}</h3>'));
const editNode = find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='editCandidate');
function compile(text,bindings,returnName) {
  const code=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  return new Function('exports','require',...Object.keys(bindings),code+`;return ${returnName};`)({},()=>jsxRuntime,...Object.values(bindings));
}
const partners=[{id:1012,ledgerPartyId:12,name:'Postpaid',isActive:true,partnerType:'food',emoji:'Food'},{id:1011,ledgerPartyId:11,name:'Inactive',isActive:false,partnerType:'other',emoji:'Inactive'},{id:1033,ledgerPartyId:33,name:'kh\u00e1c',isActive:true,partnerType:'other',emoji:'Other'}];
const partnerModule={exports:{}};
const partnerCode=ts.transpileModule(read('app/(protected)/admin/ledger/entries/PartnerSelect.tsx'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
new Function('require','module','exports',partnerCode)(name=>({'react/jsx-runtime':jsxRuntime,'@/lib/ledger/manual-entry-policy':{groupManualEntryPartners},'@/components/bar/keeping/KeepingUi':{keepingInputStyle:{}}})[name],partnerModule,partnerModule.exports);
const PartnerSelect=partnerModule.exports.default;
const draft=resolution=>({item:{candidateId:1450,name:'냅킨',nameVi:'Giấy ăn'},resolution,categoryId:'4',fundAccountId:'1',partyId:'',memo:''});
function fixture({resolution='payable',partyId=null,lang='ko',response={ok:true,body:{result:{status:'confirmed'}}},fetchImpl,partnerRows=partners}={}) {
  const candidateDraft=draft(resolution);const messages=[];const calls=[];const states=[];const closures=[];
  const selected={partyId};
  const save=compile(resolveNode.getText(ast),{selected,candidateDraft,data:{partners:partnerRows},vi:lang==='vi',
    setSaving:value=>states.push(value),setDetailMessage:value=>messages.push(value),
    setSelected:value=>closures.push(value),setCandidateDraft:value=>closures.push(value),load:async()=>{},
    fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return fetchImpl?fetchImpl(url,options):{ok:response.ok,json:async()=>response.body};},
  },'resolveCandidate');
  let saving;
  function render(message='') {
    const bindings={PartnerSelect,partners:partnerRows,vi:lang==='vi',lang,entry:selected,candidateDraft,message,saving:false,
      partnersByParty:new Map(partnerRows.map(partner=>[partner.ledgerPartyId,partner])),
      accounts:[{id:1,display_name:'Cash',is_active:true,type:'cash'}],categories:[{id:4,name:'Expenses',kind:'expense',parent_id:1}],
      styles:new Proxy({},{get:(_,key)=>String(key)}),keepingInputStyle:{},primaryButtonStyle:{},manualExpenseCategoryLabel:value=>value,
      BarField:({label,required,children})=>React.createElement('label',{'data-required':!!required},label,children({id:label})),
      BarSegmentedControl:()=>null,setCandidateDraft:value=>Object.assign(candidateDraft,value),resolveCandidate:()=>{saving=save();return saving;},
    };
    const renderEditor=compile(`function renderEditor(){return (${editorNode.whenTrue.getText(ast)});}`,bindings,'renderEditor');
    const found={selects:[],buttons:[]};
    function expand(node){
      if(Array.isArray(node))return node.map((child,index)=>{const expanded=expand(child);return React.isValidElement(expanded)&&expanded.key==null?React.cloneElement(expanded,{key:index}):expanded;});
      if(!React.isValidElement(node))return node;
      if(typeof node.type==='function')return expand(node.type(node.props));
      if(node.type==='select')found.selects.push(node);
      if(node.type==='button')found.buttons.push(node);
      return React.cloneElement(node,{},expand(node.props.children));
    }
    const tree=expand(renderEditor());
    return {...found,html:renderToStaticMarkup(tree)};
  }
  async function clickSave(){const view=render();const button=view.buttons.at(-1);assert.equal(button.props.disabled,false);button.props.onClick();await saving;}
  return {candidateDraft,save,render,clickSave,messages,calls,states,closures};
}
for(const resolution of ['payable','verification_pending']) {
  test(`missing party + ${resolution} displays required selector and blocks blank save inline in both languages`,async()=>{
    for(const lang of ['ko','vi']) {
      const ui=fixture({resolution,lang});const view=ui.render();
      const select=view.selects.find(node=>node.props.id===(lang==='vi'?'Đối tác':'거래처'));
      assert.ok(select);assert.equal(select.props.required,true);
      assert.ok(view.html.includes('Postpaid'));assert.ok(!view.html.includes('Inactive'));
      await ui.clickSave();assert.equal(ui.calls.length,0);
      const expected=lang==='vi'?'Vui lòng chọn đối tác để ghi nhận công nợ.':'미지급 등록을 위해 거래처를 선택해주세요.';
      assert.equal(ui.messages.at(-1),expected);
      assert.ok(ui.render(expected).html.includes('role="alert"'));
      assert.ok(ui.render(expected).html.includes(expected));
      assert.deepEqual(ui.states,[]);
    }
  });
  test(`selected ${resolution} partner sends ledgerPartyId instead of business partner id`,async()=>{
    const ui=fixture({resolution});const select=ui.render().selects.find(node=>node.props.id==='거래처');
    select.props.onChange({target:{value:'1012'}});
    await ui.clickSave();assert.equal(ui.calls.length,1);
    assert.equal(ui.calls[0].url,'/api/admin/ledger/candidates/1450');
    assert.equal(ui.calls[0].body.partyId,12);assert.notEqual(ui.calls[0].body.partyId,1012);
    assert.deepEqual(ui.closures,[null,null]);
  });
}
test('immediate needs no party selector and saves with null party',async()=>{
  const ui=fixture({resolution:'immediate'});assert.ok(!ui.render().selects.some(node=>node.props.id==='거래처'));
  await ui.clickSave();assert.equal(ui.calls[0].body.partyId,null);assert.equal(ui.calls[0].body.fundAccountId,1);
});
test('linked source party bypasses selector and retains source party for every resolution',async()=>{
  for(const resolution of ['immediate','payable','verification_pending']){
    const ui=fixture({resolution,partyId:10});ui.candidateDraft.partyId='1012';
    assert.ok(!ui.render().selects.some(node=>node.props.id==='거래처'));
    await ui.clickSave();assert.equal(ui.calls[0].body.partyId,10);
  }
});
test('PARTY_REQUIRED API response is translated rather than exposed to user',async()=>{
  for(const lang of ['ko','vi']){
    const ui=fixture({resolution:'payable',partyId:10,lang,response:{ok:false,body:{code:'PARTY_REQUIRED'}}});
    await ui.clickSave();assert.equal(ui.calls.length,1);
    assert.ok(!ui.messages.at(-1).includes('PARTY_REQUIRED'));
    assert.equal(ui.messages.at(-1),lang==='vi'?'Vui lòng chọn đối tác để ghi nhận công nợ.':'미지급 등록을 위해 거래처를 선택해주세요.');
    assert.deepEqual(ui.closures,[]);
  }
});
test('editing another pending item starts with no partner override',()=>{
  let captured;
  const edit=compile(editNode.getText(ast),{selected:{partyId:null,defaultResolution:'payable'},setCandidateDraft:value=>{captured=value;}},'editCandidate');
  edit({candidateId:1450,categoryId:4});assert.equal(captured.partyId,'');
});
function flattenOptions(node){const result=[];function visit(n){if(Array.isArray(n))return n.forEach(visit);if(!React.isValidElement(n))return;if(n.type==='option')result.push([String(n.props.value),text(n.props.children)]);visit(n.props.children)}visit(node);return result}
function text(node){return Array.isArray(node)?node.map(text).join(''):React.isValidElement(node)?text(node.props.children):node==null?'':String(node)}
const manualSelectNode=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='PartnerSelect'&&node.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.text==='manual'));
test('both actual editors use the same PartnerSelect with policy optgroup order, sorting, emoji and ordinary khác',()=>{
 const types=['other','rent','service','equipment','consumable','beverage','food','alcohol'];
 const partnerRows=types.flatMap((partnerType,index)=>[{id:500+index,ledgerPartyId:900+index,name:partnerType==='other'?'khác':'Z '+partnerType,partnerType,isActive:true,emoji:'Emoji '+partnerType},{id:600+index,ledgerPartyId:1000+index,name:'A '+partnerType,partnerType,isActive:true,emoji:'First '+partnerType}]);partnerRows.push({id:999,ledgerPartyId:1999,name:'Inactive',partnerType:'other',isActive:false,emoji:'Off'});
 for(const lang of ['ko','vi']){
  const renderManual=compile('function renderManual(){return ('+manualSelectNode.getText(ast)+');}',{PartnerSelect,id:'manual',data:{partners:partnerRows},lang,partnerId:'',setPartnerId(){}},'renderManual');
  const manualElement=renderManual();assert.equal(manualElement.type,PartnerSelect);const manual=PartnerSelect(manualElement.props);
  const ui=fixture({lang,partnerRows});const candidate=ui.render().selects.find(node=>node.props.required);
  assert.deepEqual(flattenOptions(manual).slice(1),flattenOptions(candidate).slice(1));
  assert.deepEqual(manual.props.children[1].map(group=>group.props.label),groupManualEntryPartners(partnerRows,lang).map(group=>group.label));
  assert.equal(flattenOptions(manual)[0][1],lang==='vi'?'Không có':'없음');assert.equal(flattenOptions(candidate)[0][1],lang==='vi'?'Chọn đối tác':'거래처 선택');
  assert.equal(manual.props.required,false);assert.equal(candidate.props.required,true);
  assert.ok(flattenOptions(manual).some(option=>option[1]==='Emoji other khác'));assert.ok(!flattenOptions(candidate).some(option=>option[1].includes('Inactive')));
 }
});
test('ordinary khác selection uses business partner id and resolves its ledger party id',async()=>{
 for(const resolution of ['payable','verification_pending']){
  const ui=fixture({resolution});const select=ui.render().selects.find(node=>node.props.required);assert.ok(flattenOptions(select).some(option=>option[0]==='1033'&&option[1]==='Other khác'));
  select.props.onChange({target:{value:'1033'}});await ui.clickSave();assert.equal(ui.calls[0].body.partyId,33);assert.notEqual(ui.calls[0].body.partyId,1033);
 }
});
test('candidate 1450 with a linked regular source party never shows selector or changes party on resolution change',async()=>{
 for(const resolution of ['immediate','payable','verification_pending']){
  const ui=fixture({resolution,partyId:33});ui.candidateDraft.partyId='1012';assert.ok(!ui.render().selects.some(node=>node.props.id==='거래처'));await ui.clickSave();assert.equal(ui.calls[0].body.partyId,33);
 }
});
test('inactive, stale and ledger-party IDs cannot be submitted as business partner selections',async()=>{
 for(const value of ['1011','999999','12']){const ui=fixture();ui.candidateDraft.partyId=value;await ui.clickSave();assert.equal(ui.calls.length,0);assert.equal(ui.messages.at(-1),'미지급 등록을 위해 거래처를 선택해주세요.');}
});
const apiCode=ts.transpileModule(read('app/api/admin/ledger/candidates/[id]/route.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
for(const resolution of ['payable','verification_pending','immediate'])test('actual candidate API receives translated ledgerPartyId for '+resolution+' without DB access',async()=>{
 const rpcCalls=[];const deps={'@/lib/ledger/server':{requireLedgerActor:async()=>({actor:{id:2}}),ledgerJson:(body,status=200)=>Response.json(body,{status})},'@/lib/supabase/server':{supabaseServer:{from(table){assert.equal(table,'ledger_candidates');const q={select(){return q},eq(){return q},async maybeSingle(){return {data:{candidate_type:'inventory_purchase'},error:null}}};return q},async rpc(name,args){rpcCalls.push({name,args});return {data:{status:'confirmed'},error:null}}}}};const mod={exports:{}};new Function('require','module','exports',apiCode)(name=>deps[name],mod,mod.exports);
 const ui=fixture({resolution,fetchImpl:(url,options)=>mod.exports.POST(new Request('http://local'+url,options),{params:Promise.resolve({id:'1450'})})});ui.candidateDraft.partyId='1033';await ui.clickSave();assert.deepEqual(ui.closures,[null,null]);assert.equal(rpcCalls.length,1);assert.equal(rpcCalls[0].name,'ledger_resolve_inventory_candidate_v1');assert.equal(rpcCalls[0].args.p_party_id,resolution==='immediate'?null:33);
});
test('application has no system-party imports, marker checks or dedicated components',()=>{
 const forbidden=/AdHocPayableSheet|ad-hoc-payable|adHocPayableParty|isAdHocPayable|system:ad_hoc_payable|OtherPayablesSection/;
 function scan(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+item.name;if(item.isDirectory())scan(path);else if(/\.(ts|tsx)$/.test(item.name)&&!item.name.includes('.test.'))assert.doesNotMatch(read(path),forbidden,path)}}scan('app');scan('lib');
 assert.equal(existsSync('app/(protected)/admin/ledger/entries/AdHocPayableSheet.tsx'),false);assert.equal(existsSync('lib/ledger/ad-hoc-payable.ts'),false);
});
