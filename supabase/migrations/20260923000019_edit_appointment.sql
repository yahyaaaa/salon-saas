-- =============================================================================
-- Editing a booking after it is made
--
-- Until now the only things that could change about an appointment were its
-- time, its therapist, and its status. If the customer asked for an extra
-- service -- or the price was quoted wrong -- the only route was to cancel and
-- rebook, which loses the booking's history and any deposit taken against it.
--
-- WHY A FUNCTION RATHER THAN AN UPDATE POLICY. The same reason booking is one:
-- the subtotal, the slot length and the agreed price are all derived from the
-- catalogue, and "all money maths is server-side" means they are derived HERE.
-- A front desk that could write `price_at_booking` directly could write
-- anything into it.
--
-- WHAT IT REFUSES.
--   * A finished appointment. Completed, cancelled and no-show bookings are
--     records of what happened, not work in progress.
--   * A billed appointment. Once a receipt exists the receipt is the agreement;
--     changing the quote underneath it would leave the two disagreeing.
--   * A new price below what has already been paid, which would silently turn
--     a deposit into money owed back. The refund is a deliberate act.
--
-- The therapist-qualification check comes free: it lives in a trigger on
-- appointment_services, so re-inserting the lines re-runs it.
-- =============================================================================

create or replace function public.update_appointment_services(
  p_appointment_id uuid,
  p_lines          jsonb,
  p_discount       numeric,
  p_quoted_total   numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id uuid := public.current_salon_id();
  v_role     public.user_role := public.current_app_role();
  v_actor    uuid := (select auth.uid());
  v_appt     public.appointments%rowtype;
  v_line     jsonb;
  v_service  public.services%rowtype;
  v_quantity integer;
  v_subtotal numeric(12, 2) := 0;
  v_minutes  integer := 0;
  v_first    uuid;
  v_index    integer := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_discount numeric(12, 2) := round(greatest(coalesce(p_discount, 0), 0), 2);
  v_total    numeric(12, 2);
  v_paid     numeric(12, 2);
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if v_role not in ('owner', 'receptionist') then
    raise exception 'Only an owner or receptionist can change a booking';
  end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'A booking needs at least one service';
  end if;

  select * into v_appt
  from public.appointments a
  where a.id = p_appointment_id and a.salon_id = v_salon_id
  for update;

  if not found then
    raise exception 'That appointment could not be found';
  end if;

  if v_appt.status not in ('booked', 'confirmed') then
    raise exception 'A % appointment cannot be changed', v_appt.status;
  end if;

  if exists (
    select 1 from public.receipts r
    where r.appointment_id = p_appointment_id and r.status = 'issued'
  ) then
    raise exception 'That appointment has already been billed; void the receipt to change it';
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

  -- A repriced booking must still cover what the customer has already handed
  -- over. Lowering it below that is a refund, and refunds are deliberate.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_appointment_id::text, 2)
  );

  select coalesce(round(sum(p.amount), 2), 0) into v_paid
  from public.payments p
  where p.appointment_id = p_appointment_id;

  if v_total < v_paid then
    raise exception
      'That would price the booking at % when % has already been paid; refund the difference first',
      to_char(v_total, 'FM999999990.00'), to_char(v_paid, 'FM999999990.00');
  end if;

  -- ---- rewrite -------------------------------------------------------------
  delete from public.appointment_services where appointment_id = p_appointment_id;

  insert into public.appointment_services (
    salon_id, appointment_id, service_id, service_name,
    quantity, unit_price, duration_minutes, sort_order
  )
  select
    v_salon_id, p_appointment_id,
    (l ->> 'service_id')::uuid,
    l ->> 'service_name',
    (l ->> 'quantity')::integer,
    (l ->> 'unit_price')::numeric,
    (l ->> 'duration_minutes')::integer,
    (l ->> 'sort_order')::integer
  from jsonb_array_elements(v_lines) l;

  -- The slot length follows the services, so the exclusion constraint
  -- re-checks the new span against everything else in the diary.
  update public.appointments
  set service_id        = v_first,
      ends_at           = v_appt.starts_at + make_interval(mins => v_minutes),
      services_subtotal = v_subtotal,
      discount_amount   = v_discount,
      quoted_total      = p_quoted_total,
      price_at_booking  = v_total
  where id = p_appointment_id;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, v_role, 'appointment.updated', 'appointment',
    p_appointment_id::text,
    jsonb_build_object(
      'customer_id', v_appt.customer_id,
      'services', jsonb_array_length(v_lines),
      'subtotal', v_subtotal,
      'discount', v_discount,
      'quoted_total', p_quoted_total,
      'price_from', v_appt.price_at_booking,
      'price_to', v_total
    )
  );
end;
$$;

revoke execute on function public.update_appointment_services(uuid, jsonb, numeric, numeric)
  from public;
grant execute on function public.update_appointment_services(uuid, jsonb, numeric, numeric)
  to authenticated, service_role;

-- =============================================================================
-- Balances for a list of appointments
--
-- `appointment_balance()` answers for one. A diary page showing thirty would
-- otherwise make thirty round trips, or sum the ledger in TypeScript -- and
-- money arithmetic belongs in Postgres.
-- =============================================================================

create or replace function public.appointment_balances(p_appointment_ids uuid[])
returns table (
  appointment_id uuid,
  amount_due     numeric,
  amount_paid    numeric,
  balance        numeric,
  has_receipt    boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    a.id,
    coalesce(bill.total, a.price_at_booking, 0)                        as amount_due,
    coalesce(paid.total, 0)                                            as amount_paid,
    round(coalesce(bill.total, a.price_at_booking, 0) - coalesce(paid.total, 0), 2)
                                                                       as balance,
    coalesce(bill.found, false)                                        as has_receipt
  from public.appointments a
  left join lateral (
    select round(sum(r.total), 2) as total, count(*) > 0 as found
    from public.receipts r
    where r.appointment_id = a.id and r.status = 'issued'
  ) bill on true
  left join lateral (
    select round(sum(p.amount), 2) as total
    from public.payments p
    where p.appointment_id = a.id
  ) paid on true
  where a.id = any (p_appointment_ids);
$$;

grant execute on function public.appointment_balances(uuid[]) to authenticated, service_role;
