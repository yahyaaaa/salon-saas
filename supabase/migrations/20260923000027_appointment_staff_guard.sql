-- =============================================================================
-- One guard on who may be booked, not two
--
-- `guard_appointment_staff` has policed this since Phase 3, and it reads
-- `profiles`: the person must be an ACTIVE profile, must not be a
-- receptionist, and must be qualified for the service. After the Team/User
-- split none of the first two hold -- staff_id names a roster entry, which has
-- no profile and no role -- so every booking failed with "That team member is
-- not active", which is true of a row that does not exist.
--
-- Migration 24 added a second trigger doing the active check against the
-- roster, which was a mistake: two triggers asking overlapping questions about
-- the same column is how they drift apart. That one is dropped here and this
-- one is corrected instead.
--
-- What each check becomes:
--
--   active profile     -> active ROSTER entry
--   not a receptionist -> gone. "Performs services" is what being on the
--                         roster means; a receptionist who also does nails
--                         simply has an entry, and a pure administrator has
--                         none and so can never be booked.
--   qualified          -> unchanged. service_staff already repointed with it.
-- =============================================================================

drop trigger if exists appointments_guard_roster on public.appointments;
drop function if exists public.guard_appointment_staff_on_roster();

create or replace function public.guard_appointment_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active     boolean;
  v_restricted boolean;
begin
  select tm.is_active into v_active
  from public.team_members tm
  where tm.id = new.staff_id and tm.salon_id = new.salon_id;

  if v_active is null then
    raise exception 'That team member is not on this salon''s roster';
  end if;

  /*
   * Only a NEW booking is refused for an inactive member. An appointment
   * already in the diary when someone leaves still has to be completable or
   * cancellable -- refusing to let the front desk resolve it would strand it.
   */
  if tg_op = 'INSERT' and not v_active then
    raise exception 'That team member is no longer active';
  end if;

  select exists (
    select 1 from public.service_staff ss where ss.service_id = new.service_id
  ) into v_restricted;

  if v_restricted and not exists (
    select 1
    from public.service_staff ss
    where ss.service_id = new.service_id and ss.staff_id = new.staff_id
  ) then
    raise exception 'That team member is not qualified to perform this service';
  end if;

  return new;
end;
$$;
