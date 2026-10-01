import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {renderToStaticMarkup} from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import ts from 'typescript';
import {inventoryManualCategoryOptions,isInventoryManualCategory,INVENTORY_MANUAL_CATEGORY_NAMES} from '../lib/ledger/manual-entry-policy.ts';
const source=readFileSync('app/(protected)/admin/ledger/entries/page.tsx','utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const selectors=[];
function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='select'&&node.getText(ast).includes('inventoryManualCategoryOptions'))selectors.push(node);ts.forEachChild(node,visit);}visit(ast);
const details=['\uac00\uacf5\uc2dd\ud488','\uac74\uc5b4\ubb3c','\uc721\ub958','\ucc44\uc18c','\ub370\ud0ac\ub77c','\ub7fc','\ub9ac\ud050\ub974','\uc2dc\ub7fd'];
const names=[...INVENTORY_MANUAL_CATEGORY_NAMES,...details,'\uae09\uc5ec/\uc778\uac74\ube44','\uc9c1\uc6d0 \uc2dd\ub300','\uacb0\uc81c\u00b7\uc740\ud589 \uc218\uc218\ub8cc'];
const categories=names.map((name,index)=>({id:index+1,name,kind:'expense'}));
function render(node,current){
 const code=ts.transpileModule(`const element=(${node.getText(ast)});`,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
 const bindings={inventoryManualCategoryOptions,categories,candidateDraft:{categoryId:String(current)},draft:{categoryId:String(current)},id:'category',lang:'ko',manualExpenseCategoryLabel:name=>name,keepingInputStyle:{},setCandidateDraft:()=>{},setDraft:()=>{}};
 const element=new Function('exports','require',...Object.keys(bindings),code+';return element;')({},()=>runtime,...Object.values(bindings));
 return renderToStaticMarkup(element);
}
test('inventory allowlist excludes internal and unrelated financial/payroll categories',()=>{
 assert.deepEqual(inventoryManualCategoryOptions(categories,'').map(row=>row.name),[...INVENTORY_MANUAL_CATEGORY_NAMES]);
 assert.equal(isInventoryManualCategory({kind:'income',name:INVENTORY_MANUAL_CATEGORY_NAMES[0]}),false);
 for(const name of names.slice(INVENTORY_MANUAL_CATEGORY_NAMES.length))assert.equal(isInventoryManualCategory({kind:'expense',name}),false,name);
});
for(const [index,label] of ['pending','confirmed'].entries()){
 test(`${label} editor shows major categories and no automatic subcategories`,()=>{
 assert.equal(selectors.length,2);const html=render(selectors[index],1);
 for(const name of INVENTORY_MANUAL_CATEGORY_NAMES)assert.ok(html.includes(name),name);
 for(const name of names.slice(INVENTORY_MANUAL_CATEGORY_NAMES.length))assert.ok(!html.includes(name),name);
 });
 test(`${label} editor preserves only the currently stored internal category`,()=>{
 const current=categories.find(row=>row.name===details[2]);const html=render(selectors[index],current.id);
 assert.match(html,new RegExp(`<option value="${current.id}" selected="">`));
 assert.equal(inventoryManualCategoryOptions(categories,current.id).filter(row=>row.id===current.id).length,1);
 for(const name of details.filter(name=>name!==current.name))assert.ok(!html.includes(name),name);
 assert.equal(inventoryManualCategoryOptions(categories,1).length,INVENTORY_MANUAL_CATEGORY_NAMES.length);
 });
}

