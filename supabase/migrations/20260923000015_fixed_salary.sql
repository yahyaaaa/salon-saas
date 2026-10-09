-- =============================================================================
-- Fixed salary
--
-- A salon pays some people for their time rather than their sales: a
-- receptionist, a cleaner, a salaried senior therapist. Until now every payroll
-- entry was derived from receipt lines, so someone who performs no services
-- earned nothing and -- worse -- did not appear on the payroll run at all.
--
-- Two changes:
--
--   1. staff_compensation gains a monthly `salary_amount` and a `joining_date`.
--   2. generate_payroll_period() now builds its entry list from everyone ON A
--      SALARY, unioned with everyone who has work in the period, rather than
--      only from the receipt lines.
--
-- PRO-RATING. A payroll period is an arbitrary date range but a salary is a
-- monthly figure, so the two have to be reconciled. Each day in the period
-- earns one day's worth of that day's own month -- so a 15-day slice of a
-- 30-day month pays half, and the same slice of a 31-day month pays 15/31.
-- Days before the joining date earn nothing. Summing per-day rather than
-- per-period is what makes a range that straddles two months come out right.
-- =============================================================================

alter table public.staff_compensation
  -- The monthly figure. Used only when commission_type is 'fixed_salary'.
  add column salary_amount numeric(12, 2) not null default 0
    check (salary_amount >= 0),
  -- Nullable: unknown for people already on the team when this shipped, and a
  -- null simply means "no start date to withhold pay before".
  add column joining_date date;

comment on column public.staff_compensation.salary_amount is
  'Monthly salary, pro-rated across the payroll period. Ignored unless commission_type is fixed_salary.';
comment on column public.staff_compensation.joining_date is
  'First day the person is payable. Days in a payroll period before this earn nothing.';

-- Snapshot columns, for the same reason the commission settings are snapshotted:
-- a payslip from March must still explain itself after the salary changes in May.
alter table public.payroll_entries
  add column salary_amount   numeric(12, 2) not null default 0,
  add column salary_days_paid integer not null default 0
    check (salary_days_paid >= 0);

comment on column public.payroll_entries.commission_amount is
  'What this entry pays out: commission on services, or the pro-rated salary. '
  'The column name predates the salary basis.';
comment on column public.payroll_entries.salary_days_paid is
  'How many days of the period were paid at salary -- the period length, less any days before joining.';

-- -----------------------------------------------------------------------------
-- prorated_salary
--
-- Kept as its own function so the arithmetic is stated once and can be checked
-- directly from the money test, rather than being buried inside a 90-line
-- payroll query.
-- -----------------------------------------------------------------------------
create or replace function public.prorated_salary(
  p_monthly   numeric,
  p_starts_on date,
  p_ends_on   date,
  p_joined_on date
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(
    coalesce(
      sum(
        p_monthly
        / extract(day from (date_trunc('month', day)::date + interval '1 month - 1 day'))
      ),
      0
    ),
    2
  )
  from generate_series(p_starts_on, p_ends_on, interval '1 day') as g(day)
  where p_joined_on is null or g.day::date >= p_joined_on;
$$;

comment on function public.prorated_salary(numeric, date, date, date) is
  'A monthly salary apportioned across an arbitrary date range, a day at a time, skipping days before joining.';

grant execute on function public.prorated_salary(numeric, date, date, date)
  to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- How many days of the period were actually payable. Shown on the payslip so a
-- part-month is self-explanatory.
-- -----------------------------------------------------------------------------
create or replace function public.payable_days(
  p_starts_on date,
  p_ends_on   date,
  p_joined_on date
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select count(*)::integer
  from generate_series(p_starts_on, p_ends_on, interval '1 day') as g(day)
  where p_joined_on is null or g.day::date >= p_joined_on;
$$;

grant execute on function public.payable_days(date, date, date) to authenticated, service_role;

-- =============================================================================
-- Payroll generation, rewritten
-- =============================================================================

/**
 * Build a draft payroll period.
 *
 * Commission is derived from receipt_line_items -- filtered to the period in
 * the SALON'S OWN timezone, and excluding voided receipts, exactly as before.
 *
 * What changed: the set of people on the run. It used to be "whoever appears
 * in the receipt lines"; it is now that set PLUS everyone on a salary, so a
 * salaried person who sold nothing still gets paid. An inactive profile is
 * included only if they actually did work in the period -- a deactivated
 * account does not keep drawing a salary.
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
    commission_type, commission_rate, fixed_amount, salary_amount,
    salary_days_paid, commission_amount,
    period_starts_on, period_ends_on, status
  )
  with work as (
    select
      li.staff_id,
      -- Quantity matters: three blow-dries on one line is three services.
      sum(li.quantity)::integer as services_performed,
      round(sum(li.line_total), 2) as revenue
    from public.receipt_line_items li
    join public.receipts r on r.id = li.receipt_id
    where li.salon_id = v_salon_id
      and li.staff_id is not null
      -- No commission on a receipt that was given back.
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
        -- Or draws a salary and is still on the team. Deliberately narrow:
        -- a commission therapist who sold nothing is owed nothing, and an
        -- entry of zero for them is noise on the payslip run. Only the salary
        -- basis pays in the absence of work, so only it earns a place here.
        or (
          p.is_active
          and exists (
            select 1 from public.staff_compensation sc
            where sc.staff_id = p.id
              and sc.salon_id = v_salon_id
              and sc.commission_type = 'fixed_salary'
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
    coalesce(sc.commission_type, 'percentage'),
    coalesce(sc.commission_rate, 0),
    coalesce(sc.fixed_amount, 0),
    coalesce(sc.salary_amount, 0),
    case
      when coalesce(sc.commission_type, 'percentage') = 'fixed_salary'
        then public.payable_days(p_starts_on, p_ends_on, sc.joining_date)
      else 0
    end,
    case coalesce(sc.commission_type, 'percentage')
      when 'fixed_salary'
        then public.prorated_salary(
               coalesce(sc.salary_amount, 0), p_starts_on, p_ends_on, sc.joining_date
             )
      when 'fixed_per_service'
        then round(coalesce(sc.fixed_amount, 0) * coalesce(work.services_performed, 0), 2)
      else round(coalesce(work.revenue, 0) * coalesce(sc.commission_rate, 0), 2)
    end,
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
