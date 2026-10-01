import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import ts from 'typescript';
const source=readFileSync('app/(protected)/admin/ledger/entries/page.tsx','utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let branch,historical;
function visit(node){
 if(ts.isConditionalExpression(node)&&node.whenTrue.getText(ast).startsWith('<PayablePartySheet'))branch=node;
 if(ts.isFunctionDeclaration(node)&&node.name?.text==='HistoricalPayablePartySheet')historical=node;
 ts.forEachChild(node,visit);
}visit(ast);
function compile(text,bindings,result){
 const code=ts.transpileModule(text,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return new Function('exports','require',...Object.keys(bindings),code+`;return ${result}`)({},()=>runtime,...Object.values(bindings));
}
for(const month of ['2026-10','2026-09','2026-11'])test(`payable modal policy for ${month}`,()=>{
 const Current=()=>null,Historical=()=>null;
 const element=compile(`const element=(${branch.getText(ast)});`,{month,currentMonth:()=> '2026-10',PayablePartySheet:Current,HistoricalPayablePartySheet:Historical,lang:'ko',payableParty:{partyId:12},businessAccounts:[],payables:{historyPayables:[{party_id:12,outstandingAmount:100},{party_id:13,outstandingAmount:200}]},setPayableParty:()=>{},load:async()=>{},setNotice:()=>{},vi:false},'element');
 assert.equal(element.type,month==='2026-10'?Current:Historical);
 assert.equal('period' in element.props,false);
 if(month!=='2026-10'){assert.deepEqual(element.props.rows,[{party_id:12,outstandingAmount:100}]);assert.equal('onPaid' in element.props,false);}
});
test('historical sheet renders only its snapshot and close action without payment inputs',()=>{
 const Sheet=compile(historical.getText(ast),{BarSheet:({children,footer})=>React.createElement('section',null,children,footer),styles:{},secondaryButtonStyle:{},partnerTypeLabel:()=> 'Other',money:String,PayableMonthTotals:()=>null,PayableDateGroups:({rows})=>React.createElement('div',null,rows.map(row=>row.outstandingAmount).join(','))},'HistoricalPayablePartySheet');
 const html=renderToStaticMarkup(React.createElement(Sheet,{lang:'ko',month:'2026-09',party:{partyName:'Partner',closingOutstanding:2400000},rows:[{outstandingAmount:2400000}],onClose:()=>{}}));
 assert.match(html,/2400000/);assert.doesNotMatch(html,/<input|<select|checkbox/);assert.equal((html.match(/<button/g)||[]).length,1);
 assert.doesNotMatch(historical.getText(ast),/fetch|payables\/pay|AccountField|onPaid/);
});
test('historical payment context is removed while current sheet uses all live carried payables',()=>{
 assert.doesNotMatch(source,/PayablePeriodContext|PayablePeriodSnapshot|currentPeriodPayables|currentRows|period=\{/);
 assert.match(source,/groupPayableRows\(detail\?\.payables\?\?\[\]\)/);
 for(const file of ['app/(protected)/admin/ledger/entries/PayablePeriodSnapshot.tsx','lib/ledger/payable-period-payment.ts','tests/ledger-historical-payable-payment.test.mjs'])assert.equal(existsSync(file),false);
});

