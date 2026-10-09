-- =============================================================================
-- Fix: a salon could not be deleted
--
-- Phases 2 to 4 used ON DELETE RESTRICT to express "you cannot delete a
-- customer who has a medical record", "you cannot delete a service that has
-- been booked", and so on. That intent is right, but RESTRICT is the wrong
-- mechanism for it.
--
-- RESTRICT is checked immediately, row by row. NO ACTION is checked at the end
-- of the statement. For a single delete the two behave identically -- both
-- refuse. They differ only when parent and child are being removed in the SAME
-- statement, which is exactly what `delete from salons` does: customers,
-- appointments, receipts and the rest are all children of the salon, and the
-- order the cascade visits them in is not defined. With RESTRICT, whichever
-- happens to go first trips over the others.
--
-- The result was that a salon could never be deleted at all. That matters for
-- closing an account, and it is why the test suites could not tear their own
-- fixtures down.
--
-- Switching these to NO ACTION keeps every single-row protection intact while
-- letting a whole salon be removed in one go.
--
-- `loyalty_transactions` had a second problem: it reached `salons` only
-- indirectly, through `customers`, so it had no cascade path of its own. It
-- gets a direct one here.
-- =============================================================================

-- --- appointments -------------------------------------------------------------
alter table public.appointments
  drop constraint appointments_customer_id_salon_id_fkey,
  add constraint appointments_customer_id_salon_id_fkey
    foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete no action;

alter table public.appointments
  drop constraint appointments_service_id_salon_id_fkey,
  add constraint appointments_service_id_salon_id_fkey
    foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete no action;

alter table public.appointments
  drop constraint appointments_staff_id_salon_id_fkey,
  add constraint appointments_staff_id_salon_id_fkey
    foreign key (staff_id, salon_id)
    references public.profiles (id, salon_id) on delete no action;

-- --- consent_forms ------------------------------------------------------------
alter table public.consent_forms
  drop constraint consent_forms_customer_id_salon_id_fkey,
  add constraint consent_forms_customer_id_salon_id_fkey
    foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete no action;

alter table public.consent_forms
  drop constraint consent_forms_service_id_salon_id_fkey,
  add constraint consent_forms_service_id_salon_id_fkey
    foreign key (service_id, salon_id)
    references public.services (id, salon_id) on delete no action;

alter table public.consent_forms
  drop constraint consent_forms_template_id_salon_id_fkey,
  add constraint consent_forms_template_id_salon_id_fkey
    foreign key (template_id, salon_id)
    references public.consent_templates (id, salon_id) on delete no action;

-- --- services -----------------------------------------------------------------
alter table public.services
  drop constraint services_consent_template_id_salon_id_fkey,
  add constraint services_consent_template_id_salon_id_fkey
    foreign key (consent_template_id, salon_id)
    references public.consent_templates (id, salon_id) on delete no action;

-- --- receipts -----------------------------------------------------------------
alter table public.receipts
  drop constraint receipts_customer_id_salon_id_fkey,
  add constraint receipts_customer_id_salon_id_fkey
    foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete no action;

alter table public.receipts
  drop constraint receipts_deal_id_salon_id_fkey,
  add constraint receipts_deal_id_salon_id_fkey
    foreign key (deal_id, salon_id)
    references public.deals (id, salon_id) on delete no action;

-- --- loyalty_transactions -----------------------------------------------------
alter table public.loyalty_transactions
  drop constraint loyalty_transactions_customer_id_salon_id_fkey,
  add constraint loyalty_transactions_customer_id_salon_id_fkey
    foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete no action;

-- The ledger reached salons only via customers, so a closed salon left its
-- loyalty history behind with nothing to remove it.
alter table public.loyalty_transactions
  add constraint loyalty_transactions_salon_id_fkey
    foreign key (salon_id) references public.salons (id) on delete cascade;
