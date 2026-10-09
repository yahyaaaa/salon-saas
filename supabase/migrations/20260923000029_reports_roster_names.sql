-- =============================================================================
-- Reports name people from the roster
--
-- Two of the Phase 6 reports resolved a staff_id against `profiles` to get a
-- name. Since staff_id is a roster entry, that join now matches nothing and
-- every row falls through to the 'Former team member' fallback -- so both
-- reports still return correct FIGURES against anonymous rows, which is the
-- sort of breakage that survives a test suite counting totals.
--
-- The fallback stays for a genuinely deleted roster entry, which is what it
-- was written for.
--
-- Both functions keep SECURITY INVOKER and their is_owner() guard by way of
-- report_context(): this only changes which table supplies the name.
-- =============================================================================

create or replace function public.report_revenue_by_staff(p_from date, p_to date)
returns table (
  staff_id   uuid,
  staff_name text,
  services   bigint,
  revenue    numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  select
    li.staff_id,
    coalesce(max(nullif(tm.full_name, '')), 'Former team member'),
    sum(li.quantity)::bigint,
    round(sum(li.line_total), 2)
  from public.receipt_line_items li
  join public.receipts r on r.id = li.receipt_id
  left join public.team_members tm on tm.id = li.staff_id
  where r.status = 'issued'
    and (li.performed_at at time zone v_tz)::date between p_from and p_to
  group by li.staff_id
  order by 4 desc;
end;
$$;

create or replace function public.report_appointment_stats(p_from date, p_to date)
returns table (
  staff_id     uuid,
  staff_name   text,
  booked       bigint,
  confirmed    bigint,
  completed    bigint,
  cancelled    bigint,
  no_show      bigint,
  total        bigint,
  no_show_rate numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tz text;
begin
  select rc.timezone into v_tz from public.report_context() rc;

  return query
  select
    a.staff_id,
    coalesce(max(nullif(tm.full_name, '')), 'Former team member'),
    count(*) filter (where a.status = 'booked')::bigint,
    count(*) filter (where a.status = 'confirmed')::bigint,
    count(*) filter (where a.status = 'completed')::bigint,
    count(*) filter (where a.status = 'cancelled')::bigint,
    count(*) filter (where a.status = 'no_show')::bigint,
    count(*)::bigint,
    case when count(*) = 0 then 0
         else round(count(*) filter (where a.status = 'no_show')::numeric / count(*), 4)
    end
  from public.appointments a
  left join public.team_members tm on tm.id = a.staff_id
  where (a.starts_at at time zone v_tz)::date between p_from and p_to
  group by a.staff_id
  order by 8 desc;
end;
$$;
