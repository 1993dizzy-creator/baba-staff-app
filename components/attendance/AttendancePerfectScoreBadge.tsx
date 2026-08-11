"use client";
export default function AttendancePerfectScoreBadge({show,vi=false}:{show:boolean;vi?:boolean}){if(!show)return null;return <span role="img" aria-label={vi?"Chấm công hoàn hảo đến hiện tại":"현재까지 완벽 근태"} title={vi?"Chấm công hoàn hảo đến hiện tại":"현재까지 완벽 근태"} style={{display:"inline-flex",marginLeft:4,lineHeight:1}}>💯</span>}
