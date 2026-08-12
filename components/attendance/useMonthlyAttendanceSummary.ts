"use client";
import {useEffect,useMemo,useState} from "react";
export type PublicMonthlyAttendanceSummary={userId:number;actualWorkDays:number;lateCount:number;earlyLeaveCount:number;unauthorizedAbsenceCount:number;blockingCount:number;perfectAttendanceCurrent:boolean};
const cache=new Map<string,Promise<PublicMonthlyAttendanceSummary[]>>();
export function currentVietnamMonth(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit"}).format(new Date()).slice(0,7)}
export function useMonthlyAttendanceSummary(month:string){const[rows,setRows]=useState<PublicMonthlyAttendanceSummary[]>([]);useEffect(()=>{let active=true;let request=cache.get(month);if(!request){request=fetch(`/api/attendance/monthly-summary?month=${month}`,{cache:"no-store"}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.code);return d.summaries??[]});cache.set(month,request);request.catch(()=>cache.delete(month))}void request.then(data=>{if(active)setRows(data)}).catch(()=>undefined);return()=>{active=false}},[month]);return useMemo(()=>new Map(rows.map(row=>[row.userId,row])),[rows])}
