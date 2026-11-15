-- OWNER APPROVAL REQUIRED. Prepared only; never run as part of tests against production.
-- First stop new app requests by turning BABA_TABLE_CLEANING_ENABLED OFF.
-- This private row fence waits for an in-flight confirmation, or times out atomically.
-- Generation advances, so old confirmations never reappear on recovery.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
update table_operations_private.config set enabled=false where singleton;
select singleton,enabled,generation from table_operations_private.config;
commit;
