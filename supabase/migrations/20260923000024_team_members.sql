-- =============================================================================
-- Phase 7a: the Team / User split
--
-- Until now "a team member" and "a login" were the same row: `profiles`, which
-- is keyed to an auth user and therefore requires an email address. That made
-- an email mandatory for anyone who performs a service, which is wrong for a
-- salon -- plenty of people on the floor have no reason to sign in, and
-- inventing an address for them puts a fictional account in the auth system.
--
-- So the two ideas separate:
--
--   team_members  the ROSTER. A name and a specialty. No email, no login, no
--                 auth user. This is who performs services and who gets paid.
--
--   profiles      a LOGIN. Still one row per auth user. Optionally linked to a
--                 roster entry via `team_member_id`, which is what lets a
--                 person see their own earnings.
--
-- The link is optional in both directions, deliberately:
--   * a roster entry with no login -- a therapist who never signs in;
--   * a login with no roster entry -- an office administrator who manages the
--     salon but performs nothing and earns no commission.
--
-- WHICH COLUMNS MOVE. The distinction is "who performed the work" versus
-- "which signed-in user did this":
--
--   moved to team_members   appointments.staff_id, receipt_line_items.staff_id,
--                           service_staff.staff_id, staff_compensation.staff_id,
--                           payroll_entries.staff_id, staff_documents.staff_id
--
--   stay on profiles        every *_by column -- created_by, issued_by,
--                           voided_by, collected_by, uploaded_by, recorded_by,
--                           resolved_by, paid_by, actor_id, invited_by. These
--                           record an ACTION taken by someone signed in, which
--                           is exactly what a login is for.
--
-- THIS IS ONE-WAY. Every existing profile gets a roster entry and every
-- existing reference is remapped, so no history is lost -- an appointment
-- still points at the same person. But there is no route back.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The roster
-- -----------------------------------------------------------------------------
create table public.team_members (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  full_name  text not null check (length(btrim(full_name)) between 1 and 160),
  -- Free text on purpose. A salon's idea of a speciality is its own, and a
  -- managed vocabulary here would be a list nobody maintains.
  specialty  text not null default '' check (length(specialty) <= 160),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, salon_id)
);

create index team_members_salon_idx on public.team_members (salon_id, full_name);

create trigger team_members_set_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

comment on table public.team_members is
  'The roster: who performs services and who is paid. No email and no login -- a login is an optional attachment, see profiles.team_member_id.';

-- -----------------------------------------------------------------------------
-- The optional login link
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column team_member_id uuid,
  -- One login per roster entry. Two people sharing a sign-in would make "my
  -- earnings" meaningless.
  add constraint profiles_team_member_unique unique (team_member_id),
  add constraint profiles_team_member_fk
    foreign key (team_member_id, salon_id)
      references public.team_members (id, salon_id) on delete set null (team_member_id);

comment on column public.profiles.team_member_id is
  'The roster entry this login belongs to, if any. NULL for an account that manages the salon but performs no services.';

-- -----------------------------------------------------------------------------
-- Who the caller is on the roster
--
-- The counterpart to current_salon_id(). SECURITY DEFINER so policies can call
-- it without recursing back through the profiles policies.
-- -----------------------------------------------------------------------------
create or replace function public.current_team_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.team_member_id
  from public.profiles p
  where p.id = (select auth.uid())
    and p.is_active
$$;

comment on function public.current_team_member_id() is
  'The roster entry linked to the signed-in user, or NULL -- a deactivated user, or a login that performs nothing.';

grant execute on function public.current_team_member_id() to authenticated, service_role;

-- =============================================================================
-- Backfill: every existing profile becomes a roster entry, and keeps its history
--
-- Receptionists and owners included. They may perform nothing, but the roster
-- is also what `staff_compensation` hangs off -- and a receptionist can be
-- salaried -- so leaving them off would make them unpayable.
-- =============================================================================
insert into public.team_members (id, salon_id, full_name, specialty, is_active)
select
  -- The roster entry deliberately reuses the profile's own id. Every existing
  -- staff_id already holds that value, so the remaps below are no-ops on the
  -- data and simply re-point the constraints -- which makes this migration far
  -- easier to verify than one that renumbers half the database.
  p.id,
  p.salon_id,
  coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)),
  '',
  p.is_active
from public.profiles p;

update public.profiles p set team_member_id = p.id;

-- =============================================================================
-- Repoint the six "who performed the work" columns
--
-- The ids are unchanged (see above), so each of these is a constraint swap
-- rather than a data migration. The ON DELETE behaviour of each is preserved
-- exactly: NO ACTION where a person with history must not vanish, CASCADE
-- where the row is meaningless without them, SET NULL where the record
-- outlives the person.
-- =============================================================================

alter table public.appointments
  drop constraint appointments_staff_id_salon_id_fkey,
  add constraint appointments_staff_id_salon_id_fkey
    foreign key (staff_id, salon_id)
      references public.team_members (id, salon_id) on delete no action;

alter table public.receipt_line_items
  drop constraint receipt_line_items_staff_id_salon_id_fkey,
  add constraint receipt_line_items_staff_id_salon_id_fkey
    foreign key (staff_id, salon_id)
      references public.team_members (id, salon_id) on delete set null (staff_id);

alter table public.service_staff
  drop constraint service_staff_staff_id_salon_id_fkey,
  add constraint service_staff_staff_id_salon_id_fkey
    foreign key (staff_id, salon_id)
      references public.team_members (id, salon_id) on delete cascade;

alter table public.staff_compensation
  drop constraint staff_compensation_staff_id_salon_id_fkey,
  add constraint staff_compensation_staff_id_salon_id_fkey
    foreign key (staff_id, salon_id)
      references public.team_members (id, salon_id) on delete cascade;

alter table public.payroll_entries
  drop constraint payroll_entries_staff_id_salon_id_fkey,
  add constraint payroll_entries_staff_id_salon_id_fkey
    foreign key (staff_id, salon_id)
      references public.team_members (id, salon_id) on delete set null (staff_id);

alter table public.staff_documents
  drop constraint staff_documents_staff_id_salon_id_fkey,
  add constraint staff_documents_staff_id_salon_id_fkey
    foreign key (staff_id, salon_id)
      references public.team_members (id, salon_id) on delete cascade;

-- =============================================================================
-- Row Level Security on the roster
-- =============================================================================
alter table public.team_members enable row level security;

-- The whole salon reads the roster: the front desk books against it, and a
-- receipt names who performed each line. It carries no pay and no contact
-- details, so there is nothing here a colleague should not see.
create policy team_members_select_own_salon
  on public.team_members for select to authenticated
  using (salon_id = public.current_salon_id());

create policy team_members_write_owner_only
  on public.team_members for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

-- =============================================================================
-- The policies that asked "is this me?"
--
-- Each compared a staff_id to auth.uid(), which only worked while the two were
-- the same thing. They now resolve the caller's roster entry instead, so a
-- login with no roster entry matches nothing -- which is correct: an account
-- that performs no services has no appointments and no earnings of its own.
-- =============================================================================

drop policy if exists appointments_select_permitted on public.appointments;
create policy appointments_select_permitted
  on public.appointments for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (
      public.current_app_role() in ('owner', 'receptionist')
      or staff_id = public.current_team_member_id()
    )
  );

drop policy if exists appointment_services_select_permitted on public.appointment_services;
create policy appointment_services_select_permitted
  on public.appointment_services for select to authenticated
  using (
    exists (
      select 1
      from public.appointments a
      where a.id = appointment_id
        and a.salon_id = public.current_salon_id()
        and (
          public.current_app_role() in ('owner', 'receptionist')
          or a.staff_id = public.current_team_member_id()
        )
    )
  );

drop policy if exists receipt_line_items_select_permitted on public.receipt_line_items;
create policy receipt_line_items_select_permitted
  on public.receipt_line_items for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (
      public.current_app_role() in ('owner', 'receptionist')
      or staff_id = public.current_team_member_id()
    )
  );

drop policy if exists payroll_entries_select_permitted on public.payroll_entries;
create policy payroll_entries_select_permitted
  on public.payroll_entries for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.is_owner() or staff_id = public.current_team_member_id())
  );

drop policy if exists staff_compensation_select_self_or_owner on public.staff_compensation;
create policy staff_compensation_select_self_or_owner
  on public.staff_compensation for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.is_owner() or staff_id = public.current_team_member_id())
  );

-- =============================================================================
-- Consent visibility
--
-- Still the one place that decides. Only the treating-therapist clause moves:
-- "an appointment I am treating" is now a question about my roster entry.
-- `collected_by` stays a profile -- collecting a form is an action taken by
-- someone signed in.
-- =============================================================================
create or replace function public.can_access_consent_form(
  p_salon_id       uuid,
  p_collected_by   uuid,
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
           and a.staff_id = public.current_team_member_id()
       )
     )
$$;

-- =============================================================================
-- Payroll: the run is built from the roster, not from the logins
--
-- This is what makes a team member with no login payable -- the whole point of
-- the split. `staff_name` now comes from the roster entry rather than from an
-- email address, which is also simply better on a payslip.
-- =============================================================================
create or replace function public.generate_payroll_period(
  p_starts_on date,
  p_ends_on   date,
  p_notes     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id   uuid := public.current_salon_id();
  v_actor      uuid := (select auth.uid());
  v_timezone   text;
  v_period_id  uuid := gen_random_uuid();
  v_revenue    numeric(12, 2);
  v_commission numeric(12, 2);
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if not public.is_owner() then
    raise exception 'Only the salon owner can run payroll';
  end if;
  if p_ends_on < p_starts_on then
    raise exception 'The end date cannot be before the start date';
  end if;

  select s.timezone into v_timezone from public.salons s where s.id = v_salon_id;
  v_timezone := coalesce(v_timezone, 'UTC');

  insert into public.payroll_periods
    (id, salon_id, starts_on, ends_on, notes, created_by)
  values
    (v_period_id, v_salon_id, p_starts_on, p_ends_on, coalesce(p_notes, ''), v_actor);

  insert into public.payroll_entries (
    salon_id, period_id, staff_id, staff_name,
    services_performed, revenue,
    commission_type, commission_basis, commission_rate, fixed_amount,
    salary_amount, salary_days_paid,
    salary_pay, commission_pay, commission_amount,
    period_starts_on, period_ends_on, status
  )
  with work as (
    select
      li.staff_id,
      sum(li.quantity)::integer as services_performed,
      round(sum(li.line_total), 2) as revenue,
      round(sum(
        public.line_commission(
          li.line_total, li.quantity,
          sc.commission_basis, sc.commission_rate, sc.fixed_amount,
          svc.commission_basis, svc.commission_rate, svc.commission_fixed
        )
      ), 2) as commission
    from public.receipt_line_items li
    join public.receipts r on r.id = li.receipt_id
    left join public.services svc
      on svc.id = li.service_id and svc.salon_id = v_salon_id
    left join public.staff_compensation sc
      on sc.staff_id = li.staff_id and sc.salon_id = v_salon_id
    where li.salon_id = v_salon_id
      and li.staff_id is not null
      and r.status = 'issued'
      and (li.performed_at at time zone v_timezone)::date between p_starts_on and p_ends_on
    group by li.staff_id
  ),
  people as (
    select tm.id as staff_id, tm.full_name as staff_name
    from public.team_members tm
    where tm.salon_id = v_salon_id
      and (
        exists (select 1 from work w where w.staff_id = tm.id)
        or (
          tm.is_active
          and exists (
            select 1 from public.staff_compensation sc
            where sc.staff_id = tm.id
              and sc.salon_id = v_salon_id
              and coalesce(sc.salary_amount, 0) > 0
          )
        )
      )
  )
  select
    v_salon_id,
    v_period_id,
    people.staff_id,
    people.staff_name,
    coalesce(work.services_performed, 0),
    coalesce(work.revenue, 0),
    case
      when coalesce(sc.salary_amount, 0) > 0 then 'fixed_salary'::public.commission_type
      when sc.commission_basis = 'fixed_per_service' then 'fixed_per_service'::public.commission_type
      else 'percentage'::public.commission_type
    end,
    sc.commission_basis,
    coalesce(sc.commission_rate, 0),
    coalesce(sc.fixed_amount, 0),
    coalesce(sc.salary_amount, 0),
    case
      when coalesce(sc.salary_amount, 0) > 0
        then public.payable_days(p_starts_on, p_ends_on, sc.joining_date)
      else 0
    end,
    case
      when coalesce(sc.salary_amount, 0) > 0
        then public.prorated_salary(sc.salary_amount, p_starts_on, p_ends_on, sc.joining_date)
      else 0
    end,
    coalesce(work.commission, 0),
    round(
      case
        when coalesce(sc.salary_amount, 0) > 0
          then public.prorated_salary(sc.salary_amount, p_starts_on, p_ends_on, sc.joining_date)
        else 0
      end
      + coalesce(work.commission, 0),
      2
    ),
    p_starts_on,
    p_ends_on,
    'draft'
  from people
  left join work on work.staff_id = people.staff_id
  left join public.staff_compensation sc
    on sc.staff_id = people.staff_id and sc.salon_id = v_salon_id;

  select coalesce(sum(e.revenue), 0), coalesce(sum(e.commission_amount), 0)
  into v_revenue, v_commission
  from public.payroll_entries e where e.period_id = v_period_id;

  update public.payroll_periods
  set total_revenue = v_revenue, total_commission = v_commission
  where id = v_period_id;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, 'owner', 'payroll.generated', 'payroll_period', v_period_id::text,
    jsonb_build_object(
      'starts_on', p_starts_on, 'ends_on', p_ends_on,
      'total_revenue', v_revenue, 'total_commission', v_commission
    )
  );

  return v_period_id;
end;
$$;

revoke execute on function public.generate_payroll_period(date, date, text) from public;
grant execute on function public.generate_payroll_period(date, date, text)
  to authenticated, service_role;

-- =============================================================================
-- Booking against the roster
--
-- create_appointment() took a staff_id and let the foreign key check it. That
-- still works, but the error a broken key produces is unreadable, and an
-- INACTIVE roster member should be refused rather than merely absent from the
-- dropdown.
-- =============================================================================
create or replace function public.guard_appointment_staff_on_roster()
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
    raise exception 'That team member is not on this salon''s roster';
  end if;

  -- An existing booking may be edited or completed after the person leaves;
  -- only a NEW booking is refused.
  if tg_op = 'INSERT' and not v_active then
    raise exception 'That team member is no longer active';
  end if;

  return new;
end;
$$;

create trigger appointments_guard_roster
  before insert or update of staff_id on public.appointments
  for each row execute function public.guard_appointment_staff_on_roster();
