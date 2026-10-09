-- =============================================================================
-- Payments: a ledger of money actually received
--
-- WHY A LEDGER RATHER THAN A COLUMN ON THE RECEIPT.
--
-- A receipt says what was owed. It could already say how it was settled --
-- cash, card, or a split of the two -- but only because settlement was assumed
-- to happen once, at the till, in full. Deposits break that assumption: a
-- customer paying 20% at booking pays it days BEFORE any receipt exists, so
-- there is nothing yet to put a column on.
--
-- So payment becomes its own list of events. Each row is an amount, a date, a
-- method and who took it. The receipt keeps saying what was owed.
--
-- TWO INDEPENDENT STATES. An appointment now has a service status (booked ->
-- confirmed -> completed: the work happened) and a payment status (unpaid /
-- part-paid / paid: the money arrived). They are deliberately not the same
-- axis. Completing an appointment must not require a receipt -- otherwise a
-- therapist cannot record that work was done until the customer settles, or
-- the salon issues a receipt marked paid when it is not.
--
-- ALLOCATION. A payment carries `appointment_id` when it belongs to a visit
-- and `receipt_id` when it was taken against a receipt. A deposit has the
-- first and not the second; a till payment for a booked visit has both; a
-- walk-in sale has only the second. Nothing is ever re-pointed afterwards --
-- the balance for a visit is simply what is owed less the sum of the payments
-- carrying that appointment_id, which needs no updates and so keeps the table
-- append-only.
--
-- APPEND-ONLY. As with receipts and the loyalty ledger: SELECT policies and no
-- write policies at all, writes only through the SECURITY DEFINER functions
-- below, plus a guard trigger -- because RLS does not constrain the
-- service_role key, and a money ledger that can be quietly edited is not one.
-- A correction is a reversing row, never an edit.
-- =============================================================================

create type public.payment_entry_method as enum ('cash', 'card', 'bank_transfer', 'other');

-- Derived by the functions, never chosen by the caller, so the daily report can
-- separate "advances taken today" from "bills settled today" without guessing.
create type public.payment_kind as enum ('deposit', 'settlement', 'refund');

create table public.payments (
  id             uuid primary key default gen_random_uuid(),
  -- Its own direct cascade. A path through appointments or receipts is not
  -- enough: a salon delete cascades to its children in an unspecified order,
  -- each as its own statement. Migrations 20260922000006 and 20260922000012
  -- were both this mistake.
  salon_id       uuid not null references public.salons (id) on delete cascade,
  customer_id    uuid not null,
  appointment_id uuid,
  receipt_id     uuid,
  kind           public.payment_kind not null,
  method         public.payment_entry_method not null,
  -- Signed: money in is positive, money back is negative. A zero payment is
  -- not an event.
  amount         numeric(12, 2) not null check (amount <> 0),
  -- When the money changed hands, which is not always when it was typed in.
  paid_at        timestamptz not null default now(),
  note           text not null default '' check (length(note) <= 500),
  -- A correction points at the row it reverses.
  reverses_id    uuid,
  recorded_by    uuid,
  created_at     timestamptz not null default now(),

  unique (id, salon_id),

  constraint payment_has_a_subject
    check (appointment_id is not null or receipt_id is not null),

  constraint payment_sign_matches_kind check (
    (kind = 'refund' and amount < 0) or (kind <> 'refund' and amount > 0)
  ),

  foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete no action,
  foreign key (appointment_id, salon_id)
    references public.appointments (id, salon_id) on delete cascade,
  foreign key (receipt_id, salon_id)
    references public.receipts (id, salon_id) on delete cascade,
  foreign key (reverses_id, salon_id)
    references public.payments (id, salon_id) on delete no action,
  foreign key (recorded_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (recorded_by)
);

create index payments_appointment_idx on public.payments (appointment_id);
create index payments_receipt_idx     on public.payments (receipt_id);
create index payments_customer_idx    on public.payments (customer_id, paid_at desc);
create index payments_salon_date_idx  on public.payments (salon_id, paid_at desc);

-- A receipt can now name the visit it settles, so the completed-appointment
-- view can show the bill and the daily report can avoid counting the same
-- money twice -- once as an appointment and again as a receipt.
alter table public.receipts
  add column appointment_id uuid,
  add constraint receipts_appointment_fk
    foreign key (appointment_id, salon_id)
      references public.appointments (id, salon_id) on delete no action;

create index receipts_appointment_idx on public.receipts (appointment_id);

-- =============================================================================
-- Row Level Security
-- =============================================================================

alter table public.payments enable row level security;

-- The front desk handles money, exactly as for `receipts`. A therapist has no
-- business reading what a customer has paid or still owes.
create policy payments_select_front_desk
  on public.payments for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

-- No insert, update or delete policy anywhere, deliberately. record_payment()
-- and refund_payment() are the only way in.

-- =============================================================================
-- Guard rail
-- =============================================================================

create or replace function public.guard_payments_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A salon being closed takes its ledger with it. The cascade removes the
  -- salon row first, so this is the only way the lookup comes back empty --
  -- nothing else reaches past the refusal below.
  if not exists (
    select 1 from public.salons s where s.id = coalesce(new.salon_id, old.salon_id)
  ) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  raise exception
    'The payment ledger is append-only; record a reversing payment instead of editing one';
end;
$$;

create trigger payments_guard_append_only
  before update or delete on public.payments
  for each row execute function public.guard_payments_append_only();

-- =============================================================================
-- Reading a balance
-- =============================================================================

/**
 * What one appointment is owed, has been paid, and still owes.
 *
 * The amount due is the receipt total once a receipt exists, and the agreed
 * price before that. It changes at checkout on purpose: the quote is an
 * estimate, and a discount given at the till is what the customer actually
 * owes.
 */
create or replace function public.appointment_balance(p_appointment_id uuid)
returns table (
  amount_due  numeric,
  amount_paid numeric,
  balance     numeric,
  has_receipt boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with appt as (
    select a.id, a.price_at_booking
    from public.appointments a
    where a.id = p_appointment_id
  ),
  bill as (
    select round(sum(r.total), 2) as total, count(*) > 0 as found
    from public.receipts r
    where r.appointment_id = p_appointment_id
      and r.status = 'issued'
  ),
  paid as (
    select coalesce(round(sum(p.amount), 2), 0) as total
    from public.payments p
    where p.appointment_id = p_appointment_id
  )
  select
    coalesce(bill.total, appt.price_at_booking, 0),
    paid.total,
    round(coalesce(bill.total, appt.price_at_booking, 0) - paid.total, 2),
    coalesce(bill.found, false)
  from appt, bill, paid;
$$;

grant execute on function public.appointment_balance(uuid) to authenticated, service_role;

-- =============================================================================
-- Taking a payment
-- =============================================================================

/**
 * Record money received against an appointment, before any receipt exists.
 *
 * This is the deposit / instalment path: "20% today, 20% on Thursday, the rest
 * on the day". Each call is one event with its own date, so the history reads
 * back as it happened.
 *
 * Overpayment is refused here rather than silently held as credit -- a deposit
 * larger than the agreed price is nearly always a typo, and the alternative
 * (accepting it and owing the difference back) is a worse default than asking.
 */
create or replace function public.record_payment(
  p_appointment_id uuid,
  p_amount         numeric,
  p_method         public.payment_entry_method,
  p_paid_at        timestamptz,
  p_note           text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id   uuid := public.current_salon_id();
  v_role       public.user_role := public.current_app_role();
  v_actor      uuid := (select auth.uid());
  v_appt       public.appointments%rowtype;
  v_amount     numeric(12, 2) := round(coalesce(p_amount, 0), 2);
  v_paid       numeric(12, 2);
  v_due        numeric(12, 2);
  v_payment_id uuid;
  v_when       timestamptz := coalesce(p_paid_at, now());
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if v_role not in ('owner', 'receptionist') then
    raise exception 'Only an owner or receptionist can take a payment';
  end if;
  if v_amount <= 0 then
    raise exception 'A payment has to be more than zero';
  end if;

  select * into v_appt
  from public.appointments a
  where a.id = p_appointment_id and a.salon_id = v_salon_id;

  if not found then
    raise exception 'That appointment could not be found';
  end if;

  if v_appt.status in ('cancelled', 'no_show') then
    raise exception 'That appointment was % -- refund the deposit instead of adding to it',
      v_appt.status;
  end if;

  -- One payment at a time per appointment, so two receptionists taking a
  -- deposit at once cannot between them exceed the balance.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_appointment_id::text, 2)
  );

  select ab.amount_paid, ab.amount_due into v_paid, v_due
  from public.appointment_balance(p_appointment_id) ab;

  if v_paid + v_amount > v_due then
    raise exception 'That would take the total paid to % against a bill of %',
      to_char(v_paid + v_amount, 'FM999999990.00'), to_char(v_due, 'FM999999990.00');
  end if;

  insert into public.payments
    (salon_id, customer_id, appointment_id, receipt_id, kind, method,
     amount, paid_at, note, recorded_by)
  values
    (v_salon_id, v_appt.customer_id, p_appointment_id, null, 'deposit', p_method,
     v_amount, v_when, coalesce(p_note, ''), v_actor)
  returning id into v_payment_id;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, v_role, 'payment.recorded', 'payment', v_payment_id::text,
    jsonb_build_object(
      'appointment_id', p_appointment_id, 'customer_id', v_appt.customer_id,
      'amount', v_amount, 'method', p_method, 'paid_at', v_when
    )
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(
  uuid, numeric, public.payment_entry_method, timestamptz, text
) from public;
grant execute on function public.record_payment(
  uuid, numeric, public.payment_entry_method, timestamptz, text
) to authenticated, service_role;

/**
 * Give money back.
 *
 * A reversing row rather than a deletion, so the history still shows that the
 * money arrived and then went back -- which is what actually happened, and
 * what the customer's own record of it will say.
 *
 * Owner-only, and a reason is required, on the same footing as voiding a
 * receipt.
 */
create or replace function public.refund_payment(
  p_payment_id uuid,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id   uuid := public.current_salon_id();
  v_actor      uuid := (select auth.uid());
  v_original   public.payments%rowtype;
  v_already    numeric(12, 2);
  v_refund_id  uuid;
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;
  if not public.is_owner() then
    raise exception 'Only the salon owner can refund a payment';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Give a reason for the refund';
  end if;

  select * into v_original
  from public.payments p
  where p.id = p_payment_id and p.salon_id = v_salon_id;

  if not found then
    raise exception 'That payment could not be found';
  end if;
  if v_original.kind = 'refund' then
    raise exception 'That row is itself a refund';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_payment_id::text, 3)
  );

  -- Refunding the same payment twice would hand back money that was only
  -- received once.
  select coalesce(round(sum(-p.amount), 2), 0) into v_already
  from public.payments p
  where p.reverses_id = p_payment_id;

  if v_already >= v_original.amount then
    raise exception 'That payment has already been refunded';
  end if;

  insert into public.payments
    (salon_id, customer_id, appointment_id, receipt_id, kind, method,
     amount, paid_at, note, reverses_id, recorded_by)
  values
    (v_salon_id, v_original.customer_id, v_original.appointment_id,
     v_original.receipt_id, 'refund', v_original.method,
     -(v_original.amount - v_already), now(), btrim(p_reason), p_payment_id, v_actor)
  returning id into v_refund_id;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, 'owner', 'payment.refunded', 'payment', v_refund_id::text,
    jsonb_build_object(
      'reverses', p_payment_id, 'customer_id', v_original.customer_id,
      'amount', v_original.amount - v_already, 'reason', btrim(p_reason)
    )
  );

  return v_refund_id;
end;
$$;

revoke execute on function public.refund_payment(uuid, text) from public;
grant execute on function public.refund_payment(uuid, text) to authenticated, service_role;
