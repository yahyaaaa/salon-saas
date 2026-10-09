import { Card } from "@/components/ui";
import { formatDayLabel, minutesFromTime, timeFromMinutes, weekdayKey } from "@/lib/time";
import type { AppointmentStatus, BusinessHours } from "@/lib/types/database";

interface GridAppointment {
  id: string;
  staffId: string;
  date: string;
  start: string;
  end: string;
  status: AppointmentStatus;
  isWalkIn: boolean;
  title: string;
  subtitle: string;
}

const STATUS_STYLE: Record<AppointmentStatus, string> = {
  booked: "bg-ink-100 border-ink-300 text-ink-800",
  confirmed: "bg-brand-50 border-brand-300 text-brand-700",
  completed: "bg-emerald-50 border-emerald-300 text-emerald-800",
  cancelled: "bg-red-50 border-red-200 text-red-700",
  no_show: "bg-amber-50 border-amber-300 text-amber-900",
};

/** One pixel per minute would be huge; this keeps an hour readable but compact. */
const PX_PER_MINUTE = 1.1;

/**
 * The diary grid.
 *
 * A day view gives each therapist a column; a week view gives each day a
 * column for the single therapist in focus, or stacks therapists per day.
 * Times are already salon-local by the time they arrive here.
 */
export function CalendarGrid({
  days,
  columns,
  appointments,
  openMinutes,
  closeMinutes,
  businessHours,
  view,
}: {
  days: string[];
  columns: { id: string; name: string }[];
  appointments: GridAppointment[];
  openMinutes: number;
  closeMinutes: number;
  businessHours: BusinessHours | null;
  view: "day" | "week";
}) {
  const totalMinutes = Math.max(60, closeMinutes - openMinutes);
  const height = totalMinutes * PX_PER_MINUTE;

  // Hour lines across the whole opening span.
  const firstHour = Math.floor(openMinutes / 60);
  const lastHour = Math.ceil(closeMinutes / 60);
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => (firstHour + i) * 60);

  // In week view the columns are days; in day view they are therapists.
  const headers =
    view === "week"
      ? days.map((day) => ({ key: day, label: formatDayLabel(day), day }))
      : columns.map((column) => ({ key: column.id, label: column.name, day: days[0] }));

  function slotsFor(headerKey: string, day: string): GridAppointment[] {
    return view === "week"
      ? appointments.filter((a) => a.date === day)
      : appointments.filter((a) => a.date === day && a.staffId === headerKey);
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-2xl">
          {/* Column headings */}
          <div
            className="grid border-b border-ink-200 bg-ink-50"
            style={{ gridTemplateColumns: `4rem repeat(${headers.length}, minmax(9rem, 1fr))` }}
          >
            <div className="px-2 py-2 text-xs font-medium text-ink-400">Time</div>
            {headers.map((header) => {
              const closed = businessHours?.[weekdayKey(header.day)]?.closed ?? false;
              return (
                <div
                  key={header.key}
                  className="border-l border-ink-200 px-2 py-2 text-xs font-semibold text-ink-700"
                >
                  {header.label}
                  {closed ? <span className="ml-1 font-normal text-ink-400">(closed)</span> : null}
                </div>
              );
            })}
          </div>

          {/* Body */}
          <div
            className="relative grid"
            style={{
              gridTemplateColumns: `4rem repeat(${headers.length}, minmax(9rem, 1fr))`,
              height: `${height}px`,
            }}
          >
            {/* Hour gutter */}
            <div className="relative">
              {hours.map((minute) => (
                <div
                  key={minute}
                  className="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-ink-400"
                  style={{ top: `${(minute - openMinutes) * PX_PER_MINUTE}px` }}
                >
                  {timeFromMinutes(minute)}
                </div>
              ))}
            </div>

            {headers.map((header) => {
              const closed = businessHours?.[weekdayKey(header.day)]?.closed ?? false;
              return (
                <div
                  key={header.key}
                  className={`relative border-l border-ink-200 ${closed ? "bg-ink-50" : ""}`}
                >
                  {/* Hour rules */}
                  {hours.map((minute) => (
                    <div
                      key={minute}
                      className="absolute inset-x-0 border-t border-ink-100"
                      style={{ top: `${(minute - openMinutes) * PX_PER_MINUTE}px` }}
                    />
                  ))}

                  {slotsFor(header.key, header.day).map((appointment) => {
                    const start = minutesFromTime(appointment.start);
                    const end = minutesFromTime(appointment.end);
                    const top = (start - openMinutes) * PX_PER_MINUTE;
                    const blockHeight = Math.max(18, (end - start) * PX_PER_MINUTE);

                    return (
                      <div
                        key={appointment.id}
                        className={`absolute inset-x-1 overflow-hidden rounded-md border px-1.5 py-1 text-[11px] leading-tight ${STATUS_STYLE[appointment.status]}`}
                        style={{ top: `${top}px`, height: `${blockHeight}px` }}
                        title={`${appointment.start}–${appointment.end} · ${appointment.title} · ${appointment.subtitle}`}
                      >
                        <p className="truncate font-semibold">
                          {appointment.start} {appointment.title}
                        </p>
                        <p className="truncate opacity-80">
                          {appointment.subtitle}
                          {appointment.isWalkIn ? " · walk-in" : ""}
                        </p>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}
