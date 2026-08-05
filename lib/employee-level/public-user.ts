export type PublicEmployeeUserRow = {
  id: number | string;
  username: string;
  name: string | null;
  full_name: string | null;
  role: string | null;
  part: string | null;
  position: string | null;
  gender: string | null;
  birth_date: string | null;
  hire_date: string | null;
  termination_date: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
  is_active: boolean | null;
  is_system_account: boolean;
  payroll_eligible_override: boolean | null;
  level_program_enabled: boolean | null;
  level_base_date_override: string | null;
  attendance_tracking_enabled: boolean;
  app_login_enabled: boolean;
};

export function sanitizePublicEmployeeUser(value: unknown): PublicEmployeeUserRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_EMPLOYEE_RPC_RESPONSE");
  }
  const row = value as Record<string, unknown>;

  return {
    id: row.id as PublicEmployeeUserRow["id"],
    username: row.username as PublicEmployeeUserRow["username"],
    name: row.name as PublicEmployeeUserRow["name"],
    full_name: row.full_name as PublicEmployeeUserRow["full_name"],
    role: row.role as PublicEmployeeUserRow["role"],
    part: row.part as PublicEmployeeUserRow["part"],
    position: row.position as PublicEmployeeUserRow["position"],
    gender: row.gender as PublicEmployeeUserRow["gender"],
    birth_date: row.birth_date as PublicEmployeeUserRow["birth_date"],
    hire_date: row.hire_date as PublicEmployeeUserRow["hire_date"],
    termination_date: row.termination_date as PublicEmployeeUserRow["termination_date"],
    work_start_time: row.work_start_time as PublicEmployeeUserRow["work_start_time"],
    work_end_time: row.work_end_time as PublicEmployeeUserRow["work_end_time"],
    is_active: row.is_active as PublicEmployeeUserRow["is_active"],
    is_system_account: row.is_system_account as PublicEmployeeUserRow["is_system_account"],
    payroll_eligible_override: row.payroll_eligible_override as PublicEmployeeUserRow["payroll_eligible_override"],
    level_program_enabled: row.level_program_enabled as PublicEmployeeUserRow["level_program_enabled"],
    level_base_date_override: row.level_base_date_override as PublicEmployeeUserRow["level_base_date_override"],
    attendance_tracking_enabled: (row.attendance_tracking_enabled as boolean | undefined) ?? true,
    app_login_enabled: (row.app_login_enabled as boolean | undefined) ?? true,
  };
}
