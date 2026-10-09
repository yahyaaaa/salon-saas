-- =============================================================================
-- Consent form attachments
--
-- A consent record can now carry supporting documents: a prior lab result, a
-- referral letter, a reference photo. These are part of the same medical record
-- as the typed history and the signature, and are treated identically.
--
-- WHEN CAN THEY BE ADDED? Only while the form is still an unsigned draft --
-- that is, during the visit, before the customer signs.
--
-- The alternative (letting documents be attached to an already-signed record)
-- was rejected: a signature attests to what the customer was shown and agreed
-- to at that moment, and a record whose contents can grow afterwards does not
-- support that claim. It is the same reason a signed form cannot be edited.
-- When a document arrives later -- a lab result that comes back next week --
-- the right move is a new consent record, exactly as it is for a correction.
-- =============================================================================

create table public.consent_form_attachments (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null,
  form_id     uuid not null,
  customer_id uuid not null,
  -- Object path in the private consent-attachments bucket, laid out as
  -- <salon_id>/<customer_id>/<form_id>/<attachment_id>.<ext>
  file_path   text not null unique,
  file_name   text not null check (length(btrim(file_name)) between 1 and 300),
  mime_type   text not null,
  size_bytes  integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by uuid,
  created_at  timestamptz not null default now(),

  constraint consent_attachment_type_allowed check (
    mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),

  foreign key (form_id, salon_id)
    references public.consent_forms (id, salon_id) on delete cascade,
  foreign key (customer_id, salon_id)
    references public.customers (id, salon_id) on delete no action,
  foreign key (uploaded_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (uploaded_by)
);

create index consent_form_attachments_form_idx
  on public.consent_form_attachments (form_id, created_at);

alter table public.consent_form_attachments enable row level security;

-- --- Row Level Security -------------------------------------------------------
-- Reading an attachment is reading the consent record, so it goes through the
-- same single rule as the form and its signature. Widening visibility in a
-- later phase means editing can_access_consent_form() and nothing else.
create policy consent_attachments_select_permitted
  on public.consent_form_attachments for select to authenticated
  using (
    exists (
      select 1
      from public.consent_forms f
      where f.id = form_id
        and public.can_access_consent_form(f.salon_id, f.collected_by, f.appointment_id)
    )
  );

-- Attach only to your own, still-unsigned draft.
create policy consent_attachments_insert_own_draft
  on public.consent_form_attachments for insert to authenticated
  with check (
    salon_id = public.current_salon_id()
    and uploaded_by = (select auth.uid())
    and exists (
      select 1
      from public.consent_forms f
      where f.id = form_id
        and f.salon_id = public.current_salon_id()
        and f.collected_by = (select auth.uid())
        and f.signed_at is null
    )
  );

-- Remove one only while that draft is still unsigned -- so a mis-attached file
-- can be taken back during the visit, and the intake action can roll itself
-- back cleanly. There is deliberately no UPDATE policy at all.
create policy consent_attachments_delete_own_draft
  on public.consent_form_attachments for delete to authenticated
  using (
    salon_id = public.current_salon_id()
    and uploaded_by = (select auth.uid())
    and exists (
      select 1
      from public.consent_forms f
      where f.id = form_id
        and f.salon_id = public.current_salon_id()
        and f.collected_by = (select auth.uid())
        and f.signed_at is null
    )
  );

-- --- Guard rail ---------------------------------------------------------------
-- Once the parent form is signed the attachment list is fixed, for anyone --
-- including the service-role key, which RLS does not constrain.
create or replace function public.guard_consent_attachment_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_signed timestamptz;
begin
  -- A salon being closed takes its records with it; the cascade removes the
  -- salon row first, so this is the only way the lookup comes back empty.
  if not exists (
    select 1 from public.salons s where s.id = coalesce(new.salon_id, old.salon_id)
  ) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select f.signed_at into v_signed
  from public.consent_forms f
  where f.id = coalesce(new.form_id, old.form_id);

  if v_signed is not null then
    raise exception
      'A signed consent record cannot gain or lose attachments; collect a new form instead';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create trigger consent_form_attachments_guard_frozen
  before insert or update or delete on public.consent_form_attachments
  for each row execute function public.guard_consent_attachment_frozen();

-- =============================================================================
-- Storage
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'consent-attachments',
  'consent-attachments',
  false,
  10485760,                    -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists consent_attachments_storage_insert on storage.objects;
drop policy if exists consent_attachments_storage_select on storage.objects;
drop policy if exists consent_attachments_storage_delete on storage.objects;

-- Upload beneath your own salon's prefix only. The row that describes the file
-- is written in the same action, and is itself limited to your unsigned draft.
create policy consent_attachments_storage_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'consent-attachments'
    and public.current_salon_id() is not null
    and (storage.foldername(name))[1] = public.current_salon_id()::text
  );

-- Read: the same rule as the consent form itself, so a therapist who did not
-- collect the form and is not treating its appointment gets nothing back, even
-- holding the exact object path.
create policy consent_attachments_storage_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'consent-attachments'
    and (storage.foldername(name))[1] = public.current_salon_id()::text
    and exists (
      select 1
      from public.consent_form_attachments a
      join public.consent_forms f on f.id = a.form_id
      where a.file_path = storage.objects.name
        and public.can_access_consent_form(f.salon_id, f.collected_by, f.appointment_id)
    )
  );

-- Deletable only while the form it belongs to is unsigned. Once signed, the
-- attachment is pinned exactly as the signature image is.
create policy consent_attachments_storage_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'consent-attachments'
    and (storage.foldername(name))[1] = public.current_salon_id()::text
    and not exists (
      select 1
      from public.consent_form_attachments a
      join public.consent_forms f on f.id = a.form_id
      where a.file_path = storage.objects.name
        and f.signed_at is not null
    )
  );
