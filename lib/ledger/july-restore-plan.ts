/** One-off July reconstruction. Pure planning; no credentials or DB connections. */
import { parseVndMilli, formatVndMilli } from './august-rebuild-plan.ts';
import { createHash } from 'node:crypto';

export const JULY_SHEET = '1BRT2ul07GftjqVPwcIf35o3LDJ6RjPIdWL_YeiRqDx4';
export const JULY_TAB = '829182003';
export const FUNDS = ['store_cash', 'vuong_personal_custody', 'cho_personal_custody', 'baba_corporate_bank'] as const;
export type Fund = typeof FUNDS[number];
export type Account = Fund | 'card_clearing';
export const OPENING = {store_cash:'202299186',vuong_personal_custody:'16123010',cho_personal_custody:'850041',baba_corporate_bank:'381587580'};
export const CLOSING = {store_cash:'95464986',vuong_personal_custody:'5231310',cho_personal_custody:'95470741',baba_corporate_bank:'104186605'};
export const CLASS_COUNTS = {card_deposit:23,manual_candidate:54,inventory_additional:99,inventory_original:17,meal:31,pos_daily_split:32,pos_card:31,other:108} as const;
export type Classification = keyof typeof CLASS_COUNTS | 'inventory_combined';
export type Effect = { account:Account; amount:string };
export type Row = {
  sheetId:string; tabId:string; row:number; date:string; classification:Classification;
  // Account effects are already reconciled in the authoritative mapping. A POS
  // summary and its split receipts must not both contribute the same receipt.
  effects:Effect[]; amount:string; mappingReference:string; sourceRefs:string[];
};
export type Action = {
  key:string; rowNumbers:number[]; kind:'expense'|'income'|'meal'|'inventory'|'transfer'|'pos'|'card_deposit'|'payable_payment'|'link'|'hold';
  date:string; amount:string; effects:Effect[]; evidence:string; economicKey:string;
  categoryId?:number; partyId?:number; transactionId?:number;
  transactionSnapshot?:Record<string,unknown>;
  candidateId?:number; candidateSnapshot?:Record<string,unknown>;
  bucket?:'cash'|'transfer'|'card'|'other';
  allocations?:{payableId:number; allocatedAmount:string}[];
  // Mandatory for new plain expenses: the existing mapping explicitly excludes
  // an already-recognized purchase/payroll/POS obligation. Never inferred by name.
  costBasis?:'verified_non_inventory'|'verified_sheet_meal';
};
export type Bundle = {
  version:1; sheetId:string; tabId:string; mappingReference:string; capturedAt:string;
  legacyInventorySplit?:'aggregate_only';
  rows:Row[]; actions:Action[];
  dailyTargets:{date:string; closing:Record<Fund,string>}[];
};

export function rowKey(row:Pick<Row,'sheetId'|'tabId'|'row'>) {
  return `sheet:${row.sheetId}:tab:${row.tabId}:row:${row.row}`;
}
export function stable(value:unknown):string {
  if (Array.isArray(value)) return '['+value.map(stable).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
  return JSON.stringify(value);
}
export const digest = (value:unknown) => createHash('sha256').update(stable(value)).digest('hex');
const money = (value:string) => parseVndMilli(value);
const fmt = (value:bigint) => formatVndMilli(value);
const validDate = (value:string) => /^2026-07-(0[1-9]|[12][0-9]|3[01])$/.test(value);
const positiveId = (value:unknown) => typeof value==='number' && Number.isSafeInteger(value) && value>0;
const accs = [...FUNDS,'card_clearing'];
function effectMap(effects:Effect[]) {
  const result = new Map<string,bigint>();
  for(const e of effects) {
    if(!accs.includes(e.account)) throw Error('UNKNOWN_ACCOUNT');
    if(result.has(e.account)) throw Error('DUPLICATE_ACCOUNT_EFFECT');
    const n=money(e.amount); if(n===BigInt(0)) throw Error('ZERO_EFFECT'); result.set(e.account,n);
  }
  return result;
}
const effectsEqual = (a:Map<string,bigint>,b:Map<string,bigint>) => accs.every(k=>(a.get(k)??BigInt(0))===(b.get(k)??BigInt(0)));

export function planJulyRestore(bundle:Bundle) {
  const blockers:string[]=[];
  const check=(ok:unknown,reason:string)=>{if(!ok)blockers.push(reason);};
  check(bundle.version===1 && bundle.sheetId===JULY_SHEET && bundle.tabId===JULY_TAB,'SOURCE_IDENTITY');
  check(Boolean(bundle.mappingReference?.trim()) && Number.isFinite(Date.parse(bundle.capturedAt)),'SOURCE_PROVENANCE');
  check(bundle.rows.length===395,'EXPECTED_395_ROWS');
  const rows=new Map<number,Row>(); const assigned=new Set<number>(); const keys=new Set<string>(); const economicKeys=new Set<string>();
  const expectedClasses:Record<string,number>=bundle.legacyInventorySplit==='aggregate_only'
    ? {...CLASS_COUNTS,inventory_original:0,inventory_additional:0,inventory_combined:116} : CLASS_COUNTS;
  const byClass=Object.fromEntries(Object.keys(expectedClasses).map(k=>[k,{total:0,ready:0,linked:0,held:0,risk:0}]));
  const sheetDaily=new Map<string,bigint>();
  for(const row of bundle.rows) {
    check(!rows.has(row.row) && positiveId(row.row),'DUPLICATE_OR_INVALID_ROW'); rows.set(row.row,row);
    check(row.sheetId===JULY_SHEET && row.tabId===JULY_TAB && validDate(row.date),'ROW_IDENTITY_OR_DATE');
    check(Boolean(row.mappingReference?.trim()) && Array.isArray(row.sourceRefs),'ROW_PROVENANCE');
    check(Object.hasOwn(expectedClasses,row.classification),'UNKNOWN_CLASSIFICATION');
    if(byClass[row.classification]) byClass[row.classification].total++;
    try {check(money(row.amount)>=BigInt(0),'NEGATIVE_ROW_AMOUNT');for(const [account,n] of effectMap(row.effects)) {
      const k=row.date+'|'+account; sheetDaily.set(k,(sheetDaily.get(k)??BigInt(0))+n);
    }} catch{blockers.push('INVALID_ROW_MONEY');}
  }
  for(const [k,n] of Object.entries(expectedClasses)) check(byClass[k].total===n,`CLASS_COUNT:${k}`);
  for(const [kind,target] of [['meal','10050000'],['pos_card','223562820'],['card_deposit','225970967']] as const) {
    try {check(bundle.rows.filter(r=>r.classification===kind).reduce((s,r)=>s+money(r.amount),BigInt(0))===money(target),`CONTROL_TOTAL:${kind}`);}catch{blockers.push(`CONTROL_TOTAL:${kind}`);}
  }
  const decisions=bundle.actions.map(action=>{
    const reasons:string[]=[]; const reject=(ok:unknown,reason:string)=>{if(!ok)reasons.push(reason);};
    reject(/^[a-z0-9][a-z0-9:_-]{0,180}$/.test(action.key),'INVALID_ACTION_KEY');
    reject(!keys.has(action.key),'DUPLICATE_ACTION_KEY'); keys.add(action.key);
    reject(Boolean(action.economicKey?.trim()) && !economicKeys.has(action.economicKey),'DUPLICATE_OR_MISSING_ECONOMIC_KEY'); economicKeys.add(action.economicKey);
    reject(validDate(action.date) && Boolean(action.evidence?.trim()),'ACTION_DATE_OR_EVIDENCE');
    reject(action.rowNumbers.length>0,'EMPTY_ROW_GROUP');
    const group:Row[]=[]; const expected=new Map<string,bigint>();
    for(const n of action.rowNumbers) {
      const row=rows.get(n);reject(Boolean(row)&&!assigned.has(n),'MISSING_OR_REUSED_ROW'); assigned.add(n);
      if(row) {group.push(row);reject(row.date===action.date,'CROSS_DAY_GROUP');try{for(const [k,v]of effectMap(row.effects))expected.set(k,(expected.get(k)??BigInt(0))+v);}catch{reasons.push('INVALID_EFFECT');}}
    }
    let effects=new Map<string,bigint>(); let amount=BigInt(0);
    try {effects=effectMap(action.effects);amount=money(action.amount);reject(amount>BigInt(0),'NONPOSITIVE_ACTION_AMOUNT');reject(effectsEqual(expected,effects),'ROW_ACTION_EFFECT_MISMATCH');}catch{reasons.push('INVALID_ACTION_MONEY');}
    const positive=[...effects].filter(([,v])=>v>BigInt(0)),negative=[...effects].filter(([,v])=>v<BigInt(0));
    const outflow=negative.length===1&&positive.length===0&&negative[0][1]===-amount&&negative[0][0]!=='card_clearing';
    const sourceRefs=group.flatMap(r=>r.sourceRefs);
    if(action.kind==='expense'||action.kind==='meal') {
      reject(outflow && positiveId(action.categoryId),'EXPENSE_SHAPE');
      reject(action.kind==='meal'?group.every(r=>r.classification==='meal')&&action.costBasis==='verified_sheet_meal':group.every(r=>r.classification==='manual_candidate'||r.classification==='other'&&[306,368].includes(r.row)&&action.categoryId===29)&&action.costBasis==='verified_non_inventory','COST_REQUIRES_LINK_OR_REVIEW');
      reject(sourceRefs.length===0,'EXISTING_COST_SOURCE_MUST_NOT_BE_EXPENSE');
    } else if(action.kind==='income') {
      reject(group.length===1&&group[0].row===236&&group[0].classification==='manual_candidate'&&positive.length===1&&negative.length===0&&positive[0][1]===amount&&!effects.has('card_clearing')&&positiveId(action.categoryId),'BANK_INTEREST_ONLY');
    } else if(action.kind==='inventory') {
      reject(outflow&&positiveId(action.categoryId)&&positiveId(action.candidateId)&&sourceRefs.length>0,'INVENTORY_SOURCE_REQUIRED');
      reject(group.every(r=>['inventory_additional','inventory_original','inventory_combined'].includes(r.classification)),'INVENTORY_CLASSIFICATION');
      const c=action.candidateSnapshot;
      reject(c?.id===action.candidateId&&c?.candidate_type==='inventory_purchase'&&c?.status==='pending'&&c?.business_date===action.date&&c?.proposed_recognition_month==='2026-07-01','INVENTORY_CANDIDATE_SNAPSHOT_REQUIRED');
      try {reject(money(String(c?.proposed_amount))===amount,'SHEET_PAYMENT_COST_DIFFERENCE_REQUIRES_REVIEW');}catch{reasons.push('INVALID_CANDIDATE_AMOUNT');}
    } else if(action.kind==='transfer') {
      reject(positive.length===1&&negative.length===1&&positive[0][1]===amount&&negative[0][1]===-amount&&!effects.has('card_clearing'),'TRANSFER_SHAPE');
    } else if(action.kind==='pos') {
      reject(positive.length===1&&negative.length===0&&positive[0][1]===amount&&positiveId(action.categoryId),'POS_SHAPE');
      reject(['cash','transfer','card','other'].includes(action.bucket??'') && sourceRefs.length>0,'POS_SOURCE_REQUIRED');
      reject(group.every(r=>['pos_daily_split','pos_card'].includes(r.classification)),'POS_CLASSIFICATION');
      reject(action.bucket==='card'?positive[0]?.[0]==='card_clearing':positive[0]?.[0]!=='card_clearing','POS_CLEARING_ACCOUNT');
      reject(!(action.date==='2026-07-09'&&action.bucket==='transfer')&&!(['2026-07-12','2026-07-28'].includes(action.date)&&action.bucket==='card'),'KNOWN_POS_DIFFERENCE_REQUIRES_REVIEW');
      reject(!(action.date==='2026-07-31'&&action.bucket==='card'),'LINK_EXISTING_1190');
    } else if(action.kind==='card_deposit') {
      reject(group.every(r=>r.classification==='card_deposit')&&effects.size===2&&effects.get('card_clearing')===-amount&&effects.get('baba_corporate_bank')===amount,'CARD_DEPOSIT_IS_NOT_REVENUE');
    } else if(action.kind==='payable_payment') {
      reject(outflow&&positiveId(action.partyId)&&sourceRefs.length>0,'PAYABLE_PAYMENT_SHAPE');
      try {reject(Boolean(action.allocations?.length)&&action.allocations!.every(a=>positiveId(a.payableId)&&money(a.allocatedAmount)>BigInt(0))&&new Set(action.allocations!.map(a=>a.payableId)).size===action.allocations!.length&&action.allocations!.reduce((s,a)=>s+money(a.allocatedAmount),BigInt(0))===amount,'EXPLICIT_PAYABLE_ALLOCATION_REQUIRED');}catch{reasons.push('INVALID_PAYABLE_ALLOCATION');}
    } else if(action.kind==='link') {
      reject(positiveId(action.transactionId)&&action.transactionSnapshot?.id===action.transactionId,'EXISTING_TRANSACTION_SNAPSHOT_REQUIRED');
    } else reject(action.kind==='hold','UNSUPPORTED_KIND');
    const status=action.kind==='hold'?'held':reasons.length?'risk':action.kind==='link'?'linked':'ready';
    for(const row of group) if(byClass[row.classification]) byClass[row.classification][status]++;
    return {key:action.key,status,reasons,rowKeys:group.map(rowKey),action};
  });
  check(assigned.size===rows.size && [...rows.keys()].every(n=>assigned.has(n)),'UNASSIGNED_ROWS');
  const targets=new Map(bundle.dailyTargets.map(t=>[t.date,t]));
  check(targets.size===31&&bundle.dailyTargets.length===31,'EXPECTED_31_DAILY_TARGETS');
  const running=Object.fromEntries(FUNDS.map(f=>[f,money(OPENING[f])]));
  const daily=[];
  for(let d=1;d<=31;d++) {
    const date=`2026-07-${String(d).padStart(2,'0')}`;const t=targets.get(date);
    for(const f of FUNDS) {
      running[f]+=sheetDaily.get(date+'|'+f)??BigInt(0);
      let delta:string|null=null;try{if(t)delta=fmt(running[f]-money(t.closing[f]));}catch{/* invalid target blocks below */}
      daily.push({date,account:f,sheetClosing:fmt(running[f]),target:t?.closing[f]??null,difference:delta,matches:delta==='0'});
    }
  }
  check(daily.every(d=>d.matches),'DAILY_TARGET_MISMATCH');
  check(FUNDS.every(f=>running[f]===money(CLOSING[f])),'MONTH_END_TARGET_MISMATCH');
  const counts={ready:decisions.filter(d=>d.status==='ready').length,linked:decisions.filter(d=>d.status==='linked').length,held:decisions.filter(d=>d.status==='held').length,risk:decisions.filter(d=>d.status==='risk').length};
  return {status:blockers.length?'BLOCKED':'REVIEWABLE',digest:digest(bundle),blockers:[...new Set(blockers)],sourceRows:bundle.rows.length,byClass,counts,daily,decisions,
    fullRestoreReady:blockers.length===0&&counts.held===0&&counts.risk===0};
}
