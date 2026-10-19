import{dashboardTables}from'./ledger-dashboard-tables.mjs';
// Local data only. Keep all entry details and payable allocations in the fixture.
export function entriesTables(extraSales=0){
 const tables=dashboardTables(extraSales);
 for(const row of tables.ledger_payables){const expense=tables.ledger_transactions.find(t=>t.id===row.expense_transaction_id);Object.assign(row,{party_id:8,original_amount:expense.amount,due_date:expense.business_date,status:'partially_paid',created_at:expense.occurred_at,party:{name:'QA Partner'},expense});}
 for(const row of tables.ledger_payable_allocations)row.payment=tables.ledger_transactions.find(t=>t.id===row.payment_transaction_id);
 tables.ledger_owner_participants=[{id:1,user_id:1,is_eligible:true,effective_from:'2026-08-01',effective_to:null,sort_order:1}];
 tables.ledger_owner_investments=['08','09','10'].map(m=>({id:Number(m),participant_id:1,entry_type:'contribution',signed_amount:1000,occurred_at:`2026-${m}-10T12:00:00+07:00`,reason:'QA investment',source_snapshot:{fundAccountId:1}}));tables.users=[{id:1,name:'QA owner'}];
 return tables;
}
