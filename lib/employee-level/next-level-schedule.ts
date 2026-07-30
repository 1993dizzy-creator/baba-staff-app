import { EMPLOYEE_LEVEL_MAX, type EmployeeLevelInfo } from "./types";
import { calendarDayDifference } from "./calendar-day";
export type NextLevelSchedule={status:"future";date:string;days:number}|{status:"today";date:string;days:0}|{status:"maximum"}|null;
export function getNextLevelSchedule(info:EmployeeLevelInfo|null|undefined,today:string):NextLevelSchedule{if(!info?.eligible)return null;if(info.level===EMPLOYEE_LEVEL_MAX)return{status:"maximum"};if(!info.nextLevelDate)return null;const days=calendarDayDifference(today,info.nextLevelDate);if(days===0)return{status:"today",date:info.nextLevelDate,days:0};return days>0?{status:"future",date:info.nextLevelDate,days}:null}
