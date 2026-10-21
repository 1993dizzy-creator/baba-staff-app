import assert from 'node:assert/strict';import test from 'node:test';import {randomUUID} from 'node:crypto';
import {workDatabase,work,correct,correction} from './helpers/pos-resolution-work-fixture.mjs';
import {seedPending,review,request} from './helpers/pos-pending-resolution-fixture.mjs';
import {daySource,closeDay} from './helpers/pos-business-day-close-fixture.mjs';
// User-supplied incident facts, not exported production raw files. All
// unspecified unit prices/catalog identities below are synthetic test data.
import {incidents} from './fixtures/pos-resolution-work-cases.mjs';
for(const incident of incidents)test('phase2 incident '+incident.refNo+': explicit correction retains original rows/raw; no automatic dedup or overcount',async()=>{
 const db=await workDatabase();try{
 await seedPending(db,{...incident,amount:incident.original});
 await db.query(`update pos_sales_receipts set raw_json=$1::jsonb where id=10`,[JSON.stringify({PaymentStatus:1,FinalAmount:incident.original,fixture:'synthetic-shape',incidentFacts:incident})]);
 await db.query(`update pos_sales_receipt_lines set source='cukcuk',ref_detail_id='ref-'||id,sort_order=id,amount=unit_price,final_amount=unit_price,discount_amount=0,tax_rate=0,tax_amount=0,is_option=false,is_excluded=false,mapping_status='direct',ref_detail_type=1,raw_json=jsonb_build_object('OrderDetailID','same-order') where receipt_id=10`);
 const original=(await db.query('select raw_json from pos_sales_receipts where id=10')).rows[0].raw_json;
 const body=request(await review(db),{requestId:randomUUID(),amount:incident.actual,payments:[{method:'cash',amount:incident.actual}]});
 assert.equal((await db.query('select sales_resolve_pending_receipt_v2(10,1,$1::jsonb) r',[JSON.stringify(body)])).rows[0].r.status,'resolved');
 let w=await work(db);assert.equal(w.state.receipt.admin_resolution_financial_review_required,Boolean(incident.duplicate||incident.actual!==incident.original));const count=w.state.lines.length;assert.equal(count,incident.duplicate?2:1);
 if(incident.duplicate||incident.actual!==incident.original){assert.equal(w.state.receipt.admin_resolution_financial_review_required,true);await assert.rejects(daySource(db,incident.date),/FINANCIAL_CORRECTION_REQUIRED/);await assert.rejects(db.query('select pos_sales_close_private.build_source($1)',[incident.date]),/FINANCIAL_CORRECTION_REQUIRED/);}
 const line=w.state.lines[0];await correct(db,correction(w,{requestId:randomUUID(),amount:incident.actual,payments:[{method:'cash',amount:incident.actual}],lines:[{id:line.id,quantity:1,unit_price:incident.actual,discount_amount:0,tax_rate:0}]}));
 w=await work(db);assert.equal(w.state.lines.length,count);assert.equal(w.state.lines.filter(l=>!l.is_excluded).length,1);assert.deepEqual(w.state.receipt.raw_json,original);assert.equal(w.state.receipt.admin_resolution_financial_review_required,false);assert.equal(Number((await daySource(db,incident.date)).receiptTotal),incident.actual);
 assert.equal(w.state.receipt.inventory_deduction_processing_paused,true);
 }finally{await db.close()}
});
