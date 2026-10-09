-- =============================================================================
-- A module is a DELEGATED power, not access to your own work
--
-- The seeded Staff / Therapist role was given the `calendar` module, on the
-- reasoning that a therapist uses the diary. That was wrong, and the isolation
-- suite caught it immediately: `calendar` guards writing to the diary, so
-- every therapist could suddenly book, reschedule and cancel appointments for
-- the whole salon -- a front-desk power they have never had.
--
-- The distinction that makes the model coherent:
--
--   a module        something the owner DELEGATES -- managing the diary for
--                   everyone, taking payment, running payroll
--
--   your own work   never a module. Every policy that needs it already says
--                   `or staff_id = current_team_member_id()`, so a therapist
--                   reads their own appointments, their own receipt lines,
--                   their own pay settings and their own payslips whatever
--                   their role holds -- including a role holding nothing.
--
-- So Staff / Therapist ships with NO modules, and still sees its own diary and
-- its own earnings. That restores the pre-Phase-7 behaviour exactly, which is
-- what the regression is for.
-- =============================================================================

delete from public.role_modules rm
using public.roles r
where rm.role_id = r.id
  and r.is_system
  and r.name = 'Staff / Therapist'
  and rm.module = 'calendar';

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

  /*
   * Staff / Therapist: no modules at all, deliberately. They see their own
   * appointments, their own service history and their own earnings through
   * the "or it is mine" clause on each policy, which no module controls.
   */
  insert into public.roles (salon_id, name, is_system)
  values (p_salon_id, 'Staff / Therapist', true)
  on conflict do nothing;

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
