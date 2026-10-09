-- =============================================================================
-- Harden the audit log: append-only at the DATABASE level, not just in the app
--
-- Until now `audit_logs` was protected only by RLS: a SELECT policy for owners
-- and an INSERT policy, with no UPDATE or DELETE policy at all. That stops
-- every ordinary caller, because RLS refuses a command it has no policy for.
--
-- What it does NOT stop is anything that bypasses RLS -- the `service_role`
-- key, or the table owner. Both could quietly rewrite history. For a log whose
-- entire purpose is to be trustworthy after the fact, "no policy" is the wrong
-- kind of protection: it is an absence, and absences are easy to add to.
--
-- This makes the guarantee explicit. A trigger refuses every UPDATE and DELETE
-- regardless of who is asking, superuser included.
--
-- The single exception is a salon being deleted. A cascade removes the parent
-- salon row first, so by the time this fires for the children the salon is
-- already gone -- which is the only way `exists` comes back false here. Without
-- it a closed account could never be removed, and the log would be protecting
-- records belonging to nobody. The same carve-out is used by the loyalty ledger
-- and by payroll.
-- =============================================================================

create or replace function public.guard_audit_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.salons s where s.id = old.salon_id) then
    raise exception
      'The audit log is append-only: entries cannot be % once written',
      case tg_op when 'DELETE' then 'deleted' else 'altered' end;
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function public.guard_audit_append_only();
