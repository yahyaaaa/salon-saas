-- =============================================================================
-- New logins and the roster
--
-- The backfill in migration 24 gave every EXISTING profile a roster entry.
-- Without this, every login created afterwards would have none -- a new salon
-- owner would be unbookable and unpayable in their own salon, which is a worse
-- first five minutes than the problem the split solves.
--
-- So an invitation now says what should happen:
--
--   team_member_id set      link this login to that existing roster entry --
--                           "give Hafsa, who is already on the team, a login"
--   create_roster_entry     make a roster entry for them and link it (the
--                           default, and what every invite did implicitly
--                           before this existed)
--   neither                 a login with no roster entry: someone who manages
--                           the salon but performs no services and earns
--                           nothing
--
-- A brand new salon's owner always gets one. A salon with nobody on its roster
-- cannot take a booking, and the owner is the only person there on day one.
-- =============================================================================

alter table public.invitations
  add column team_member_id uuid,
  add column create_roster_entry boolean not null default true,
  add constraint invitations_team_member_fk
    foreign key (team_member_id, salon_id)
      references public.team_members (id, salon_id) on delete set null (team_member_id);

comment on column public.invitations.team_member_id is
  'Link the accepted login to this existing roster entry. Overrides create_roster_entry.';
comment on column public.invitations.create_roster_entry is
  'When no existing entry is named, whether to create one for them. False means a login that performs no services.';

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
    -- Path 2: joining an existing salon through an invite.
    v_salon_id  := v_invite.salon_id;
    v_role      := v_invite.role;
    v_full_name := coalesce(nullif(v_meta ->> 'full_name', ''), v_invite.full_name, '');
    v_action    := 'staff.invite_accepted';
    v_invited   := true;

    update public.invitations
    set status = 'accepted', accepted_at = now(), accepted_user_id = new.id
    where id = v_invite.id;

  elsif coalesce(nullif(btrim(v_meta ->> 'salon_name'), ''), '') <> '' then
    -- Path 1: an owner signing up a brand new salon.
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

  else
    raise exception
      'No salon context for %: sign up with salon details or use an invitation link', new.email
      using errcode = 'check_violation';
  end if;

  /*
   * Which roster entry, if any, this login belongs to.
   *
   * The name falls back to the local part of the email only as a last resort:
   * a roster entry with a blank name would be unpickable in the booking form.
   */
  if v_invited and v_invite.team_member_id is not null then
    -- An existing person on the roster is being given a login. Confirm it is
    -- unclaimed; two logins sharing one roster entry would make "my earnings"
    -- ambiguous, and the unique constraint would refuse it anyway.
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

  insert into public.profiles (id, salon_id, role, full_name, email, team_member_id)
  values (new.id, v_salon_id, v_role, v_full_name, new.email, v_member_id);

  insert into public.audit_logs (
    salon_id, actor_id, actor_email, actor_role, action, entity_type, entity_id, metadata
  )
  values (
    v_salon_id, new.id, new.email, v_role, v_action, 'profile', new.id::text,
    jsonb_build_object(
      'role', v_role,
      'via', case when v_action = 'salon.created' then 'signup' else 'invitation' end,
      'team_member_id', v_member_id
    )
  );

  return new;
end;
$$;
