-- =============================================================================
-- Fix: consent attachments blocked salon deletion
--
-- `consent_form_attachments` reached `salons` only indirectly, through
-- `consent_forms`. Deleting a salon cascades to its children in an unspecified
-- order, and each cascade is its own statement: when `customers` was reached
-- first, the NO ACTION check on `consent_form_attachments.customer_id` ran
-- before the `consent_forms` cascade had removed the attachment rows, and the
-- delete was refused.
--
-- This is exactly the failure that 20260922000006 fixed for
-- `loyalty_transactions`, and the fix is the same: give the table a direct
-- cascade from `salons` so it is removed in the same wave as the customers it
-- references, rather than a wave later.
--
-- The rule this encodes: a tenant table needs its OWN
-- `salon_id references salons on delete cascade`. A path through a parent is
-- not enough, because ordering between siblings is not guaranteed.
-- =============================================================================

alter table public.consent_form_attachments
  add constraint consent_form_attachments_salon_id_fkey
    foreign key (salon_id) references public.salons (id) on delete cascade;
