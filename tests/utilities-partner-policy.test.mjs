import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function load(file,mocks={}){const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};new Function('require','exports','module',code)(id=>{if(id in mocks)return mocks[id];throw Error(id);},m.exports,m);return m.exports;}
const policy=load('lib/partners/policy.ts');const labels=load('lib/partners/text.ts');const emojis=load('lib/partners/emoji.ts');const manual=load('lib/ledger/manual-entry-policy.ts');
const subtype={id:43,code:'utility_gas',partnerType:'utilities',nameKo:'가스',nameVi:'Gas',emoji:null,sortOrder:0,isActive:true};
const partner={name:'Cửa hàng gas petrolimex chính hãng',partnerType:'utilities',partnerSubtypeId:43,paymentMode:'postpaid',settlementMode:null,settlementRule:null,defaultPaymentTermDays:null,defaultFundAccountId:null,isActive:true,ledgerPartyId:21};
test('utilities is accepted for partner create/update and subtype creation with KO/VI label and emoji',()=>{
 assert.ok(policy.PARTNER_TYPES.includes('utilities'));assert.ok(policy.PARTNER_TYPE_GROUP_ORDER.includes('utilities'));assert.deepEqual(labels.partnerTypeLabels.utilities,{ko:'공과금',vi:'Điện nước & gas'});assert.equal(emojis.partnerTypeEmoji.utilities,'⚡');
 const parsed=policy.parsePartnerInput(partner);assert.equal(parsed.partnerType,'utilities');assert.equal(parsed.partnerSubtypeId,43);assert.equal(parsed.ledgerPartyId,21);assert.equal(parsed.paymentMode,'postpaid');assert.equal(parsed.isActive,true);
 assert.equal(policy.parsePartnerSubtypeCreateInput({partnerType:'utilities',nameKo:'가스',nameVi:'Gas'}).partnerType,'utilities');
});
test('utility gas groups under utilities in both languages and null subtype emoji safely falls back',()=>{
 for(const lang of ['ko','vi']){const groups=policy.groupPartnersByTypeAndSubtype([partner],true,lang,[subtype]);assert.equal(groups[0].type,'utilities');assert.equal(groups[0].subgroups[0].subtype.id,43);assert.equal(groups[0].subgroups[0].partners[0].name,partner.name);assert.equal(labels.formatPartnerSubtypeName(subtype,lang),lang==='ko'?'가스':'Gas');assert.equal(emojis.effectivePartnerEmoji('utilities',subtype),'⚡');}
});
test('manual utility gas uses gas expense exclusively and other mappings stay unchanged',()=>{
 assert.equal(manual.manualExpenseCategoryNameForPartner('utilities','utility_gas'),'가스비');assert.equal(manual.manualExpenseCategoryNameForPartner('utilities',null),null);assert.equal(manual.manualExpenseCategoryNameForPartner('utilities','gas'),null);assert.equal(manual.manualExpenseCategoryNameForPartner('other','utility_gas'),'기타 비용');assert.equal(manual.manualExpenseCategoryNameForPartner('other','gas'),'기타 비용');assert.equal(manual.manualExpenseCategoryNameForPartner('other','printing'),'인쇄·홍보비');assert.equal(manual.manualExpenseCategoryNameForPartner('consumable',null),'소모품·잡화');
 for(const lang of ['ko','vi']){const groups=manual.groupManualEntryPartners([partner],lang);assert.equal(groups[0].group,'utilities');assert.equal(groups[0].label,labels.partnerTypeLabels.utilities[lang]);}
});
test('all partner editors/managers/list groups reuse the shared type contract',()=>{
 for(const p of ['components/PartnerForm.tsx','components/PartnerSubtypeManager.tsx','components/CandidatePartnerReviewForm.tsx'])assert.match(readFileSync(p,'utf8'),/PARTNER_TYPES\.map/);
 assert.match(readFileSync('components/partners/PartnerSettingsPanel.tsx','utf8'),/groupPartnersByTypeAndSubtype/);
});
test('legacy candidate loader includes explicit source partner ID without changing null-ID hashes',async()=>{
 const log={id:3430,item_id:342,item_name:'가스통',item_name_vi:'Bình ga',category:'기타',change_quantity:2,new_purchase_price:1395000,new_supplier:partner.name,business_date:'2026-10-11',created_at:'2026-10-11T00:00:00Z',reason:'purchase',source:'quick_save',purchase_supplier_partner_id:21};let columns;
 const query={select(value){columns=value;return this;},gte(){return this;},lte(){return this;},order(){return this;},range(){return Promise.resolve({data:[log]});}};
 const source=load('lib/ledger/inventory-candidates.ts',{'server-only':{},'node:crypto':await import('node:crypto'),'@/lib/inventory/purchase-cost':{calculateInventoryPurchaseAmount:(q,p)=>q*p},'@/lib/inventory/reasons':{normalizeInventoryReason:v=>v},'@/lib/supabase/server':{supabaseServer:{from:()=>query}}});
 assert.equal((await source.loadInventoryCandidateSource('2026-10')).rows[0].snapshot.purchase_supplier_partner_id,21);assert.match(columns,/purchase_supplier_partner_id/);log.purchase_supplier_partner_id=null;assert.equal(Object.hasOwn((await source.loadInventoryCandidateSource('2026-10')).rows[0].snapshot,'purchase_supplier_partner_id'),false);
});

test('actual partner create/update API accepts utilities and preserves session actor and existing bridge',async()=>{
 const calls=[];const partnerJson=(body,status=200)=>Response.json(body,{status});const mocks={'@/lib/partners/policy':policy,'@/lib/partners/server':{partnerJson,requirePartnerManager:async()=>({actor:{id:2,role:'owner'}})},'@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{calls.push({name,args});return {data:{status:name.includes('create')?'created':'updated',partnerId:21,ledgerPartyId:21}};}}}};
 const create=load('app/api/admin/partners/route.ts',mocks);const update=load('app/api/admin/partners/[id]/route.ts',mocks);const request=()=>new Request('http://local/api/admin/partners/21',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...partner,actorUserId:999})});assert.equal((await create.POST(request())).status,201);assert.equal((await update.PATCH(request(),{params:Promise.resolve({id:'21'})})).status,200);
 for(const call of calls){assert.equal(call.args.p_partner_type,'utilities');assert.equal(call.args.p_partner_subtype_id,43);assert.equal(call.args.p_ledger_party_id,21);assert.equal(call.args.p_actor_user_id,2);assert.equal(call.args.p_payment_mode,'postpaid');}
});
