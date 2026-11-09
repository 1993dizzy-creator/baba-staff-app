-- pos_open_orders_v1 — RPC SMOKE after install. Each part runs in its own transaction
-- that ends with ROLLBACK, so nothing is kept. Success = the NOTICE "... PASS"; any
-- problem raises an exception. Run as postgres (needs SET ROLE to the API roles).

-- A. Read path and refusals (no writes at all).
begin;
do $$
declare v jsonb; denied integer := 0; r text;
begin
  set local role service_role;
  v := public.pos_open_orders_read(repeat('0', 64) || ':smoke-branch', current_date);
  if v is null or jsonb_typeof(v -> 'orders') <> 'array' or jsonb_array_length(v -> 'orders') <> 0
     or (v -> 'sync') <> 'null'::jsonb then
    raise exception 'smoke A: unexpected read result %', v;
  end if;
  begin
    perform 1 from pos_open_orders_private.orders limit 1;
    raise exception 'smoke A: service_role could read a private table';
  exception when insufficient_privilege then null;
  end;
  reset role;
  foreach r in array array['anon', 'authenticated'] loop
    execute format('set local role %I', r);
    begin
      perform public.pos_open_orders_read('x', current_date);
      raise exception 'smoke A: % could execute the read wrapper', r;
    exception when insufficient_privilege then denied := denied + 1;
    end;
    begin
      perform pos_open_orders_private.read_v1('x', current_date);
      raise exception 'smoke A: % could execute an internal function', r;
    exception when insufficient_privilege then denied := denied + 1;
    end;
    begin
      perform 1 from pos_open_orders_private.runs limit 1;
      raise exception 'smoke A: % could read a private table', r;
    exception when insufficient_privilege then denied := denied + 1;
    end;
    reset role;
  end loop;
  if denied <> 6 then raise exception 'smoke A: expected 6 refusals, got %', denied; end if;
  raise notice 'pos_open_orders_v1 smoke A: PASS';
end $$;
rollback;

-- B. Write path (claim -> busy -> fail -> late commit fenced) inside a rolled-back transaction.
--    Optional: it executes DML that is discarded by the ROLLBACK below.
begin;
do $$
declare
  v_scope text := repeat('f', 64) || ':smoke-branch';
  v_date date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_run uuid := gen_random_uuid(); v_owner uuid := gen_random_uuid(); v jsonb;
begin
  set local role service_role;
  v := public.pos_open_orders_claim(v_run, v_owner, v_scope, 'smoke-branch', v_date, 0);
  if v ->> 'status' <> 'collecting' then raise exception 'smoke B: claim %', v; end if;
  v := public.pos_open_orders_claim(gen_random_uuid(), gen_random_uuid(), v_scope, 'smoke-branch', v_date, 0);
  if v ->> 'status' <> 'busy' then raise exception 'smoke B: second claim %', v; end if;
  v := public.pos_open_orders_fail(v_run, v_owner, 'smoke_test');
  if v ->> 'status' <> 'failed' then raise exception 'smoke B: fail %', v; end if;
  begin
    perform public.pos_open_orders_commit(v_run, v_owner, '{}'::jsonb, '[]'::jsonb);
    raise exception 'smoke B: commit after fail was accepted';
  exception when others then
    if sqlerrm <> 'open_orders_lease_lost' then raise; end if;
  end;
  v := public.pos_open_orders_read(v_scope, v_date);
  if v -> 'sync' ->> 'lastErrorCode' <> 'smoke_test' or jsonb_array_length(v -> 'orders') <> 0 then
    raise exception 'smoke B: read after fail %', v;
  end if;
  reset role;
  raise notice 'pos_open_orders_v1 smoke B: PASS (rolled back)';
end $$;
rollback;
