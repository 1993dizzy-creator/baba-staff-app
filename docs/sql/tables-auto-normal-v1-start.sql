-- SEPARATE ACTIVATION APPROVAL REQUIRED. App auto switch must be OFF first.
-- Run only after initial Postflight PASS. Does not touch manual cleaning.
begin;
set local lock_timeout='3s';
update table_operations_private.auto_config set enabled=true where singleton and not enabled
 returning generation,activation_key;
-- Exactly one row required. Set returned key in BABA_TABLE_AUTO_NORMAL_ACTIVATION,
-- then enable BABA_TABLE_AUTO_NORMAL_ENABLED=true. Never reuse a previous key.
commit;
