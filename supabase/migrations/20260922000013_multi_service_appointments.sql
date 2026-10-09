-- =============================================================================
-- Multi-service appointments, quoted pricing, and atomic inline customers
--
-- Three changes that belong together:
--
--   1. An appointment can now hold several services -- a bridal package plus an
--      add-on -- rather than exactly one.
--   2. Its price can be quoted rather than summed: the front desk may override
--      the total, apply a discount, or both.
--   3. Creating a customer during a booking or a sale is no longer a separate
--      step that can succeed on its own. Both now happen inside one function,
--      so a booking that fails validation leaves no customer behind.
--
-- `appointments.service_id` is kept, holding the FIRST service on the booking.
-- It is what the calendar labels a slot with, what the qualification guard
-- checks, and what Phase 6's reports read; keeping it avoids rewriting all of
-- that, and `appointment_services` carries the full list including that one.
-- =============================================================================

alter table public.appointments
  -- The sum of the service lines, before any discount or override.
  add column services_subtotal numeric(12, 2) not null default 0
    check (services_subtotal >= 0),
  add column discount_amount numeric(12, 2) not null default 0
    check (discount_amount >= 0),
  -- A price quoted for the whole booking, replacing the arithmetic entirely.
  -- Null means "just add the lines up".
  add column quoted_total numeric(12, 2)
    check (quoted_total is null or quoted_total >= 0);

-- Existing rows priced a single service, so that price is the subtotal.
update public.appointments set services_subtotal = price_at_booking;

comment on column public.appointments.price_at_booking is
  'The agreed price: the override if one was given, otherwise subtotal minus discount.';

-- -----------------------------------------------------------------------------
-- appointment_services
--
-- `unit_price` and `duration_minutes` are snapshots, like receipt lines: the
-- slot a booking occupies and the price quoted for it must not move when the
-- price list does.
-- -----------------------------------------------------------------------------
create table public.appointment_services (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null references public.salons (id) on delete cascade,
  appointment_id   uuid not null,
  service_id       uuid not null,
  service_name     text not null,
  quantity         integer not null default 1 check (quantity between 1 and 20),
  unit_price       numeric(12, 2) not null check (unit_price >= 0),
  duration_minutes integer not null check (duration_minutes between 5 and 1440),
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),

  foreign key (appointment_id, salon_id)
    references public.appointments (id, salon_id) on delete cascade,
  foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete no action
);

create index appointment_services_appointment_idx
  on public.appointment_services (appointment_id, sort_order);
create index appointment_services_service_idx on public.appointment_services (service_id);

alter table public.appointment_services enable row level security;

-- Visible to whoever can see the appointment: the front desk, or the therapist
-- it belongs to.
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
          or a.staff_id = (select auth.uid())
        )
    )
  );

create policy appointment_services_write_front_desk
  on public.appointment_services for all to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  )
  with check (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

-- Every service on a booking must be one the assigned therapist may perform,
-- not just the first.
create or replace function public.guard_appointment_service_staff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff_id   uuid;
  v_restricted boolean;
begin
  select a.staff_id into v_staff_id
  from public.appointments a where a.id = new.appointment_id;

  if v_staff_id is null then
    return new;
  end if;

  select exists (
    select 1 from public.service_staff ss where ss.service_id = new.service_id
  ) into v_restricted;

  if v_restricted and not exists (
    select 1
    from public.service_staff ss
    where ss.service_id = new.service_id and ss.staff_id = v_staff_id
  ) then
    raise exception 'That team member is not qualified to perform %', new.service_name;
  end if;

  return new;
end;
$$;

create trigger appointment_services_guard_staff
  before insert or update on public.appointment_services
  for each row execute function public.guard_appointment_service_staff();

-- =============================================================================
-- Shared helper: refuse a duplicate phone, and say who already has it
-- =============================================================================

/**
 * Create a customer, or raise with something the front desk can act on.
 *
 * The unique index already prevents duplicates; this turns the resulting
 * 23505 into a message naming the person who already holds that number, so the
 * receptionist can pick them instead of guessing.
 */
create or replace function public.create_customer_checked(
  p_salon_id uuid,
  p_full_name text,
  p_phone text,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_name text;
  v_id uuid;
begin
  if p_full_name is null or length(btrim(p_full_name)) < 2 then
    raise exception 'Enter the customer''s name';
  end if;
  if p_phone is null or length(regexp_replace(p_phone, '[^0-9]', '', 'g')) < 6 then
    raise exception 'Enter a valid phone number';
  end if;

  select c.full_name into v_existing_name
  from public.customers c
  where c.salon_id = p_salon_id
    and c.phone_normalized = regexp_replace(p_phone, '[^0-9]', '', 'g');

  if found then
    raise exception
      '% already uses that phone number. Choose them as an existing customer instead.',
      v_existing_name
      using errcode = 'unique_violation';
  end if;

  insert into public.customers (salon_id, full_name, phone, created_by)
  values (p_salon_id, btrim(p_full_name), btrim(p_phone), p_created_by)
  returning id into v_id;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    p_salon_id, p_created_by, public.current_app_role(), 'customer.created',
    'customer', v_id::text, jsonb_build_object('name', btrim(p_full_name))
  );

  return v_id;
end;
$$;

revoke execute on function public.create_customer_checked(uuid, text, text, uuid) from public;
grant execute on function public.create_customer_checked(uuid, text, text, uuid)
  to authenticated, service_role;

-- =============================================================================
-- Booking
-- =============================================================================

/**
 * Book an appointment, in one transaction.
 *
 * The whole point of doing this in the database rather than in the action is
 * atomicity: a customer created for a booking that then fails -- an unqualified
 * therapist, a clashing slot -- is rolled back with it. Previously the customer
 * survived the failure and the front desk was left with a phantom profile.
 *
 * Durations and prices come from the catalogue. The caller may override the
 * total or apply a discount, because quoting a package price is a real thing
 * salons do; it may not invent a line's price.
 *
 * p_lines: [{ service_id, quantity }]
 */
create or replace function public.create_appointment(
  p_customer_id        uuid,
  p_new_customer_name  text,
  p_new_customer_phone text,
  p_staff_id           uuid,
  p_starts_at          timestamptz,
  p_notes              text,
  p_is_walk_in         boolean,
  p_discount           numeric,
  p_quoted_total       numeric,
  p_lines              jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id    uuid := public.current_salon_id();
  v_role        public.user_role := public.current_app_role();
  v_actor       uuid := (select auth.uid());
  v_customer_id uuid := p_customer_id;
  v_line        jsonb;
  v_service     public.services%rowtype;
  v_quantity    integer;
  v_subtotal    numeric(12, 2) := 0;
  v_minutes     integer := 0;
  v_first       uuid;
  v_index       integer := 0;
  v_lines       jsonb := '[]'::jsonb;
  v_discount    numeric(12, 2) := round(greatest(coalesce(p_discount, 0), 0), 2);
  v_total       numeric(12, 2);
  v_appointment uuid := gen_random_uuid();
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if v_role not in ('owner', 'receptionist') then
    raise exception 'Only an owner or receptionist can book appointments';
  end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'Add at least one service to the booking';
  end if;

  -- ---- customer -----------------------------------------------------------
  if v_customer_id is null then
    v_customer_id := public.create_customer_checked(
      v_salon_id, p_new_customer_name, p_new_customer_phone, v_actor
    );
  elsif not exists (
    select 1 from public.customers c
    where c.id = v_customer_id and c.salon_id = v_salon_id
  ) then
    raise exception 'That customer is not in this salon';
  end if;

  -- ---- price and duration from the catalogue ------------------------------
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_service
    from public.services s
    where s.id = (v_line ->> 'service_id')::uuid and s.salon_id = v_salon_id;

    if not found then
      raise exception 'A service on this booking is not in this salon';
    end if;
    if not v_service.is_active then
      raise exception '% is archived and cannot be booked', v_service.name;
    end if;

    v_quantity := greatest(1, least(20, coalesce((v_line ->> 'quantity')::integer, 1)));

    v_subtotal := v_subtotal + (v_service.price * v_quantity);
    v_minutes := v_minutes + (v_service.duration_minutes * v_quantity);
    if v_first is null then v_first := v_service.id; end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'service_id', v_service.id,
      'service_name', v_service.name,
      'quantity', v_quantity,
      'unit_price', v_service.price,
      'duration_minutes', v_service.duration_minutes,
      'sort_order', v_index
    ));
    v_index := v_index + 1;
  end loop;

  v_subtotal := round(v_subtotal, 2);

  if p_quoted_total is not null then
    v_total := round(greatest(p_quoted_total, 0), 2);
  else
    v_total := round(v_subtotal - v_discount, 2);
  end if;

  if v_total < 0 then
    raise exception 'A discount cannot exceed the value of the services';
  end if;

  -- ---- write ---------------------------------------------------------------
  insert into public.appointments (
    id, salon_id, customer_id, staff_id, service_id,
    starts_at, ends_at, is_walk_in, notes,
    services_subtotal, discount_amount, quoted_total, price_at_booking, created_by
  ) values (
    v_appointment, v_salon_id, v_customer_id, p_staff_id, v_first,
    p_starts_at, p_starts_at + make_interval(mins => v_minutes),
    coalesce(p_is_walk_in, false), coalesce(p_notes, ''),
    v_subtotal, v_discount, p_quoted_total, v_total, v_actor
  );

  insert into public.appointment_services (
    salon_id, appointment_id, service_id, service_name,
    quantity, unit_price, duration_minutes, sort_order
  )
  select
    v_salon_id, v_appointment,
    (l ->> 'service_id')::uuid,
    l ->> 'service_name',
    (l ->> 'quantity')::integer,
    (l ->> 'unit_price')::numeric,
    (l ->> 'duration_minutes')::integer,
    (l ->> 'sort_order')::integer
  from jsonb_array_elements(v_lines) l;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, v_role, 'appointment.booked', 'appointment', v_appointment::text,
    jsonb_build_object(
      'customer_id', v_customer_id,
      'staff_id', p_staff_id,
      'starts_at', p_starts_at,
      'services', jsonb_array_length(v_lines),
      'subtotal', v_subtotal,
      'discount', v_discount,
      'quoted_total', p_quoted_total,
      'total', v_total,
      'walk_in', coalesce(p_is_walk_in, false)
    )
  );

  return v_appointment;
end;
$$;

revoke execute on function public.create_appointment(
  uuid, text, text, uuid, timestamptz, text, boolean, numeric, numeric, jsonb
) from public;
grant execute on function public.create_appointment(
  uuid, text, text, uuid, timestamptz, text, boolean, numeric, numeric, jsonb
) to authenticated, service_role;

-- =============================================================================
-- Checkout: the same atomicity for a sale
-- =============================================================================

drop function if exists public.create_receipt(
  uuid, public.payment_method, numeric, numeric, numeric, uuid, text, jsonb
);

create or replace function public.create_receipt(
  p_customer_id        uuid,
  p_payment_method     public.payment_method,
  p_cash_amount        numeric,
  p_card_amount        numeric,
  p_loyalty_redeem     numeric,
  p_deal_id            uuid,
  p_notes              text,
  p_lines              jsonb,
  p_new_customer_name  text default null,
  p_new_customer_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id       uuid := public.current_salon_id();
  v_role           public.user_role := public.current_app_role();
  v_actor          uuid := (select auth.uid());
  v_customer_id    uuid := p_customer_id;
  v_line           jsonb;
  v_service        public.services%rowtype;
  v_staff_role     public.user_role;
  v_quantity       integer;
  v_gross          numeric(12, 2) := 0;
  v_discount_total numeric(12, 2) := 0;
  v_eligible_gross numeric(12, 2) := 0;
  v_deal           public.deals%rowtype;
  v_deal_services  uuid[];
  v_present        uuid[];
  v_bundle_cut     numeric(12, 2) := 0;
  v_balance        numeric(12, 2);
  v_redeem         numeric(12, 2);
  v_bill           numeric(12, 2);
  v_total          numeric(12, 2);
  v_rate           numeric(6, 4);
  v_earned         numeric(12, 2);
  v_receipt_id     uuid := gen_random_uuid();
  v_number         integer;
  v_now            timestamptz := now();
  v_index          integer := 0;
  v_lines          jsonb := '[]'::jsonb;
  v_cash           numeric(12, 2) := round(coalesce(p_cash_amount, 0), 2);
  v_card           numeric(12, 2) := round(coalesce(p_card_amount, 0), 2);
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;

  if v_role not in ('owner', 'receptionist') then
    raise exception 'Only an owner or receptionist can issue a receipt';
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'A receipt needs at least one service';
  end if;

  -- A customer rung up for the first time is created here, inside the same
  -- transaction as the sale, so a refused sale leaves no profile behind.
  if v_customer_id is null then
    v_customer_id := public.create_customer_checked(
      v_salon_id, p_new_customer_name, p_new_customer_phone, v_actor
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_customer_id::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_salon_id::text, 1));

  if not exists (
    select 1 from public.customers c
    where c.id = v_customer_id and c.salon_id = v_salon_id
  ) then
    raise exception 'That customer is not in this salon';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_service
    from public.services s
    where s.id = (v_line ->> 'service_id')::uuid
      and s.salon_id = v_salon_id;

    if not found then
      raise exception 'A service on this receipt is not in this salon';
    end if;

    v_quantity := greatest(1, coalesce((v_line ->> 'quantity')::integer, 1));

    if (v_line ->> 'staff_id') is null then
      raise exception 'Every service must be attributed to the team member who performed it';
    end if;

    select p.role into v_staff_role
    from public.profiles p
    where p.id = (v_line ->> 'staff_id')::uuid and p.salon_id = v_salon_id;

    if v_staff_role is null then
      raise exception 'A team member on this receipt is not in this salon';
    end if;
    if v_staff_role = 'receptionist' then
      raise exception 'Receptionists do not perform treatments';
    end if;

    v_gross := v_gross + (v_service.price * v_quantity);

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'service_id', v_service.id,
      'service_name', v_service.name,
      'staff_id', (v_line ->> 'staff_id')::uuid,
      'appointment_id', nullif(v_line ->> 'appointment_id', '')::uuid,
      'quantity', v_quantity,
      'unit_price', v_service.price,
      'gross', v_service.price * v_quantity,
      'discount', 0::numeric,
      'sort_order', v_index
    ));
    v_index := v_index + 1;
  end loop;

  v_gross := round(v_gross, 2);

  if p_deal_id is not null then
    select * into v_deal
    from public.deals d
    where d.id = p_deal_id and d.salon_id = v_salon_id and d.is_active;

    if not found then
      raise exception 'That deal is not available';
    end if;

    if v_now::date < v_deal.starts_on or v_now::date > v_deal.ends_on then
      raise exception 'That deal is not running today';
    end if;

    select array_agg(ds.service_id) into v_deal_services
    from public.deal_services ds where ds.deal_id = v_deal.id;

    v_deal_services := coalesce(v_deal_services, array[]::uuid[]);

    select coalesce(sum((l ->> 'gross')::numeric), 0) into v_eligible_gross
    from jsonb_array_elements(v_lines) l
    where (l ->> 'service_id')::uuid = any (v_deal_services);

    if v_eligible_gross <= 0 then
      raise exception 'Nothing on this receipt qualifies for that deal';
    end if;

    if v_deal.deal_type = 'percentage' then
      v_discount_total := round(v_eligible_gross * v_deal.value / 100, 2);

    elsif v_deal.deal_type = 'fixed_amount' then
      v_discount_total := least(round(v_deal.value, 2), v_eligible_gross);

    else
      select array_agg(distinct (l ->> 'service_id')::uuid) into v_present
      from jsonb_array_elements(v_lines) l
      where (l ->> 'service_id')::uuid = any (v_deal_services);

      if not (v_deal_services <@ coalesce(v_present, array[]::uuid[])) then
        raise exception 'That bundle needs every one of its services on the receipt';
      end if;

      v_bundle_cut := v_eligible_gross - round(v_deal.value, 2);
      v_discount_total := greatest(v_bundle_cut, 0);
    end if;

    v_lines := (
      select jsonb_agg(
        case
          when (l ->> 'service_id')::uuid = any (v_deal_services)
          then jsonb_set(
                 l, '{discount}',
                 to_jsonb(round(
                   v_discount_total * ((l ->> 'gross')::numeric / v_eligible_gross), 2
                 ))
               )
          else l
        end
        order by (l ->> 'sort_order')::integer
      )
      from jsonb_array_elements(v_lines) l
    );

    declare
      v_allocated numeric(12, 2);
      v_drift     numeric(12, 2);
      v_target    integer;
    begin
      select coalesce(sum((l ->> 'discount')::numeric), 0) into v_allocated
      from jsonb_array_elements(v_lines) l;

      v_drift := v_discount_total - v_allocated;

      if v_drift <> 0 then
        select (l ->> 'sort_order')::integer into v_target
        from jsonb_array_elements(v_lines) l
        where (l ->> 'service_id')::uuid = any (v_deal_services)
        order by (l ->> 'gross')::numeric desc
        limit 1;

        v_lines := (
          select jsonb_agg(
            case
              when (l ->> 'sort_order')::integer = v_target
              then jsonb_set(l, '{discount}',
                     to_jsonb(round((l ->> 'discount')::numeric + v_drift, 2)))
              else l
            end
            order by (l ->> 'sort_order')::integer
          )
          from jsonb_array_elements(v_lines) l
        );
      end if;
    end;
  end if;

  v_bill := round(v_gross - v_discount_total, 2);
  if v_bill < 0 then
    raise exception 'A discount cannot exceed the value of the services';
  end if;

  v_balance := public.customer_loyalty_balance(v_customer_id);
  v_redeem := round(greatest(coalesce(p_loyalty_redeem, 0), 0), 2);

  if v_redeem > greatest(v_balance, 0) then
    raise exception 'Only % is available to redeem', to_char(greatest(v_balance, 0), 'FM999999990.00');
  end if;
  if v_redeem > v_bill then
    raise exception 'Loyalty redemption cannot exceed the bill total';
  end if;

  v_total := round(v_bill - v_redeem, 2);

  if p_payment_method = 'cash' then
    v_cash := v_total; v_card := 0;
  elsif p_payment_method = 'card' then
    v_card := v_total; v_cash := 0;
  elsif v_cash + v_card <> v_total then
    raise exception 'The split (% cash + % card) does not add up to %',
      to_char(v_cash, 'FM999999990.00'), to_char(v_card, 'FM999999990.00'),
      to_char(v_total, 'FM999999990.00');
  end if;

  select ss.loyalty_earn_rate into v_rate
  from public.salon_settings ss where ss.salon_id = v_salon_id;
  v_rate := coalesce(v_rate, 0.05);

  v_earned := round(v_total * v_rate, 2);

  select coalesce(max(r.receipt_number), 0) + 1 into v_number
  from public.receipts r where r.salon_id = v_salon_id;

  insert into public.receipts (
    id, salon_id, receipt_number, customer_id, issued_by, deal_id,
    subtotal, discount_total, loyalty_redeemed, total,
    loyalty_earned, loyalty_earn_rate,
    payment_method, cash_amount, card_amount, notes, created_at
  ) values (
    v_receipt_id, v_salon_id, v_number, v_customer_id, v_actor, p_deal_id,
    v_gross, v_discount_total, v_redeem, v_total,
    v_earned, v_rate,
    p_payment_method, v_cash, v_card, coalesce(p_notes, ''), v_now
  );

  insert into public.receipt_line_items (
    salon_id, receipt_id, service_id, service_name, staff_id, appointment_id,
    quantity, unit_price, discount_amount, line_total, performed_at, sort_order
  )
  select
    v_salon_id, v_receipt_id,
    (l ->> 'service_id')::uuid,
    l ->> 'service_name',
    (l ->> 'staff_id')::uuid,
    nullif(l ->> 'appointment_id', '')::uuid,
    (l ->> 'quantity')::integer,
    (l ->> 'unit_price')::numeric,
    (l ->> 'discount')::numeric,
    round((l ->> 'gross')::numeric - (l ->> 'discount')::numeric, 2),
    v_now,
    (l ->> 'sort_order')::integer
  from jsonb_array_elements(v_lines) l;

  if v_redeem > 0 then
    v_balance := v_balance - v_redeem;
    insert into public.loyalty_transactions
      (salon_id, customer_id, receipt_id, type, amount, resulting_balance, created_at)
    values
      (v_salon_id, v_customer_id, v_receipt_id, 'redeem', -v_redeem, v_balance, v_now);

    insert into public.audit_logs
      (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
    values (
      v_salon_id, v_actor, v_role, 'loyalty.redeemed', 'receipt', v_receipt_id::text,
      jsonb_build_object('customer_id', v_customer_id, 'amount', v_redeem,
                         'resulting_balance', v_balance)
    );
  end if;

  if v_earned > 0 then
    v_balance := v_balance + v_earned;
    insert into public.loyalty_transactions
      (salon_id, customer_id, receipt_id, type, amount, resulting_balance, created_at)
    values
      (v_salon_id, v_customer_id, v_receipt_id, 'earn', v_earned, v_balance, v_now);
  end if;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, v_role, 'receipt.created', 'receipt', v_receipt_id::text,
    jsonb_build_object(
      'receipt_number', v_number, 'customer_id', v_customer_id,
      'subtotal', v_gross, 'discount_total', v_discount_total,
      'loyalty_redeemed', v_redeem, 'total', v_total, 'loyalty_earned', v_earned,
      'payment_method', p_payment_method
    )
  );

  return v_receipt_id;
end;
$$;

revoke execute on function public.create_receipt(
  uuid, public.payment_method, numeric, numeric, numeric, uuid, text, jsonb, text, text
) from public;
grant execute on function public.create_receipt(
  uuid, public.payment_method, numeric, numeric, numeric, uuid, text, jsonb, text, text
) to authenticated, service_role;

-- =============================================================================
-- Customer search, for the type-ahead pickers
-- =============================================================================

/**
 * Find customers by name or phone. Digits in the query are matched against the
 * normalised phone, so "0300 123" finds "+92 300 1234567".
 */
create or replace function public.search_customers(p_query text, p_limit integer default 3)
returns table (id uuid, full_name text, phone text)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.full_name, c.phone
  from public.customers c
  where c.salon_id = public.current_salon_id()
    and (
      btrim(coalesce(p_query, '')) = ''
      or c.full_name ilike '%' || btrim(p_query) || '%'
      or (
        length(regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g')) >= 3
        and c.phone_normalized like
            '%' || regexp_replace(p_query, '[^0-9]', '', 'g') || '%'
      )
    )
  order by c.full_name
  limit greatest(1, least(coalesce(p_limit, 3), 10))
$$;

revoke execute on function public.search_customers(text, integer) from public;
grant execute on function public.search_customers(text, integer) to authenticated, service_role;
