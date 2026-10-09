-- =============================================================================
-- New salons get their roles; new logins get one assigned
--
-- Without this a salon created after Phase 7b has no roles at all, so its
-- owner holds no modules and is locked out of their own salon on the first
-- screen -- `has_module()` would return false for everything.
--
-- The invitation carries the role now. When it does not name one (an invite
-- sent before this shipped, or by an older client), the legacy `role` enum is
-- used to find the matching built-in by name, so nothing is left role-less.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_invite    public.invitations%rowtype;
  v_salon_id  uuid;
  v_role      public.user_role;
  v_full_name text;
  v_action    text;
  v_member_id uuid;
  v_role_id   uuid;
  v_invited   boolean := false;
begin
  select * into v_invite
  from public.invitations i
  where lower(i.email) = lower(new.email)
    and i.status = 'pending'
    and i.expires_at > now()
  order by i.created_at desc
  limit 1;

  if found then
    v_salon_id  := v_invite.salon_id;
    v_role      := v_invite.role;
    v_full_name := coalesce(nullif(v_meta ->> 'full_name', ''), v_invite.full_name, '');
    v_action    := 'staff.invite_accepted';
    v_invited   := true;

    update public.invitations
    set status = 'accepted', accepted_at = now(), accepted_user_id = new.id
    where id = v_invite.id;

  elsif coalesce(nullif(btrim(v_meta ->> 'salon_name'), ''), '') <> '' then
    v_role      := 'owner';
    v_full_name := coalesce(v_meta ->> 'full_name', '');
    v_action    := 'salon.created';

    insert into public.salons (name, business_type, country, timezone, currency)
    values (
      btrim(v_meta ->> 'salon_name'),
      coalesce((nullif(v_meta ->> 'business_type', ''))::public.business_type, 'salon'),
      coalesce(nullif(v_meta ->> 'country', ''), 'US'),
      coalesce(nullif(v_meta ->> 'timezone', ''), 'UTC'),
      coalesce(nullif(v_meta ->> 'currency', ''), 'USD')
    )
    returning id into v_salon_id;

    insert into public.salon_settings (salon_id) values (v_salon_id);

    -- Before the profile: the owner needs a role to hold any module at all.
    perform public.seed_default_roles(v_salon_id);

  else
    raise exception
      'No salon context for %: sign up with salon details or use an invitation link', new.email
      using errcode = 'check_violation';
  end if;

  -- ---- which role ----------------------------------------------------------
  if not v_invited then
    -- The salon's owner takes the owner role. It is never assignable, so this
    -- is the only place it is ever handed out.
    select r.id into v_role_id
    from public.roles r where r.salon_id = v_salon_id and r.is_owner;

  elsif v_invite.role_id is not null then
    v_role_id := v_invite.role_id;

  else
    -- An older invitation that named only the legacy enum. Match it to the
    -- built-in of the same meaning rather than leaving them role-less.
    select r.id into v_role_id
    from public.roles r
    where r.salon_id = v_salon_id
      and r.name = case v_role
                     when 'receptionist' then 'Receptionist'
                     else 'Staff / Therapist'
                   end;
  end if;

  -- ---- which roster entry, if any -----------------------------------------
  if v_invited and v_invite.team_member_id is not null then
    if exists (
      select 1 from public.profiles p where p.team_member_id = v_invite.team_member_id
    ) then
      raise exception 'That team member already has a login'
        using errcode = 'unique_violation';
    end if;
    v_member_id := v_invite.team_member_id;

  elsif (not v_invited) or v_invite.create_roster_entry then
    insert into public.team_members (salon_id, full_name)
    values (
      v_salon_id,
      coalesce(nullif(btrim(v_full_name), ''), split_part(new.email, '@', 1))
    )
    returning id into v_member_id;
  end if;

  insert into public.profiles (id, salon_id, role, full_name, email, team_member_id, role_id)
  values (new.id, v_salon_id, v_role, v_full_name, new.email, v_member_id, v_role_id);

  insert into public.audit_logs (
    salon_id, actor_id, actor_email, actor_role, action, entity_type, entity_id, metadata
  )
  values (
    v_salon_id, new.id, new.email, v_role, v_action, 'profile', new.id::text,
    jsonb_build_object(
      'role', v_role,
      'via', case when v_action = 'salon.created' then 'signup' else 'invitation' end,
      'team_member_id', v_member_id,
      'role_id', v_role_id
    )
  );

  return new;
end;
$$;
