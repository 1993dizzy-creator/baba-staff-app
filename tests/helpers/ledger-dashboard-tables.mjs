// Synthetic local records, including the closed revision-3/current-month shapes.
export function dashboardTables(extraSales=0) {
 const tables={ledger_transactions:[],ledger_movements:[],ledger_fund_accounts:[
  {id:1,code:'store_cash',type:'cash',display_name:'QA Cash',is_active:true,is_business_fund:true,sort_order:1},
  {id:2,code:'bank',type:'bank',display_name:'QA Bank',is_active:true,is_business_fund:true,sort_order:2},
  {id:3,code:'card_clearing',type:'card_clearing',display_name:'QA Card',is_active:true,is_business_fund:false,sort_order:3}],
 ledger_categories:[{id:1,name:'Income',kind:'income',parent_id:null,is_active:true},{id:2,name:'Interest',kind:'income',parent_id:1,is_active:true},{id:3,name:'Purchases',kind:'expense',parent_id:null,is_active:true},{id:4,name:'Ingredients',kind:'expense',parent_id:3,is_active:true},{id:5,name:'Payroll',kind:'expense',parent_id:null,is_active:true}],
 ledger_parties:[{id:8,name:'QA Partner',type:'supplier',is_active:true}],
 business_partners:[{id:8,name:'QA Partner',partner_type:'supplier',partner_subtype_id:1,payment_mode:'payable',default_fund_account_id:2,is_active:true}],
 business_partner_subtypes:[{id:1,code:'ingredients',emoji:'QA'}],business_partner_ledger_parties:[{business_partner_id:8,ledger_party_id:8}],
 ledger_month_closures:['08','09'].map(m=>({id:Number(m),month:`2026-${m}-01`,status:'closed',revision:3,summary_snapshot:{funds:{accounts:[{id:1,code:'store_cash',balance:100000+Number(m)*1000},{id:2,code:'bank',balance:200000+Number(m)*1000}]},reserve:{plans:[]}}})),
 ledger_candidates:[],ledger_payable_allocations:[],ledger_payables:[],ledger_recurring_expense_plans:[{id:1,category_id:4}],
 ledger_card_reconciliations:[],ledger_card_reconciliation_lines:[],ledger_card_fee_allocation_lines:[],ledger_card_fee_closures:[],
 ledger_reserve_plans:[{id:1,name:'QA reserve',is_active:true,fund_account_id:1,linked_recurring_plan:null}],ledger_reserve_entries:[]};
 let id=1,mid=1;
 function add(month,type,amount,account=1,movement=0,extra={}){
  const row={id:id++,type,amount,economic_effect_sign:1,status:'confirmed',business_date:month+'-10',recognition_month:month+'-01',occurred_at:month+'-10T12:00:00+07:00',source_type:'manual',source_key:'qa:'+id,source_snapshot:{evidence:'x'.repeat(512)},memo:'QA detail '+id,category_id:type==='income'?2:4,category:{id:type==='income'?2:4,name:'QA'},party_id:8,movements:movement?[{amount:movement,fund_account:{id:account,code:account===1?'store_cash':'bank',display_name:'QA'}}]:[],payable:null,...extra};
  tables.ledger_transactions.push(row);for(const m of row.movements)tables.ledger_movements.push({id:mid++,fund_account_id:m.fund_account.id,amount:m.amount,transaction:{status:row.status,type:row.type,business_date:row.business_date,occurred_at:row.occurred_at,source_type:row.source_type}});return row;
 }
 for(const month of ['2026-07','2026-08','2026-09','2026-10']){
  add(month,'opening',100000,1,100000,{business_date:month+'-01',recognition_month:null,source_type:'opening'});
  add(month,'sales',70000,1,70000);const card=add(month,'sales',30000,3,30000,{source_type:'pos_sales_daily_payment',source_key:`pos:${month}:card`});
  add(month,'income',500,1,500);add(month,'income',250,2,250);
  add(month,'expense',1000,1,-1000);
  const root=add(month,'expense_recognition',5000,1,0,{payable:{id:id+5000,original_amount:5000,status:'partially_paid',allocations:[{allocated_amount:2000,payment:{id:id+1,type:'payable_payment',source_type:'manual',business_date:month+'-10',status:'confirmed',amount:2000,economic_effect_sign:1,movements:[{amount:-2000}]}}]}});
  const paid=add(month,'payable_payment',2000,1,-2000,{recognition_month:null});
  tables.ledger_payables.push({id:root.id+5000,expense_transaction_id:root.id});tables.ledger_payable_allocations.push({id:paid.id,payment_transaction_id:paid.id,payable_id:root.id+5000,allocated_amount:2000});
  const old=add(month,'payroll_payment',10000,2,-10000,{recognition_month:null,source_type:'payroll_payment_group',source_snapshot:{groupKey:month,fundAccountId:2}});
  add(month,'payroll_payment',10000,2,10000,{recognition_month:null,source_type:'payroll_payment_group_reversal',correction_of_id:old.id,economic_effect_sign:-1,source_snapshot:{groupKey:month,originalTransactionId:old.id}});
  add(month,'payroll_payment',15000,2,-15000,{recognition_month:null,source_type:'payroll_payment_group',source_snapshot:{groupKey:month,fundAccountId:2}});
  add(month,'prepaid_expense_payment',3000,1,-3000,{recognition_month:null,source_snapshot:{planId:1}});
  add(month,'investment',4000,1,4000,{recognition_month:null,source_type:'owner_investment'});
  add(month,'expense',100,1,0,{economic_effect_sign:-1,source_type:'ledger_correction',correction_of_id:root.id,source_snapshot:{adjustmentType:'technical'}});
  add(month,'expense',200,1,-200,{source_type:'ledger_correction',source_snapshot:{economicDelta:200,movementAdjustments:[]}});
  const reconciliation={id:card.id,status:'partial',deposit_date:month+'-15',deposit_amount:9000,matched_gross_amount:10000,difference_amount:1000};
  tables.ledger_card_reconciliations.push(reconciliation);tables.ledger_card_reconciliation_lines.push({id:card.id,reconciliation_id:card.id,pos_card_transaction_id:card.id,allocated_gross_amount:10000,reconciliation,sale:{...card}});
  add(month,'card_settlement_deposit',9000,2,9000,{recognition_month:null});
  tables.ledger_reserve_entries.push({id:card.id,reserve_plan_id:1,entry_type:'allocate',amount:100,occurred_at:month+'-10T12:00:00+07:00'});
  tables.ledger_candidates.push({id:card.id,business_date:month+'-10',candidate_type:'inventory_purchase',status:'pending',proposed_amount:100,source_snapshot:{itemName:'QA candidate'}});
  for(let i=0;i<extraSales;i++)add(month,'sales',10,1,10);
 }
 add('2026-10','expense_recognition',176185794,1,0,{recognition_month:'2026-09-01',source_type:'payroll_completed_batch',category_id:5,category:{id:5}});
 add('2026-08','balance_adjustment',0,1,0,{source_key:'legacy_sheet_expense_reconciliation:2026-08',source_snapshot:{sheetCashOutflow:66666}});
 // A meal's correction in a later month must not affect the original month's cash.
 const meal=add('2026-08','expense',100,1,0,{source_type:'attendance_meal_daily_candidate'});
 add('2026-10','expense',200,1,0,{source_type:'ledger_correction',correction_of_id:meal.id,source_snapshot:{adjustmentType:'employee_meal',economicDelta:200,movementAdjustments:[]}});
 return tables;
}
