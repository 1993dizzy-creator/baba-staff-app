import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as selectOptions from '../lib/partners/select-options.ts';

// One 거래처 select rule set for 장부작성, 재고관리, 일자별재고 and 빠른 구매: 장부 group order,
// KO/VI labels, name order, subtype emoji first. Each screen keeps its own values and save logic.
const {partnerSelectOptions,partnerSelectGroups,partnerOptionLabel,PARTNER_OPTION_COLUMNS}=selectOptions;
function load(path,deps){
 const target={exports:{}};
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected '+name);return deps[name];},target,target.exports);
 return target.exports;
}
const base={react:React,'react/jsx-runtime':jsxRuntime,'@/lib/partners/select-options':selectOptions};
const optionGroups=load('components/partners/PartnerOptionGroups.tsx',base);
const SupplierSelectOptions=load('components/inventory/SupplierSelectOptions.tsx',{...base,'@/components/partners/PartnerOptionGroups':optionGroups}).default;
const PartnerSelect=load('app/(protected)/admin/ledger/entries/PartnerSelect.tsx',{...base,'@/components/partners/PartnerOptionGroups':optionGroups,'@/components/bar/keeping/KeepingUi':{keepingInputStyle:{}}}).default;

// Rows as the inventory APIs read them (business_partners + business_partner_subtypes).
const subtypes=[{id:1,emoji:'🥩'},{id:2,emoji:null},{id:3,emoji:'  '}];
const rows=[
 {id:35,name:'THỦY NAM',partner_type:'food',partner_subtype_id:1,is_active:true},
 {id:2,name:'Dabaco',partner_type:'food',partner_subtype_id:2,is_active:true},
 {id:3,name:'Wow Spirit',partner_type:'alcohol',partner_subtype_id:null,is_active:true},
 {id:9,name:'An Liên',partner_type:'food',partner_subtype_id:3,is_active:true},
 {id:40,name:'EVN',partner_type:'utilities',partner_subtype_id:null,is_active:true},
 {id:41,name:'Coca',partner_type:'beverage',partner_subtype_id:null,is_active:true},
 {id:42,name:'khác',partner_type:null,partner_subtype_id:null,is_active:true},
 {id:43,name:'Old Supplier',partner_type:'food',partner_subtype_id:null,is_active:false},
];
const options=partnerSelectOptions(rows,subtypes);
const optionValues=html=>[...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(([,value,label])=>[value,label]);
const groupLabels=html=>[...html.matchAll(/<optgroup label="([^"]*)">/g)].map(match=>match[1]);

test('inventory rows carry type, effective emoji (subtype first, else type) and active flag',()=>{
 assert.equal(PARTNER_OPTION_COLUMNS,'id,name,partner_type,partner_subtype_id,is_active');
 assert.deepEqual(options.slice(0,4),[
  {id:35,name:'THỦY NAM',partnerType:'food',emoji:'🥩',isActive:true},
  {id:2,name:'Dabaco',partnerType:'food',emoji:'🛒',isActive:true},
  {id:3,name:'Wow Spirit',partnerType:'alcohol',emoji:'🍾',isActive:true},
  {id:9,name:'An Liên',partnerType:'food',emoji:'🛒',isActive:true},
 ]);
 assert.equal(options.find(o=>o.id===42).emoji,'📦','unknown type → 기타 emoji');
 assert.equal(options.find(o=>o.id===43).isActive,false);
});

test('groups follow the 장부 order with KO/VI labels; names sorted inside a group; inactive hidden',()=>{
 assert.deepEqual(partnerSelectGroups(options,'ko').map(g=>[g.label,g.partners.map(p=>p.name)]),[
  ['주류',['Wow Spirit']],['식자재',['An Liên','Dabaco','THỦY NAM']],['음료',['Coca']],['공과금',['EVN']],['기타',['khác']]]);
 assert.deepEqual(partnerSelectGroups(options,'vi').map(g=>g.label),['Rượu','Thực phẩm','Đồ uống','Điện nước & gas','Khác']);
 assert.equal(partnerOptionLabel({name:'THỦY NAM',partnerType:'food',emoji:'🥩'}),'🥩 THỦY NAM');
 assert.equal(partnerOptionLabel({name:'Legacy',partnerType:'alcohol'}),'🍾 Legacy','no emoji in an old response → type emoji');
});

test('장부작성 PartnerSelect and inventory selects render the same groups, order and labels',()=>{
 // Ledger partners come from /api/admin/ledger with the same type/emoji rule.
 const ledgerPartners=options.map(o=>({...o,ledgerPartyId:o.id+100}));
 for(const lang of ['ko','vi']){
  const ledger=renderToStaticMarkup(React.createElement(PartnerSelect,{id:'p',partners:ledgerPartners,lang,value:'',onChange(){}}));
  const inventory=renderToStaticMarkup(React.createElement('select',null,React.createElement(SupplierSelectOptions,{partners:options,aliases:[],lang,placeholder:'-',directInput:'+'})));
  const ledgerGroups=groupLabels(ledger),inventoryGroups=groupLabels(inventory);
  assert.deepEqual(inventoryGroups.slice(0,-1),ledgerGroups,lang);
  assert.equal(inventoryGroups.at(-1),lang==='vi'?'Cần xác nhận':'확인 필요');
  const ledgerLabels=optionValues(ledger).slice(1).map(([,label])=>label),inventoryLabels=optionValues(inventory).filter(([v])=>v.startsWith('partner:')).map(([,label])=>label);
  assert.deepEqual(inventoryLabels,ledgerLabels);
  assert.deepEqual(ledgerLabels.slice(0,4),['🍾 Wow Spirit','🛒 An Liên','🛒 Dabaco','🥩 THỦY NAM']);
  // Ledger values stay the plain id.
  assert.deepEqual(optionValues(ledger).slice(0,3).map(([v])=>v),['','3','9']);
 }
});

test('inventory keeps none, partner:{id}, 확인 필요 alias:{id} in its own group, and __custom__',()=>{
 const aliases=[{id:7,supplierName:'Minh Thắm',status:'pending',businessPartnerId:null},{id:8,supplierName:'Linked',status:'linked',businessPartnerId:2},{id:9,supplierName:'Ignored',status:'ignored',businessPartnerId:null}];
 const html=renderToStaticMarkup(React.createElement('select',null,React.createElement(SupplierSelectOptions,{partners:options,aliases,lang:'ko',placeholder:'거래처',directInput:'직접 입력'})));
 const values=optionValues(html);
 assert.deepEqual(values[0],['','거래처']);
 assert.deepEqual(values.at(-1),['__custom__','직접 입력']);
 assert.deepEqual(values.at(-2),['alias:7','Minh Thắm'],'only pending aliases, last group');
 assert.ok(!html.includes('Linked')&&!html.includes('Ignored'));
 assert.ok(values.filter(([v])=>v.startsWith('partner:')).every(([v])=>/^partner:\d+$/.test(v)));
 assert.ok(!html.includes('partner:43'),'inactive partner not offered');
 assert.match(html,/<optgroup label="확인 필요"><option value="alias:7">Minh Thắm<\/option><\/optgroup><option value="__custom__">/);
 // Empty partner list (e.g. an older cached response) still offers the alias group and direct input.
 assert.deepEqual(optionValues(renderToStaticMarkup(React.createElement('select',null,React.createElement(SupplierSelectOptions,{partners:[],aliases,lang:'vi',placeholder:'x',directInput:'y'})))).map(([v])=>v),['','alias:7','__custom__']);
});

test('APIs: bootstrap stream and single item read the same partner/subtype columns in one parallel batch; the list route is unchanged',()=>{
 const bootstrap=readFileSync('lib/inventory/bootstrap-server.ts','utf8');
 assert.match(bootstrap,/const \[items, partners, subtypes, aliases\] = await Promise\.all\(\[/);
 assert.match(bootstrap,/from\("business_partners"\)\.select\(PARTNER_OPTION_COLUMNS\)\.eq\("is_active", true\)\.order\("name"\)/);
 assert.match(bootstrap,/from\("business_partner_subtypes"\)\.select\(PARTNER_SUBTYPE_EMOJI_COLUMNS\)/);
 assert.match(bootstrap,/supplierPartners: partnerSelectOptions\(partnerRows, subtypeRows\),/);
 assert.match(bootstrap,/supplierPartnerNames: new Map\(partnerRows\.map\(row => \[Number\(row\.id\), row\.name\]\)\)/);
 const items=readFileSync('app/api/inventory/items/route.ts','utf8');
 assert.match(items,/const \[itemResult, partners, subtypes, aliases\] = await Promise\.all\(\[/);
 assert.match(items,/supplierPartners: partnerSelectOptions\(partners\.data \?\? \[\], subtypes\.data \?\? \[\]\)/);
 assert.match(items,/const \[items, partnerResult\] = await Promise\.all\(\[\n\s*fetchInventoryItems\(\{ supabase: supabaseAdmin, includeInactive: canIncludeInactive \}\),\n\s*supabaseAdmin\.from\("business_partners"\)\.select\("id,name"\)\.eq\("is_active", true\),/);
 // All three inventory selects use the adapter; their change handlers (partner:/alias:/__custom__) are untouched.
 const page=readFileSync('components/inventory/InventoryPageContent.tsx','utf8'),editor=readFileSync('components/inventory/InventoryItemEditor.tsx','utf8');
 assert.equal((page.match(/<SupplierSelectOptions partners=\{supplierPartners\} aliases=\{supplierAliases\} lang=\{lang\}/g)??[]).length,2);
 assert.equal((editor.match(/<SupplierSelectOptions partners=\{supplierPartners\} aliases=\{supplierAliases\} lang=\{lang\}/g)??[]).length,1);
 for(const source of [page,editor]){
  assert.doesNotMatch(source,/정규 거래처/);
  assert.match(source,/value\.startsWith\("partner:"\)/);assert.match(source,/value\.startsWith\("alias:"\)/);assert.match(source,/value === "__custom__"/);
 }
});
