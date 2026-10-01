import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import * as runtime from 'react/jsx-runtime';
import ts from 'typescript';
import {parsePartnerInput,PAYMENT_MODES} from '../lib/partners/policy.ts';
import {partnerText,formatPartnerPaymentMode} from '../lib/partners/text.ts';
import {buildLedgerEntries} from '../lib/ledger/entries.ts';
const read=path=>readFileSync(path,'utf8');
const base={name:'Regular',partnerType:'other',paymentMode:'unspecified',settlementMode:null,settlementRule:null,defaultPaymentTermDays:null,isActive:true};
test('partner parser accepts explicit unspecified and rejects non-null settlement fields',()=>{
 assert.deepEqual(PAYMENT_MODES,['unspecified','immediate','postpaid']);
 const parsed=parsePartnerInput(base);assert.equal(parsed.paymentMode,'unspecified');assert.equal(parsed.settlementMode,null);
 for(const bad of [{settlementMode:'ad_hoc'},{settlementRule:'net_days'},{defaultPaymentTermDays:30}])assert.equal(parsePartnerInput({...base,...bad}),null);
 for(const paymentMode of [null,'unknown'])assert.equal(parsePartnerInput({...base,paymentMode}),null);
});
for(const [paymentMode,resolution] of [['unspecified',undefined],['immediate','verification_pending'],['postpaid','payable']])test(`${paymentMode} partner resolution is determined by policy, independent of name`,()=>{
 for(const name of ['Regular','kh\u00e1c']){
 const candidates=[{id:1450,business_date:'2026-09-29',proposed_amount:2400000,proposed_party_id:33,proposed_category_id:4,source_snapshot:{item_name:'Napkin'},party:{name},category:{name:'Inventory'}}];
 const result=buildLedgerEntries([],candidates,new Map([[33,{paymentMode,defaultFundAccountId:null,defaultFundAccountName:null}]]))[0];
 assert.equal(result.defaultResolution,resolution);assert.equal(result.partyId,33);if(!resolution)assert.equal(result.accountName,null);
 }
});
function load(path,deps){const mod={exports:{}};const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},mod,mod.exports);return mod.exports.default;}
function segments(element){if(!element||typeof element!=='object')return [];if(Array.isArray(element))return element.flatMap(segments);if(typeof element.type==='function')return segments(element.type(element.props));return [element,...segments(element.props?.children)];}
test('partner payment UI renders three choices and clears policy on unspecified',()=>{
 const stub=props=>({type:'segmented',props});
 const Fields=load('components/PartnerSettlementFields.tsx',{'react/jsx-runtime':runtime,'@/components/bar/keeping/KeepingUi':{BarSegmentedControl:stub,keepingInputStyle:{}},'@/lib/partners/text':{partnerText,formatPartnerFundAccount:()=>''}});
 for(const lang of ['ko','vi'])for(const paymentMode of PAYMENT_MODES){
 let changed;const value={...base,paymentMode,settlementMode:'scheduled',settlementRule:'net_days',defaultPaymentTermDays:30};
 const tree=segments(Fields({lang,value,fundAccounts:[],onChange:next=>{changed=next;}}));const segmented=tree.find(node=>node.type==='segmented');
 assert.equal(segmented.props.value,paymentMode);assert.deepEqual(segmented.props.options.map(option=>option.value),[...PAYMENT_MODES]);
 assert.equal(segmented.props.options[0].label,partnerText[lang].unspecified);
 segmented.props.onChange('unspecified');assert.equal(changed.paymentMode,'unspecified');for(const key of ['settlementMode','settlementRule','defaultPaymentTermDays'])assert.equal(changed[key],null);
 assert.equal(tree.filter(node=>node.type==='select').length,1,'fund account only, no settlement inputs');
 }
 assert.equal(formatPartnerPaymentMode('unspecified','ko'),'\ubbf8\uc9c0\uc815');assert.equal(formatPartnerPaymentMode('unspecified','vi','compact'),'Ch\u01b0a x\u00e1c \u0111\u1ecbnh');
});
test('new PartnerForm defaults unspecified and existing values/party bridge round-trip',async()=>{
 for(const initial of [undefined,{...base,paymentMode:'immediate',ledgerPartyId:33},{...base,paymentMode:'postpaid',ledgerPartyId:33},{...base,settlementMode:'scheduled',settlementRule:'net_days',defaultPaymentTermDays:30,ledgerPartyId:33}]){
 const states=[];let submitted;
 const Form=load('components/PartnerForm.tsx',{'react/jsx-runtime':runtime,react:{useState:value=>{const current=typeof value==='function'?value():value;states.push(current);return [current,()=>{}];}},'@/components/bar/keeping/KeepingUi':{},'@/components/PartnerSettlementFields':{default:()=>null},'@/lib/partners/policy':{PARTNER_TYPES:['other']},'@/lib/partners/text':{partnerText,partnerTypeLabels:{},formatPartnerSubtypeName:()=>''}});
 const element=Form({lang:'ko',initial,fundAccounts:[],partnerSubtypes:[],onSubmit:async value=>{submitted=value;return true;}});
 assert.equal(states[0].paymentMode,initial?.paymentMode??'unspecified');
 await element.props.onSubmit({preventDefault(){}});assert.equal(submitted.paymentMode,initial?.paymentMode??'unspecified');assert.equal(submitted.ledgerPartyId,initial?.ledgerPartyId??null);
 if(submitted.paymentMode==='unspecified')for(const key of ['settlementMode','settlementRule','defaultPaymentTermDays'])assert.equal(submitted[key],null);
 }
});
