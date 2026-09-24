"use client";
import { shouldShowAttendancePerfectScoreBadge } from "@/lib/payroll/attendance-bonus";
export default function AttendancePerfectScoreBadge({show,eligible,vi=false}:{show:boolean;eligible:boolean;vi?:boolean}){if(!shouldShowAttendancePerfectScoreBadge(eligible,show))return null;return <span role="img" aria-label={vi?"Chấm công hoàn hảo đến hiện tại":"현재까지 완벽 근태"} title={vi?"Chấm công hoàn hảo đến hiện tại":"현재까지 완벽 근태"} style={{display:"inline-flex",marginLeft:4,lineHeight:1}}>💯</span>}
