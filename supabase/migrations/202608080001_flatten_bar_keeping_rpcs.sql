-- Phase 1-D: BAR keeping mutation RPC 최신 경로 단일화
--
-- 목적
--   현재 application이 실제로 호출하는 두 진입점(bar_mutate_keeping_v5,
--   bar_update_and_move_keeping)이 더 이상 구버전 RPC(bar_mutate_keeping_v4 →
--   v3 → v2 → bar_mutate_keeping)를 내부적으로 호출하지 않도록, 두 진입점이
--   기존 4단계 delegation chain이 누적해 온 정책을 모두 흡수한 완전 독립
--   로직으로 CREATE OR REPLACE 한다.
--
-- 배경(운영 DB에서 재확인한 현재 구조)
--   bar_mutate_keeping_v5 -> v4 -> v3 -> v2 -> bar_mutate_keeping (4단계 위임)
--   bar_update_and_move_keeping -> bar_mutate_keeping_v3 을 update/move 각각 1회씩 호출
--
--   application에서 사용하는 8개 action(update / update_with_move / use /
--   correct_remaining / move / replace_photo / close / reactivate) 중
--   update_with_move을 제외한 7개는 이미 bar_mutate_keeping_v5를 직접 호출하고
--   있었다. bar_update_and_move_keeping만 legacy v3를 직접 호출해, v4/v5가
--   앞으로 update/move에 정책을 추가하더라도 이 경로만 우회될 위험이 있었다.
--   (현재는 v4/v5가 update/move에 추가하는 동작이 없어 결과값이 동일하지만,
--   이번 작업의 목적은 그 우회 가능성 자체를 제거하는 것이다.)
--
-- 이번 migration이 하는 일
--   1) bar_mutate_keeping_v5 를 CREATE OR REPLACE 하여, bar_mutate_keeping
--      (base) + v2 + v3 + v4 + v5가 각 action별로 누적해 온 정책을 모두
--      하나의 함수 본문으로 흡수한다. 구버전 RPC 호출은 전혀 남기지 않는다.
--   2) bar_update_and_move_keeping 을 CREATE OR REPLACE 하여, 내부에서
--      bar_mutate_keeping_v3 대신 새로 독립화된 bar_mutate_keeping_v5를
--      호출하도록 바꾼다.
--   3) 두 함수 모두 signature(인자 이름/타입/순서, 리턴 타입)는 전혀 바꾸지
--      않는다 — 시그니처가 동일하므로 CREATE OR REPLACE만으로 기존 GRANT가
--      보존된다.
--   4) bar_mutate_keeping / v2 / v3 / v4 자체와 bar_create_keeping,
--      bar_delete_active_keeping_v1, bar_delete_keeping_v2, bar_update_zone,
--      bar_update_zone_photo 등 다른 BAR 함수는 이번 migration에서 전혀
--      건드리지 않는다. 구버전 RPC(DROP)는 이번 단계에서 하지 않는다 —
--      Phase 1-D2에서 별도로 다룬다.
--
-- 정책 보존 검증(action별 최종 동작 — 원본 4단계 delegation과 동일)
--   update            : actor 검증 → row lock/version 충돌 검증(가장 먼저 하는
--                        것은 v3의 customer_contact 길이 검증과 v2의
--                        liquor_source 해석/expires_at 계산 — 원본에서도 이
--                        두 단계가 actor 검증/row lock보다 먼저 실행되므로
--                        동일한 순서를 유지한다) → closed 상태 게이트 →
--                        customer_name/customer_identifier/liquor_name/note/
--                        stored_at/expires_at/liquor_source/inventory_item_id/
--                        customer_contact 갱신 → version+1 → 활동 로그 1건
--                        (liquor_source/inventory_item_id/liquor_name/
--                        stored_at/expires_at/customer_contact 포함)
--   use               : active 상태 검증 → finish 시 remaining_percent=0
--                        강제 → remaining_percent/last_used_at/사진/상태/
--                        close_reason/close_note(=null 고정)/closed_at/
--                        closed_by 갱신 → use_count+1 → note 컬럼 갱신
--                        (finish 시 legacy close_note 자동 대입 없이 note
--                        컬럼에만 별도 기록) → version+1 → 활동 로그 1건
--                        (use_count/action_note/note 포함)
--   correct_remaining : active 상태 검증 → remaining_percent 갱신 → note
--                        컬럼 갱신(payload에 note가 있으면) → version+1 →
--                        활동 로그 1건(action_note/note 포함)
--   move              : active 상태 검증 → 동일 zone 재선택 차단 → zone
--                        유효성 검증 → zone_code 갱신 → version+1 → 활동
--                        로그 1건(추가 정책 없음, base 그대로)
--   replace_photo     : image_path 필수 검증 → 사진 갱신 → version+1 →
--                        활동 로그 1건(추가 정책 없음, base 그대로)
--   close             : active 상태 검증 → close_note는 legacy close_note
--                        키를 fallback으로 허용하되 note 컬럼에만 기록 →
--                        상태/close_reason/closed_at/closed_by/사진 갱신 →
--                        version+1 → 활동 로그 1건(action_note/note 포함)
--   reactivate        : closed 상태 검증 → zone 유효성 검증 → note는 legacy
--                        reason 키로도 로그에 남기고 note 컬럼에는 별도
--                        기록 → 상태/close 관련 컬럼 초기화/zone/
--                        remaining_percent/expires_at/사진 갱신 →
--                        version+1 → 활동 로그 신규 1건 정합성 검증(정확히
--                        1건 생성됐는지 확인) 후 action_note/note 보강
--
-- 예외 처리 범위(원본과 동일하게 유지)
--   원본 체인에서 check_violation / invalid_text_representation /
--   datetime_field_overflow를 잡아 invalid_input으로 변환하는 것은
--   bar_mutate_keeping(base) / v2 / v3뿐이었고, v4 / v5 자신의 코드(예:
--   use.finish boolean 캐스팅)에는 예외 처리기가 없어 예외가 그대로
--   전파됐다. 이번 flatten에서도 동일한 범위를 재현하기 위해, base+v2+v3에
--   해당하는 구간만 중첩 BEGIN/EXCEPTION 블록으로 감싸고, v4/v5에
--   해당하는 구간(사전 payload 변형, 사후 note 반영)은 예외 처리 범위
--   밖에 둔다.
--
-- 운영 DB 적용 여부: 이번 turn에서는 로컬 migration 작성 + 테스트까지만
-- 진행하며, 운영 Supabase에는 어떤 DDL도 실행하지 않는다.

begin;

create or replace function public.bar_mutate_keeping_v5(
  p_id bigint,
  p_expected_version integer,
  p_action text,
  p_payload jsonb,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_old public.bar_keepings%rowtype;
  v_new public.bar_keepings%rowtype;
  v_zone public.bar_zones%rowtype;
  v_now timestamptz := clock_timestamp();
  v_snapshot text;
  v_new_zone text;
  v_reason text;
  v_used_at timestamptz;
  v_actor_name text;
  v_payload jsonb := p_payload;
  v_action_note text;
  v_contact text;
  v_source text;
  v_item_id bigint;
  v_liquor_name text;
  v_stored_at date;
  v_use_count integer;
  v2_action_type text;
  v4_action_type text;
  v_final_note text;
  v_log_id bigint;
  v_log_id_before bigint;
  v_new_log_count integer;
begin
  -- ===== 구 v5-pre / v4-pre: action별 payload 사전 변형 =====
  -- (구 v5가 reactivate만 가로채고, 그 외 action은 그대로 v4로 전달했던 것과
  -- 동일한 분기 구조. v4/v5 자신의 코드에는 예외 처리기가 없었으므로 이
  -- 구간은 아래 nested EXCEPTION 블록 밖에 둔다.)
  if p_action = 'reactivate' then
    v_action_note := nullif(btrim(p_payload->>'note'), '');
    -- 배포된 base 함수는 reason 입력을 검증하지 않지만, 재활성 로그에
    -- legacy reason 키를 계속 기록한다. action_note를 새 로그 렌더링의
    -- 정본 값으로 유지하면서 legacy 입력 계약도 보존한다.
    v_payload := (p_payload - 'note') || jsonb_build_object('reason', v_action_note);

    select coalesce(max(l.id), 0)
    into v_log_id_before
    from public.bar_activity_logs l
    where l.entity_type = 'keeping'
      and l.entity_id = p_id
      and l.action_type = 'keeping_reactivated';
  else
    -- close_note는 임시 호환 fallback으로만 허용한다.
    if p_action = 'close' then
      v_action_note := nullif(
        btrim(coalesce(p_payload->>'note', p_payload->>'close_note')),
        ''
      );
    else
      v_action_note := nullif(btrim(p_payload->>'note'), '');
    end if;

    -- legacy base 로직은 use.finish 시 note를 close_note에 자동 대입하고,
    -- close.close_note를 직접 기록한다. note/action-note 저장은 이 함수가
    -- 전담하므로, 아래 base 단계에는 해당 legacy 입력을 제거하고 넘긴다.
    if p_action = 'use'
      and coalesce((p_payload->>'finish')::boolean, false)
    then
      v_payload := p_payload - 'note';
    elsif p_action = 'close' then
      v_payload := p_payload - 'close_note';
    else
      v_payload := p_payload;
    end if;
  end if;

  -- ===== 구 base + v2 + v3: actor/row/version 검증, 핵심 mutation, 활동 로그 =====
  -- (base/v2/v3 세 함수 모두 check_violation, invalid_text_representation,
  -- datetime_field_overflow를 잡아 invalid_input으로 변환하던 구간이므로
  -- 동일하게 하나의 nested 블록으로 감싼다.)
  begin
    -- ----- 구 v3-pre: update 전용 customer_contact 검증 -----
    if p_action = 'update' then
      v_contact := nullif(btrim(v_payload->>'customer_contact'), '');
      if v_contact is not null and char_length(v_contact) > 120 then
        return jsonb_build_object('status', 'invalid_input');
      end if;
    end if;

    -- ----- 구 v2-pre: update/reactivate 전용 liquor_source 해석 + expires_at 계산 -----
    if p_action = 'update' then
      v_stored_at := (v_payload->>'stored_at')::date;
      v_source := v_payload->>'liquor_source';
      if v_source = 'inventory' then
        v_item_id := nullif(v_payload->>'inventory_item_id', '')::bigint;
        select coalesce(nullif(btrim(i.item_name), ''), nullif(btrim(i.item_name_vi), ''))
        into v_liquor_name
        from public.inventory i
        where i.id = v_item_id and i.part = 'bar' and i.is_active = true;
        if not found or v_liquor_name is null then
          return jsonb_build_object('status', 'invalid_inventory_item');
        end if;
      elsif v_source = 'external' then
        v_item_id := null;
        v_liquor_name := nullif(btrim(v_payload->>'liquor_name'), '');
        if v_liquor_name is null then
          return jsonb_build_object('status', 'invalid_input');
        end if;
      else
        return jsonb_build_object('status', 'invalid_input');
      end if;
      v_payload := v_payload || jsonb_build_object(
        'liquor_name', v_liquor_name,
        'expires_at', to_char((v_stored_at + interval '3 months')::date, 'YYYY-MM-DD')
      );
    elsif p_action = 'reactivate' then
      v_stored_at := (v_payload->>'stored_at')::date;
      v_payload := v_payload || jsonb_build_object(
        'expires_at', to_char((v_stored_at + interval '3 months')::date, 'YYYY-MM-DD')
      );
    end if;

    -- ----- 구 base: actor 검증, row lock, version 충돌, 이미지 쌍 검증 -----
    select coalesce(nullif(u.name, ''), nullif(u.full_name, ''), u.username)
    into v_actor_name
    from public.users as u
    where u.id = p_actor_user_id and u.is_active = true;
    if not found or v_actor_name is null then
      return jsonb_build_object('status', 'invalid_actor');
    end if;

    select * into v_old from public.bar_keepings where id = p_id for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    if v_old.version <> p_expected_version then
      return jsonb_build_object('status', 'conflict', 'version', v_old.version);
    end if;
    if (nullif(v_payload->>'image_path', '') is null) <> (nullif(v_payload->>'thumbnail_path', '') is null) then
      return jsonb_build_object('status', 'invalid_input');
    end if;
    v_snapshot := left(v_old.customer_name || ' · ' || v_old.liquor_name, 240);

    if p_action = 'update' then
      if v_old.status = 'closed' and coalesce((v_payload->>'allow_closed')::boolean, false) is not true then
        return jsonb_build_object('status', 'invalid_state');
      end if;
      update public.bar_keepings set
        customer_name = btrim(v_payload->>'customer_name'),
        customer_identifier = nullif(btrim(v_payload->>'customer_identifier'), ''),
        liquor_name = btrim(v_payload->>'liquor_name'),
        note = nullif(btrim(v_payload->>'note'), ''),
        stored_at = (v_payload->>'stored_at')::date,
        expires_at = nullif(v_payload->>'expires_at', '')::date,
        updated_by_user_id = p_actor_user_id, updated_at = v_now, version = version + 1
      where id = p_id returning * into v_new;
    elsif p_action = 'use' then
      if v_old.status <> 'active' then
        return jsonb_build_object('status', 'invalid_state');
      end if;
      if coalesce((v_payload->>'finish')::boolean, false) and (v_payload->>'remaining_percent')::integer <> 0 then
        return jsonb_build_object('status', 'invalid_input');
      end if;
      v_used_at := (v_payload->>'used_at')::timestamptz;
      update public.bar_keepings set
        remaining_percent = (v_payload->>'remaining_percent')::integer, last_used_at = v_used_at,
        image_path = coalesce(nullif(v_payload->>'image_path', ''), image_path),
        thumbnail_path = coalesce(nullif(v_payload->>'thumbnail_path', ''), thumbnail_path),
        image_updated_at = case when nullif(v_payload->>'image_path', '') is null then image_updated_at else v_now end,
        status = case when coalesce((v_payload->>'finish')::boolean, false) then 'closed' else status end,
        close_reason = case when coalesce((v_payload->>'finish')::boolean, false) then 'finished' else null end,
        close_note = case when coalesce((v_payload->>'finish')::boolean, false) then nullif(btrim(v_payload->>'note'), '') else null end,
        closed_at = case when coalesce((v_payload->>'finish')::boolean, false) then v_used_at else null end,
        closed_by_user_id = case when coalesce((v_payload->>'finish')::boolean, false) then p_actor_user_id else null end,
        updated_by_user_id = p_actor_user_id, updated_at = v_now, version = version + 1
      where id = p_id returning * into v_new;
    elsif p_action = 'correct_remaining' then
      if v_old.status <> 'active' then
        return jsonb_build_object('status', 'invalid_state');
      end if;
      update public.bar_keepings set
        remaining_percent = (v_payload->>'remaining_percent')::integer,
        updated_by_user_id = p_actor_user_id, updated_at = v_now, version = version + 1
      where id = p_id returning * into v_new;
    elsif p_action = 'move' then
      if v_old.status <> 'active' then
        return jsonb_build_object('status', 'invalid_state');
      end if;
      v_new_zone := v_payload->>'zone_code';
      if v_new_zone = v_old.zone_code then
        return jsonb_build_object('status', 'same_zone');
      end if;
      select * into v_zone from public.bar_zones where code = v_new_zone;
      if not found or not v_zone.is_active or not v_zone.selectable_for_keeping then
        return jsonb_build_object('status', 'invalid_zone');
      end if;
      update public.bar_keepings set
        zone_code = v_new_zone, updated_by_user_id = p_actor_user_id, updated_at = v_now, version = version + 1
      where id = p_id returning * into v_new;
    elsif p_action = 'replace_photo' then
      if nullif(v_payload->>'image_path', '') is null then
        return jsonb_build_object('status', 'invalid_input');
      end if;
      update public.bar_keepings set
        image_path = v_payload->>'image_path', thumbnail_path = v_payload->>'thumbnail_path', image_updated_at = v_now,
        updated_by_user_id = p_actor_user_id, updated_at = v_now, version = version + 1
      where id = p_id returning * into v_new;
    elsif p_action = 'close' then
      if v_old.status <> 'active' then
        return jsonb_build_object('status', 'invalid_state');
      end if;
      v_reason := v_payload->>'close_reason';
      update public.bar_keepings set
        status = 'closed', close_reason = v_reason, close_note = nullif(btrim(v_payload->>'close_note'), ''),
        closed_at = (v_payload->>'closed_at')::timestamptz, closed_by_user_id = p_actor_user_id,
        image_path = coalesce(nullif(v_payload->>'image_path', ''), image_path),
        thumbnail_path = coalesce(nullif(v_payload->>'thumbnail_path', ''), thumbnail_path),
        image_updated_at = case when nullif(v_payload->>'image_path', '') is null then image_updated_at else v_now end,
        updated_by_user_id = p_actor_user_id, updated_at = v_now, version = version + 1
      where id = p_id returning * into v_new;
    elsif p_action = 'reactivate' then
      if v_old.status <> 'closed' then
        return jsonb_build_object('status', 'invalid_state');
      end if;
      v_new_zone := v_payload->>'zone_code';
      select * into v_zone from public.bar_zones where code = v_new_zone;
      if not found or not v_zone.is_active or not v_zone.selectable_for_keeping then
        return jsonb_build_object('status', 'invalid_zone');
      end if;
      update public.bar_keepings set
        status = 'active', close_reason = null, close_note = null, closed_at = null, closed_by_user_id = null,
        zone_code = v_new_zone, remaining_percent = (v_payload->>'remaining_percent')::integer,
        expires_at = nullif(v_payload->>'expires_at', '')::date,
        image_path = coalesce(nullif(v_payload->>'image_path', ''), image_path),
        thumbnail_path = coalesce(nullif(v_payload->>'thumbnail_path', ''), thumbnail_path),
        image_updated_at = case when nullif(v_payload->>'image_path', '') is null then image_updated_at else v_now end,
        updated_by_user_id = p_actor_user_id, updated_at = v_now, version = version + 1
      where id = p_id returning * into v_new;
    else
      return jsonb_build_object('status', 'invalid_action');
    end if;

    insert into public.bar_activity_logs(
      entity_type, entity_id, entity_code_snapshot, action_type, before_data, after_data,
      actor_user_id, actor_name_snapshot, created_at
    )
    values (
      'keeping', p_id, v_snapshot,
      case p_action
        when 'update' then 'keeping_updated'
        when 'use' then 'keeping_used'
        when 'correct_remaining' then 'keeping_remaining_corrected'
        when 'move' then 'keeping_zone_changed'
        when 'replace_photo' then 'keeping_photo_replaced'
        when 'close' then 'keeping_closed'
        when 'reactivate' then 'keeping_reactivated'
      end,
      to_jsonb(v_old) || jsonb_build_object('reason', v_payload->>'reason'),
      to_jsonb(v_new) || jsonb_build_object('reason', v_payload->>'reason', 'note', v_payload->>'note'),
      p_actor_user_id, v_actor_name, v_now
    );

    -- ----- 구 v2-post: update 전용 liquor_source/inventory_item_id, use 전용 use_count,
    -- reactivate 전용 stored_at/expires_at 반영 + 각 로그 보강 -----
    if p_action = 'update' then
      update public.bar_keepings set liquor_source = v_source, inventory_item_id = v_item_id where id = p_id;
      v2_action_type := 'keeping_updated';
    elsif p_action = 'use' then
      update public.bar_keepings set use_count = use_count + 1 where id = p_id returning use_count into v_use_count;
      v2_action_type := 'keeping_used';
    elsif p_action = 'reactivate' then
      update public.bar_keepings
      set stored_at = v_stored_at, expires_at = (v_stored_at + interval '3 months')::date
      where id = p_id;
      v2_action_type := 'keeping_reactivated';
    else
      v2_action_type := null;
    end if;

    if v2_action_type is not null then
      select l.id into v_log_id from public.bar_activity_logs l
      where l.entity_type = 'keeping' and l.entity_id = p_id
        and l.action_type = v2_action_type and l.actor_user_id = p_actor_user_id
      order by l.created_at desc, l.id desc limit 1;
    end if;
    if v_log_id is not null and p_action = 'update' then
      update public.bar_activity_logs set after_data = after_data || jsonb_build_object(
        'liquor_source', v_source, 'inventory_item_id', v_item_id, 'liquor_name', v_liquor_name,
        'stored_at', v_stored_at, 'expires_at', (v_stored_at + interval '3 months')::date
      ) where id = v_log_id;
    elsif v_log_id is not null and p_action = 'use' then
      update public.bar_activity_logs set after_data = after_data || jsonb_build_object('use_count', v_use_count) where id = v_log_id;
    elsif v_log_id is not null and p_action = 'reactivate' then
      update public.bar_activity_logs set after_data = after_data || jsonb_build_object(
        'stored_at', v_stored_at, 'expires_at', (v_stored_at + interval '3 months')::date
      ) where id = v_log_id;
    end if;

    -- ----- 구 v3-post: update 전용 customer_contact 반영 + 로그 보강 -----
    if p_action = 'update' then
      update public.bar_keepings set customer_contact = v_contact where id = p_id;
      select l.id into v_log_id from public.bar_activity_logs l
      where l.entity_type = 'keeping' and l.entity_id = p_id
        and l.action_type = 'keeping_updated' and l.actor_user_id = p_actor_user_id
      order by l.created_at desc, l.id desc limit 1;
      if v_log_id is not null then
        update public.bar_activity_logs
        set after_data = after_data || jsonb_build_object('customer_contact', v_contact)
        where id = v_log_id;
      end if;
    end if;
  exception when check_violation or invalid_text_representation or datetime_field_overflow then
    return jsonb_build_object('status', 'invalid_input');
  end;

  -- ===== 구 v4-post: use/correct_remaining/close 전용 note 컬럼 반영 + 로그 보강 =====
  -- (v4 자신에는 예외 처리기가 없었으므로 위 nested 블록 밖에 둔다.)
  v4_action_type := case p_action
    when 'use' then 'keeping_used'
    when 'correct_remaining' then 'keeping_remaining_corrected'
    when 'close' then 'keeping_closed'
    else null
  end;
  if v4_action_type is not null then
    -- 이미 version이 증가한 mutation 위에 note만 추가로 반영하는 것이므로
    -- version은 다시 올리지 않는다.
    if v_action_note is not null then
      update public.bar_keepings set note = v_action_note where id = p_id;
    end if;

    select k.note into v_final_note from public.bar_keepings k where k.id = p_id;

    select l.id into v_log_id from public.bar_activity_logs l
    where l.entity_type = 'keeping' and l.entity_id = p_id
      and l.action_type = v4_action_type and l.actor_user_id = p_actor_user_id
    order by l.created_at desc, l.id desc limit 1;

    if v_log_id is null then
      raise exception 'keeping action log not found for %, %, %', p_id, v4_action_type, p_actor_user_id;
    end if;

    update public.bar_activity_logs
    set after_data = coalesce(after_data, '{}'::jsonb) || jsonb_build_object('action_note', v_action_note, 'note', v_final_note)
    where id = v_log_id;

    if not found then
      raise exception 'keeping action log update failed for %', v_log_id;
    end if;
  end if;

  -- ===== 구 v5-post: reactivate 전용 note 컬럼 반영(정합성 검증 포함) + 로그 보강 =====
  -- (v5 자신에도 예외 처리기가 없었으므로 nested 블록 밖에 둔다.)
  if p_action = 'reactivate' then
    if v_action_note is not null then
      update public.bar_keepings set note = v_action_note where id = p_id;
    end if;

    select k.note into v_final_note from public.bar_keepings k where k.id = p_id;

    select count(*), max(l.id) into v_new_log_count, v_log_id
    from public.bar_activity_logs l
    where l.entity_type = 'keeping' and l.entity_id = p_id
      and l.action_type = 'keeping_reactivated' and l.actor_user_id = p_actor_user_id
      and l.id > v_log_id_before;

    if v_new_log_count <> 1 or v_log_id is null then
      raise exception 'expected one new keeping reactivation log for %, %, got %', p_id, p_actor_user_id, v_new_log_count;
    end if;

    if v_action_note is not null then
      update public.bar_activity_logs
      set after_data = coalesce(after_data, '{}'::jsonb) || jsonb_build_object('action_note', v_action_note, 'note', v_final_note)
      where id = v_log_id;

      if not found then
        raise exception 'keeping reactivation log update failed for %', v_log_id;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'status', 'ok', 'version', v_new.version,
    'old_image_path', v_old.image_path, 'old_thumbnail_path', v_old.thumbnail_path
  );
end;
$function$;

create or replace function public.bar_update_and_move_keeping(
  p_id bigint,
  p_expected_version integer,
  p_update_payload jsonb,
  p_move_payload jsonb,
  p_actor_user_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_update_result jsonb;
  v_move_result jsonb;
  v_next_version integer;
begin
  -- 구버전 bar_mutate_keeping_v3 대신, 이번 migration에서 완전히 독립화된
  -- bar_mutate_keeping_v5를 호출한다. update/move action에 대한 v5의 동작은
  -- 기존 v3 호출과 결과가 동일하며(v4/v5가 이 두 action에 추가하던 정책이
  -- 없었음을 확인함), 앞으로 v5에 정책이 추가되어도 이 경로가 우회되지
  -- 않도록 하기 위한 변경이다.
  v_update_result := public.bar_mutate_keeping_v5(
    p_id, p_expected_version, 'update', p_update_payload, p_actor_user_id
  );
  if v_update_result->>'status' <> 'ok' then
    return v_update_result;
  end if;

  v_next_version := (v_update_result->>'version')::integer;
  v_move_result := public.bar_mutate_keeping_v5(
    p_id, v_next_version, 'move', p_move_payload, p_actor_user_id
  );

  if v_move_result->>'status' <> 'ok' then
    raise exception 'atomic keeping move failed: %', v_move_result->>'status';
  end if;
  return v_move_result;
end;
$function$;

commit;
