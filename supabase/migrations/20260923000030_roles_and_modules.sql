-- =============================================================================
-- Phase 7b: roles with module permissions
--
-- Access has been decided by a three-value enum on the login -- owner, staff,
-- receptionist -- and every policy asked that enum directly. Two problems:
--
--   1. A salon cannot describe the people it actually employs. An accountant
--      needs Reports and Payroll and nothing else; there is no way to say so.
--   2. "Receptionist" means one fixed set of powers in every salon, and no
--      owner can narrow or widen it.
--
-- So a role becomes a row the owner can create, name and tick modules for.
--
-- THE OWNER ROLE IS SPECIAL, AND NOT ASSIGNABLE. Exactly one per salon, made
-- at signup and held by the account that created it. It implies every module
-- -- including ones added in future releases, which is the point of it being a
-- flag rather than a full set of ticks. Nobody can be moved into or out of it,
-- because "who owns this salon" is not a permission setting: an owner who
-- could hand the role over, or an admin who could grant it to themselves, is
-- a privilege-escalation path dressed up as a dropdown.
--
-- WHERE THIS IS ENFORCED. In Postgres, as everything else is. `has_module()`
-- replaces `current_app_role()` inside the policies themselves, so a page that
-- forgets to check, or a request that skips the app entirely, still cannot
-- read another module's rows. The nav hiding a link is a convenience on top.
-- =============================================================================

create type public.app_module as enum (
  'calendar',   -- the diary, bookings, appointment services
  'customers',  -- customer profiles and their consent records
  'pos',        -- the till, receipts, loyalty, payments
  'services',   -- the catalogue, deals, consent templates
  'payroll',    -- pay settings and payroll runs
  'reports',    -- the reporting suite
  'team',       -- the roster, accounts, invitations, roles
  'audit',      -- the audit log
  'settings'    -- salon settings
);

comment on type public.app_module is
  'A grantable area of the product. Adding a value here grants it to nobody until a role ticks it -- except the owner, who has every module by definition.';

-- -----------------------------------------------------------------------------
-- roles
-- -----------------------------------------------------------------------------
create table public.roles (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 2 and 60),
  -- The salon owner's role. Implies every module, cannot be assigned, cannot
  -- be deleted, and there is exactly one.
  is_owner   boolean not null default false,
  -- Shipped with the product. Its modules are editable; the role itself
  -- cannot be deleted, so a salon cannot end up with nothing to assign.
  is_system  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, salon_id)
);

create unique index roles_salon_name_key on public.roles (salon_id, lower(btrim(name)));
create unique index roles_one_owner_per_salon on public.roles (salon_id) where is_owner;

create trigger roles_set_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- role_modules -- the ticks
-- -----------------------------------------------------------------------------
create table public.role_modules (
  salon_id uuid not null references public.salons (id) on delete cascade,
  role_id  uuid not null,
  module   public.app_module not null,
  primary key (role_id, module),
  foreign key (role_id, salon_id) references public.roles (id, salon_id) on delete cascade
);

create index role_modules_salon_idx on public.role_modules (salon_id);

-- -----------------------------------------------------------------------------
-- Which role a login holds
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column role_id uuid,
  add constraint profiles_role_fk
    foreign key (role_id, salon_id)
      references public.roles (id, salon_id) on delete no action;

comment on column public.profiles.role_id is
  'The role this login holds. The authority on what they may do -- profiles.role is now only a coarse label kept for display and for invitations.';

alter table public.invitations add column role_id uuid;
alter table public.invitations
  add constraint invitations_role_fk
    foreign key (role_id, salon_id)
      references public.roles (id, salon_id) on delete set null (role_id);

-- =============================================================================
-- The roles every salon starts with
--
-- Their module sets reproduce exactly what each old enum value could do, so
-- nobody gains or loses access in the migration. Accountant is new -- it is the
-- example the brief gives of a role the old model could not express at all.
-- =============================================================================
create or replace function public.seed_default_roles(p_salon_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_id uuid;
begin
  -- Owner: no ticks, because is_owner implies everything.
  insert into public.roles (salon_id, name, is_owner, is_system)
  values (p_salon_id, 'Owner', true, true)
  on conflict do nothing;

  insert into public.roles (salon_id, name, is_system)
  values (p_salon_id, 'Staff / Therapist', true)
  on conflict do nothing
  returning id into v_role_id;

  if v_role_id is not null then
    -- Their own diary and nothing else. "My earnings" is not a module: it is
    -- always available and shows only the holder's own figures.
    insert into public.role_modules (salon_id, role_id, module)
    values (p_salon_id, v_role_id, 'calendar');
  end if;

  insert into public.roles (salon_id, name, is_system)
  values (p_salon_id, 'Receptionist', true)
  on conflict do nothing
  returning id into v_role_id;

  if v_role_id is not null then
    insert into public.role_modules (salon_id, role_id, module)
    select p_salon_id, v_role_id, m
    from unnest(array['calendar', 'customers', 'pos']::public.app_module[]) m;
  end if;

  insert into public.roles (salon_id, name, is_system)
  values (p_salon_id, 'Accountant', true)
  on conflict do nothing
  returning id into v_role_id;

  if v_role_id is not null then
    insert into public.role_modules (salon_id, role_id, module)
    select p_salon_id, v_role_id, m
    from unnest(array['reports', 'payroll']::public.app_module[]) m;
  end if;
end;
$$;

grant execute on function public.seed_default_roles(uuid) to service_role;

-- Every existing salon gets them, and every existing login is moved onto the
-- role matching the enum value it already had.
do $$
declare
  v_salon record;
begin
  for v_salon in select id from public.salons loop
    perform public.seed_default_roles(v_salon.id);
  end loop;
end;
$$;

update public.profiles p
set role_id = r.id
from public.roles r
where r.salon_id = p.salon_id
  and (
    (p.role = 'owner'        and r.is_owner)
    or (p.role = 'staff'        and r.name = 'Staff / Therapist')
    or (p.role = 'receptionist' and r.name = 'Receptionist')
  );

-- =============================================================================
-- The two questions every policy asks
-- =============================================================================

/**
 * Does the caller hold this module?
 *
 * SECURITY DEFINER so it can read profiles and roles without recursing through
 * their own policies, and STABLE so a policy calling it many times in one
 * statement pays for it once.
 *
 * A deactivated login holds nothing, which is the same rule current_salon_id()
 * already applies -- access is revoked in one place.
 */
create or replace function public.has_module(p_module public.app_module)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.id = p.role_id and r.salon_id = p.salon_id
    where p.id = (select auth.uid())
      and p.is_active
      and (
        -- The owner holds every module, including ones that do not exist yet.
        r.is_owner
        or exists (
          select 1 from public.role_modules rm
          where rm.role_id = r.id and rm.module = p_module
        )
      )
  );
$$;

grant execute on function public.has_module(public.app_module) to authenticated, service_role;

/**
 * Is the caller the salon's owner?
 *
 * Same name and same meaning as before, but it now reads the role rather than
 * the enum on the profile, so there is one answer to "who owns this salon"
 * rather than two that can disagree.
 */
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.roles r on r.id = p.role_id and r.salon_id = p.salon_id
    where p.id = (select auth.uid())
      and p.is_active
      and r.is_owner
  );
$$;

-- =============================================================================
-- Row Level Security on the roles themselves
-- =============================================================================
alter table public.roles        enable row level security;
alter table public.role_modules enable row level security;

-- Everyone reads the role list: the Team page shows it, and a person seeing
-- what their own role is called is not a leak.
create policy roles_select_own_salon
  on public.roles for select to authenticated
  using (salon_id = public.current_salon_id());

-- Only someone with the Team module may change them -- and never the owner
-- role, which the guard trigger below refuses outright.
create policy roles_write_team_module
  on public.roles for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('team'))
  with check (salon_id = public.current_salon_id() and public.has_module('team'));

create policy role_modules_select_own_salon
  on public.role_modules for select to authenticated
  using (salon_id = public.current_salon_id());

create policy role_modules_write_team_module
  on public.role_modules for all to authenticated
  using (salon_id = public.current_salon_id() and public.has_module('team'))
  with check (salon_id = public.current_salon_id() and public.has_module('team'));

-- =============================================================================
-- Guard rails on the owner role
--
-- The policy above lets anyone holding the Team module edit roles, which is
-- the point. These triggers stop that becoming a way to seize the salon.
-- =============================================================================
create or replace function public.guard_owner_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A salon being closed takes its roles with it.
  if not exists (
    select 1 from public.salons s where s.id = coalesce(new.salon_id, old.salon_id)
  ) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception 'The owner role cannot be deleted';
    end if;
    if old.is_system then
      raise exception 'A built-in role cannot be deleted; take everyone off it instead';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' and new.is_owner then
    raise exception 'The owner role is created with the salon and cannot be added';
  end if;

  if tg_op = 'UPDATE' then
    if old.is_owner <> new.is_owner then
      raise exception 'A role cannot be turned into the owner role, or out of it';
    end if;
    if old.is_owner and btrim(old.name) <> btrim(new.name) then
      raise exception 'The owner role cannot be renamed';
    end if;
  end if;

  return new;
end;
$$;

create trigger roles_guard_owner
  before insert or update or delete on public.roles
  for each row execute function public.guard_owner_role();

-- Ticking modules onto the owner role is meaningless -- it holds everything --
-- and letting rows accumulate there would suggest otherwise.
create or replace function public.guard_owner_role_modules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.roles r
    where r.id = coalesce(new.role_id, old.role_id) and r.is_owner
  ) then
    raise exception 'The owner role already holds every module';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create trigger role_modules_guard_owner
  before insert or update or delete on public.role_modules
  for each row execute function public.guard_owner_role_modules();
