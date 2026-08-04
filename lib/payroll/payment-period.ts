export function vietnamPayrollMonth(now:Date=new Date()){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit"}).format(now).slice(0,7);
}

export function isClosedPayrollMonth(month:string,now:Date=new Date()){
  return /^\d{4}-\d{2}$/.test(month)&&month<vietnamPayrollMonth(now);
}
