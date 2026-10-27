import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const signature='public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint)';
export const expectedBodyHash='beebd06ff35eb3eaf0a68dfde8494412';
export const migrations=[
  ['20261027112354','aug_sep_reclose_corrections'],
  ['20261027160650','fix_aug_sep_reclose_lock_order'],
].map(([version,name])=>{
  const sql=readFileSync(new URL(`../../supabase/migrations/${version}_${name}.sql`,import.meta.url),'utf8').replaceAll('\r\n','\n');
  return {version,name,sql,sha256:createHash('sha256').update(sql).digest('hex')};
});

const setup=`begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtext('baba_m_stage_install'));
select pg_advisory_xact_lock(hashtext('baba_migration_history:20261027112354'));
select pg_advisory_xact_lock(hashtext('baba_migration_history:20261027160650'));
`;
const metadata=`do $m_stage_verify$
declare v public.pg_proc%rowtype;
begin
  select * into v from pg_catalog.pg_proc where oid=to_regprocedure('${signature}');
  if v.oid is null or md5(regexp_replace(v.prosrc,'\\s+','','g')) is distinct from '${expectedBodyHash}'
    or pg_get_userbyid(v.proowner)<>'postgres' or not v.prosecdef
    or v.prorettype<>'jsonb'::regtype
    or v.proargnames is distinct from array['p_month','p_rent_plan_id','p_actor_user_id']::text[]
    or not coalesce(v.proconfig @> array['search_path=pg_catalog, public','lock_timeout=5s']::text[],false)
    or exists(select 1 from aclexplode(coalesce(v.proacl,acldefault('f',v.proowner))) a
      where a.privilege_type='EXECUTE' and a.grantee not in(v.proowner,(select oid from pg_roles where rolname='service_role')))
    or has_function_privilege('anon',v.oid,'EXECUTE')
    or has_function_privilege('authenticated',v.oid,'EXECUTE')
    or not has_function_privilege('service_role',v.oid,'EXECUTE') then
    raise exception 'M_STAGE_FINAL_FUNCTION_INVALID';
  end if;
end;
$m_stage_verify$;
`.replace('public.pg_proc','pg_catalog.pg_proc');

export function buildBundles() {
  const provenance=migrations.map(m=>`-- ${m.version} ${m.name}; normalized-LF SHA256 ${m.sha256}`).join('\n');
  const install=`-- REVIEW ONLY UNTIL SEPARATE OPERATIONAL APPROVAL. User SQL Editor installation.
-- Run the WHOLE file in one session/batch. Never execute the original alone.
-- On any error issue ROLLBACK in that session. Do not continue from a fragment.
${provenance}
${setup}
do $m_stage_precheck$
begin
  if to_regprocedure('${signature}') is not null then raise exception 'M_STAGE_FUNCTION_ALREADY_EXISTS';end if;
  if exists(select 1 from supabase_migrations.schema_migrations where version in('20261027112354','20261027160650')) then
    raise exception 'M_STAGE_HISTORY_ALREADY_EXISTS';
  end if;
end;
$m_stage_precheck$;
-- M_STAGE_ORIGINAL_BEGIN
${migrations[0].sql}
-- M_STAGE_ORIGINAL_END
-- M_STAGE_FIX_BEGIN
${migrations[1].sql}
-- M_STAGE_FIX_END
${metadata}
commit;
-- History is intentionally registered separately, only after application confirmation and verification.
`;
  const values=migrations.map(m=>{
    const delimiter=`$source_${m.version}$`;
    if(m.sql.includes(delimiter))throw Error('Unsafe SQL delimiter');
    return `('${m.version}','${m.name}',array[${delimiter}${m.sql}${delimiter}]::text[])`;
  }).join(',\n');
  const register=`-- REVIEW ONLY. After the user confirms installation and GPT verifies approved/executed SQL.
-- No function DDL, accounting DML or unrelated history repair is performed here.
-- Run the WHOLE file. On error ROLLBACK. Repeating identical registration is a no-op.
${provenance}
${setup}
${metadata}
do $m_stage_history$
declare v record;v_actual record;
begin
  for v in select * from (values ${values}) expected(version,name,statements) loop
    select name,statements into v_actual from supabase_migrations.schema_migrations where version=v.version for update;
    if found and (v_actual.name is distinct from v.name or v_actual.statements is distinct from v.statements) then
      raise exception 'M_STAGE_HISTORY_CONTENT_MISMATCH: %',v.version;
    end if;
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values(v.version,v.name,v.statements) on conflict(version) do nothing;
    select name,statements into v_actual from supabase_migrations.schema_migrations where version=v.version;
    if v_actual.name is distinct from v.name or v_actual.statements is distinct from v.statements then
      raise exception 'M_STAGE_HISTORY_CONTENT_MISMATCH: %',v.version;
    end if;
  end loop;
end;
$m_stage_history$;
commit;
`;
  return {install,register};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]!=='--write')throw Error('Use --write to generate local review artifacts; this program never connects to a database');
  for(const [kind,sql] of Object.entries(buildBundles()))writeFileSync(new URL(`./m-stage-${kind}.sql`,import.meta.url),sql);
}
