export function isMissingAttendanceCandidateDate(input: {
  date: string;
  hireDate: string | null;
  terminationDate: string | null;
  calculationEndDate: string | null;
  hasActiveSchedule: boolean;
  hasAttendanceRecord: boolean;
}) {
  return Boolean(
    input.calculationEndDate && input.date <= input.calculationEndDate &&
    (!input.hireDate || input.date >= input.hireDate) &&
    (!input.terminationDate || input.date <= input.terminationDate) &&
    input.hasActiveSchedule && !input.hasAttendanceRecord
  );
}
