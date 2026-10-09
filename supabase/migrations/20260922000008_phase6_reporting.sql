-- =============================================================================
-- Phase 6: Reporting & analytics (owner only)
--
-- Every function here is SECURITY INVOKER, unlike the Phase 4 and 5 money
-- functions. Reporting only reads, so leaving RLS switched on is the safer
-- choice: the tenant filter is then the database's, not something each query
-- below has to remember. What the policies do NOT express is that reports are
-- the owner's alone -- a receptionist can read receipts perfectly legitimately
-- for the till -- so each function checks is_owner() for itself.
--
-- Everything is bucketed in the SALON'S timezone. A receipt at 11pm on the
-- 31st belongs to the month the salon was working, and "peak hours" means the
-- hours staff were actually standing up.
-- =============================================================================

/** Guard shared by every report. Returns the salon, or raises. */
create or replace function public.report_context()
returns table (salon_id uuid, timezone text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_salon_id uuid := public.current_salon_id();
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if not public.is_owner() then
    raise exception 'Reporting is available to the salon owner only';
  end if;

  return query
  select s.id, coalesce(s.timezone, 'UTC')
  from public.salons s
  where s.id = v_salon_id;
end;
$$;

revoke execute on function public.report_context() from public;
grant execute on function public.report_context() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Revenue over time
-- -----------------------------------------------------------------------------
create or replace function public.report_revenue_over_time(
  p_from        date,
  p_to          date,
  p_granularity text default 'day'
)
returns table (
  bucket           date,
  receipt_count    bigint,
  gross            numeric,
  discounts        numeric,
  loyalty_redeemed numeric,
  revenue          numeric,
  loyalty_earned   numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz   text;
  v_unit text := case lower(coalesce(p_granularity, 'day'))
                   when 'week' then 'week'
                   when 'month' then 'month'
                   else 'day'
                 end;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  select
    date_trunc(v_unit, (r.created_at at time zone v_tz))::date as bucket,
    count(*)::bigint,
    round(sum(r.subtotal), 2),
    round(sum(r.discount_total), 2),
    round(sum(r.loyalty_redeemed), 2),
    round(sum(r.total), 2),
    round(sum(r.loyalty_earned), 2)
  from public.receipts r
  where r.status = 'issued'
    and (r.created_at at time zone v_tz)::date between p_from and p_to
  group by 1
  order by 1;
end;
$$;

-- -----------------------------------------------------------------------------
-- Revenue by service
-- -----------------------------------------------------------------------------
create or replace function public.report_revenue_by_service(p_from date, p_to date)
returns table (
  service_name text,
  quantity     bigint,
  revenue      numeric,
  discounts    numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  select
    li.service_name,
    sum(li.quantity)::bigint,
    round(sum(li.line_total), 2),
    round(sum(li.discount_amount), 2)
  from public.receipt_line_items li
  join public.receipts r on r.id = li.receipt_id
  where r.status = 'issued'
    and (li.performed_at at time zone v_tz)::date between p_from and p_to
  group by li.service_name
  order by 3 desc;
end;
$$;

-- -----------------------------------------------------------------------------
-- Revenue by staff member
-- -----------------------------------------------------------------------------
create or replace function public.report_revenue_by_staff(p_from date, p_to date)
returns table (
  staff_id   uuid,
  staff_name text,
  services   bigint,
  revenue    numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  select
    li.staff_id,
    coalesce(max(nullif(p.full_name, '')), max(p.email), 'Former team member'),
    sum(li.quantity)::bigint,
    round(sum(li.line_total), 2)
  from public.receipt_line_items li
  join public.receipts r on r.id = li.receipt_id
  left join public.profiles p on p.id = li.staff_id
  where r.status = 'issued'
    and (li.performed_at at time zone v_tz)::date between p_from and p_to
  group by li.staff_id
  order by 4 desc;
end;
$$;

-- -----------------------------------------------------------------------------
-- Customer retention
--
-- Definitions, stated plainly because "retention" means different things:
--   new       -- their first ever paid visit falls inside the period
--   returning -- they visited in the period, and had visited before it started
--   repeat rate -- returning / (new + returning)
--
-- Voided receipts do not count as visits.
-- -----------------------------------------------------------------------------
create or replace function public.report_customer_retention(p_from date, p_to date)
returns table (
  new_customers       bigint,
  returning_customers bigint,
  total_customers     bigint,
  repeat_rate         numeric,
  visits              bigint,
  visits_per_customer numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  with visits_in_period as (
    select r.customer_id, count(*)::bigint as visit_count
    from public.receipts r
    where r.status = 'issued'
      and (r.created_at at time zone v_tz)::date between p_from and p_to
    group by r.customer_id
  ),
  first_visit as (
    select r.customer_id, min((r.created_at at time zone v_tz)::date) as first_date
    from public.receipts r
    where r.status = 'issued'
    group by r.customer_id
  ),
  classified as (
    select
      v.customer_id,
      v.visit_count,
      (f.first_date >= p_from) as is_new
    from visits_in_period v
    join first_visit f on f.customer_id = v.customer_id
  )
  select
    count(*) filter (where is_new)::bigint,
    count(*) filter (where not is_new)::bigint,
    count(*)::bigint,
    case when count(*) = 0 then 0
         else round(count(*) filter (where not is_new)::numeric / count(*), 4)
    end,
    coalesce(sum(visit_count), 0)::bigint,
    case when count(*) = 0 then 0
         else round(coalesce(sum(visit_count), 0)::numeric / count(*), 2)
    end
  from classified;
end;
$$;

-- -----------------------------------------------------------------------------
-- Appointment outcomes by staff member
-- -----------------------------------------------------------------------------
create or replace function public.report_appointment_stats(p_from date, p_to date)
returns table (
  staff_id    uuid,
  staff_name  text,
  booked      bigint,
  confirmed   bigint,
  completed   bigint,
  cancelled   bigint,
  no_show     bigint,
  total       bigint,
  no_show_rate numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  select
    a.staff_id,
    coalesce(max(nullif(p.full_name, '')), max(p.email), 'Former team member'),
    count(*) filter (where a.status = 'booked')::bigint,
    count(*) filter (where a.status = 'confirmed')::bigint,
    count(*) filter (where a.status = 'completed')::bigint,
    count(*) filter (where a.status = 'cancelled')::bigint,
    count(*) filter (where a.status = 'no_show')::bigint,
    count(*)::bigint,
    case when count(*) = 0 then 0
         else round(count(*) filter (where a.status = 'no_show')::numeric / count(*), 4)
    end
  from public.appointments a
  left join public.profiles p on p.id = a.staff_id
  where (a.starts_at at time zone v_tz)::date between p_from and p_to
  group by a.staff_id
  order by 8 desc;
end;
$$;

-- -----------------------------------------------------------------------------
-- Loyalty programme cost
--
-- The brief calls this out as a real liability the owner needs to see: credit
-- issued is money promised, and the outstanding balance is what the salon still
-- owes its customers. `outstanding_balance` is the whole programme to date, not
-- just the period -- a liability does not reset each month.
-- -----------------------------------------------------------------------------
create or replace function public.report_loyalty_cost(p_from date, p_to date)
returns table (
  issued              numeric,
  redeemed            numeric,
  adjustments         numeric,
  net_change          numeric,
  outstanding_balance numeric,
  customers_with_balance bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  with in_period as (
    select lt.type, lt.amount
    from public.loyalty_transactions lt
    where (lt.created_at at time zone v_tz)::date between p_from and p_to
  ),
  balances as (
    select lt.customer_id, sum(lt.amount) as balance
    from public.loyalty_transactions lt
    group by lt.customer_id
  )
  select
    round(coalesce(sum(amount) filter (where type = 'earn'), 0), 2),
    -- Stored negative; reported as a positive figure.
    round(abs(coalesce(sum(amount) filter (where type = 'redeem'), 0)), 2),
    round(coalesce(sum(amount) filter (where type = 'void_reversal'), 0), 2),
    round(coalesce(sum(amount), 0), 2),
    (select round(coalesce(sum(b.balance) filter (where b.balance > 0), 0), 2) from balances b),
    (select count(*)::bigint from balances b where b.balance > 0)
  from in_period;
end;
$$;

-- -----------------------------------------------------------------------------
-- Peak times
--
-- Cancelled appointments are excluded -- they tell you nothing about when the
-- salon was busy. No-shows are kept: the slot was held and the staff member
-- was waiting.
-- -----------------------------------------------------------------------------
create or replace function public.report_peak_times(p_from date, p_to date)
returns table (
  weekday      integer,
  hour_of_day  integer,
  appointments bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  select
    -- 0 = Monday, to match the business-hours keys used everywhere else.
    (extract(isodow from (a.starts_at at time zone v_tz))::integer - 1),
    extract(hour from (a.starts_at at time zone v_tz))::integer,
    count(*)::bigint
  from public.appointments a
  where a.status <> 'cancelled'
    and (a.starts_at at time zone v_tz)::date between p_from and p_to
  group by 1, 2
  order by 1, 2;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants. Each function guards itself with is_owner(); these grants only make
-- them callable at all.
-- -----------------------------------------------------------------------------
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.report_revenue_over_time(date, date, text)',
    'public.report_revenue_by_service(date, date)',
    'public.report_revenue_by_staff(date, date)',
    'public.report_customer_retention(date, date)',
    'public.report_appointment_stats(date, date)',
    'public.report_loyalty_cost(date, date)',
    'public.report_peak_times(date, date)'
  ]
  loop
    execute format('revoke execute on function %s from public', v_signature);
    execute format('grant execute on function %s to authenticated, service_role', v_signature);
  end loop;
end;
$$;
