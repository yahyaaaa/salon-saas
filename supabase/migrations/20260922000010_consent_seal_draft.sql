-- =============================================================================
-- Fix: consent forms were never actually being signed
--
-- `createConsentFormAction` writes the form as a draft, uploads the signature,
-- and then sets `signature_path` and `signed_at` to seal it. That last UPDATE
-- had no policy permitting it -- consent_forms carried SELECT, INSERT and a
-- narrow DELETE, and nothing else, because the intent was "a signed consent
-- record is immutable".
--
-- The intent was right; the gap was that a form has to BECOME signed before it
-- can be immutable. With no UPDATE policy the seal silently matched zero rows,
-- PostgREST reported no error for a zero-row update, and the action returned
-- success. Every consent form collected through the interface stayed an
-- unsigned draft -- and the customer's consent history filters on `signed_at`,
-- so none of them were ever visible.
--
-- This policy permits exactly one transition: the person who collected a form
-- sealing their own, still-unsigned draft. Because `using` requires
-- `signed_at is null`, the row stops being updatable the instant it is signed,
-- which is the immutability the schema was already aiming for -- now enforced
-- by a rule that exists, rather than by the absence of one.
-- =============================================================================

create policy consent_forms_seal_own_draft
  on public.consent_forms for update to authenticated
  using (
    salon_id = public.current_salon_id()
    and collected_by = (select auth.uid())
    and signed_at is null
  )
  with check (
    salon_id = public.current_salon_id()
    and collected_by = (select auth.uid())
  );
