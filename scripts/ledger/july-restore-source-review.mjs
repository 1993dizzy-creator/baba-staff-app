// Offline adapter for the owner's November 7 export. No DB/HTTP/env loading.
// node --experimental-strip-types scripts/ledger/july-restore-source-review.mjs <inputs-dir> <new-results-dir>
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {JULY_SHEET,JULY_TAB,OPENING,CLOSING,FUNDS,CLASS_COUNTS,rowKey} from '../../lib/ledger/july-restore-plan.ts';

export function parseCsv(text) {
  const records=[];let row=[],cell='',quoted=false;
  const input=text.replace(/^\uFEFF/,'');
  for(let i=0;i<input.length;i++) {
    const ch=input[i];
    if(ch==='"') {if(quoted&&input[i+1]==='"'){cell+='"';i++;}else if(quoted||cell==='')quoted=!quoted;else throw Error('CSV_UNEXPECTED_QUOTE');}
    else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&input[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x!==''))records.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(quoted)throw Error('CSV_UNCLOSED_QUOTE');
  if(cell!==''||row.length){row.push(cell);records.push(row);}
  const [headers,...data]=records;if(!headers||new Set(headers).size!==headers.length)throw Error('CSV_HEADERS');
  return data.map(r=>{if(r.length!==headers.length)throw Error('CSV_WIDTH');return Object.fromEntries(headers.map((h,i)=>[h,r[i]]));});
}
const whole=value=>{if(!/^-?(0|[1-9]\d*)$/.test(value||'0'))throw Error('NONINTEGER_SOURCE_VND');return BigInt(value||'0');};
const normalized=value=>value.replace(/\\([_:~])/g,'$1').replace(/<[^>]+>/g,'').trim();
const columns={store_cash:'cash_vnd',vuong_personal_custody:'vuong_vnd',cho_personal_custody:'cho_vnd',card_clearing:'card_vnd',baba_corporate_bank:'corporate_vnd'};
const csv=(headers,rows)=>'\uFEFF'+[headers,...rows.map(r=>headers.map(h=>r[h]??''))].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
const sha=body=>createHash('sha256').update(body).digest('hex');

export function reviewJulySources(inputDir) {
  const names=['README_Codex.txt','july_2026_395_transactions.csv','july_2026_395_mapping_full.md','july_2026_daily_targets.csv'];
  const files=Object.fromEntries(names.map(n=>[n,readFileSync(join(inputDir,n),'utf8')]));
  const rows=parseCsv(files[names[1]]),targets=parseCsv(files[names[3]]);
  if(rows.length!==395||targets.length!==31)throw Error('SOURCE_ROW_COUNT');
  const map=new Map();
  for(const line of files[names[2]].split(/\r?\n/)) {
    if(!/^\| \d+ \| \d+\/\d+ \|/.test(line))continue;
    const cells=line.split('|').slice(1,-1).map(v=>v.trim());
    if(cells.length!==6||map.has(Number(cells[0])))throw Error('MARKDOWN_DUPLICATE_OR_WIDTH');map.set(Number(cells[0]),cells);
  }
  if(map.size!==395)throw Error('MAPPING_395_REQUIRED');
  const seen=new Set();const result=[];
  for(const r of rows) {
    const number=Number(r.sheet_row),m=map.get(number);
    if(!Number.isSafeInteger(number)||number<4||number>406||seen.has(number)||!m)throw Error('SOURCE_ROW_IDENTITY');seen.add(number);
    const expectedDate='2026-'+m[1].split('/').map(v=>v.padStart(2,'0')).join('-');
    if(r.business_date!==expectedDate||normalized(r.mapping_type)!==normalized(m[2])||normalized(r.mapping_memo)!==normalized(m[3])||normalized(r.mapping_account_amount)!==normalized(m[4])||normalized(r.mapping_notes)!==normalized(m[5]))throw Error(`MAPPING_SOURCE_MISMATCH:${number}`);
    const effects=Object.entries(columns).map(([account,col])=>({account,amount:String(whole(r[col]))})).filter(e=>e.amount!=='0');
    if(!effects.length)throw Error('NONZERO_ROW_REQUIRED');
    let group,status,reason,batch;
    const risks=[];const type=r.mapping_type,note=r.mapping_notes;
    const isSummary=type==='매출 / 정산'&&(/이체 일합계|이체 분할/.test(note)||number===114);
    if(type==='매출 / 결제확인') {group='card_deposit';status='needs_link';reason='원정산·전월 이월 연결 및 기존 69건 배분 보호';batch='B2_CARD';risks.push('NOT_NEW_REVENUE','NO_FIFO_REALLOCATION');}
    else if(type==='경비 / 식비') {group='meal';status='registration_candidate';reason='시트 식대·현금액 확정; 실행 시 기존 식대 중복 및 category/계정 재확인';batch='B1_EXPENSE';}
    else if(type==='매출 / 카드결제') {
      group='pos_card';batch='B2_POS';
      if(number===395){status='link_existing';reason='기존 POS 카드 #1190 보존·원본행 연결만';risks.push('DO_NOT_RECREATE_1190');}
      else if([154,344].includes(number)){status='hold';reason='기존 매핑의 카드 차이 미확정·조정 금지';risks.push('KNOWN_POS_DIFFERENCE');}
      else{status='registration_candidate';reason='기존 POS 카드 일합계 일치 매핑 재사용; 실행 시 원거래 키·현재 전표 재확인';}
    } else if(type==='매출 / 정산') {
      group=isSummary?'pos_daily_split':'other';batch='B2_POS';status=number===114?'hold':'needs_link';
      reason=number===114?'기존 7/9 은행 POS 차이 809000 미확정':'일합계/개별수금 그룹 연결 후 수입 1회만 인식';risks.push('POS_AGGREGATE_DETAIL_OVERLAP');
      if(number===114)risks.push('KNOWN_POS_DIFFERENCE');
    } else if(type==='경비 / 공금'&&number===5 || /^(급여|투자금|자금이동|법인) \/ /.test(type)) {
      group='other';batch='B3_SPECIAL';status='hold';reason='특수거래·귀속 분리 및 증빙/기존 계약 연결 필요';
      if(type==='자금이동 / 정산'){status='registration_candidate';reason='기존 매핑에서 비매출·비비용 자금이동 확인; 양방향 계정/동액 실행검사';risks.push('ZERO_PROFIT_TRANSFER');}
      if([306,368].includes(number)){status='registration_candidate';reason='VAT 세액과 구분된 은행/송금수수료; 기존 category #29 실행검사';batch='B1_EXPENSE';}
      if(number===33){risks.push('EXISTING_RENT_PAYMENT_HISTORY','NOT_JULY_RENT_EXPENSE');}
      if([123,144,252,289].includes(number))risks.push('PAYROLL_OR_ADVANCE_NOT_NEW_EXPENSE');
      if([184,267].includes(number))risks.push('INVESTMENT_NOT_REVENUE_OR_EXPENSE');
      if(number===367)risks.push('VAT_LIABILITY_NOT_AUTOMATIC_EXPENSE');
    } else if(/^(식자재|주류|음료) \/ /.test(type)) {
      group='inventory_combined';batch='B1_INVENTORY';status='needs_confirmation';reason='기존 입고 연결/실지급·후불을 1회만 인식; 후보 상태와 청구·배분 미확정 조건 유지';risks.push('INVENTORY_PAYMENT_DOUBLE_COST');
    } else {
      group='manual_candidate';batch='B1_EXPENSE';status=note==='비입고 수기비용 후보'||type==='매출 / 예금이자'?'registration_candidate':'needs_confirmation';
      reason=status==='registration_candidate'?'기존 비입고/은행이자 매핑 재사용; 경제분류·category·기등록 조회 후 편입':'기존 메모의 품목/입고/청구·경제 귀속 확인조건 유지';
      if(/입고|#\d{4,}/.test(note))risks.push('SOURCE_REFERENCE_CONTEXT_REQUIRED');
    }
    result.push({key:rowKey({sheetId:JULY_SHEET,tabId:JULY_TAB,row:number}),row:number,date:r.business_date,group,status,batch,reason,
      sourceType:type,description:r.description,effects,risks,mappingNotes:note,
      // Tokens retain context in the unchanged mapping note. A #number can be a
      // sheet row, user, ledger transaction, candidate or inventory log; never
      // treat this list as verified inventory IDs or execute it automatically.
      referenceTokens:[...new Set(note.match(/#\d+(?:\\?~\d+)?/g)||[])],
      executable:false,missingRuntimeEvidence:['current ledger/source snapshots','category/account/actor IDs','separate owner DB approval']});
  }
  const targetMap=new Map(targets.map(t=>[t.business_date,t]));
  if(targetMap.size!==31)throw Error('DUPLICATE_TARGET_DATE');
  const balances=Object.fromEntries(FUNDS.map(f=>[f,BigInt(OPENING[f])]));const daily=[];
  const totals=Object.fromEntries(Object.keys(columns).map(f=>[f,0n]));
  for(let d=1;d<=31;d++) {
    const date=`2026-07-${String(d).padStart(2,'0')}`,t=targetMap.get(date),day=result.filter(r=>r.date===date);
    if(!t||day.length!==Number(t.sheet_row_count))throw Error('DAILY_ROW_COUNT');
    for(const [account,col]of Object.entries(columns)) {
      const delta=day.flatMap(r=>r.effects).filter(e=>e.account===account).reduce((s,e)=>s+BigInt(e.amount),0n);totals[account]+=delta;
      const expectedDelta=whole(t[col.replace('_vnd','_delta_vnd')]);
      if(FUNDS.includes(account))balances[account]+=delta;
      const closing=FUNDS.includes(account)?balances[account]:null;
      const expectedClosing=closing===null?null:whole(t[col.replace('_vnd','_closing_vnd')]);
      daily.push({date,account,delta:String(delta),targetDelta:String(expectedDelta),deltaDifference:String(delta-expectedDelta),closing:closing===null?null:String(closing),targetClosing:expectedClosing===null?null:String(expectedClosing),closingDifference:closing===null?null:String(closing-expectedClosing),matches:delta===expectedDelta&&(closing===null||closing===expectedClosing)});
    }
    if(FUNDS.reduce((s,f)=>s+balances[f],0n)!==whole(t.business_fund_closing_vnd))throw Error('DAILY_FUND_TOTAL');
  }
  if(!daily.every(x=>x.matches)||!FUNDS.every(f=>String(balances[f])===CLOSING[f]))throw Error('SOURCE_TARGET_CONTROL');
  if(String(totals.card_clearing)!=='223562820')throw Error('CARD_CONTROL');
  const byGroup={};const byStatus={};const batches={};const candidateDeltas=Object.fromEntries(FUNDS.map(f=>[f,0n]));
  for(const r of result) {
    byStatus[r.status]=(byStatus[r.status]||0)+1;
    const g=byGroup[r.group]??={rows:0,statuses:{}};g.rows++;g.statuses[r.status]=(g.statuses[r.status]||0)+1;
    const b=batches[r.batch]??={rows:0,statuses:{},deltas:Object.fromEntries(FUNDS.map(f=>[f,0n]))};b.rows++;b.statuses[r.status]=(b.statuses[r.status]||0)+1;
    for(const e of r.effects)if(FUNDS.includes(e.account))b.deltas[e.account]+=BigInt(e.amount);
    if(r.status==='registration_candidate')for(const e of r.effects)if(FUNDS.includes(e.account))candidateDeltas[e.account]+=BigInt(e.amount);
  }
  const expectedGroups={card_deposit:23,manual_candidate:54,inventory_combined:116,meal:31,pos_daily_split:32,pos_card:31,other:108};
  if(Object.entries(expectedGroups).some(([k,n])=>byGroup[k]?.rows!==n))throw Error('EXPORTED_GROUP_COUNT');
  const meals=result.filter(r=>r.group==='meal').flatMap(r=>r.effects).reduce((s,e)=>s+BigInt(e.amount),0n);
  const deposits=result.filter(r=>r.group==='card_deposit').flatMap(r=>r.effects).filter(e=>e.account==='baba_corporate_bank').reduce((s,e)=>s+BigInt(e.amount),0n);
  const existingCard=result.filter(r=>r.status==='link_existing').flatMap(r=>r.effects).filter(e=>e.account==='card_clearing').reduce((s,e)=>s+BigInt(e.amount),0n);
  if(existingCard!==3694200n)throw Error('EXISTING_1190_CONTROL');
  if(meals!==-10050000n||deposits!==225970967n)throw Error('MEAL_DEPOSIT_CONTROL');
  const summary={status:'PASS_SOURCE_DRY_RUN',executionStatus:'BLOCKED_PENDING_RUNTIME_EVIDENCE',sourceRows:395,mappingRows:map.size,sourceFiles:Object.fromEntries(names.map(n=>[n,{sha256:sha(files[n])}])),
    historicalClassificationCounts:CLASS_COUNTS,byGroup,byStatus,batches:Object.fromEntries(Object.entries(batches).map(([k,b])=>[k,{...b,deltas:Object.fromEntries(Object.entries(b.deltas).map(([f,v])=>[f,String(v)]))}])),
    controlTotals:{opening:'600859817',businessFundDelta:'-300506175',closing:'300353642',meal:'10050000',cardSales:'223562820',cardDeposits:'225970967',deltas:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,String(v)]))},
    candidateDeltas:Object.fromEntries(Object.entries(candidateDeltas).map(([k,v])=>[k,String(v)])),
    duplicateRiskRows:result.filter(r=>r.risks.some(k=>['NOT_NEW_REVENUE','POS_AGGREGATE_DETAIL_OVERLAP','INVENTORY_PAYMENT_DOUBLE_COST','DO_NOT_RECREATE_1190','EXISTING_RENT_PAYMENT_HISTORY','SOURCE_REFERENCE_CONTEXT_REQUIRED'].includes(k))).length,
    cardCarryover:{existing1190:String(existingCard),newJulyCardSales:String(totals.card_clearing-existingCard),julyDeposits:String(deposits),unresolvedEffectOnCurrentClearing:String(totals.card_clearing-existingCard-deposits),executionGuard:'Reject any change to current card_clearing; no invented carryover/fee/balancing entry'},
    checks:{mappingRowIdentityAndDate:395,dailyAccountDeltaMatches:daily.filter(d=>d.matches).length,dailyBusinessClosingMatches:daily.filter(d=>d.matches&&d.closing!==null).length,executedDbWrites:0},
    limitations:['registration_candidate is not executable approval or live DB verification','The export retains historical inventory counts 17 + 99 but no per-row original subclass field; keep combined 116 without guessing the split','#number references keep original context and are never automatically resolved as inventory IDs','No fake balancing entry, no allocation of POS summaries as independent receipts']};
  return {summary,rows:result,daily};
}

export function saveJulySourceReview(review,outputDir) {
  const rel=relative(fileURLToPath(new URL('../../.local/',import.meta.url)),resolve(outputDir));
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('WORKTREE_LOCAL_OUTPUT_REQUIRED');
  if(existsSync(outputDir))throw Error('OUTPUT_ALREADY_EXISTS');mkdirSync(outputDir,{recursive:true});
  writeFileSync(join(outputDir,'summary.json'),JSON.stringify(review.summary,null,2));
  writeFileSync(join(outputDir,'395-row-dry-run.json'),JSON.stringify(review.rows,null,2));
  const rows=review.rows.map(r=>({source_key:r.key,sheet_row:r.row,business_date:r.date,source_type:r.sourceType,review_group:r.group,processing_status:r.status,batch:r.batch,
    ...Object.fromEntries(Object.keys(columns).map(f=>[f,r.effects.find(e=>e.account===f)?.amount??'0'])),reference_tokens:r.referenceTokens.join(';'),risk_flags:r.risks.join(';'),reason:r.reason,mapping_notes:r.mappingNotes,executable:false}));
  writeFileSync(join(outputDir,'395-row-dry-run.csv'),csv(Object.keys(rows[0]),rows));
  writeFileSync(join(outputDir,'31-day-reconciliation.csv'),csv(Object.keys(review.daily[0]),review.daily));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [, ,input,out]=process.argv;if(!input||!out)throw Error('Usage: <inputs-dir> <new-results-dir>');
  const review=reviewJulySources(resolve(input));saveJulySourceReview(review,resolve(out));console.log(JSON.stringify(review.summary,null,2));
}
