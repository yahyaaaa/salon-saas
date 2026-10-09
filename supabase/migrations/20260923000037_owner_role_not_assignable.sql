-- =============================================================================
-- The owner role cannot be handed out, at the database
--
-- `changeRoleAction` refuses to assign the owner role and the form never
-- offers it -- but `profiles` has an UPDATE policy for anyone holding the Team
-- module, so a hand-made PostgREST request could simply write
-- `role_id = <the owner role>` and take the salon. The application check was
-- the only thing in the way, which is precisely the arrangement this project
-- does not accept: the rule belongs in Postgres.
--
-- Found by the isolation suite, not by review -- "nobody can be moved onto the
-- owner role" failed the first time it ran.
--
-- The INSERT path stays open because that is how a salon's owner gets the role
-- in the first place, and is guarded differently: one owner role per salon by
-- unique index, and `handle_new_user` is the only thing that creates salons.
-- =============================================================================

create or replace function public.guard_owner_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_owner_role boolean;
begin
  -- Nothing to protect once the salon is gone.
  if not exists (select 1 from public.salons s where s.id = new.salon_id) then
    return new;
  end if;

  if new.role_id is null or new.role_id is not distinct from old.role_id then
    return new;
  end if;

  select r.is_owner into v_is_owner_role
  from public.roles r
  where r.id = new.role_id and r.salon_id = new.salon_id;

  if coalesce(v_is_owner_role, false) then
    raise exception
      'The owner role belongs to the account that created this salon and cannot be reassigned';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_owner_role
  before update of role_id on public.profiles
  for each row execute function public.guard_owner_role_assignment();

-- `claim_owner_role()` updated `profiles.role_id` to the owner role and is now
-- refused by the trigger above. It was never called -- handle_new_user sets
-- role_id on INSERT -- so it goes rather than being left as a function that
-- cannot work.
drop function if exists public.claim_owner_role(uuid, uuid);
