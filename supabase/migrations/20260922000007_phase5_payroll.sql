-- =============================================================================
-- Phase 5: Payroll
--
-- Commission is computed from receipt_line_items -- the same rows the POS
-- wrote, which already carry who performed each service, what it netted after
-- discount, and when. Nothing here re-enters a figure by hand.
--
-- As with Phase 4, the money tables have SELECT policies and no write policies:
-- payroll is generated and frozen by SECURITY DEFINER functions, so a period
-- cannot be hand-edited into existence or quietly adjusted afterwards.
-- =============================================================================

create type public.commission_type as enum ('percentage', 'fixed_per_service');
create type public.payroll_status as enum ('draft', 'paid');

-- -----------------------------------------------------------------------------
-- staff_compensation
--
-- Deliberately its own table rather than a column on `profiles`: every member
-- of a salon can read `profiles` (the front desk needs the staff list), and
-- what a colleague is paid is not theirs to see. Here, an owner sees the whole
-- salon and a therapist sees only their own row.
-- -----------------------------------------------------------------------------
create table public.staff_compensation (
  staff_id        uuid primary key,
  salon_id        uuid not null references public.salons (id) on delete cascade,
  commission_type public.commission_type not null default 'percentage',
  -- A fraction, so 0.3000 is 30%. Stored the same way as loyalty_earn_rate.
  commission_rate numeric(6, 4) not null default 0
    check (commission_rate >= 0 and commission_rate <= 1),
  -- Used when commission_type is fixed_per_service.
  fixed_amount    numeric(12, 2) not null default 0 check (fixed_amount >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (staff_id, salon_id),
  foreign key (staff_id, salon_id)
    references public.profiles (id, salon_id) on delete cascade
);

create index staff_compensation_salon_idx on public.staff_compensation (salon_id);

create trigger staff_compensation_set_updated_at
  before update on public.staff_compensation
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- payroll_periods
-- -----------------------------------------------------------------------------
create table public.payroll_periods (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null references public.salons (id) on delete cascade,
  starts_on        date not null,
  ends_on          date not null,
  status           public.payroll_status not null default 'draft',
  total_revenue    numeric(12, 2) not null default 0,
  total_commission numeric(12, 2) not null default 0,
  notes            text not null default '',
  created_by       uuid,
  created_at       timestamptz not null default now(),
  paid_at          timestamptz,
  paid_by          uuid,
  unique (id, salon_id),
  constraint payroll_period_valid check (ends_on >= starts_on),
  constraint payroll_paid_has_stamp
    check (status <> 'paid' or paid_at is not null),
  foreign key (created_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (created_by),
  foreign key (paid_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (paid_by)
);

-- Two periods covering the same day would pay the same work twice. The
-- database refuses rather than relying on whoever is generating them to notice.
alter table public.payroll_periods
  add constraint payroll_periods_no_overlap
  exclude using gist (
    salon_id with =,
    daterange(starts_on, ends_on, '[]') with &&
  );

create index payroll_periods_salon_idx on public.payroll_periods (salon_id, starts_on desc);

-- -----------------------------------------------------------------------------
-- payroll_entries -- one row per staff member per period.
--
-- The period dates and status are copied onto each entry for the same reason
-- receipt lines carry `performed_at`: a therapist can then read their own
-- earnings history without being given access to payroll_periods, which holds
-- the salon-wide totals.
--
-- The commission settings are snapshotted too, so a historical payslip still
-- explains itself after the owner changes someone's rate.
-- -----------------------------------------------------------------------------
create table public.payroll_entries (
  id                 uuid primary key default gen_random_uuid(),
  salon_id           uuid not null,
  period_id          uuid not null,
  staff_id           uuid,
  staff_name         text not null,
  services_performed integer not null default 0 check (services_performed >= 0),
  revenue            numeric(12, 2) not null default 0 check (revenue >= 0),
  commission_type    public.commission_type not null,
  commission_rate    numeric(6, 4) not null default 0,
  fixed_amount       numeric(12, 2) not null default 0,
  commission_amount  numeric(12, 2) not null default 0 check (commission_amount >= 0),
  period_starts_on   date not null,
  period_ends_on     date not null,
  status             public.payroll_status not null default 'draft',
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  unique (period_id, staff_id),
  foreign key (period_id, salon_id)
    references public.payroll_periods (id, salon_id) on delete cascade,
  foreign key (staff_id, salon_id)
    references public.profiles (id, salon_id) on delete set null (staff_id)
);

create index payroll_entries_staff_idx on public.payroll_entries (staff_id, period_starts_on desc);
create index payroll_entries_period_idx on public.payroll_entries (period_id);

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.staff_compensation enable row level security;
alter table public.payroll_periods    enable row level security;
alter table public.payroll_entries    enable row level security;

-- --- staff_compensation -------------------------------------------------------
-- An owner manages the whole salon's rates; a therapist may see their own, so
-- their commission history makes sense to them. Nobody sees a colleague's.
create policy staff_compensation_select_self_or_owner
  on public.staff_compensation for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.is_owner() or staff_id = (select auth.uid()))
  );

create policy staff_compensation_write_owner_only
  on public.staff_compensation for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

-- --- payroll_periods ----------------------------------------------------------
-- Owner only: these rows carry salon-wide revenue and the total wage bill.
-- Generated and frozen by the functions below, so there is no write policy.
create policy payroll_periods_select_owner_only
  on public.payroll_periods for select to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner());

-- A draft that was generated for the wrong dates can be discarded and redone.
-- A paid period cannot: the brief requires it to stay viewable, not editable.
create policy payroll_periods_delete_draft_owner_only
  on public.payroll_periods for delete to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.is_owner()
    and status = 'draft'
  );

-- --- payroll_entries ----------------------------------------------------------
create policy payroll_entries_select_permitted
  on public.payroll_entries for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (public.is_owner() or staff_id = (select auth.uid()))
  );

-- =============================================================================
-- Generation
-- =============================================================================

/**
 * Build a draft payroll period.
 *
 * Commission is derived from receipt_line_items, filtered to the period in the
 * SALON'S OWN timezone -- a receipt at 11pm on the 31st belongs to the month
 * the salon was working, not to whatever UTC says.
 *
 * Voided receipts are excluded: no commission is owed on money that was given
 * back.
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
  v_salon_id  uuid := public.current_salon_id();
  v_actor     uuid := (select auth.uid());
  v_timezone  text;
  v_period_id uuid := gen_random_uuid();
  v_revenue   numeric(12, 2);
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
    commission_type, commission_rate, fixed_amount, commission_amount,
    period_starts_on, period_ends_on, status
  )
  select
    v_salon_id,
    v_period_id,
    work.staff_id,
    work.staff_name,
    work.services_performed,
    work.revenue,
    coalesce(sc.commission_type, 'percentage'),
    coalesce(sc.commission_rate, 0),
    coalesce(sc.fixed_amount, 0),
    case coalesce(sc.commission_type, 'percentage')
      when 'fixed_per_service'
        then round(coalesce(sc.fixed_amount, 0) * work.services_performed, 2)
      else round(work.revenue * coalesce(sc.commission_rate, 0), 2)
    end,
    p_starts_on,
    p_ends_on,
    'draft'
  from (
    select
      li.staff_id,
      max(coalesce(nullif(p.full_name, ''), p.email)) as staff_name,
      -- Quantity matters: three blow-dries on one line is three services.
      sum(li.quantity)::integer as services_performed,
      round(sum(li.line_total), 2) as revenue
    from public.receipt_line_items li
    join public.receipts r on r.id = li.receipt_id
    left join public.profiles p on p.id = li.staff_id
    where li.salon_id = v_salon_id
      and li.staff_id is not null
      -- No commission on a receipt that was given back.
      and r.status = 'issued'
      and (li.performed_at at time zone v_timezone)::date between p_starts_on and p_ends_on
    group by li.staff_id
  ) work
  left join public.staff_compensation sc
    on sc.staff_id = work.staff_id and sc.salon_id = v_salon_id;

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

/**
 * Freeze a period as paid.
 *
 * After this the period is historical: the guard triggers below reject every
 * further change to it or to its entries, which is what the brief asks for.
 */
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
  if not public.is_owner() then
    raise exception 'Only the salon owner can mark payroll paid';
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

-- =============================================================================
-- Guard rails
-- =============================================================================

-- "Payroll records are historical -- don't allow editing a period once marked
-- paid, only viewing."
create or replace function public.guard_payroll_period_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A salon being closed takes its payroll with it. The cascade removes the
  -- salon row first, so this is the only way `exists` comes back false --
  -- nothing else can reach past the checks below.
  if not exists (
    select 1 from public.salons s where s.id = coalesce(new.salon_id, old.salon_id)
  ) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'paid' then
      raise exception 'A paid payroll period cannot be deleted';
    end if;
    return old;
  end if;

  if old.status = 'paid' then
    raise exception 'A paid payroll period cannot be changed';
  end if;

  return new;
end;
$$;

create trigger payroll_periods_guard_frozen
  before update or delete on public.payroll_periods
  for each row execute function public.guard_payroll_period_frozen();

create or replace function public.guard_payroll_entry_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A salon being closed takes its payroll with it; nothing else may touch a
  -- paid entry. Same carve-out as the loyalty ledger.
  if not exists (select 1 from public.salons s where s.id = coalesce(new.salon_id, old.salon_id)) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if old.status = 'paid' then
    raise exception 'A paid payroll entry cannot be changed';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create trigger payroll_entries_guard_frozen
  before update or delete on public.payroll_entries
  for each row execute function public.guard_payroll_entry_frozen();
