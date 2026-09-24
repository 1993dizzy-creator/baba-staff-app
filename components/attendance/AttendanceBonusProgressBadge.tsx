"use client";

import { attendanceBonusProgressIcon } from "@/lib/payroll/attendance-bonus";

export default function AttendanceBonusProgressBadge({
  eligible,
  perfectAttendanceCurrent,
  vi = false,
}: {
  eligible: boolean;
  perfectAttendanceCurrent: boolean;
  vi?: boolean;
}) {
  const status = attendanceBonusProgressIcon(eligible, perfectAttendanceCurrent);
  if (!status) return null;
  const perfect = status === "perfect";
  const label = perfect
    ? vi ? "Đạt điều kiện chuyên cần đến hiện tại" : "현재까지 개근 조건 충족"
    : vi ? "Thuộc đối tượng thưởng chuyên cần" : "개근 보너스 대상";
  return <span role="img" aria-label={label} title={label} style={{display:"inline-flex",marginLeft:4,lineHeight:1}}>{perfect ? "💯" : String.fromCodePoint(0x1F4C5)}</span>;
}
