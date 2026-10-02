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
 const element=compile(`const element=(${branch.getText(ast)});`,{month,currentMonth:()=> '2026-10',PayablePartySheet:Current,HistoricalPayablePartySheet:Historical,lang:'ko',payableParty:{partyId:12},businessAccounts:[],payables:{},setPayableParty:()=>{},load:async()=>{},setNotice:()=>{},vi:false},'element');
 assert.equal(element.type,month==='2026-10'?Current:Historical);
 assert.equal('period' in element.props,false);
 if(month!=='2026-10'){assert.deepEqual(element.props.party,{partyId:12});assert.equal(element.props.month,month);assert.equal('rows' in element.props,false);assert.equal('onPaid' in element.props,false);}
});
test('historical sheet renders only its snapshot and close action without payment inputs',()=>{
 // Loaded state: the sheet's own read resolved with this party's month-end rows.
 const states=[[[{outstandingAmount:2400000}],()=>{}],[false,()=>{}]];let call=0;
 const Sheet=compile(historical.getText(ast),{useState:()=>states[call++%2],useEffect:()=>{},BarSheet:({children,footer})=>React.createElement('section',null,children,footer),styles:{},secondaryButtonStyle:{},partnerTypeLabel:()=> 'Other',money:String,PayableMonthTotals:()=>null,PayableMonthGroups:({rows})=>React.createElement('div',null,rows.map(row=>row.outstandingAmount).join(','))},'HistoricalPayablePartySheet');
 const html=renderToStaticMarkup(React.createElement(Sheet,{lang:'ko',month:'2026-09',party:{partyId:12,partyName:'Partner',closingOutstanding:2400000},onClose:()=>{}}));
 assert.match(html,/2400000/);assert.doesNotMatch(html,/<input|<select|checkbox/);assert.equal((html.match(/<button/g)||[]).length,1);
 // Its only request is the read-only per-party history GET; no payment path.
 assert.doesNotMatch(historical.getText(ast),/payables\/pay|AccountField|onPaid|method:/);
 assert.match(historical.getText(ast),/historyPartyId=\$\{party\.partyId\}/);
});
test('historical payment context is removed while current sheet uses all live carried payables',()=>{
 assert.doesNotMatch(source,/PayablePeriodContext|PayablePeriodSnapshot|currentPeriodPayables|currentRows|period=\{/);
 assert.match(source,/groupPayableRows\(detail\?\.payables\?\?\[\]\)/);
 for(const file of ['app/(protected)/admin/ledger/entries/PayablePeriodSnapshot.tsx','lib/ledger/payable-period-payment.ts','tests/ledger-historical-payable-payment.test.mjs'])assert.equal(existsSync(file),false);
});

