-- =============================================================================
-- Phase 4: POS receipts + loyalty as currency
--
-- The brief is explicit that all money arithmetic happens server-side and that
-- no client-submitted total is ever trusted. This migration takes that further
-- than RLS alone would:
--
--   receipts, receipt_line_items and loyalty_transactions have SELECT policies
--   and NOTHING ELSE. There is no INSERT, UPDATE or DELETE policy on any of
--   them. The only way to write a receipt or move a loyalty balance is through
--   the SECURITY DEFINER functions at the bottom of this file, which re-derive
--   every figure from the catalogue and check the caller's role themselves.
--
-- A receptionist with a REST client and the publishable key therefore cannot
-- mint loyalty, alter a total, or hand-write a receipt line.
-- =============================================================================

create type public.payment_method as enum ('cash', 'card', 'split');
create type public.receipt_status as enum ('issued', 'voided');
create type public.loyalty_transaction_type as enum ('earn', 'redeem', 'void_reversal');

-- -----------------------------------------------------------------------------
-- receipts
-- -----------------------------------------------------------------------------
create table public.receipts (
  id                uuid primary key default gen_random_uuid(),
  salon_id          uuid not null references public.salons (id) on delete cascade,
  -- Gapless, per salon, for printing and for the customer to quote back.
  receipt_number    integer not null,
  customer_id       uuid not null,
  issued_by         uuid,
  deal_id           uuid,

  -- Every figure below is computed by create_receipt(), never supplied.
  subtotal          numeric(12, 2) not null check (subtotal >= 0),
  discount_total    numeric(12, 2) not null default 0 check (discount_total >= 0),
  loyalty_redeemed  numeric(12, 2) not null default 0 check (loyalty_redeemed >= 0),
  total             numeric(12, 2) not null check (total >= 0),
  loyalty_earned    numeric(12, 2) not null default 0 check (loyalty_earned >= 0),
  -- The rate in force at the time, so an old receipt still explains itself
  -- after the owner changes the setting.
  loyalty_earn_rate numeric(6, 4) not null,

  payment_method    public.payment_method not null,
  cash_amount       numeric(12, 2) not null default 0 check (cash_amount >= 0),
  card_amount       numeric(12, 2) not null default 0 check (card_amount >= 0),

  status            public.receipt_status not null default 'issued',
  void_reason       text,
  voided_at         timestamptz,
  voided_by         uuid,

  notes             text not null default '',
  created_at        timestamptz not null default now(),

  unique (id, salon_id),
  unique (salon_id, receipt_number),

  constraint receipts_totals_consistent
    check (total = subtotal - discount_total - loyalty_redeemed),
  constraint receipts_payment_covers_total
    check (cash_amount + card_amount = total),
  constraint receipts_void_has_reason
    check (
      status <> 'voided'
      or (void_reason is not null and length(btrim(void_reason)) > 0 and voided_at is not null)
    ),

  foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete restrict,
  foreign key (issued_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (issued_by),
  foreign key (voided_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (voided_by),
  foreign key (deal_id, salon_id)
    references public.deals (id, salon_id) on delete restrict
);

create index receipts_salon_created_idx on public.receipts (salon_id, created_at desc);
create index receipts_customer_idx on public.receipts (customer_id, created_at desc);

-- -----------------------------------------------------------------------------
-- receipt_line_items
--
-- `service_name` and `unit_price` are snapshots: a receipt is a financial
-- record and must not change when the price list does.
--
-- `performed_at` is a deliberate copy of the receipt's timestamp. It lets a
-- therapist read their own services-performed history without being granted
-- access to the receipt header, which carries the customer's total spend and
-- loyalty position -- things the brief keeps away from them.
-- -----------------------------------------------------------------------------
create table public.receipt_line_items (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null,
  receipt_id      uuid not null,
  service_id      uuid,
  service_name    text not null,
  staff_id        uuid,
  appointment_id  uuid,
  quantity        integer not null default 1 check (quantity between 1 and 99),
  unit_price      numeric(12, 2) not null check (unit_price >= 0),
  discount_amount numeric(12, 2) not null default 0 check (discount_amount >= 0),
  line_total      numeric(12, 2) not null check (line_total >= 0),
  performed_at    timestamptz not null default now(),
  sort_order      integer not null default 0,

  constraint line_total_consistent
    check (line_total = (unit_price * quantity) - discount_amount),

  foreign key (receipt_id, salon_id)
    references public.receipts (id, salon_id) on delete cascade,
  foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete set null (service_id),
  foreign key (staff_id, salon_id)
    references public.profiles (id, salon_id) on delete set null (staff_id),
  foreign key (appointment_id, salon_id)
    references public.appointments (id, salon_id) on delete set null (appointment_id)
);

create index receipt_line_items_receipt_idx on public.receipt_line_items (receipt_id, sort_order);
create index receipt_line_items_staff_idx on public.receipt_line_items (staff_id, performed_at desc);
create index receipt_line_items_service_idx on public.receipt_line_items (service_id);

-- -----------------------------------------------------------------------------
-- loyalty_transactions -- the ledger. Append-only; the balance is its sum.
--
-- `amount` is signed: earning is positive, redeeming negative. Keeping one
-- signed column means the balance is a plain SUM that cannot disagree with
-- itself, which a pair of earned/redeemed columns eventually would.
-- -----------------------------------------------------------------------------
create table public.loyalty_transactions (
  id                uuid primary key default gen_random_uuid(),
  salon_id          uuid not null,
  customer_id       uuid not null,
  receipt_id        uuid,
  type              public.loyalty_transaction_type not null,
  amount            numeric(12, 2) not null,
  resulting_balance numeric(12, 2) not null,
  created_at        timestamptz not null default now(),

  constraint loyalty_amount_sign check (
    (type = 'earn'  and amount > 0)
    or (type = 'redeem' and amount < 0)
    or (type = 'void_reversal' and amount <> 0)
  ),

  foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete restrict,
  foreign key (receipt_id, salon_id)
    references public.receipts (id, salon_id) on delete set null (receipt_id)
);

create index loyalty_transactions_customer_idx
  on public.loyalty_transactions (customer_id, created_at desc);
create index loyalty_transactions_salon_created_idx
  on public.loyalty_transactions (salon_id, created_at desc);
create index loyalty_transactions_receipt_idx on public.loyalty_transactions (receipt_id);

-- =============================================================================
-- Balance
-- =============================================================================

/**
 * A customer's loyalty balance, in salon currency.
 *
 * Derived from the ledger rather than cached on the customer row: a cached
 * column is one bug away from disagreeing with the transactions that justify
 * it, and this figure is a real liability the owner reports on.
 */
create or replace function public.customer_loyalty_balance(p_customer_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(lt.amount), 0)::numeric(12, 2)
  from public.loyalty_transactions lt
  where lt.customer_id = p_customer_id
    and lt.salon_id = public.current_salon_id()
$$;

revoke execute on function public.customer_loyalty_balance(uuid) from public;
grant execute on function public.customer_loyalty_balance(uuid) to authenticated, service_role;

-- =============================================================================
-- Row Level Security
--
-- SELECT only. See the note at the top of this file.
-- =============================================================================
alter table public.receipts             enable row level security;
alter table public.receipt_line_items   enable row level security;
alter table public.loyalty_transactions enable row level security;

-- The receipt header shows what the customer spent and where their loyalty
-- balance stands, so it stays with the front desk and the owner.
create policy receipts_select_front_desk
  on public.receipts for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

-- A therapist sees the lines they personally performed -- their
-- services-performed history -- and nothing else on the receipt.
create policy receipt_line_items_select_permitted
  on public.receipt_line_items for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and (
      public.current_app_role() in ('owner', 'receptionist')
      or staff_id = (select auth.uid())
    )
  );

create policy loyalty_transactions_select_front_desk
  on public.loyalty_transactions for select to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

-- =============================================================================
-- Checkout
-- =============================================================================

/**
 * Issue a receipt.
 *
 * SECURITY DEFINER because the tables it writes have no write policies at all;
 * this function is the only door. It therefore does its own authorisation
 * rather than leaning on RLS, and re-derives every monetary figure from the
 * catalogue. The caller supplies *what was done* -- services, quantities, who
 * performed them -- never what it costs.
 *
 * p_lines: [{ service_id, staff_id, quantity, appointment_id }]
 */
create or replace function public.create_receipt(
  p_customer_id     uuid,
  p_payment_method  public.payment_method,
  p_cash_amount     numeric,
  p_card_amount     numeric,
  p_loyalty_redeem  numeric,
  p_deal_id         uuid,
  p_notes           text,
  p_lines           jsonb
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

  -- Taking payment is a front-desk job.
  if v_role not in ('owner', 'receptionist') then
    raise exception 'Only an owner or receptionist can issue a receipt';
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'A receipt needs at least one service';
  end if;

  -- Serialise per customer, so two tills cannot both spend the same balance,
  -- and per salon, so receipt numbering has no gaps or collisions.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_customer_id::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_salon_id::text, 1));

  if not exists (
    select 1 from public.customers c
    where c.id = p_customer_id and c.salon_id = v_salon_id
  ) then
    raise exception 'That customer is not in this salon';
  end if;

  -- ---- 1. price every line from the catalogue -----------------------------
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

    -- A therapist must be nameable for payroll, and must be one.
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

  -- ---- 2. apply the deal, if one was chosen -------------------------------
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

    else -- bundle_price: the qualifying set is charged at the bundle price,
         -- but only when the whole bundle is actually present.
      select array_agg(distinct (l ->> 'service_id')::uuid) into v_present
      from jsonb_array_elements(v_lines) l
      where (l ->> 'service_id')::uuid = any (v_deal_services);

      if not (v_deal_services <@ coalesce(v_present, array[]::uuid[])) then
        raise exception 'That bundle needs every one of its services on the receipt';
      end if;

      v_bundle_cut := v_eligible_gross - round(v_deal.value, 2);
      v_discount_total := greatest(v_bundle_cut, 0);
    end if;

    -- Spread the discount across the qualifying lines in proportion to their
    -- value, so payroll attributes the right amount to each therapist.
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

    -- Proportional rounding can drift a cent from the intended total; settle
    -- it on the largest qualifying line so the receipt adds up exactly.
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

  -- ---- 3. loyalty redemption ----------------------------------------------
  v_balance := public.customer_loyalty_balance(p_customer_id);
  v_redeem := round(greatest(coalesce(p_loyalty_redeem, 0), 0), 2);

  -- Never more than the balance, never more than the bill. Raised rather than
  -- silently clamped: the till should not quietly charge more than it showed.
  if v_redeem > greatest(v_balance, 0) then
    raise exception 'Only % is available to redeem', to_char(greatest(v_balance, 0), 'FM999999990.00');
  end if;
  if v_redeem > v_bill then
    raise exception 'Loyalty redemption cannot exceed the bill total';
  end if;

  v_total := round(v_bill - v_redeem, 2);

  -- ---- 4. payment ----------------------------------------------------------
  if p_payment_method = 'cash' then
    v_cash := v_total; v_card := 0;
  elsif p_payment_method = 'card' then
    v_card := v_total; v_cash := 0;
  elsif v_cash + v_card <> v_total then
    raise exception 'The split (% cash + % card) does not add up to %',
      to_char(v_cash, 'FM999999990.00'), to_char(v_card, 'FM999999990.00'),
      to_char(v_total, 'FM999999990.00');
  end if;

  -- ---- 5. earn --------------------------------------------------------------
  -- The rate lives in salon_settings so the 5% default is configurable.
  select ss.loyalty_earn_rate into v_rate
  from public.salon_settings ss where ss.salon_id = v_salon_id;
  v_rate := coalesce(v_rate, 0.05);

  -- Earned on what was actually paid, i.e. after discount and after any
  -- redemption -- so spending a balance cannot itself mint a new one.
  v_earned := round(v_total * v_rate, 2);

  -- ---- 6. write -------------------------------------------------------------
  select coalesce(max(r.receipt_number), 0) + 1 into v_number
  from public.receipts r where r.salon_id = v_salon_id;

  insert into public.receipts (
    id, salon_id, receipt_number, customer_id, issued_by, deal_id,
    subtotal, discount_total, loyalty_redeemed, total,
    loyalty_earned, loyalty_earn_rate,
    payment_method, cash_amount, card_amount, notes, created_at
  ) values (
    v_receipt_id, v_salon_id, v_number, p_customer_id, v_actor, p_deal_id,
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

  -- ---- 7. ledger ------------------------------------------------------------
  if v_redeem > 0 then
    v_balance := v_balance - v_redeem;
    insert into public.loyalty_transactions
      (salon_id, customer_id, receipt_id, type, amount, resulting_balance, created_at)
    values
      (v_salon_id, p_customer_id, v_receipt_id, 'redeem', -v_redeem, v_balance, v_now);

    insert into public.audit_logs
      (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
    values (
      v_salon_id, v_actor, v_role, 'loyalty.redeemed', 'receipt', v_receipt_id::text,
      jsonb_build_object('customer_id', p_customer_id, 'amount', v_redeem,
                         'resulting_balance', v_balance)
    );
  end if;

  if v_earned > 0 then
    v_balance := v_balance + v_earned;
    insert into public.loyalty_transactions
      (salon_id, customer_id, receipt_id, type, amount, resulting_balance, created_at)
    values
      (v_salon_id, p_customer_id, v_receipt_id, 'earn', v_earned, v_balance, v_now);
  end if;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, v_role, 'receipt.created', 'receipt', v_receipt_id::text,
    jsonb_build_object(
      'receipt_number', v_number, 'customer_id', p_customer_id,
      'subtotal', v_gross, 'discount_total', v_discount_total,
      'loyalty_redeemed', v_redeem, 'total', v_total, 'loyalty_earned', v_earned,
      'payment_method', p_payment_method
    )
  );

  return v_receipt_id;
end;
$$;

revoke execute on function public.create_receipt(uuid, public.payment_method, numeric, numeric, numeric, uuid, text, jsonb) from public;
grant execute on function public.create_receipt(uuid, public.payment_method, numeric, numeric, numeric, uuid, text, jsonb)
  to authenticated, service_role;

-- =============================================================================
-- Void
-- =============================================================================

/**
 * Void a receipt. Owner only, reason required.
 *
 * The receipt is marked, never deleted -- the brief requires the original to
 * stay in the record. The loyalty it moved is undone with compensating ledger
 * entries rather than by editing history, so the balance and the transactions
 * that justify it always agree.
 */
create or replace function public.void_receipt(p_receipt_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon_id uuid := public.current_salon_id();
  v_actor    uuid := (select auth.uid());
  v_receipt  public.receipts%rowtype;
  v_balance  numeric(12, 2);
  v_now      timestamptz := now();
begin
  if v_salon_id is null then
    raise exception 'You are not signed in to a salon';
  end if;

  -- Voiding moves money, so it is the owner's call alone.
  if not public.is_owner() then
    raise exception 'Only the salon owner can void a receipt';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Voiding a receipt requires a reason';
  end if;

  select * into v_receipt
  from public.receipts r
  where r.id = p_receipt_id and r.salon_id = v_salon_id
  for update;

  if not found then
    raise exception 'That receipt could not be found';
  end if;
  if v_receipt.status = 'voided' then
    raise exception 'That receipt is already voided';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_receipt.customer_id::text, 0)
  );

  v_balance := public.customer_loyalty_balance(v_receipt.customer_id);

  -- Take back what the receipt granted...
  if v_receipt.loyalty_earned > 0 then
    v_balance := v_balance - v_receipt.loyalty_earned;
    insert into public.loyalty_transactions
      (salon_id, customer_id, receipt_id, type, amount, resulting_balance, created_at)
    values
      (v_salon_id, v_receipt.customer_id, v_receipt.id, 'void_reversal',
       -v_receipt.loyalty_earned, v_balance, v_now);
  end if;

  -- ...and give back what it consumed. If the customer has already spent the
  -- points this receipt granted, the balance can land below zero. That is left
  -- visible rather than clamped: it is a real debt, and redemption is capped at
  -- zero elsewhere so it cannot be spent.
  if v_receipt.loyalty_redeemed > 0 then
    v_balance := v_balance + v_receipt.loyalty_redeemed;
    insert into public.loyalty_transactions
      (salon_id, customer_id, receipt_id, type, amount, resulting_balance, created_at)
    values
      (v_salon_id, v_receipt.customer_id, v_receipt.id, 'void_reversal',
       v_receipt.loyalty_redeemed, v_balance, v_now);
  end if;

  update public.receipts
  set status = 'voided',
      void_reason = btrim(p_reason),
      voided_at = v_now,
      voided_by = v_actor
  where id = v_receipt.id;

  insert into public.audit_logs
    (salon_id, actor_id, actor_role, action, entity_type, entity_id, metadata)
  values (
    v_salon_id, v_actor, 'owner', 'receipt.voided', 'receipt', v_receipt.id::text,
    jsonb_build_object(
      'receipt_number', v_receipt.receipt_number,
      'customer_id', v_receipt.customer_id,
      'total', v_receipt.total,
      'loyalty_earned_reversed', v_receipt.loyalty_earned,
      'loyalty_redeemed_restored', v_receipt.loyalty_redeemed,
      'reason', btrim(p_reason)
    )
  );
end;
$$;

revoke execute on function public.void_receipt(uuid, text) from public;
grant execute on function public.void_receipt(uuid, text) to authenticated, service_role;

-- =============================================================================
-- Guard rails
-- =============================================================================

-- Nothing edits a receipt in place. void_receipt() is SECURITY DEFINER and
-- passes through this trigger too, so it is allowed exactly the void columns.
create or replace function public.guard_receipt_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.salon_id      is distinct from old.salon_id
     or new.receipt_number is distinct from old.receipt_number
     or new.customer_id   is distinct from old.customer_id
     or new.subtotal      is distinct from old.subtotal
     or new.discount_total is distinct from old.discount_total
     or new.loyalty_redeemed is distinct from old.loyalty_redeemed
     or new.total         is distinct from old.total
     or new.loyalty_earned is distinct from old.loyalty_earned
     or new.loyalty_earn_rate is distinct from old.loyalty_earn_rate
     or new.payment_method is distinct from old.payment_method
     or new.cash_amount   is distinct from old.cash_amount
     or new.card_amount   is distinct from old.card_amount
     or new.created_at    is distinct from old.created_at then
    raise exception 'A receipt cannot be altered; void it and issue a new one';
  end if;

  if old.status = 'voided' and new.status is distinct from old.status then
    raise exception 'A voided receipt cannot be reinstated';
  end if;

  return new;
end;
$$;

create trigger receipts_guard_immutable
  before update on public.receipts
  for each row execute function public.guard_receipt_immutable();

-- The ledger is append-only, like the audit log.
--
-- The one exception is a salon being deleted outright. A cascade removes the
-- parent salon row first, so by the time this fires for the children the salon
-- is already gone -- and that is the only way `exists` comes back false here.
-- Without this, a closed salon's rows could never be removed at all, and the
-- guard would be protecting data that has no owner left.
create or replace function public.guard_loyalty_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.salons s where s.id = old.salon_id) then
    raise exception 'Loyalty transactions are append-only; void the receipt instead';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create trigger loyalty_transactions_append_only
  before update or delete on public.loyalty_transactions
  for each row execute function public.guard_loyalty_append_only();

-- Receipt lines are part of the financial record.
create or replace function public.guard_receipt_lines_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same carve-out as the ledger guard above: a deleted salon takes its
  -- records with it, and nothing else can reach this branch.
  if exists (select 1 from public.salons s where s.id = old.salon_id) then
    raise exception 'Receipt lines cannot be changed; void the receipt instead';
  end if;

  return new;
end;
$$;

create trigger receipt_line_items_immutable
  before update on public.receipt_line_items
  for each row execute function public.guard_receipt_lines_immutable();
