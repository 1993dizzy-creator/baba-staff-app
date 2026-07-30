function ordinal(date:string){const[y,m,d]=date.split("-").map(Number);return Math.floor(Date.UTC(y,m-1,d)/86_400_000)}
export function calendarDayDifference(fromDate:string,toDate:string){return ordinal(toDate)-ordinal(fromDate)}
