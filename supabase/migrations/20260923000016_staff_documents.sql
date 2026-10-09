-- =============================================================================
-- Staff documents -- an ID card image kept for the owner's own records.
--
-- SENSITIVITY. A national ID card is the same class of data as a consent form:
-- it identifies a real person, it is held because the business needs it rather
-- than because the subject wanted it shared, and a leak of one is not
-- recoverable. It gets the same treatment -- a private bucket, a row that
-- records the object, and a single place that decides who may read it.
--
-- WHO MAY READ ONE. The owner, and nobody else. Explicitly NOT:
--   * other staff, including colleagues in the same salon;
--   * the person the document belongs to (they see it on their own ID card,
--     and giving the subject read access means a compromised staff login can
--     enumerate the bucket). Flip `staff_documents_readable()` if that is
--     wanted later -- the way consent widening goes through
--     can_access_consent_form(), this goes through one function too.
--   * anyone in another salon, which RLS refuses structurally.
--
-- There is deliberately no UPDATE policy. Replacing a card is a delete and an
-- insert, so the storage object and the row never drift apart.
-- =============================================================================

create type public.staff_document_type as enum ('id_card');

create table public.staff_documents (
  id          uuid primary key default gen_random_uuid(),
  -- Its own direct cascade, not merely a path through profiles: a salon delete
  -- cascades to its children in an unspecified order, one statement each, and
  -- a table reachable only two levels down can still be holding a reference
  -- when a sibling is checked. This has bitten twice before (migrations
  -- 20260922000006 and 20260922000012).
  salon_id    uuid not null references public.salons (id) on delete cascade,
  staff_id    uuid not null,
  doc_type    public.staff_document_type not null default 'id_card',
  -- Object path in the private staff-documents bucket, laid out as
  -- <salon_id>/<staff_id>/<document_id>.<ext>
  file_path   text not null unique,
  file_name   text not null check (length(btrim(file_name)) between 1 and 300),
  mime_type   text not null,
  size_bytes  integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  note        text not null default '' check (length(note) <= 500),
  uploaded_by uuid,
  created_at  timestamptz not null default now(),

  constraint staff_document_type_allowed check (
    mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
  ),

  -- One card per person per kind. Replacing it means deleting the old row,
  -- which is also what keeps the bucket from accumulating orphans.
  unique (staff_id, doc_type),

  foreign key (staff_id, salon_id)
    references public.profiles (id, salon_id) on delete cascade,
  foreign key (uploaded_by, salon_id)
    references public.profiles (id, salon_id) on delete set null (uploaded_by)
);

create index staff_documents_salon_idx on public.staff_documents (salon_id, staff_id);

alter table public.staff_documents enable row level security;

-- -----------------------------------------------------------------------------
-- The single place that decides visibility. Both the table policies and the
-- Storage policies call it, so there is one rule rather than two that can
-- drift apart.
-- -----------------------------------------------------------------------------
create or replace function public.can_access_staff_document(p_salon_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_salon_id is not null
     and p_salon_id = public.current_salon_id()
     and public.is_owner();
$$;

comment on function public.can_access_staff_document(uuid) is
  'The only rule for reading a staff ID document. Widen visibility by editing this, never by adding a second policy.';

grant execute on function public.can_access_staff_document(uuid) to authenticated, service_role;

create policy staff_documents_select_owner_only
  on public.staff_documents for select to authenticated
  using (public.can_access_staff_document(salon_id));

create policy staff_documents_insert_owner_only
  on public.staff_documents for insert to authenticated
  with check (
    public.can_access_staff_document(salon_id)
    and uploaded_by = (select auth.uid())
  );

create policy staff_documents_delete_owner_only
  on public.staff_documents for delete to authenticated
  using (public.can_access_staff_document(salon_id));

-- =============================================================================
-- Storage
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'staff-documents',
  'staff-documents',
  false,
  10485760,                    -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists staff_documents_storage_insert on storage.objects;
drop policy if exists staff_documents_storage_select on storage.objects;
drop policy if exists staff_documents_storage_delete on storage.objects;

-- Upload beneath your own salon's prefix, and only as the owner.
create policy staff_documents_storage_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'staff-documents'
    and public.can_access_staff_document(public.current_salon_id())
    and (storage.foldername(name))[1] = public.current_salon_id()::text
  );

-- Read: the same single rule. A staff member holding the exact object path
-- gets nothing back, and neither does another tenant.
create policy staff_documents_storage_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'staff-documents'
    and (storage.foldername(name))[1] = public.current_salon_id()::text
    and exists (
      select 1
      from public.staff_documents d
      where d.file_path = storage.objects.name
        and public.can_access_staff_document(d.salon_id)
    )
  );

create policy staff_documents_storage_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'staff-documents'
    and (storage.foldername(name))[1] = public.current_salon_id()::text
    and public.can_access_staff_document(public.current_salon_id())
  );
