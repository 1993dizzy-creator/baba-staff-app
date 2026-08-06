-- 재고(inventory) 화면/API는 이제 kitchen/hall/bar/etc 4개 파트만 유효하다고 검증한다
-- (app/(protected)/inventory/page.tsx, app/api/inventory/items/route.ts,
-- lib/inventory/parts.ts 참고). 그런데 DB 컬럼 public.inventory.part는 아직 nullable이고
-- CHECK constraint도 없어, 코드 검증을 우회하는 경로(SQL Editor 수동 실행, 다른 서비스의
-- 직접 INSERT/UPDATE 등)로는 여전히 NULL이나 owner/cleaning 같은 잘못된 값이 들어갈 수
-- 있다. 이 Migration은 그 구멍을 DB 레벨에서 막는다.
--
-- 적용 시점 기준 운영 DB의 재고 ID 167은 이미 part='kitchen'으로 정정되었고(교정 로그:
-- inventory_logs ID 8482), 허용되지 않는 빈 파트 재고는 0건으로 확인되었다. 그래도 이
-- Migration은 그 확인에 의존하지 않고, 적용 시점에 다시 한번 직접 사전 검증한다 — 검증
-- 결과가 다르면(예: 이 사이에 새로 잘못된 값이 들어갔다면) 의미 있는 오류로 즉시 중단하고
-- NOT NULL/CHECK 어느 것도 추가하지 않는다.
--
-- 반복 적용 안전성: NOT NULL은 information_schema로 이미 적용됐는지 먼저 확인하고
-- 아닐 때만 ALTER한다. CHECK constraint는 기존 동일 이름이 있으면 먼저 DROP한 뒤
-- 다시 추가해 이름 충돌 없이 반복 실행할 수 있게 한다.

begin;

-- ---------------------------------------------------------------------------
-- 1. 사전 검증 — NULL, 빈 문자열, 허용되지 않은 값이 하나라도 있으면 중단
-- ---------------------------------------------------------------------------

do $$
declare
  v_invalid_count bigint;
begin
  select count(*) into v_invalid_count
  from public.inventory
  where part is null
     or btrim(part) = ''
     or part not in ('kitchen', 'hall', 'bar', 'etc');

  if v_invalid_count > 0 then
    raise exception
      'ENFORCE_INVENTORY_PART_VALUES_ABORTED: % row(s) in public.inventory have a null/blank/invalid part (must be kitchen, hall, bar, or etc). Fix these rows (see inventory_logs for correction history) before re-running this migration.',
      v_invalid_count
      using errcode = '23514';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. part를 NOT NULL로 변경 (이미 NOT NULL이면 건너뜀 — 반복 적용 안전)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory'
      and column_name = 'part'
      and is_nullable = 'YES'
  ) then
    alter table public.inventory
      alter column part set not null;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. 허용값 CHECK constraint 추가 (기존 동일 이름 constraint는 먼저 제거 —
--    반복 적용/이름 충돌 방지)
-- ---------------------------------------------------------------------------

alter table public.inventory
  drop constraint if exists inventory_part_allowed_values;

alter table public.inventory
  add constraint inventory_part_allowed_values
  check (part in ('kitchen', 'hall', 'bar', 'etc'));

comment on constraint inventory_part_allowed_values on public.inventory is
  '재고 파트는 kitchen/hall/bar/etc 4개만 허용한다. 직원 공통 파트(owner/cleaning 포함,
  lib/common/parts.ts)와는 별개의 재고 전용 정책이다 — lib/inventory/parts.ts 참고.';

commit;
