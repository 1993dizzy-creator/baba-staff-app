// Synthetic, anonymized history matching the user-supplied aggregate totals.
// This is not an export or re-verification of Production rows.
export function payment(id, amount, account = 1, date = '2026-10-10', key = `group:${account}:${date}`) {
  return {id,type:'payroll_payment',status:'confirmed',source_type:'payroll_payment_group',
    business_date:date,amount,economic_effect_sign:1,
    source_snapshot:{groupKey:key,fundAccountId:account},
    movements:[{amount:-amount,fund_account:{id:account,display_name:`QA account ${account}`}}]};
}
export function reversal(original, id) {
  return {...structuredClone(original),id,source_type:'payroll_payment_group_reversal',correction_of_id:original.id,
    economic_effect_sign:-1,source_snapshot:{groupKey:original.source_snapshot.groupKey,originalTransactionId:original.id},
    movements:original.movements.map(m=>({...m,amount:-m.amount}))};
}
export function octoberHistory() {
  const rows=[];
  for(let i=0;i<15;i++) {
    const old=payment(100+i,i===14?9305227:91000000,3);
    rows.push(old,reversal(old,200+i));
  }
  rows.push(payment(301,7300000,1),payment(302,3000000,2),payment(303,141148409,3));
  rows.push({id:401,type:'expense',status:'confirmed',business_date:'2026-10-10',source_type:'manual',economic_effect_sign:1,amount:7205900,movements:[{amount:-7205900,fund_account:{id:1}}]});
  rows.push({id:402,type:'income',status:'confirmed',business_date:'2026-10-10',source_type:'manual',economic_effect_sign:1,amount:41530800,movements:[{amount:41530800,fund_account:{id:1}}]});
  rows.push({id:403,type:'expense_recognition',status:'confirmed',business_date:'2026-10-10',recognition_month:'2026-09-01',source_type:'payroll_completed_batch',economic_effect_sign:1,amount:176185794,movements:[]});
  return rows;
}

