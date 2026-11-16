-- SEPARATE OPERATING APPROVAL REQUIRED. Turn app auto switch OFF before running.
-- Re-enable only with start.sql and the NEW activation key. Audit rows are retained.
begin;
set local lock_timeout='3s';
update table_operations_private.auto_config set enabled=false where singleton returning enabled,generation;
commit;
