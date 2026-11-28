// Synthetic staff + roles for the notification foundation tests (no production data or credentials).
import { readFileSync } from 'node:fs';

export const MIGRATION_FILE = 'supabase/migrations/20261126124217_notification_center_foundation.sql';
export const PUSH_MIGRATION_FILE = 'supabase/migrations/20261128073109_notification_web_push_foundation.sql';
export const pushMigration = readFileSync(PUSH_MIGRATION_FILE, 'utf8');
// BABA_NOTIFICATION_WITH_PUSH=1 re-runs the 01-A suites on 01-A + 01-B (old contracts after the push migration).
export const pushMigrationIncluded = process.env.BABA_NOTIFICATION_WITH_PUSH === '1';
export const migration = readFileSync(MIGRATION_FILE, 'utf8') + (pushMigrationIncluded ? '\n' + pushMigration : '');

export const U = {
  owner: 1, master: 2, masterNull: 3, managerHall: 4, leaderBar: 5, leaderKitchen: 6, leaderHall: 7,
  staffBar: 8, staffHall: 9, staffKitchenInactive: 10, staffHallNoLogin: 11, staffNullPart: 12, unknown: 999,
};

export const baseSql = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create table public.users(id bigint primary key, username text not null, name text, full_name text, role text,
  position text, part text, is_active boolean, app_login_enabled boolean);
insert into public.users values
  (1,'u1','Owner A',null,'owner','owner','owner',true,true),
  (2,'u2','Master B',null,'master','owner','owner',true,true),
  (3,'u3','Master C',null,'master',null,null,true,true),
  (4,'u4','Manager Hall',null,'manager','manager','hall',true,true),
  (5,'u5','Leader Bar',null,'leader','leader','bar',true,true),
  (6,'u6','Leader Kitchen',null,'leader','leader','kitchen',true,true),
  (7,'u7','Leader Hall',null,'leader','leader','hall',true,true),
  (8,'u8','Staff Bar',null,'staff','staff','bar',true,true),
  (9,'u9','Staff Hall',null,'Staff ',' staff','HALL',true,true),
  (10,'u10','Staff Kitchen Off',null,'staff','staff','kitchen',false,true),
  (11,'u11','Staff Hall NoLogin',null,'staff','staff','hall',true,false),
  (12,'u12','Staff NoPart',null,'staff','staff',null,true,true);
`;

// Test-only catalog rows, standing in for future migrations: a type every role may access and a
// manager+ type. Inserted as the migration owner, like a migration would.
export const testTypesSql = `
insert into notification_private.types (code, domain, access_roles, default_severity) values
  ('system.test_all', 'system', array['owner','master','manager','leader','staff'], 'normal'),
  ('sales.test_manager', 'sales', array['owner','master','manager'], 'warning');
insert into notification_private.policies (type_code, enabled, in_app_enabled, rules) values
  ('system.test_all', true, true, '{"groups":[{"roles":[],"positions":[],"parts":[]}],"userIds":[]}'),
  ('sales.test_manager', true, true, '{"groups":[{"roles":[],"positions":[],"parts":[]}],"userIds":[]}');
`;

export const payload = (extra = {}) => ({
  severity: 'warning', titleKo: '테스트 알림', titleVi: 'Thông báo thử', bodyKo: '본문', bodyVi: 'Nội dung',
  subjectType: 'test_subject', subjectId: 'S-1', href: '/admin/sales?tab=deductions', ...extra,
});
