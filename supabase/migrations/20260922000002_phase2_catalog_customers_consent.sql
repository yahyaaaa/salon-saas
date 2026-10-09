-- =============================================================================
-- Phase 2: Services & pricing, deals, customer profiles, consent/medical intake
--
-- Tables: consent_templates, consent_template_items, services, service_staff,
--         deals, deal_services, customers, consent_forms, consent_form_responses
--
-- Two structural rules run through this migration:
--
--   1. Every table carries salon_id and is guarded by RLS, as in Phase 1.
--   2. Every foreign key between tenant tables is COMPOSITE -- it references
--      (id, salon_id), not just id. That makes it physically impossible to
--      stitch a row to a parent in another salon, even with RLS disabled or a
--      bug in application code. Each parent therefore carries a
--      `unique (id, salon_id)` alongside its primary key purely to be a
--      composite FK target.
-- =============================================================================

create type public.deal_type as enum ('percentage', 'fixed_amount', 'bundle_price');

-- Composite FK targets for the Phase 1 tables that Phase 2 references.
alter table public.profiles add constraint profiles_id_salon_key unique (id, salon_id);

-- -----------------------------------------------------------------------------
-- consent_templates -- the treatment-specific consent wording an owner defines.
-- Templates are archived (is_active = false), never deleted: a signed consent
-- form must keep pointing at the template it was signed against.
-- -----------------------------------------------------------------------------
create table public.consent_templates (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null references public.salons (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 160),
  description text not null default '',
  -- Whether the intake section (medical history / allergies) must be filled in.
  requires_medical_history boolean not null default true,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, salon_id)
);

create index consent_templates_salon_idx on public.consent_templates (salon_id) where is_active;

create trigger consent_templates_set_updated_at
  before update on public.consent_templates
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- consent_template_items -- the individual "I consent to ..." checkboxes.
-- -----------------------------------------------------------------------------
create table public.consent_template_items (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null,
  template_id uuid not null,
  label       text not null check (length(btrim(label)) between 1 and 500),
  is_required boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  foreign key (template_id, salon_id)
    references public.consent_templates (id, salon_id) on delete cascade
);

create index consent_template_items_template_idx
  on public.consent_template_items (template_id, sort_order);

-- -----------------------------------------------------------------------------
-- services -- what the salon sells. Price and duration drive the booking
-- calendar (Phase 3) and the POS (Phase 4), so both are required.
-- -----------------------------------------------------------------------------
create table public.services (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null references public.salons (id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 160),
  category         text not null default 'General' check (length(btrim(category)) between 1 and 80),
  description      text not null default '',
  price            numeric(12, 2) not null check (price >= 0),
  duration_minutes integer not null check (duration_minutes between 5 and 1440),
  -- Which consent wording applies when this treatment is performed, if any.
  consent_template_id uuid,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, salon_id),
  -- Archiving a template must not silently detach it from live services, so
  -- this restricts rather than cascades; templates are archived, not deleted.
  foreign key (consent_template_id, salon_id)
    references public.consent_templates (id, salon_id) on delete restrict
);

create index services_salon_idx on public.services (salon_id) where is_active;
create index services_salon_category_idx on public.services (salon_id, category);

-- No two live services may share a name, which would make the POS ambiguous.
create unique index services_unique_active_name
  on public.services (salon_id, lower(btrim(name)))
  where is_active;

create trigger services_set_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- service_staff -- which staff members are qualified to perform a service.
-- Empty means "anyone"; the booking UI reads it that way.
-- -----------------------------------------------------------------------------
create table public.service_staff (
  salon_id   uuid not null,
  service_id uuid not null,
  staff_id   uuid not null,
  created_at timestamptz not null default now(),
  primary key (service_id, staff_id),
  foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete cascade,
  foreign key (staff_id, salon_id)
    references public.profiles (id, salon_id) on delete cascade
);

create index service_staff_staff_idx on public.service_staff (staff_id);

-- -----------------------------------------------------------------------------
-- deals -- time-boxed discounts the receptionist applies at checkout (Phase 4).
-- -----------------------------------------------------------------------------
create table public.deals (
  id         uuid primary key default gen_random_uuid(),
  salon_id   uuid not null references public.salons (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 160),
  deal_type  public.deal_type not null,
  -- percentage: 0-100. fixed_amount: currency off the line. bundle_price: the
  -- total charged for the whole set of linked services.
  value      numeric(12, 2) not null check (value >= 0),
  starts_on  date not null,
  ends_on    date not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, salon_id),
  constraint deals_period_valid check (ends_on >= starts_on),
  constraint deals_percentage_within_range
    check (deal_type <> 'percentage' or value <= 100)
);

create index deals_salon_window_idx on public.deals (salon_id, starts_on, ends_on) where is_active;

create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();

create table public.deal_services (
  salon_id   uuid not null,
  deal_id    uuid not null,
  service_id uuid not null,
  primary key (deal_id, service_id),
  foreign key (deal_id, salon_id)
    references public.deals (id, salon_id) on delete cascade,
  foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete cascade
);

create index deal_services_service_idx on public.deal_services (service_id);

-- -----------------------------------------------------------------------------
-- customers -- phone is the primary lookup key, per the brief.
--
-- phone_normalized strips formatting so "+92 300 1234567", "03001234567" and
-- "0300-123-4567" collide as the same customer instead of creating duplicates.
-- -----------------------------------------------------------------------------
create table public.customers (
  id               uuid primary key default gen_random_uuid(),
  salon_id         uuid not null references public.salons (id) on delete cascade,
  full_name        text not null check (length(btrim(full_name)) between 1 and 160),
  phone            text not null check (length(btrim(phone)) between 3 and 32),
  phone_normalized text generated always as (regexp_replace(phone, '[^0-9]', '', 'g')) stored,
  email            text,
  date_of_birth    date,
  notes            text not null default '',
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (id, salon_id),
  foreign key (created_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (created_by)
);

-- One customer per phone number within a salon. Different salons are free to
-- hold the same person independently -- they are separate tenants.
create unique index customers_salon_phone_key
  on public.customers (salon_id, phone_normalized);

create index customers_salon_name_idx on public.customers (salon_id, lower(full_name));

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- consent_forms -- SENSITIVE MEDICAL RECORD.
--
-- One row per visit rather than one per customer, so the history is versioned:
-- a form is never edited after signing, a new one is collected next time.
-- `signature_path` points at an object in the private consent-signatures
-- bucket, laid out as <salon_id>/<customer_id>/<form_id>.png so the storage
-- policies can authorise on the path prefix alone.
-- -----------------------------------------------------------------------------
create table public.consent_forms (
  id              uuid primary key default gen_random_uuid(),
  salon_id        uuid not null references public.salons (id) on delete cascade,
  customer_id     uuid not null,
  template_id     uuid,
  service_id      uuid,
  -- Phase 3 links the form to the appointment it was collected for; until then
  -- it stays null and staff visibility falls back to "forms I collected".
  appointment_id  uuid,
  collected_by    uuid,
  medical_history text not null default '',
  allergies       text not null default '',
  signature_path  text,
  signed_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (id, salon_id),
  -- Medical records outlive the catalogue rows that describe them, so these
  -- restrict. Services and templates are archived, never deleted.
  foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete restrict,
  foreign key (template_id, salon_id)
    references public.consent_templates (id, salon_id) on delete restrict,
  foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete restrict,
  -- A staff member may leave; the record of what they collected must remain.
  foreign key (collected_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (collected_by)
);

create index consent_forms_customer_idx on public.consent_forms (customer_id, created_at desc);
create index consent_forms_salon_idx on public.consent_forms (salon_id, created_at desc);
create index consent_forms_collected_by_idx on public.consent_forms (collected_by);

-- -----------------------------------------------------------------------------
-- consent_form_responses -- the ticked boxes, with the wording snapshotted.
--
-- `label` is a copy, not a lookup. Consent is a legal record: if the owner
-- later edits the template, what this customer actually agreed to must not
-- change underneath them.
-- -----------------------------------------------------------------------------
create table public.consent_form_responses (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null,
  form_id     uuid not null,
  item_id     uuid,
  label       text not null,
  is_required boolean not null default false,
  checked     boolean not null default false,
  sort_order  integer not null default 0,
  foreign key (form_id, salon_id)
    references public.consent_forms (id, salon_id) on delete cascade
);

create index consent_form_responses_form_idx
  on public.consent_form_responses (form_id, sort_order);

-- =============================================================================
-- Consent visibility
--
-- Single source of truth for who may see a consent form, used by both the
-- consent_forms policies and the storage policies on the signature images, so
-- the two can never drift apart. Phase 3 extends this one function to include
-- the staff member treating the linked appointment.
-- =============================================================================
create or replace function public.can_access_consent_form(
  p_salon_id uuid,
  p_collected_by uuid
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
       -- A therapist sees only what they collected themselves.
       or p_collected_by = (select auth.uid())
     )
$$;

revoke execute on function public.can_access_consent_form(uuid, uuid) from public;
grant execute on function public.can_access_consent_form(uuid, uuid) to authenticated, service_role;

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.consent_templates      enable row level security;
alter table public.consent_template_items enable row level security;
alter table public.services               enable row level security;
alter table public.service_staff          enable row level security;
alter table public.deals                  enable row level security;
alter table public.deal_services          enable row level security;
alter table public.customers              enable row level security;
alter table public.consent_forms          enable row level security;
alter table public.consent_form_responses enable row level security;

-- --- Catalogue: everyone in the salon reads, only the owner writes -----------
-- Receptionists need services and deals to build a bill; therapists need to
-- know what they are performing. Pricing changes stay with the owner.

create policy services_select_own_tenant
  on public.services for select to authenticated
  using (salon_id = public.current_salon_id());

create policy services_write_owner_only
  on public.services for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy service_staff_select_own_tenant
  on public.service_staff for select to authenticated
  using (salon_id = public.current_salon_id());

create policy service_staff_write_owner_only
  on public.service_staff for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy deals_select_own_tenant
  on public.deals for select to authenticated
  using (salon_id = public.current_salon_id());

create policy deals_write_owner_only
  on public.deals for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy deal_services_select_own_tenant
  on public.deal_services for select to authenticated
  using (salon_id = public.current_salon_id());

create policy deal_services_write_owner_only
  on public.deal_services for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy consent_templates_select_own_tenant
  on public.consent_templates for select to authenticated
  using (salon_id = public.current_salon_id());

create policy consent_templates_write_owner_only
  on public.consent_templates for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

create policy consent_template_items_select_own_tenant
  on public.consent_template_items for select to authenticated
  using (salon_id = public.current_salon_id());

create policy consent_template_items_write_owner_only
  on public.consent_template_items for all to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner())
  with check (salon_id = public.current_salon_id() and public.is_owner());

-- --- Customers ---------------------------------------------------------------
-- Readable salon-wide: a therapist needs the name and number of the person in
-- their chair. Created and edited by owners and receptionists -- the brief puts
-- customer profile management on the front desk.

create policy customers_select_own_tenant
  on public.customers for select to authenticated
  using (salon_id = public.current_salon_id());

create policy customers_insert_front_desk
  on public.customers for insert to authenticated
  with check (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

create policy customers_update_front_desk
  on public.customers for update to authenticated
  using (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  )
  with check (
    salon_id = public.current_salon_id()
    and public.current_app_role() in ('owner', 'receptionist')
  );

-- Deleting a customer would orphan their medical history. Owners only, and the
-- restrict-style foreign keys above still block it once consent exists.
create policy customers_delete_owner_only
  on public.customers for delete to authenticated
  using (salon_id = public.current_salon_id() and public.is_owner());

-- --- Consent forms: sensitive medical information ----------------------------
-- Read access is narrower than the rest of the app and is defined once, in
-- can_access_consent_form(). There is deliberately no UPDATE and no DELETE
-- policy: a signed consent record is immutable, and a correction means
-- collecting a new form.

create policy consent_forms_select_permitted
  on public.consent_forms for select to authenticated
  using (public.can_access_consent_form(salon_id, collected_by));

create policy consent_forms_insert_own_tenant
  on public.consent_forms for insert to authenticated
  with check (
    salon_id = public.current_salon_id()
    -- You may only record a form as collected by yourself.
    and collected_by = (select auth.uid())
  );

-- A form that was never signed is a draft -- the collector abandoned it, or the
-- signature upload failed part-way. Its collector may discard it. Signed forms
-- stay undeletable: no policy covers them, and responses cascade from here.
create policy consent_forms_delete_unsigned_draft
  on public.consent_forms for delete to authenticated
  using (
    salon_id = public.current_salon_id()
    and collected_by = (select auth.uid())
    and signed_at is null
  );

create policy consent_form_responses_select_permitted
  on public.consent_form_responses for select to authenticated
  using (
    exists (
      select 1
      from public.consent_forms f
      where f.id = form_id
        and public.can_access_consent_form(f.salon_id, f.collected_by)
    )
  );

create policy consent_form_responses_insert_own_tenant
  on public.consent_form_responses for insert to authenticated
  with check (
    salon_id = public.current_salon_id()
    and exists (
      select 1
      from public.consent_forms f
      where f.id = form_id
        and f.salon_id = public.current_salon_id()
        and f.collected_by = (select auth.uid())
    )
  );

-- =============================================================================
-- Guard rails
-- =============================================================================

-- A signed consent form is a legal record. Block any edit to the substantive
-- fields after signing; only the Phase 3 appointment link may still be set.
create or replace function public.guard_consent_form_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.signed_at is not null then
    if new.medical_history is distinct from old.medical_history
       or new.allergies is distinct from old.allergies
       or new.signature_path is distinct from old.signature_path
       or new.signed_at is distinct from old.signed_at
       or new.customer_id is distinct from old.customer_id
       or new.template_id is distinct from old.template_id
       or new.service_id is distinct from old.service_id
       or new.salon_id is distinct from old.salon_id then
      raise exception 'A signed consent form cannot be altered; collect a new one instead';
    end if;

    -- collected_by is the one exception. When a staff account is deleted
    -- outright, the foreign key nulls this column, and that UPDATE lands here.
    -- Blocking it would make such an account undeletable forever. Losing the
    -- attribution is acceptable; re-pointing it at a different person is not.
    if new.collected_by is distinct from old.collected_by and new.collected_by is not null then
      raise exception 'A signed consent form cannot be reattributed to another user';
    end if;
  end if;

  return new;
end;
$$;

create trigger consent_forms_guard_immutable
  before update on public.consent_forms
  for each row execute function public.guard_consent_form_immutable();

-- Likewise for the ticked boxes.
create or replace function public.guard_consent_responses_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_signed timestamptz;
begin
  select f.signed_at into v_signed
  from public.consent_forms f
  where f.id = coalesce(new.form_id, old.form_id);

  if v_signed is not null then
    raise exception 'Responses on a signed consent form cannot be altered';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger consent_form_responses_guard_immutable
  before update or delete on public.consent_form_responses
  for each row execute function public.guard_consent_responses_immutable();

-- Only staff who are permitted to perform a service may be linked to it.
-- Owners count as staff for this purpose -- small salons run that way.
create or replace function public.guard_service_staff_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.user_role;
begin
  select p.role into v_role
  from public.profiles p
  where p.id = new.staff_id;

  if v_role is null or v_role = 'receptionist' then
    raise exception 'Only therapists and owners can be assigned to perform a service';
  end if;

  return new;
end;
$$;

create trigger service_staff_guard_role
  before insert or update on public.service_staff
  for each row execute function public.guard_service_staff_role();
