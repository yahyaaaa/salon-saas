-- =============================================================================
-- Phase 2: private Storage bucket for consent signatures
--
-- Signature images are part of a medical record, so the bucket is private and
-- its policies mirror the consent_forms row policies exactly -- both go through
-- public.can_access_consent_form(). Extending visibility in Phase 3 means
-- changing that one function; the bucket follows automatically.
--
-- Object layout:  <salon_id>/<customer_id>/<form_id>.png
-- The first path segment is the tenant, which is what every policy checks.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'consent-signatures',
  'consent-signatures',
  false,
  524288,                      -- 512 KB; a signature PNG is a few KB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects is owned by supabase_storage_admin, but Supabase grants the
-- postgres role the rights to manage policies on it directly. Do NOT try to
-- `set role supabase_storage_admin` here -- that membership is superuser-only
-- and the statement is refused.

drop policy if exists consent_signatures_insert on storage.objects;
drop policy if exists consent_signatures_select on storage.objects;
drop policy if exists consent_signatures_update on storage.objects;
drop policy if exists consent_signatures_delete on storage.objects;

-- Upload: any active member of the salon, and only beneath their own salon's
-- prefix. The matching consent_forms row is written in the same action and is
-- itself constrained to collected_by = auth.uid().
create policy consent_signatures_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'consent-signatures'
    and public.current_salon_id() is not null
    and (storage.foldername(name))[1] = public.current_salon_id()::text
  );

-- Read: the same rule as reading the consent form itself. A therapist who did
-- not collect the form cannot fetch its signature image, even with the exact
-- object path.
create policy consent_signatures_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'consent-signatures'
    and (storage.foldername(name))[1] = public.current_salon_id()::text
    and exists (
      select 1
      from public.consent_forms f
      where f.signature_path = storage.objects.name
        and public.can_access_consent_form(f.salon_id, f.collected_by)
    )
  );

-- A signature is written once. There is no UPDATE policy at all, so overwriting
-- one is refused by the database.

-- Deletion exists only so an abandoned upload (a form that was never signed)
-- can be tidied up by the owner. Once signed_at is set, the object is pinned.
create policy consent_signatures_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'consent-signatures'
    and (storage.foldername(name))[1] = public.current_salon_id()::text
    and public.is_owner()
    and not exists (
      select 1
      from public.consent_forms f
      where f.signature_path = storage.objects.name
        and f.signed_at is not null
    )
  );
