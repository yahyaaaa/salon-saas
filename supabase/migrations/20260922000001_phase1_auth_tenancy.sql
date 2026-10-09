-- =============================================================================
-- Phase 1: Auth + multi-tenant scaffolding
-- Tables: salons, profiles, salon_settings, invitations, audit_logs
-- Every table except `salons` carries salon_id and is guarded by RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.user_role as enum ('owner', 'staff', 'receptionist');

create type public.business_type as enum ('salon', 'aesthetic_clinic');

-- Mirrors the Stripe subscription status values we care about (wired up in Phase 8).
create type public.subscription_status as enum (
  'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid'
);

create type public.invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- salons -- the tenant root. The only table without a salon_id column.
-- -----------------------------------------------------------------------------
create table public.salons (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(btrim(name)) between 1 and 200),
  business_type          public.business_type not null default 'salon',
  country                text not null default 'US',
  timezone               text not null default 'UTC',
  currency               text not null default 'USD',
  -- Billing (Phase 8 populates these; Phase 1 just seeds the trial window).
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  subscription_status    public.subscription_status not null default 'trialing',
  trial_ends_at          timestamptz not null default now() + interval '14 days',
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger salons_set_updated_at
  before update on public.salons
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- profiles -- application user record, 1:1 with auth.users, scoped to one salon.
-- A user belongs to exactly one salon. Second locations = separate accounts.
-- -----------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  salon_id   uuid not null references public.salons (id) on delete cascade,
  role       public.user_role not null,
  full_name  text not null default '',
  email      text not null,
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_salon_id_idx on public.profiles (salon_id);
create index profiles_salon_role_idx on public.profiles (salon_id, role) where is_active;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- salon_settings -- one row per salon, created automatically at signup.
-- loyalty_earn_rate lives here so the 5% default is configurable, never hardcoded.
-- -----------------------------------------------------------------------------
create table public.salon_settings (
  salon_id          uuid primary key references public.salons (id) on delete cascade,
  loyalty_earn_rate numeric(6, 4) not null default 0.0500
    check (loyalty_earn_rate >= 0 and loyalty_earn_rate <= 1),
  business_hours    jsonb not null default jsonb_build_object(
    'mon', jsonb_build_object('open', '09:00', 'close', '18:00', 'closed', false),
    'tue', jsonb_build_object('open', '09:00', 'close', '18:00', 'closed', false),
    'wed', jsonb_build_object('open', '09:00', 'close', '18:00', 'closed', false),
    'thu', jsonb_build_object('open', '09:00', 'close', '18:00', 'closed', false),
    'fri', jsonb_build_object('open', '09:00', 'close', '18:00', 'closed', false),
    'sat', jsonb_build_object('open', '10:00', 'close', '16:00', 'closed', false),
    'sun', jsonb_build_object('open', '10:00', 'close', '16:00', 'closed', true)
  ),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger salon_settings_set_updated_at
  before update on public.salon_settings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- invitations -- owner invites staff/receptionists by email with a preset role.
-- The row must exist BEFORE the Supabase Auth invite is sent: the auth.users
-- trigger below reads it to decide which salon the new user joins.
-- -----------------------------------------------------------------------------
create table public.invitations (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null references public.salons (id) on delete cascade,
  email            text not null check (position('@' in email) > 1),
  role             public.user_role not null,
  full_name        text not null default '',
  status           public.invitation_status not null default 'pending',
  invited_by       uuid references public.profiles (id) on delete set null,
  accepted_user_id uuid references auth.users (id) on delete set null,
  accepted_at      timestamptz,
  expires_at       timestamptz not null default now() + interval '7 days',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index invitations_salon_id_idx on public.invitations (salon_id);
create index invitations_email_idx on public.invitations (lower(email));

-- Only one live invite per email per salon.
create unique index invitations_one_pending_per_email
  on public.invitations (salon_id, lower(email))
  where status = 'pending';

create trigger invitations_set_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- audit_logs -- append-only. No update/delete policy exists, by design.
-- Threaded through every feature as it is built, not bolted on at the end.
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  salon_id    uuid not null references public.salons (id) on delete cascade,
  actor_id    uuid references public.profiles (id) on delete set null,
  actor_email text,
  actor_role  public.user_role,
  action      text not null,
  entity_type text,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index audit_logs_salon_created_idx on public.audit_logs (salon_id, created_at desc);
create index audit_logs_salon_actor_idx on public.audit_logs (salon_id, actor_id, created_at desc);
create index audit_logs_salon_action_idx on public.audit_logs (salon_id, action, created_at desc);

-- =============================================================================
-- Tenancy helpers
--
-- These are SECURITY DEFINER so they can read public.profiles without being
-- filtered by the very policies they are used in (which would recurse).
-- Every RLS policy in this project resolves the tenant through these.
-- =============================================================================

-- The caller's salon. NULL for anonymous callers and for deactivated users --
-- which means a deactivated user's queries match no rows anywhere.
create or replace function public.current_salon_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.salon_id
  from public.profiles p
  where p.id = (select auth.uid())
    and p.is_active
$$;

create or replace function public.current_app_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.is_active
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() = 'owner', false)
$$;

revoke execute on function public.current_salon_id() from public;
revoke execute on function public.current_app_role() from public;
revoke execute on function public.is_owner() from public;
grant execute on function public.current_salon_id() to authenticated, service_role;
grant execute on function public.current_app_role() to authenticated, service_role;
grant execute on function public.is_owner() to authenticated, service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.salons         enable row level security;
alter table public.profiles       enable row level security;
alter table public.salon_settings enable row level security;
alter table public.invitations    enable row level security;
alter table public.audit_logs     enable row level security;

-- Note on FORCE ROW LEVEL SECURITY: deliberately not used. Roles that own
-- these tables (postgres, service_role) carry BYPASSRLS, which outranks FORCE,
-- so it would buy nothing here -- while breaking the SECURITY DEFINER signup
-- trigger on any deployment where that is not the case. The roles that matter,
-- `authenticated` and `anon`, own nothing and are fully governed by the
-- policies below.

-- --- salons -------------------------------------------------------------------
-- Readable only by members of that salon. Created exclusively by the signup
-- trigger (SECURITY DEFINER) -- there is deliberately no INSERT policy.
create policy salons_select_own_tenant
  on public.salons for select
  to authenticated
  using (id = public.current_salon_id());

create policy salons_update_owner_only
  on public.salons for update
  to authenticated
  using (id = public.current_salon_id() and public.is_owner())
  with check (id = public.current_salon_id() and public.is_owner());

-- --- profiles -----------------------------------------------------------------
-- Everyone in a salon can see their colleagues (receptionists need the staff
-- list to book against). Sensitive figures such as commission rates live in
-- their own owner-only table in Phase 5, never on this row.
create policy profiles_select_own_tenant
  on public.profiles for select
  to authenticated
  using (salon_id = public.current_salon_id());

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and salon_id = public.current_salon_id());

create policy profiles_update_owner_manages_tenant
  on public.profiles for update
  to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

-- --- salon_settings -----------------------------------------------------------
create policy salon_settings_select_own_tenant
  on public.salon_settings for select
  to authenticated
  using (salon_id = public.current_salon_id());

create policy salon_settings_update_owner_only
  on public.salon_settings for update
  to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy salon_settings_insert_owner_only
  on public.salon_settings for insert
  to authenticated
  with check (salon_id = public.current_salon_id() and public.is_owner());

-- --- invitations --------------------------------------------------------------
-- Staff management is owner-only, so invitations are invisible to other roles.
create policy invitations_select_owner_only
  on public.invitations for select
  to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner());

create policy invitations_insert_owner_only
  on public.invitations for insert
  to authenticated
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy invitations_update_owner_only
  on public.invitations for update
  to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy invitations_delete_owner_only
  on public.invitations for delete
  to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner());

-- --- audit_logs ---------------------------------------------------------------
-- Readable by owners only. Writable by any member of the salon (features log as
-- they act), but never updatable or deletable -- no such policy exists.
create policy audit_logs_select_owner_only
  on public.audit_logs for select
  to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner());

create policy audit_logs_insert_own_tenant
  on public.audit_logs for insert
  to authenticated
  with check (
    salon_id = public.current_salon_id()
    and actor_id = (select auth.uid())
  );

-- =============================================================================
-- Guard rails
-- =============================================================================

-- A user's salon and their own role are not self-service fields.
create or replace function public.guard_profile_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.salon_id is distinct from old.salon_id then
    raise exception 'A user cannot be moved between salons';
  end if;

  if new.id is distinct from old.id then
    raise exception 'Profile id is immutable';
  end if;

  -- Nobody changes their own role or reactivates themselves, owners included.
  if new.id = (select auth.uid()) then
    if new.role is distinct from old.role then
      raise exception 'You cannot change your own role';
    end if;
    if new.is_active is distinct from old.is_active then
      raise exception 'You cannot change your own active status';
    end if;
  end if;

  return new;
end;
$$;

create trigger profiles_guard_changes
  before update on public.profiles
  for each row execute function public.guard_profile_changes();

-- Every salon must keep at least one active owner.
create or replace function public.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_owners int;
begin
  if old.role = 'owner' and old.is_active
     and (new.role is distinct from 'owner' or not new.is_active) then
    select count(*) into v_active_owners
    from public.profiles p
    where p.salon_id = old.salon_id
      and p.role = 'owner'
      and p.is_active
      and p.id <> old.id;

    if v_active_owners = 0 then
      raise exception 'A salon must always have at least one active owner';
    end if;
  end if;

  return new;
end;
$$;

create trigger profiles_guard_last_owner
  before update on public.profiles
  for each row execute function public.guard_last_owner();

-- =============================================================================
-- Signup / invite acceptance
--
-- Fires when Supabase Auth creates a user, for both paths:
--   1. Owner self-signup   -> raw_user_meta_data carries salon_name etc.
--   2. Invited team member -> a pending invitations row decides salon + role.
-- Raising here aborts the auth user creation, so we never strand an auth user
-- without a profile (and therefore without a tenant).
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

  insert into public.profiles (id, salon_id, role, full_name, email)
  values (new.id, v_salon_id, v_role, v_full_name, new.email);

  insert into public.audit_logs (
    salon_id, actor_id, actor_email, actor_role, action, entity_type, entity_id, metadata
  )
  values (
    v_salon_id, new.id, new.email, v_role, v_action, 'profile', new.id::text,
    jsonb_build_object(
      'role', v_role,
      'via', case when v_action = 'salon.created' then 'signup' else 'invitation' end
    )
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the profile's email in step if the user changes it in Supabase Auth.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();
