import Link from "next/link";
import type { Metadata } from "next";

import { BookingForm } from "./booking-form";
import { CalendarGrid } from "./calendar-grid";
import { AppointmentActions } from "./appointment-actions";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/format";
import {
  addDays,
  daysInRange,
  endOfMonth,
  formatDayLabel,
  formatInstantInSalon,
  formatLongDayLabel,
  instantToSalonDate,
  instantToSalonTime,
  minutesFromTime,
  salonToday,
  startOfMonth,
  startOfWeek,
  weekdayKey,
} from "@/lib/time";
import { Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader } from "@/components/ui";
import type {
  AppointmentBalance,
  AppointmentRow,
  AppointmentServiceRow,
  TeamMemberRow,
  AppointmentStatus,
  BusinessHours,
  CustomerRow,
  ProfileRow,
  ServiceRow,
} from "@/lib/types/database";

export const metadata: Metadata = { title: "Calendar" };

export const STATUS_TONE: Record<AppointmentStatus, "brand" | "success" | "warning" | "danger" | "neutral"> = {
  booked: "neutral",
  confirmed: "brand",
  completed: "success",
  cancelled: "danger",
  no_show: "warning",
};

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

const DEFAULT_HOURS = { open: "09:00", close: "18:00", closed: false };

/**
 * A range longer than this is almost always a typo in the date box, and it
 * would pull an unbounded number of rows into one page.
 */
const MAX_RANGE_DAYS = 366;

type View = "day" | "week" | "agenda";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value: unknown, fallback: string): string {
  return typeof value === "string" && ISO_DATE.test(value) ? value : fallback;
}

export default async function CalendarPage({ searchParams }: PageProps<"/dashboard/calendar">) {
  const session = await requireSession();
  const supabase = await createClient();

  const timeZone = session.salon.timezone;
  const params = await searchParams;
  const today = salonToday(timeZone);

  const view: View =
    params.view === "week" ? "week" : params.view === "agenda" ? "agenda" : "day";
  const requested = asDate(params.date, today);

  /*
   * Day and week derive their span from a single anchor date; agenda takes an
   * explicit pair. Keeping all three as a plain [rangeStart, rangeEnd] means
   * the query, the bucketing and the list below are written once.
   */
  let rangeStart: string;
  let rangeEnd: string;
  let rangeTooLong = false;

  if (view === "agenda") {
    rangeStart = asDate(params.from, startOfMonth(today));
    rangeEnd = asDate(params.to, endOfMonth(today));
    // A backwards range is a slip of the date pickers, not a reason to error.
    if (rangeEnd < rangeStart) [rangeStart, rangeEnd] = [rangeEnd, rangeStart];
    if (daysInRange(rangeStart, rangeEnd) > MAX_RANGE_DAYS) {
      rangeEnd = addDays(rangeStart, MAX_RANGE_DAYS - 1);
      rangeTooLong = true;
    }
  } else if (view === "week") {
    rangeStart = startOfWeek(requested);
    rangeEnd = addDays(rangeStart, 6);
  } else {
    rangeStart = requested;
    rangeEnd = requested;
  }

  // The grid still needs a day-by-day list; the agenda builds its own from
  // whichever days actually have appointments.
  const days =
    view === "agenda"
      ? []
      : Array.from({ length: daysInRange(rangeStart, rangeEnd) }, (_, i) => addDays(rangeStart, i));

  // Query a generous window in salon-local terms, then bucket by local date.
  // The extra day on each side absorbs the timezone offset.
  const windowStart = `${addDays(rangeStart, -1)}T00:00:00.000Z`;
  const windowEnd = `${addDays(rangeEnd, 2)}T00:00:00.000Z`;

  const isFrontDesk = session.profile.role === "owner" || session.profile.role === "receptionist";

  const [
    { data: appointments },
    { data: team },
    { data: services },
    { data: customers },
    { data: settings },
  ] = await Promise.all([
    // RLS already limits a therapist to their own appointments; no filter here
    // decides who sees what.
    supabase
      .from("appointments")
      .select("*")
      .gte("starts_at", windowStart)
      .lt("starts_at", windowEnd)
      .order("starts_at"),
    // The ROSTER, not the logins. Who can be booked is a question about the
    // team, and plenty of the team never sign in.
    supabase.from("team_members").select("*").eq("is_active", true).order("full_name"),
    supabase.from("services").select("*").eq("is_active", true).order("name"),
    isFrontDesk
      ? supabase.from("customers").select("*").order("full_name").limit(500)
      : Promise.resolve({ data: [] as CustomerRow[] }),
    supabase
      .from("salon_settings")
      .select("business_hours")
      .eq("salon_id", session.profile.salon_id)
      .maybeSingle(),
  ]);

  /*
   * The booked services. `appointments.service_id` is only the FIRST line --
   * it is kept for the qualification guard and the Phase 6 reports -- so
   * anything that shows a customer what they booked reads this table instead.
   */
  const appointmentIds = ((appointments ?? []) as AppointmentRow[]).map((a) => a.id);
  const { data: bookedServices } = appointmentIds.length
    ? await supabase
        .from("appointment_services")
        .select("*")
        .in("appointment_id", appointmentIds)
        .order("sort_order")
    : { data: [] as AppointmentServiceRow[] };

  /*
   * What each visit is owed and has been paid. Summed in Postgres rather than
   * here: money arithmetic is the database's job, and one call beats a query
   * per row. The front desk alone can read the ledger, so a therapist simply
   * gets an empty list and no payment badges.
   */
  const { data: balanceRows } = isFrontDesk && appointmentIds.length
    ? await supabase.rpc("appointment_balances", { p_appointment_ids: appointmentIds })
    : { data: [] as (AppointmentBalance & { appointment_id: string })[] };

  const balanceByAppointment = new Map<string, AppointmentBalance>();
  for (const row of (balanceRows ?? []) as (AppointmentBalance & {
    appointment_id: string;
  })[]) {
    balanceByAppointment.set(row.appointment_id, row);
  }

  const linesByAppointment = new Map<string, AppointmentServiceRow[]>();
  for (const line of (bookedServices ?? []) as AppointmentServiceRow[]) {
    linesByAppointment.set(line.appointment_id, [
      ...(linesByAppointment.get(line.appointment_id) ?? []),
      line,
    ]);
  }

  /*
   * Everyone on the roster is bookable. The old code filtered logins by role,
   * excluding receptionists -- but "performs services" is what being on the
   * roster MEANS now, so there is nothing left to filter on.
   */
  const therapists = (team ?? []) as TeamMemberRow[];

  // A therapist sees only their own column of the diary -- matched on their
  // roster entry, which is what appointments actually reference.
  const columns = isFrontDesk
    ? therapists
    : therapists.filter((p) => p.id === session.teamMemberId);

  const nameById = new Map<string, string>();
  for (const p of therapists) nameById.set(p.id, p.full_name);

  // Who took each booking. A login, deliberately separate from the roster.
  const { data: logins } = await supabase
    .from("profiles")
    .select("id, full_name, email");
  const bookedByName = new Map<string, string>();
  for (const p of (logins ?? []) as Pick<ProfileRow, "id" | "full_name" | "email">[]) {
    bookedByName.set(p.id, p.full_name || p.email);
  }

  const serviceById = new Map<string, ServiceRow>();
  for (const s of (services ?? []) as ServiceRow[]) serviceById.set(s.id, s);

  const customerById = new Map<string, CustomerRow>();
  for (const c of (customers ?? []) as CustomerRow[]) customerById.set(c.id, c);

  const businessHours = (settings?.business_hours ?? null) as BusinessHours | null;

  // Bound the grid to the widest opening across the days on screen, so a
  // Saturday with different hours still fits.
  let earliest = 24 * 60;
  let latest = 0;
  for (const day of days) {
    const hours = businessHours?.[weekdayKey(day)] ?? DEFAULT_HOURS;
    if (hours.closed) continue;
    earliest = Math.min(earliest, minutesFromTime(hours.open));
    latest = Math.max(latest, minutesFromTime(hours.close));
  }
  if (earliest >= latest) {
    earliest = minutesFromTime(DEFAULT_HOURS.open);
    latest = minutesFromTime(DEFAULT_HOURS.close);
  }

  const visible = ((appointments ?? []) as AppointmentRow[]).map((appointment) => {
    const lines = linesByAppointment.get(appointment.id) ?? [];
    return {
      ...appointment,
      localDate: instantToSalonDate(appointment.starts_at, timeZone),
      localStart: instantToSalonTime(appointment.starts_at, timeZone),
      localEnd: instantToSalonTime(appointment.ends_at, timeZone),
      lines,
      // A booking made before the lines table existed still has its one
      // service on the appointment itself.
      serviceSummary:
        lines.length > 0
          ? lines
              .map((l) => (l.quantity > 1 ? `${l.service_name} ×${l.quantity}` : l.service_name))
              .join(", ")
          : (serviceById.get(appointment.service_id)?.name ?? "Service"),
      blockTitle:
        lines.length > 1
          ? `${lines[0].service_name} +${lines.length - 1}`
          : (lines[0]?.service_name ?? serviceById.get(appointment.service_id)?.name ?? "Service"),
      customerName: customerById.get(appointment.customer_id)?.full_name ?? "Customer",
      staffName: nameById.get(appointment.staff_id) ?? "Team member",
      balance: balanceByAppointment.get(appointment.id) ?? null,
    };
  });

  const inRange = visible.filter((a) => a.localDate >= rangeStart && a.localDate <= rangeEnd);
  const live = inRange.filter((a) => a.status !== "cancelled" && a.status !== "no_show");

  const prev = view === "week" ? addDays(rangeStart, -7) : addDays(rangeStart, -1);
  const next = view === "week" ? addDays(rangeStart, 7) : addDays(rangeStart, 1);
  const todayHref = `/dashboard/calendar?view=${view}&date=${today}`;

  // Agenda groups into date headings, newest day first would read backwards
  // for a schedule, so it stays chronological.
  const byDay = new Map<string, typeof inRange>();
  for (const appointment of inRange) {
    byDay.set(appointment.localDate, [...(byDay.get(appointment.localDate) ?? []), appointment]);
  }
  const agendaDays = [...byDay.keys()].sort();

  const rangeValue = inRange
    .filter((a) => a.status !== "cancelled" && a.status !== "no_show")
    .reduce((sum, a) => sum + Number(a.price_at_booking), 0);

  function renderActions(appointment: (typeof inRange)[number]) {
    if (!isFrontDesk) return null;
    return (
      <AppointmentActions
        appointmentId={appointment.id}
        status={appointment.status}
        staffId={appointment.staff_id}
        date={appointment.localDate}
        time={appointment.localStart}
        therapists={therapists.map((t) => ({ id: t.id, name: t.full_name }))}
      />
    );
  }

  function renderDetail(appointment: (typeof inRange)[number], showDate: boolean) {
    const subtotal = Number(appointment.services_subtotal);
    const discount = Number(appointment.discount_amount);
    const quoted = appointment.quoted_total === null ? null : Number(appointment.quoted_total);

    return (
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
          <span className="tabular-nums">
            {appointment.localStart}&ndash;{appointment.localEnd}
          </span>
          <Link
            href={`/dashboard/calendar/${appointment.id}`}
            className="text-brand-700 hover:underline"
          >
            {appointment.serviceSummary}
          </Link>
          <Badge tone={STATUS_TONE[appointment.status]}>
            {STATUS_LABEL[appointment.status]}
          </Badge>
          {appointment.is_walk_in ? <Badge tone="warning">Walk-in</Badge> : null}
          {/*
            The payment state, which is a separate axis from the service
            state: a visit can be paid in advance and not yet done, or done
            and still owed for.
          */}
          {appointment.balance && Number(appointment.balance.amount_paid) > 0 ? (
            Number(appointment.balance.balance) > 0.005 ? (
              <Badge tone="warning">
                Part-paid {formatMoney(appointment.balance.amount_paid, session.salon.currency)}
              </Badge>
            ) : (
              <Badge tone="success">Paid</Badge>
            )
          ) : null}
        </p>

        <p className="mt-0.5 text-xs text-ink-500">
          {showDate ? `${formatDayLabel(appointment.localDate)} · ` : ""}
          <Link
            href={`/dashboard/customers/${appointment.customer_id}`}
            className="text-brand-700 hover:underline"
          >
            {appointment.customerName}
          </Link>{" "}
          &middot; {appointment.staffName}
        </p>

        {/* Every line, with what each one costs. */}
        {appointment.lines.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {appointment.lines.map((line) => (
              <li key={line.id} className="text-xs text-ink-600">
                &bull; {line.service_name}
                {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                <span className="ml-1.5 tabular-nums text-ink-400">
                  {formatMoney(Number(line.unit_price) * line.quantity, session.salon.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
          <span className="font-medium tabular-nums text-ink-800">
            {formatMoney(appointment.price_at_booking, session.salon.currency)}
          </span>
          {discount > 0 ? (
            <span className="text-emerald-700">
              subtotal {formatMoney(subtotal, session.salon.currency)} &minus;{" "}
              {formatMoney(discount, session.salon.currency)} discount
            </span>
          ) : null}
          {quoted !== null ? (
            <span className="text-brand-700">
              quoted price, services total{" "}
              {formatMoney(subtotal, session.salon.currency)}
            </span>
          ) : null}
        </p>

        <p className="mt-1 text-xs text-ink-400">
          Booked {formatInstantInSalon(appointment.created_at, timeZone)}
          {/* created_by is a LOGIN, not a roster entry -- it records who took
              the booking at the desk, which is a different question from who
              performs it. */}
          {appointment.created_by
            ? ` by ${bookedByName.get(appointment.created_by) ?? "a colleague"}`
            : ""}
        </p>

        {appointment.notes ? (
          <p className="mt-1 text-xs text-ink-500">{appointment.notes}</p>
        ) : null}
        {appointment.resolution_reason ? (
          <p className="mt-1 text-xs text-red-600">Reason: {appointment.resolution_reason}</p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Calendar"
        description={
          view === "agenda"
            ? `${formatLongDayLabel(rangeStart)} to ${formatLongDayLabel(rangeEnd)} · times shown in ${timeZone}`
            : view === "week"
              ? `Week of ${formatDayLabel(rangeStart)} · times shown in ${timeZone}`
              : `${formatLongDayLabel(rangeStart)} · times shown in ${timeZone}`
        }
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-1">
            {view === "agenda" ? (
              <>
                <NavLink href={agendaHref(addDays(rangeStart, -daysInRange(rangeStart, rangeEnd)), addDays(rangeStart, -1))}>
                  &larr; Previous
                </NavLink>
                <NavLink href={agendaHref(startOfMonth(today), endOfMonth(today))}>
                  This month
                </NavLink>
                <NavLink href={agendaHref(addDays(rangeEnd, 1), addDays(rangeEnd, daysInRange(rangeStart, rangeEnd)))}>
                  Next &rarr;
                </NavLink>
              </>
            ) : (
              <>
                <NavLink href={`/dashboard/calendar?view=${view}&date=${prev}`}>&larr; Previous</NavLink>
                <NavLink href={todayHref}>Today</NavLink>
                <NavLink href={`/dashboard/calendar?view=${view}&date=${next}`}>Next &rarr;</NavLink>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <NavLink href={`/dashboard/calendar?view=day&date=${requested}`} active={view === "day"}>
              Day
            </NavLink>
            <NavLink href={`/dashboard/calendar?view=week&date=${requested}`} active={view === "week"}>
              Week
            </NavLink>
            <NavLink href={agendaHref(rangeStart, rangeEnd)} active={view === "agenda"}>
              List
            </NavLink>
          </div>
        </div>

        {view === "agenda" ? (
          <div className="border-t border-ink-200 px-5 py-3">
            {/*
              A plain GET form: the range lives in the URL, so a particular
              span is linkable and survives a refresh.
            */}
            <form method="get" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="view" value="agenda" />
              <div className="w-44">
                <label htmlFor="agenda-from" className="mb-1.5 block text-xs font-medium text-ink-600">
                  From
                </label>
                <Input id="agenda-from" name="from" type="date" defaultValue={rangeStart} />
              </div>
              <div className="w-44">
                <label htmlFor="agenda-to" className="mb-1.5 block text-xs font-medium text-ink-600">
                  To
                </label>
                <Input id="agenda-to" name="to" type="date" defaultValue={rangeEnd} />
              </div>
              <Button type="submit" variant="secondary">
                Show range
              </Button>

              <div className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-ink-400">Quick:</span>
                <QuickRange href={agendaHref(today, today)}>Today</QuickRange>
                <QuickRange href={agendaHref(startOfWeek(today), addDays(startOfWeek(today), 6))}>
                  This week
                </QuickRange>
                <QuickRange href={agendaHref(startOfMonth(today), endOfMonth(today))}>
                  This month
                </QuickRange>
                <QuickRange href={agendaHref(addDays(today, -29), today)}>Last 30 days</QuickRange>
                <QuickRange href={agendaHref(today, addDays(today, 29))}>Next 30 days</QuickRange>
              </div>
            </form>

            {rangeTooLong ? (
              <p className="mt-2 text-xs text-amber-700">
                That range was longer than a year, so it has been trimmed to {MAX_RANGE_DAYS} days.
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      {view !== "agenda" ? (
        columns.length === 0 ? (
          <Card>
            <EmptyState>
              Nobody on the team roster yet. Add someone from the Team page before
              booking — they do not need a login.
            </EmptyState>
          </Card>
        ) : (
          <CalendarGrid
            days={days}
            columns={columns.map((c) => ({ id: c.id, name: c.full_name }))}
            appointments={live.map((a) => ({
              id: a.id,
              staffId: a.staff_id,
              date: a.localDate,
              start: a.localStart,
              end: a.localEnd,
              status: a.status,
              isWalkIn: a.is_walk_in,
              title: a.blockTitle,
              subtitle: a.customerName,
            }))}
            openMinutes={earliest}
            closeMinutes={latest}
            businessHours={businessHours}
            view={view}
          />
        )
      ) : null}

      {view === "agenda" ? (
        <Card>
          <CardHeader
            title={`${inRange.length} appointment${inRange.length === 1 ? "" : "s"} over ${daysInRange(rangeStart, rangeEnd)} days`}
            description={`Worth ${formatMoney(rangeValue, session.salon.currency)}, excluding cancellations and no-shows.`}
          />
          {agendaDays.length === 0 ? (
            <EmptyState>Nothing booked in this range.</EmptyState>
          ) : (
            agendaDays.map((day) => (
              <section key={day}>
                <h3 className="flex items-baseline justify-between border-b border-ink-200 bg-ink-50 px-5 py-1.5">
                  <span className="text-xs font-bold uppercase tracking-wide text-ink-500">
                    {formatLongDayLabel(day)}
                  </span>
                  <span className="text-xs text-ink-400">
                    {byDay.get(day)?.length} booked
                  </span>
                </h3>
                <ul className="divide-y divide-ink-200">
                  {(byDay.get(day) ?? []).map((appointment) => (
                    <li
                      key={appointment.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
                    >
                      {renderDetail(appointment, false)}
                      {renderActions(appointment)}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={view === "week" ? "Appointments this week" : "Appointments this day"}
            description={
              isFrontDesk
                ? "Cancellations and no-shows keep their reason on the record."
                : "Your own schedule. Booking and status changes are handled at the front desk."
            }
          />
          {inRange.length === 0 ? (
            <EmptyState>Nothing booked.</EmptyState>
          ) : (
            <ul className="divide-y divide-ink-200">
              {inRange.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-5 py-3"
                >
                  {renderDetail(appointment, true)}
                  {renderActions(appointment)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {isFrontDesk ? (
        <Card>
          <CardHeader
            title="Book an appointment"
            description="The slot length is the sum of the services booked. A walk-in skips the conflict check and is squeezed in."
          />
          <div className="px-5 py-4">
            <BookingForm
              therapists={therapists.map((t) => ({ id: t.id, name: t.full_name }))}
              services={(services ?? []) as ServiceRow[]}
              defaultDate={view === "agenda" ? today : rangeStart}
              currency={session.salon.currency}
            />
          </div>
        </Card>
      ) : null}
    </>
  );
}

function agendaHref(from: string, to: string): string {
  return `/dashboard/calendar?view=agenda&from=${from}&to=${to}`;
}

function QuickRange({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-ink-200 px-2 py-1 font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
    >
      {children}
    </Link>
  );
}

function NavLink({
  href,
  children,
  active = false,
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? "rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700"
          : "rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 hover:bg-ink-100"
      }
    >
      {children}
    </Link>
  );
}
