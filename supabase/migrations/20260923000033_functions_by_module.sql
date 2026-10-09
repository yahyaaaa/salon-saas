-- =============================================================================
-- The SECURITY DEFINER functions ask for a module too
--
-- Migration 32 moved the policies. These functions bypass RLS by design, so
-- they check for themselves -- and each was still asking is_owner(). Left
-- alone, an Accountant granted Reports and Payroll could see the pages and
-- then be refused by the database, which is the exact UI-disagrees-with-the-
-- database failure the whole phase exists to avoid.
--
-- WHAT STAYS OWNER-ONLY, DELIBERATELY:
--
--   void_receipt      the brief makes voiding admin-only, with a reason
--   refund_payment    the same, for the same reason -- both hand money back
--   staff ID cards    held about a person for the owner's records
--
-- These are not areas of the product that a salon delegates by ticking a box;
-- they are the owner's own authority, and the brief says so. If that should
-- become a module later it is a deliberate decision, not a consequence of this
-- migration.
-- =============================================================================

create or replace function public.report_context()
returns table (salon_id uuid, timezone text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_salon_id uuid := public.current_salon_id();
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if not public.has_module('reports') then
    raise exception 'Your role does not include reporting';
  end if;

  return query
  select s.id, coalesce(s.timezone, 'UTC')
  from public.salons s
  where s.id = v_salon_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Payroll: the module, not the owner
-- -----------------------------------------------------------------------------
create or replace function public.mark_payroll_paid(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id uuid := public.current_salon_id();
  v_actor    uuid := (select auth.uid());
  v_period   public.payroll_periods%rowtype;
  v_now      timestamptz := now();
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if not public.has_module('payroll') then
    raise exception 'Your role does not include payroll';
  end if;

  select * into v_period
  from public.payroll_periods pp
  where pp.id = p_period_id and pp.salon_id = v_salon_id
  for update;

  if not found then
    raise exception 'That payroll period could not be found';
  end if;
  if v_period.status = 'paid' then
    raise exception 'That period is already marked paid';
  end if;

  update public.payroll_periods
  set status = 'paid', paid_at = v_now, paid_by = v_actor
  where id = p_period_id;

  update public.payroll_entries
  set status = 'paid', paid_at = v_now
  where period_id = p_period_id;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, 'owner', 'payroll.marked_paid', 'payroll_period', p_period_id::text,
    jsonb_build_object(
      'starts_on', v_period.starts_on, 'ends_on', v_period.ends_on,
      'total_commission', v_period.total_commission
    )
  );
end;
$$;

revoke execute on function public.mark_payroll_paid(uuid) from public;
grant execute on function public.mark_payroll_paid(uuid) to authenticated, service_role;

-- `generate_payroll_period` differs from the version in migration 24 only in
-- its guard, but it is a single statement so it is restated whole.
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
  if not public.has_module('payroll') then
    raise exception 'Your role does not include payroll';
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

-- -----------------------------------------------------------------------------
-- New salons get their roles, and their owner is put on the owner role
-- -----------------------------------------------------------------------------
create or replace function public.claim_owner_role(p_salon_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_id uuid;
begin
  select r.id into v_role_id
  from public.roles r
  where r.salon_id = p_salon_id and r.is_owner;

  update public.profiles set role_id = v_role_id where id = p_profile_id;
end;
$$;

grant execute on function public.claim_owner_role(uuid, uuid) to service_role;
