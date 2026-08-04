with current_version as (
  select distinct on (v.user_id) v.*
  from public.employee_level_program_versions v
  where v.effective_from <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
    and (v.effective_to is null or v.effective_to > (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  order by v.user_id,v.effective_from desc,v.revision desc
), classified as (
  select u.id user_id,coalesce(u.name,u.full_name,u.username) employee_name,
    u.username,u.role,u.is_system_account,u.hire_date,
    u.level_base_date_override current_users_override,
    v.enabled current_version_enabled,v.base_date current_version_base_date,
    prior.base_date previous_version_base_date,
    case
      when u.is_system_account then null
      when coalesce(v.base_date,u.level_base_date_override) is not null
        and coalesce(v.base_date,u.level_base_date_override) is distinct from u.hire_date then 'override'
      when u.hire_date is not null then 'hire_date'
      else null
    end decided_base_date_mode,
    case
      when u.is_system_account then 'manual_review'
      when coalesce(v.base_date,u.level_base_date_override) is not null
        and coalesce(v.base_date,u.level_base_date_override) is distinct from u.hire_date
        then 'current_policy_base_date_differs_from_hire_date'
      when not coalesce(v.enabled,false) and u.position='owner' and u.hire_date is not null
        then 'disabled_owner_default_hire_date'
      when v.base_date is null and prior.base_date is not null then 'inherited_from_previous_version'
      when v.base_date is null and u.hire_date is not null then 'disabled_default_hire_date'
      when v.base_date is not distinct from u.hire_date and u.hire_date is not null
        then 'legacy_backfill_same_as_hire_date'
      when v.id is null and u.hire_date is not null then 'hire_date_without_current_version'
      else 'manual_review'
    end decision_reason,
    case
      when u.is_system_account then null
      when coalesce(v.base_date,u.level_base_date_override) is not null
        and coalesce(v.base_date,u.level_base_date_override) is distinct from u.hire_date
        then coalesce(v.base_date,u.level_base_date_override)
      else coalesce(v.base_date,prior.base_date,u.hire_date)
    end repaired_version_base_date,
    case
      when coalesce(v.base_date,u.level_base_date_override) is not null
        and coalesce(v.base_date,u.level_base_date_override) is distinct from u.hire_date
        then coalesce(v.base_date,u.level_base_date_override)
      else null
    end repaired_users_override,
    u.is_system_account or u.hire_date is null as manual_review
  from public.users u
  left join current_version v on v.user_id=u.id
  left join lateral (
    select p.base_date from public.employee_level_program_versions p
    where p.user_id=u.id and p.revision<v.revision and p.base_date is not null
    order by p.revision desc limit 1
  ) prior on true
)
select classified.*,
  count(*) over (partition by decided_base_date_mode) mode_count,
  count(*) filter (where manual_review) over () manual_review_count
from classified
order by manual_review desc,user_id;
