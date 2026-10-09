-- =============================================================================
-- Pay, restructured: salary and commission become independent
--
-- WHAT WAS WRONG. `staff_compensation.commission_type` was a single enum, and
-- payroll picked exactly one branch from it: 'fixed_salary' paid a salary and
-- no commission, 'percentage' and 'fixed_per_service' paid commission and no
-- salary. A base salary WITH commission on top -- the commonest arrangement in
-- a salon -- could not be expressed at all, and `salary_amount` sitting on a
-- percentage row was silently ignored.
--
-- So the one axis becomes two:
--
--   salary      salary_amount (0 = none), pro-rated from joining_date
--   commission  commission_basis, which is its own setting entirely
--
-- and pay = salary + commission. The three models then fall out of the data
-- rather than being special cases in the code:
--
--   salary-only      salary > 0, basis 'none'
--   commission-only  salary = 0, basis percentage | fixed_per_service | null
--   hybrid           salary > 0, basis percentage | fixed_per_service | null
--
-- WHY commission_basis HAS THREE STATES AND NOT TWO. Services now carry their
-- own default rate, so the absence of a staff rate has to mean "fall back to
-- the service". That leaves no way to say "this person earns no commission at
-- all" -- which is exactly what salary-only means. Hence:
--
--   'none'                explicitly no commission; service defaults ignored
--   null                  not set; use whatever the service says
--   'percentage'          a personal % of what they sell
--   'fixed_per_service'   a personal flat amount per service performed
--
-- PRECEDENCE, per performed service line:
--
--   1. the staff member's own basis, if set -- including an explicit 'none',
--      and including a deliberate 0%, both of which beat the service default
--   2. otherwise the service's own default
--   3. otherwise no commission on that line
--
-- MIGRATING THE EXISTING ROWS. A 'fixed_salary' row becomes salary + basis
-- 'none', which preserves today's behaviour exactly -- those people earn their
-- salary and no commission, as they do now. The other two bases carry across
-- unchanged with salary 0.
-- =============================================================================

create type public.commission_basis as enum ('none', 'percentage', 'fixed_per_service');

-- -----------------------------------------------------------------------------
-- staff_compensation
-- -----------------------------------------------------------------------------
alter table public.staff_compensation
  add column commission_basis public.commission_basis;

comment on column public.staff_compensation.commission_basis is
  'How this person earns commission. NULL means unset -- fall back to the service''s own default. ''none'' means explicitly no commission.';

-- The rate columns become nullable so "unset" is distinguishable from a
-- deliberate zero. NOT NULL DEFAULT 0 made every row look configured.
alter table public.staff_compensation
  alter column commission_rate drop not null,
  alter column commission_rate drop default,
  alter column fixed_amount    drop not null,
  alter column fixed_amount    drop default;

update public.staff_compensation
set commission_basis = case commission_type
                         when 'fixed_salary'      then 'none'::public.commission_basis
                         when 'percentage'        then 'percentage'::public.commission_basis
                         when 'fixed_per_service' then 'fixed_per_service'::public.commission_basis
                       end,
    -- A salaried row's rate columns were never read; leave them genuinely unset
    -- rather than carrying a meaningless zero forward.
    commission_rate = case when commission_type = 'percentage'        then commission_rate end,
    fixed_amount    = case when commission_type = 'fixed_per_service' then fixed_amount end,
    salary_amount   = case when commission_type = 'fixed_salary' then salary_amount else 0 end;

-- `commission_type` has done its job. Leaving it would give the table two
-- disagreeing accounts of how someone is paid, which is how the bug got in.
alter table public.staff_compensation drop column commission_type;

alter table public.staff_compensation
  add constraint staff_commission_rate_needs_basis check (
    commission_basis is distinct from 'percentage' or commission_rate is not null
  ),
  add constraint staff_fixed_needs_basis check (
    commission_basis is distinct from 'fixed_per_service' or fixed_amount is not null
  );

-- -----------------------------------------------------------------------------
-- services -- a default rate for whoever performs it
-- -----------------------------------------------------------------------------
alter table public.services
  add column commission_basis public.commission_basis,
  add column commission_rate  numeric(6, 4)
    check (commission_rate is null or (commission_rate >= 0 and commission_rate <= 1)),
  add column commission_fixed numeric(12, 2)
    check (commission_fixed is null or commission_fixed >= 0),
  add constraint service_commission_rate_needs_basis check (
    commission_basis is distinct from 'percentage' or commission_rate is not null
  ),
  add constraint service_fixed_needs_basis check (
    commission_basis is distinct from 'fixed_per_service' or commission_fixed is not null
  );

comment on column public.services.commission_basis is
  'Default commission for this service, used when the staff member has no rate of their own. NULL means none.';

-- -----------------------------------------------------------------------------
-- payroll_entries -- record the two halves separately
--
-- `commission_amount` keeps its meaning -- what this entry pays out -- because
-- the period totals and the payroll page both read it. It is now the sum of
-- the two new columns, so a payslip can show where the money came from.
-- -----------------------------------------------------------------------------
alter table public.payroll_entries
  add column salary_pay     numeric(12, 2) not null default 0 check (salary_pay >= 0),
  add column commission_pay numeric(12, 2) not null default 0 check (commission_pay >= 0),
  add column commission_basis public.commission_basis;

comment on column public.payroll_entries.salary_pay is
  'The pro-rated salary for this period.';
comment on column public.payroll_entries.commission_pay is
  'Commission earned on services performed in this period.';
comment on column public.payroll_entries.commission_amount is
  'Total payable: salary_pay + commission_pay.';

/*
 * Historical entries predate the split. Their commission_amount was one or the
 * other, so it can be attributed exactly rather than guessed at.
 *
 * The guard trigger refuses any change to a PAID entry, and paid entries are
 * exactly the ones that exist. That guard is there to stop the application
 * rewriting history, which this is not: commission_amount -- the figure the
 * payslip stated and the money that was actually handed over -- is not touched.
 * Only the new columns are filled in, saying which half of that unchanged total
 * was salary and which was commission.
 *
 * Disabled and re-enabled inside the one transaction, so a failure anywhere
 * here leaves the guard on.
 */
alter table public.payroll_entries disable trigger payroll_entries_guard_frozen;

update public.payroll_entries
set salary_pay     = case when commission_type = 'fixed_salary' then commission_amount else 0 end,
    commission_pay = case when commission_type = 'fixed_salary' then 0 else commission_amount end,
    commission_basis = case commission_type
                         when 'fixed_salary'      then 'none'::public.commission_basis
                         when 'percentage'        then 'percentage'::public.commission_basis
                         when 'fixed_per_service' then 'fixed_per_service'::public.commission_basis
                       end;

alter table public.payroll_entries enable trigger payroll_entries_guard_frozen;

-- =============================================================================
-- Commission for one performed line
--
-- Its own function so the precedence is stated once, can be read on its own,
-- and can be checked directly from the money test rather than only through a
-- whole payroll run.
-- =============================================================================
create or replace function public.line_commission(
  p_line_total       numeric,
  p_quantity         integer,
  p_staff_basis      public.commission_basis,
  p_staff_rate       numeric,
  p_staff_fixed      numeric,
  p_service_basis    public.commission_basis,
  p_service_rate     numeric,
  p_service_fixed    numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    -- 1. The staff member's own arrangement wins, whatever it says -- an
    --    explicit 'none' and a deliberate 0% both beat the service default.
    when p_staff_basis = 'none' then 0
    when p_staff_basis = 'percentage' then
      coalesce(p_line_total, 0) * coalesce(p_staff_rate, 0)
    when p_staff_basis = 'fixed_per_service' then
      coalesce(p_staff_fixed, 0) * coalesce(p_quantity, 0)

    -- 2. Otherwise whatever the service says.
    when p_service_basis = 'percentage' then
      coalesce(p_line_total, 0) * coalesce(p_service_rate, 0)
    when p_service_basis = 'fixed_per_service' then
      coalesce(p_service_fixed, 0) * coalesce(p_quantity, 0)

    -- 3. Neither set: this line earns nothing.
    else 0
  end;
$$;

comment on function public.line_commission(
  numeric, integer, public.commission_basis, numeric, numeric,
  public.commission_basis, numeric, numeric
) is
  'Commission for one performed service: the staff rate if set, else the service default, else nothing.';

grant execute on function public.line_commission(
  numeric, integer, public.commission_basis, numeric, numeric,
  public.commission_basis, numeric, numeric
) to authenticated, service_role;

-- =============================================================================
-- Payroll generation
-- =============================================================================

/**
 * Build a draft payroll period.
 *
 * Commission is now computed PER LINE rather than per person, because the rate
 * can come from the service. Salary is added on top, independently -- which is
 * what makes a hybrid arrangement simply a row with both.
 *
 * As before: the salon's own timezone decides which day a receipt falls on,
 * voided receipts earn nothing, and everyone with a salary appears on the run
 * whether or not they performed anything.
 */
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
      -- The per-line sum. Rounded once, at the end, not line by line.
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
    select
      p.id as staff_id,
      coalesce(nullif(p.full_name, ''), p.email) as staff_name
    from public.profiles p
    where p.salon_id = v_salon_id
      and (
        -- Did work in the period: always paid, active or not.
        exists (select 1 from work w where w.staff_id = p.id)
        -- Or draws a salary and is still on the team. A commission-only person
        -- who sold nothing is owed nothing, and a row of zeroes for them is
        -- noise on the run.
        or (
          p.is_active
          and exists (
            select 1 from public.staff_compensation sc
            where sc.staff_id = p.id
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
    -- The legacy column, kept so historical rows and the enum stay coherent.
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
    -- salary and commission, computed independently and then added.
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
