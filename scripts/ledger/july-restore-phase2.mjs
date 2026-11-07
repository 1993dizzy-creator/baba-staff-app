// Offline reconstruction of existing notes. No discovery of new inventory purchases.
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseVndMilli,formatVndMilli} from '../../lib/ledger/august-rebuild-plan.ts';
export const APPLIED=[11,17,30,43,45,56,67,91,95,96,108,125,126,136,147,163,173,185,191,193,198,216,220,221,225,236,238,249,258,262,275,277,282,284,291,298,302,306,311,314,319,331,340,353,357,363,368,374,381];
export const WEAK=[8,81,109,271,349,61];
export const FRUIT=[20,44,86,175,227,301,327];
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
// Only IDs explicitly assigned to THIS sheet row in its preserved note.
// Do not extract every #token: other rows, cancelled logs and ledger IDs coexist.
export const ASSIGNED={
 6:[5566],7:[5562],8:[5563],9:[5580],10:[5581],14:[5582,5583],16:[5615],18:[5636],19:[5635],20:range(5637,5642),21:[5634],
 27:[5679],28:[5683],29:[5707],31:[5720],32:[5724],39:range(5725,5728),44:range(5783,5787),46:[5827],47:range(5828,5831),
 53:[5914,5915,5916],54:[5912],55:[5913],58:[5911],61:[5789,5790,5792,5793,5794,5795,5796,5798],68:[6049],69:[6051],
 79:[6229,6230,6233],80:[6186,6187],81:[6212,6213,6214],82:[6259],83:[6238],85:[6231],86:range(6234,6237),93:range(6329,6332),94:[6323],
 99:[6335,6337,6340,6342,6345,6347],105:[5561],107:[6409],109:[6414],110:[6416],111:[6417,6418,6419,6422],
 124:[6588,6589,6592,6608,6609],127:range(6574,6577),128:[6591],133:[6652],134:[6651],135:[6650],137:[6194,6195,6197,6665],138:[6673],148:[6742,6744],149:range(6745,6749),
 158:[6792],159:[6795],160:[6796],161:[6797],162:[6794],164:[6812],174:[6844],175:range(6845,6848),176:[6852],199:range(6982,6985),200:[6981,6987],201:[6986],
 202:[6928,6929],209:[7059,7060,7061,7063,7064,7065,7066,7067,7068,7069],210:[6876],214:[5704,5709],217:[7140,7141],218:[7073],226:[7186],227:range(7188,7190),228:[7192],229:[7200],239:[7240,7242],240:range(7277,7280),241:[7273,7274],
 250:[7340,7342],251:[7344],259:[7373],260:[7379],261:[7380],263:[7398],264:[7402],270:[7511],271:[7363,7364],272:[7382,7383,7385,7386,7387,7389,7391,7393],273:[6833],276:[7463,7465,7467],278:[7445],279:range(7447,7449),280:[7446],281:range(7451,7454),283:[7456],287:[7457,7458],
 292:[7550,7551],293:[7549],300:[7575,7577],301:range(7579,7582),310:[7650],312:[7645],313:[7644],317:[7673],320:[7747],321:[7751],322:[7757],324:[7767],325:[7760],326:[7759],327:range(7761,7766),332:[7769],337:range(7927,7929),338:[7931],339:[7930],341:[7933],342:[7947],349:[7588,7594,7635],352:[7979,7981,7982,7983,7984,7985,7986],354:[7962],355:[7963],356:range(7964,7968),358:[7990],359:[7989],371:[8019],372:[7377,7378],380:[8060],382:[8080,8081,8083],398:[8057,8059],
};
export const CORRECTIONS={111:[6421],137:[6196],240:[7281],281:[7455]};
export const EXCLUDED={9:[5582,5583],44:[5827],53:[5912,5913],81:[6217],85:[],86:[6231],105:[6644],128:[6466],199:[6981,6987],210:[6791],227:[7192],260:[],263:[7379,7380],356:[7990],372:[8002]};
// Keep discrepancies and uncertain historical payment periods visible, never fit 80.
const additional={
 9:'QUANTITY_MEMO_CONFLICT',21:'ITEM_IDENTITY_WEAK',99:'SUPPLIER_ALIAS_INVOICE_UNCONFIRMED',105:'HISTORICAL_PAYABLE_PERIOD',124:'UNEXPLAINED_AMOUNT_DIFFERENCE',128:'OTHER_PURCHASE_PAYMENT_UNCLEAR',133:'ADVANCE_PAYMENT_DATE',137:'HISTORICAL_PAYABLE_WITH_CANCELLATION',148:'QUANTITY_AND_AMOUNT_CONFLICT',202:'CROSS_DATE_INVOICE_ALLOCATION',209:'POSSIBLE_NONPURCHASE_BOTTLE_TRANSFER',210:'HISTORICAL_PAYABLE_AND_QUANTITY_CONFLICT',214:'SUPPLIER_ITEM_DATE_WEAK',240:'CORRECTION_INVOICE_DIFFERENCE',241:'UNEXPLAINED_AMOUNT_DIFFERENCE',261:'INVOICE_DIFFERENCE_UNCONFIRMED',263:'UNEXPLAINED_AMOUNT_DIFFERENCE',270:'ADVANCE_PAYMENT_DATE',272:'SUPPLIER_ALIAS_INVOICE_UNCONFIRMED',273:'HISTORICAL_PAYABLE_PERIOD',287:'SUPPLIER_ALIAS_INVOICE_UNCONFIRMED',317:'SUPPLIER_ALIAS_INVOICE_UNCONFIRMED',332:'HISTORICAL_PAYABLE_PERIOD',352:'SUPPLIER_ALIAS_SPLIT_PAYMENT',372:'HISTORICAL_PAYABLE_PERIOD',398:'SUPPLIER_AND_AMOUNT_WEAK',
};
export const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export const paid=r=>formatVndMilli(r.effects.reduce((s,e)=>s+(parseVndMilli(e.amount)<0n?-parseVndMilli(e.amount):0n),0n));
export function reconstruct(source){
 if(source.length!==395||new Set(source.map(r=>r.row)).size!==395||new Set(source.map(r=>r.key)).size!==395)throw Error('SOURCE_SCOPE');
 const remaining=source.filter(r=>!APPLIED.includes(r.row)&&r.row!==395);
 if(remaining.length!==345)throw Error('REMAINING_SCOPE');
 const owners=new Map();for(const r of remaining)for(const id of [...(ASSIGNED[r.row]||[]),...(CORRECTIONS[r.row]||[])]){const a=owners.get(id)||[];a.push(r.row);owners.set(id,a);}
 return remaining.map(r=>{
  const ids=ASSIGNED[r.row]||[],corrections=CORRECTIONS[r.row]||[],excluded=EXCLUDED[r.row]||[];
  // Guard this reviewed transcription against notes silently changing.
  const note=r.mappingNotes.replaceAll('\\','');
  for(const id of [...ids,...corrections,...excluded])if(!new RegExp(`#${id}(?![0-9])`).test(note)&&!([...note.matchAll(/#(\d{4,})~#?(\d{4,})/g)].some(m=>id>=Number(m[1])&&id<=Number(m[2]))))throw Error(`ID_NOT_IN_EXISTING_NOTE:${r.row}:${id}`);
  const duplicates=[...ids,...corrections].filter(id=>owners.get(id).length!==1);
  const blockers=[...(WEAK.includes(r.row)?['OWNER_WEAK_SIX']:[]),...(additional[r.row]?[additional[r.row]]:[]),...(duplicates.length?['CROSS_ROW_SOURCE_DUPLICATE']:[])];
  const evidenceClass=ids.length?(blockers.length?'B':'A'):'C';
  return {...r,inventoryIds:ids,correctionIds:corrections,excludedIds:excluded,duplicateIds:duplicates,
   evidenceClass,blockers:ids.length?blockers:[(['card_deposit','pos_card'].includes(r.group)?'CARD_CARRYOVER_BLOCKED':r.sourceType==='매출 / 정산'?'POS_COMPONENT_GROUPING_REQUIRED':['inventory_combined','manual_candidate'].includes(r.group)?'NO_CONFIRMED_INVENTORY_ASSIGNMENT':'SEPARATE_ECONOMIC_TYPE_REVIEW')],
   state:ids.length?'needs_link':'hold',paid:paid(r),executable:false};
 });
}
export function summary(rows){
 const group=key=>Object.fromEntries([...new Set(rows.map(r=>r[key]))].sort().map(k=>{const a=rows.filter(r=>r[key]===k);return[k,{rows:a.length,paid:formatVndMilli(a.reduce((s,r)=>s+parseVndMilli(r.paid),0n))}]}));
 const a=rows.filter(r=>r.evidenceClass==='A');
 return {remaining:rows.length,byEvidence:group('evidenceClass'),byState:group('state'),
  historical80:{referenceRows:80,referencePaid:'67777342',reconstructedRows:a.length,reconstructedPaid:formatVndMilli(a.reduce((s,r)=>s+parseVndMilli(r.paid),0n)),
   rowDifference:a.length-80,amountDifference:formatVndMilli(a.reduce((s,r)=>s+parseVndMilli(r.paid),0n)-67777342000n),
   identityComparison:'Historical 73-row membership unavailable; exact missing/added identities cannot be asserted. Current full A list and excluded reasons supplied.'},
  additionalFruit:rows.filter(r=>FRUIT.includes(r.row)).map(r=>({row:r.row,ids:r.inventoryIds,paid:r.paid,evidenceClass:r.evidenceClass})),
  weakSix:rows.filter(r=>WEAK.includes(r.row)).map(r=>({row:r.row,paid:r.paid,state:r.state,blockers:r.blockers})),
  cardCarryoverBlocked:'-6102347',productionWrites:0};
}
export const csv=(headers,rows)=>'\uFEFF'+[headers,...rows.map(r=>headers.map(h=>r[h]??''))].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
export function reviewRuntime(rows,capture){
 if(capture.status!=='CAPTURED'||capture.readOnly!==true||capture.requests.some(r=>r.method!=='GET'||r.http!==200&&r.http!==206))throw Error('INCOMPLETE_READONLY_EVIDENCE');
 const t=capture.tables,logs=new Map(t.inventoryLogs.map(l=>[l.id,l]));
 const allTx=[...new Map(['julyTransactions','directTransactions','resolvedTransactions','payableTransactions'].flatMap(k=>t[k]).map(x=>[x.id,x])).values()];
 const norm=x=>(x||'').trim().toLowerCase();
 return rows.map(row=>{
  const r={...row,blockers:[...row.blockers],runtimeChecks:[],logDetails:[]};
  if(!r.inventoryIds.length)return r;
  const sourceLogs=[...r.inventoryIds,...r.correctionIds].map(id=>logs.get(id));
  if(sourceLogs.some(l=>!l)){r.blockers.push('SOURCE_LOG_MISSING');r.state='hold';return r;}
  r.logDetails=sourceLogs.map(l=>({id:l.id,itemId:l.item_id,item:l.item_name||l.item_name_vi,quantity:l.change_quantity,price:l.new_purchase_price,supplier:l.new_supplier,date:l.business_date,reason:l.reason}));
  r.calculatedAmount=formatVndMilli(sourceLogs.reduce((s,l)=>s+parseVndMilli(String(Math.round(Number(l.change_quantity)*Number(l.new_purchase_price)*1000)/1000)),0n));
  r.sheetMinusCalculated=formatVndMilli(parseVndMilli(r.paid)-parseVndMilli(r.calculatedAmount));
  if(r.inventoryIds.some(id=>logs.get(id).reason!=='purchase'||Number(logs.get(id).change_quantity)<=0))r.blockers.push('NOT_POSITIVE_PURCHASE');
  if(r.inventoryIds.some(id=>logs.get(id).correction_of_inventory_log_id!==null))r.blockers.push('SOURCE_IS_LINKED_CORRECTION');
  if(sourceLogs.some(l=>l.business_date!==r.date))r.blockers.push('PAYMENT_RECEIPT_DATE_DIFFERENCE');
  if(sourceLogs.some(l=>l.billed_amount!==null||l.purchase_supplier_partner_id!==null))r.blockers.push('BILL_OR_SUPPLIER_METADATA_CHANGED');
  const keys=r.inventoryIds.map(id=>'inventory-log:'+id);
  if(t.candidates.some(c=>keys.includes(c.source_key)))r.blockers.push('EXISTING_CANDIDATE');
  if(allTx.some(x=>r.inventoryIds.includes(Number(x.source_snapshot?.inventory_log_id))))r.blockers.push('EXISTING_SOURCE_TRANSACTION');
  if(t.projection.some(p=>r.inventoryIds.includes(p.inventory_log_id)))r.blockers.push('EXISTING_PROJECTION_REVIEW');
  if(t.julyAudits.some(a=>a.reason===r.key)||allTx.some(x=>x.source_key===r.key||x.source_key==='july-restore:'+r.key))r.blockers.push('EXISTING_ROW_KEY');
  if(t.julyTransactions.some(x=>x.status==='confirmed'&&x.business_date===r.date&&parseVndMilli(String(x.amount))===parseVndMilli(r.paid)&&
    t.movements.some(m=>m.transaction_id===x.id&&r.effects.some(e=>t.accounts.find(a=>a.id===m.fund_account_id)?.code===e.account&&parseVndMilli(String(m.amount))===parseVndMilli(e.amount)))))r.blockers.push('POSSIBLE_EXISTING_SAME_DATE_PAYMENT');
  const suppliers=[...new Set(sourceLogs.map(l=>norm(l.new_supplier)))];
  const partyIds=[...new Set(suppliers.flatMap(s=>t.supplierMappings.filter(m=>m.is_active&&norm(m.supplier_name)===s).map(m=>m.party_id)))];
  r.partyIds=partyIds;
  if(partyIds.length!==1||!t.parties.some(p=>p.id===partyIds[0]&&p.is_active))r.blockers.push('PARTY_NOT_UNIQUE');
  const pastPayables=t.payables.filter(p=>partyIds.includes(p.party_id)&&allTx.find(x=>x.id===p.expense_transaction_id)?.business_date<'2026-08-01'&&p.status!=='cancelled');
  r.existingPayableIds=pastPayables.map(p=>p.id);
  if(pastPayables.length)r.blockers.push('HISTORICAL_PAYABLE_REQUIRES_ALLOCATION_REVIEW');
  // First safe batch uses the existing one-log immediate resolver, with no pricing
  // allocation or artificial adjustment of a multi-log invoice.
  if(r.inventoryIds.length!==1||r.correctionIds.length)r.blockers.push('MULTI_LOG_INVOICE_BATCH_REQUIRED');
  if(r.effects.length!==1||r.effects.some(e=>parseVndMilli(e.amount)>=0n||e.account==='card_clearing'))r.blockers.push('SPLIT_ACCOUNT_BATCH_REQUIRED');
  if(r.sheetMinusCalculated!=='0')r.blockers.push('SHEET_PRICE_OVERRIDE_REVIEW');
  if(r.group==='manual_candidate')r.blockers.push('EXPENSE_ASSET_CLASSIFICATION_REQUIRED');
  const categories=[...new Set(sourceLogs.flatMap(l=>t.categoryMappings.filter(m=>m.is_active&&norm(m.inventory_category)===norm(l.category)).map(m=>m.ledger_category_id)))];
  r.categoryIds=categories;
  if(categories.length!==1||!t.categories.some(c=>c.id===categories[0]&&c.kind==='expense'&&c.is_active))r.blockers.push('CATEGORY_NOT_UNIQUE');
  if(sourceLogs.some(l=>!t.inventoryItems.some(i=>i.id===l.item_id)))r.blockers.push('INVENTORY_ITEM_MISSING');
  if(r.effects.some(e=>!t.accounts.some(a=>a.code===e.account&&a.is_active&&a.is_business_fund&&a.type!=='card_clearing')))r.blockers.push('INVALID_ACCOUNT');
  if(r.blockers.length===0&&r.evidenceClass==='A'){
   r.state='ready';r.runtimeChecks=['SOURCE_PRESENT','SOURCE_UNIQUE','SHEET_AMOUNT_EXACT','SAME_DATE','NO_ROW_OR_SOURCE_LEDGER','NO_HISTORICAL_PAYABLE','CATEGORY_PARTY_ACCOUNT_VALID'];
  }else r.state='needs_link';
  // Even ready means a reviewed local proposal, never authorization to execute.
  r.executable=false;return r;
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../../.local/july-restore/',import.meta.url)),out=resolve(process.argv[2]||'');
 const rel=relative(root,out);if(!rel||rel.startsWith('..')||isAbsolute(rel)||existsSync(out))throw Error('NEW_LOCAL_OUTPUT_REQUIRED');
 const rows=reconstruct(JSON.parse(readFileSync(join(root,'dry-run-20261107-v2/395-row-dry-run.json'),'utf8')));
 mkdirSync(out,{recursive:true});writeFileSync(join(out,'reconstructed-345.json'),JSON.stringify(rows,null,2));
 writeFileSync(join(out,'mapping.csv'),csv(['row','key','date','paid','effects','inventoryIds','correctionIds','excludedIds','evidenceClass','blockers','mappingNotes'],rows.map(r=>({...r,effects:JSON.stringify(r.effects),inventoryIds:r.inventoryIds.join(';'),correctionIds:r.correctionIds.join(';'),excludedIds:r.excludedIds.join(';'),blockers:r.blockers.join(';')}))));
 writeFileSync(join(out,'summary.json'),JSON.stringify(summary(rows),null,2));console.log(JSON.stringify(summary(rows)));
}
