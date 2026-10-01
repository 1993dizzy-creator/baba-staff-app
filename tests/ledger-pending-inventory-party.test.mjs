import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { database } from './helpers/inventory-ledger-fixture.mjs';
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
const partners=[{id:1012,ledgerPartyId:12,name:'Postpaid',isActive:true},{id:1011,ledgerPartyId:11,name:'Inactive',isActive:false}];
const draft=resolution=>({item:{candidateId:1450,name:'냅킨',nameVi:'Giấy ăn'},resolution,categoryId:'4',fundAccountId:'1',partyId:'',memo:''});
function fixture({resolution='payable',partyId=null,lang='ko',response={ok:true,body:{result:{status:'confirmed'}}},fetchImpl,adHocPayableParty=null}={}) {
  const candidateDraft=draft(resolution);const messages=[];const calls=[];const states=[];const closures=[];
  const selected={partyId};
  const save=compile(resolveNode.getText(ast),{selected,candidateDraft,data:{partners,adHocPayableParty},vi:lang==='vi',
    setSaving:value=>states.push(value),setDetailMessage:value=>messages.push(value),
    setSelected:value=>closures.push(value),setCandidateDraft:value=>closures.push(value),load:async()=>{},
    fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return fetchImpl?fetchImpl(url,options):{ok:response.ok,json:async()=>response.body};},
  },'resolveCandidate');
  let saving;
  function render(message='') {
    const bindings={adHocPayableParty,vi:lang==='vi',lang,entry:selected,candidateDraft,message,saving:false,
      partnersByParty:new Map(partners.map(partner=>[partner.ledgerPartyId,partner])),
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
    select.props.onChange({target:{value:'12'}});
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
    const ui=fixture({resolution,partyId:10});ui.candidateDraft.partyId='12';
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
// Local PostgreSQL execution through the actual existing API and resolver.
const apiCode=ts.transpileModule(read('app/api/admin/ledger/candidates/[id]/route.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function candidateDatabase() {
  const db=await database();
  const verification=read('supabase/migrations/20260921170100_add_inventory_payment_verification.sql');
  // Load its existing resolver amendments, without unrelated preflight/payment schema.
  await db.exec(verification.slice(0,verification.indexOf('  -- The current reconciliation entry point'))+'end; $payment_verification$;');
  await db.exec(`insert into business_partner_supplier_aliases values(null,'pending','khác');
    insert into ledger_candidates(id,candidate_type,source_type,source_key,business_date,proposed_amount,proposed_category_id,proposed_recognition_month,source_snapshot,source_fingerprint)
    values(1450,'inventory_purchase','inventory_purchase_log','inventory-log:1450','2026-09-29',2400000,4,'2026-09-01','{"supplier":"khác","item_name":"냅킨","item_name_vi":"Giấy ăn"}',repeat('a',64));`);
  return db;
}
function apiFetch(db){
  const deps={
    '@/lib/ledger/server':{requireLedgerActor:async()=>({actor:{id:2}}),ledgerJson:(body,status=200)=>Response.json(body,{status})},
    '@/lib/supabase/server':{supabaseServer:{
      from(table){assert.equal(table,'ledger_candidates');const query={select(){return query;},eq(){return query;},async maybeSingle(){return {data:{candidate_type:'inventory_purchase'},error:null};}};return query;},
      async rpc(name,args){assert.equal(name,'ledger_resolve_inventory_candidate_v1');return {data:(await db.query('select public.ledger_resolve_inventory_candidate_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',[args.p_candidate_id,args.p_resolution,args.p_category_id,args.p_party_id,args.p_fund_account_id,args.p_due_date,args.p_memo,args.p_reason,args.p_actor_user_id])).rows[0].result,error:null};},
    }},
  };const testModule={exports:{}};
  new Function('require','module','exports',apiCode)(name=>deps[name],testModule,testModule.exports);
  return (url,options)=>testModule.exports.POST(new Request('http://local'+url,options),{params:Promise.resolve({id:'1450'})});
}
for(const resolution of ['payable','verification_pending','immediate']){
  test(`candidate 1450: UI/API/RPC ${resolution} confirms expense, preserving pending supplier alias and partner defaults`,async()=>{
    const db=await candidateDatabase();
    try{
      const aliasesBefore=(await db.query('select * from business_partner_supplier_aliases')).rows;
      const partnersBefore=(await db.query('select * from business_partners order by id')).rows;
      const mappingsBefore=(await db.query('select * from ledger_supplier_party_mappings')).rows;
      const ui=fixture({resolution,fetchImpl:apiFetch(db)});
      if(resolution!=='immediate')ui.candidateDraft.partyId='12';
      await ui.clickSave();assert.deepEqual(ui.closures,[null,null]);
      const candidate=(await db.query('select * from ledger_candidates where id=1450')).rows[0];
      assert.equal(candidate.status,'confirmed');assert.equal(candidate.source_snapshot.supplier,'khác');
      assert.equal(candidate.proposed_party_id,null);
      const tx=(await db.query('select * from ledger_transactions where id=$1',[candidate.resolved_transaction_id])).rows[0];
      assert.equal(tx.status,'confirmed');assert.equal(Number(tx.amount),2400000);
      assert.equal(tx.party_id==null?null:Number(tx.party_id),resolution==='immediate'?null:12);
      assert.equal(tx.source_snapshot.paymentVerification??null,resolution==='verification_pending'?'pending':null);
      const payables=(await db.query('select * from ledger_payables where expense_transaction_id=$1',[tx.id])).rows;
      assert.equal(payables.length,resolution==='immediate'?0:1);
      if(payables.length){assert.equal(Number(payables[0].party_id),12);assert.equal(Number(payables[0].original_amount),2400000);}
      const movements=(await db.query('select * from ledger_movements where transaction_id=$1',[tx.id])).rows;
      assert.equal(movements.length,resolution==='immediate'?1:0);
      assert.deepEqual((await db.query('select * from business_partner_supplier_aliases')).rows,aliasesBefore);
      assert.deepEqual((await db.query('select * from business_partners order by id')).rows,partnersBefore);
      assert.deepEqual((await db.query('select * from ledger_supplier_party_mappings')).rows,mappingsBefore);
    }finally{await db.close();}
  });
}

for(const resolution of ['payable','verification_pending']) {
 test('system party is first selectable partner and candidate 1450 creates '+resolution+' without changing masters',async()=>{
  const db=await candidateDatabase();
  try {
   await db.exec(read('supabase/migrations/202608210004_add_ledger_payable_payments.sql'));
   const migration=read('supabase/migrations/20261001140419_add_ad_hoc_ledger_payable_party.sql');
   const before=(await db.query('select * from business_partners order by id')).rows;
   const aliases=(await db.query('select * from business_partner_supplier_aliases')).rows;
   await db.exec(migration);await db.exec(migration);
   const parties=(await db.query("select * from ledger_parties where memo='system:ad_hoc_payable'")).rows;
   assert.equal(parties.length,1);assert.equal(parties[0].type,'other');assert.equal(parties[0].is_active,true);
   const adHocPayableParty={ledgerPartyId:Number(parties[0].id),name:parties[0].name};
   const ui=fixture({resolution,adHocPayableParty,fetchImpl:apiFetch(db)});
   const select=ui.render().selects.find(node=>node.props.required&&node.props.onChange);
   const html=ui.render().html;assert.ok(html.indexOf(adHocPayableParty.name)<html.indexOf('Postpaid'));
   select.props.onChange({target:{value:String(adHocPayableParty.ledgerPartyId)}});
   await ui.clickSave();assert.deepEqual(ui.closures,[null,null]);
   const rows=(await db.query('select * from ledger_payables')).rows;
   assert.equal(rows.length,1);assert.equal(Number(rows[0].party_id),adHocPayableParty.ledgerPartyId);assert.equal(Number(rows[0].original_amount),2400000);
   assert.deepEqual((await db.query('select * from business_partners order by id')).rows,before);
   assert.deepEqual((await db.query('select * from business_partner_supplier_aliases')).rows,aliases);
   assert.equal((await db.query('select * from ledger_supplier_party_mappings')).rows.length,0);
  }finally{await db.close();}
 });
}
