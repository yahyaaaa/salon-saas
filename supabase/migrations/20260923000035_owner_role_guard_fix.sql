-- =============================================================================
-- The owner-role guard refused the one insert that has to be allowed
--
-- `guard_owner_role` rejected EVERY insert with is_owner set -- including
-- `seed_default_roles()` creating the role in the first place. So signing up a
-- new salon failed outright, with the auth layer reporting only "Database
-- error creating new user".
--
-- The blanket refusal was redundant as well as wrong: `roles_one_owner_per_
-- salon` is a partial unique index, so a second owner role is already
-- impossible. What the guard needs to say is narrower -- an owner role may be
-- created only for a salon that does not have one, which is exactly the seed.
--
-- Everything else it does is unchanged and is the part that matters: the owner
-- role cannot be renamed, deleted, or flipped into or out of, so holding the
-- Team module never becomes a way to seize the salon.
-- =============================================================================

create or replace function public.guard_owner_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A salon being closed takes its roles with it.
  if not exists (
    select 1 from public.salons s where s.id = coalesce(new.salon_id, old.salon_id)
  ) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception 'The owner role cannot be deleted';
    end if;
    if old.is_system then
      raise exception 'A built-in role cannot be deleted; take everyone off it instead';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' and new.is_owner then
    -- Permitted only where there is no owner role yet: the salon being
    -- created. The unique index makes a second one impossible regardless.
    if exists (
      select 1 from public.roles r
      where r.salon_id = new.salon_id and r.is_owner
    ) then
      raise exception 'This salon already has an owner role';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.is_owner <> new.is_owner then
      raise exception 'A role cannot be turned into the owner role, or out of it';
    end if;
    if old.is_owner and btrim(old.name) <> btrim(new.name) then
      raise exception 'The owner role cannot be renamed';
    end if;
  end if;

  return new;
end;
$$;
