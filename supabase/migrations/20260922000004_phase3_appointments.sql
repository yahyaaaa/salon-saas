-- =============================================================================
-- Phase 3: Appointment / booking calendar
--
-- Adds `appointments`, and links consent forms to the appointment they were
-- collected for so the treating therapist can see them.
-- =============================================================================

-- Needed for the exclusion constraint below: it mixes an equality test on a
-- uuid with an overlap test on a range, which plain GiST cannot index.
create extension if not exists btree_gist with schema extensions;

create type public.appointment_status as enum (
  'booked', 'confirmed', 'completed', 'cancelled', 'no_show'
);

-- -----------------------------------------------------------------------------
-- appointments
--
-- `ends_at` is stored rather than derived so the slot a booking occupies stays
-- fixed even if the service's duration is edited afterwards. Likewise
-- `price_at_booking`: Phase 4 bills what was quoted, not today's price list.
-- -----------------------------------------------------------------------------
create table public.appointments (
  id                  uuid primary key default gen_random_uuid(),
  salon_id            uuid not null references public.salons (id) on delete cascade,
  customer_id         uuid not null,
  staff_id            uuid not null,
  service_id          uuid not null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  status              public.appointment_status not null default 'booked',
  is_walk_in          boolean not null default false,
  notes               text not null default '',
  price_at_booking    numeric(12, 2) not null check (price_at_booking >= 0),
  created_by          uuid,
  -- Cancellation and no-show must carry a reason and a timestamp: the brief
  -- feeds both into reporting.
  resolution_reason   text,
  resolved_at         timestamptz,
  resolved_by         uuid,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (id, salon_id),
  constraint appointments_period_valid check (ends_at > starts_at),
  constraint appointments_reason_required check (
    status not in ('cancelled', 'no_show')
    or (resolution_reason is not null and length(btrim(resolution_reason)) > 0)
  ),
  foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete restrict,
  foreign key (staff_id, salon_id)
    references public.profiles (id, salon_id) on delete restrict,
  foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete restrict,
  foreign key (created_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (created_by),
  foreign key (resolved_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (resolved_by)
);

create index appointments_salon_start_idx on public.appointments (salon_id, starts_at);
create index appointments_staff_start_idx on public.appointments (staff_id, starts_at);
create index appointments_customer_idx on public.appointments (customer_id, starts_at desc);

create trigger appointments_set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

-- A therapist cannot be in two places at once.
--
-- Enforced as an exclusion constraint rather than a "check for conflicts then
-- insert" in application code, which would race: two receptionists booking the
-- same slot at the same moment would both see a free slot and both succeed.
--
-- Walk-ins are excluded from the constraint on purpose. The brief calls for
-- them to skip slot conflict checks, so they neither cause a conflict nor
-- suffer one -- they are squeezed in alongside whatever is already booked.
-- Cancelled and no-show appointments stop occupying their slot.
alter table public.appointments
  add constraint appointments_no_double_booking
  exclude using gist (
    staff_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
  where (status in ('booked', 'confirmed', 'completed') and not is_walk_in);

-- -----------------------------------------------------------------------------
-- Link consent forms to the appointment they belong to.
-- -----------------------------------------------------------------------------
alter table public.consent_forms
  add constraint consent_forms_appointment_fkey
  foreign key (appointment_id, salon_id)
    references public.appointments (id, salon_id) on delete set null (appointment_id);

create index consent_forms_appointment_idx on public.consent_forms (appointment_id);

-- =============================================================================
-- Consent visibility, widened
--
-- Until now a therapist could see only the forms they collected themselves.
-- The brief also requires the treating staff member to see consent for their
-- own bookings, so the rule gains a third input: the linked appointment.
--
-- This is still the single source of truth -- the storage policies on signature
-- images call the same function, so widening it here widens both at once.
-- =============================================================================
create or replace function public.can_access_consent_form(
  p_salon_id uuid,
  p_collected_by uuid,
  p_appointment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_salon_id is not null
     and p_salon_id = public.current_salon_id()
     and (
       -- Owners and receptionists work across the whole salon's records.
       public.current_app_role() in ('owner', 'receptionist')
       -- A therapist sees what they collected themselves...
       or p_collected_by = (select auth.uid())
       -- ...and whatever belongs to an appointment they are treating.
       or exists (
         select 1
         from public.appointments a
         where a.id = p_appointment_id
           and a.salon_id = p_salon_id
           and a.staff_id = (select auth.uid())
       )
     )
$$;

revoke execute on function public.can_access_consent_form(uuid, uuid, uuid) from public;
grant execute on function public.can_access_consent_form(uuid, uuid, uuid)
  to authenticated, service_role;

-- Repoint the existing policies at the three-argument version, then retire the
-- two-argument one so there is only ever one definition of this rule.
alter policy consent_forms_select_permitted
  on public.consent_forms
  using (public.can_access_consent_form(salon_id, collected_by, appointment_id));

alter policy consent_form_responses_select_permitted
  on public.consent_form_responses
  using (
    exists (
      select 1
      from public.consent_forms f
      where f.id = form_id
        and public.can_access_consent_form(f.salon_id, f.collected_by, f.appointment_id)
    )
  );

alter policy consent_signatures_select
  on storage.objects
  using (
    bucket_id = 'consent-signatures'
    and (storage.foldername(name))[1] = public.current_salon_id()::text
    and exists (
      select 1
      from public.consent_forms f
      where f.signature_path = storage.objects.name
        and public.can_access_consent_form(f.salon_id, f.collected_by, f.appointment_id)
    )
  );

drop function if exists public.can_access_consent_form(uuid, uuid);

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.appointments enable row level security;

-- Owners and receptionists run the diary. A therapist sees their own column of
-- it and nothing else -- explicitly not other staff members' schedules.
create policy appointments_select_permitted
  on public.appointments for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (
      public.current_app_role() in ('owner', 'receptionist')
      or staff_id = (select auth.uid())
    )
  );

-- Booking and managing the diary is a front-desk job, per the brief: a
-- therapist has no write access to appointments at all.
create policy appointments_insert_front_desk
  on public.appointments for insert to authenticated
  with check (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

create policy appointments_update_front_desk
  on public.appointments for update to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  )
  with check (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

-- Appointments are never deleted: a cancellation is a status plus a reason, and
-- reporting needs the row. There is deliberately no DELETE policy.

-- =============================================================================
-- Guard rails
-- =============================================================================

-- Once an appointment reaches a terminal state it stops being editable, and the
-- stamps that reporting depends on are set here rather than trusted from the
-- client.
create or replace function public.guard_appointment_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('completed', 'cancelled', 'no_show')
     and new.status is distinct from old.status then
    raise exception 'This appointment is already %; it cannot be changed', old.status;
  end if;

  if new.salon_id is distinct from old.salon_id then
    raise exception 'An appointment cannot be moved between salons';
  end if;

  if new.status is distinct from old.status then
    if new.status in ('cancelled', 'no_show') then
      new.resolved_at := now();
      new.resolved_by := (select auth.uid());
    elsif new.status = 'completed' then
      new.completed_at := now();
    end if;
  end if;

  return new;
end;
$$;

create trigger appointments_guard_transition
  before update on public.appointments
  for each row execute function public.guard_appointment_transition();

-- Only someone qualified for the service may be booked to perform it. An empty
-- service_staff set means "anyone", which is how the catalogue reads it too.
create or replace function public.guard_appointment_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role       public.user_role;
  v_restricted boolean;
begin
  select p.role into v_role
  from public.profiles p
  where p.id = new.staff_id and p.is_active;

  if v_role is null then
    raise exception 'That team member is not active';
  end if;

  if v_role = 'receptionist' then
    raise exception 'Receptionists do not perform treatments';
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

create trigger appointments_guard_staff
  before insert or update of staff_id, service_id on public.appointments
  for each row execute function public.guard_appointment_staff();
