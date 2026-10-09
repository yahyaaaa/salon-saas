-- =============================================================================
-- Service qualifications point at the roster too
--
-- The last of the guards that inferred "may perform a treatment" from a role
-- on a login. `guard_service_staff_role` read `profiles.role` and refused
-- receptionists; since `service_staff.staff_id` now names a roster entry, it
-- found no profile at all and refused everyone.
--
-- Same resolution as the appointment guard in migration 27: the question is
-- whether they are on this salon's roster, because that is what being able to
-- perform a service now means. The function keeps its name -- it is wired to a
-- trigger, and renaming it would only make the history harder to follow.
-- =============================================================================

create or replace function public.guard_service_staff_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean;
begin
  select tm.is_active into v_active
  from public.team_members tm
  where tm.id = new.staff_id and tm.salon_id = new.salon_id;

  if v_active is null then
    raise exception 'Only someone on this salon''s roster can be assigned to perform a service';
  end if;

  return new;
end;
$$;

comment on function public.guard_service_staff_role() is
  'A service may only be assigned to a member of the same salon''s roster.';
