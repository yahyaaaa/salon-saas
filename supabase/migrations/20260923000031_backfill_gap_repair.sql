-- =============================================================================
-- One-off repair: logins created in the gap between two migrations
--
-- Migration 24 gave every profile that existed AT THAT MOMENT a roster entry.
-- Migration 26 taught the signup trigger to create one for every profile made
-- afterwards. Anyone who signed up between the two got neither, and ends up
-- able to sign in but absent from the roster -- so they cannot be booked, do
-- not appear on payroll, and see an empty "My earnings".
--
-- That state is LEGITIMATE in general: an administrator or a bookkeeper has an
-- account and performs no services, and is meant to look exactly like this.
-- What makes these particular rows wrong is only that nobody chose it for
-- them. So this is a dated, one-time repair of that window and not a rule --
-- there is deliberately no trigger enforcing "every login has a roster entry",
-- because that would break the very case the split exists to allow.
--
-- Safe to re-run: it matches nothing once applied.
-- =============================================================================

with orphaned as (
  select p.id, p.salon_id, p.full_name, p.email
  from public.profiles p
  where p.team_member_id is null
    -- Only the ones from the gap. A login created after the trigger was fixed
    -- has no roster entry because somebody decided it should not.
    and p.created_at < timestamptz '2026-09-23 18:00:00+00'
),
made as (
  insert into public.team_members (salon_id, full_name, is_active)
  select o.salon_id,
         coalesce(nullif(btrim(o.full_name), ''), split_part(o.email, '@', 1)),
         true
  from orphaned o
  returning id, salon_id, full_name
)
update public.profiles p
set team_member_id = m.id
from made m, orphaned o
where p.id = o.id
  and m.salon_id = o.salon_id
  and m.full_name = coalesce(nullif(btrim(o.full_name), ''), split_part(o.email, '@', 1));
