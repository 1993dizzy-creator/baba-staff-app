export const INITIAL_INSURANCE_ENROLLMENT_NOTE = "Initial payroll insurance enrollment";

export function formatInsuranceNote(note: string | null, vi: boolean) {
  if (!note) return null;
  return note === INITIAL_INSURANCE_ENROLLMENT_NOTE
    ? vi
      ? "Thiết lập tham gia bảo hiểm ban đầu"
      : "최초 보험 가입 설정"
    : note;
}
