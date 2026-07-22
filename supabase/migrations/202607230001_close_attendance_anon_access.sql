drop policy if exists "allow attendance records read"
on public.attendance_records;

drop policy if exists "allow attendance records select"
on public.attendance_records;

drop policy if exists "allow anon select attendance check logs"
on public.attendance_check_logs;

revoke all privileges
on table public.attendance_records
from anon, authenticated;

revoke all privileges
on table public.attendance_check_logs
from anon, authenticated;

revoke all privileges
on sequence public.attendance_records_id_seq
from anon, authenticated;

revoke all privileges
on sequence public.attendance_check_logs_id_seq
from anon, authenticated;
