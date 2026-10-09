"use client";

import { useState } from "react";

import type { PeakTime } from "@/lib/types/database";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * When the salon is busy.
 *
 * Magnitude across two ordered dimensions, so a heatmap rather than seven
 * overlaid lines. It is a SEQUENTIAL encoding: one hue, light to dark — never a
 * rainbow, which would imply categories where there is only "more" and "less".
 *
 * Intensity alone is not the only cue: the count is printed in every cell that
 * has one, so the grid is readable without relying on colour.
 */
export function PeakHeatmap({ rows }: { rows: PeakTime[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(`${row.weekday}-${row.hour_of_day}`, Number(row.appointments));
  }

  const max = Math.max(...rows.map((r) => Number(r.appointments)), 1);

  // Only show hours that actually have bookings, with a little padding, so the
  // grid does not waste half its width on the small hours.
  const hoursWithData = rows.map((r) => r.hour_of_day);
  const firstHour = Math.max(0, Math.min(...hoursWithData) - 1);
  const lastHour = Math.min(23, Math.max(...hoursWithData) + 1);
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);

  const busiest = rows.reduce(
    (best, row) => (Number(row.appointments) > Number(best.appointments) ? row : best),
    rows[0],
  );

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-xs">
          <caption className="sr-only">
            Appointments by weekday and hour, in the salon&rsquo;s local time.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-10" />
              {hours.map((hour) => (
                <th
                  key={hour}
                  scope="col"
                  className="pb-1 text-center font-medium tabular-nums text-ink-400"
                >
                  {String(hour).padStart(2, "0")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day, weekday) => (
              <tr key={day}>
                <th scope="row" className="pr-2 text-right font-medium text-ink-500">
                  {day}
                </th>
                {hours.map((hour) => {
                  const key = `${weekday}-${hour}`;
                  const count = counts.get(key) ?? 0;
                  // A single hue, stepped by intensity. Empty cells stay on the
                  // surface tint so "none" reads as absence, not as a low value.
                  const intensity = count === 0 ? 0 : 0.15 + (count / max) * 0.85;

                  return (
                    <td
                      key={hour}
                      className="relative h-7 rounded-[3px] text-center tabular-nums transition-colors"
                      style={{
                        backgroundColor:
                          count === 0
                            ? "var(--color-ink-100)"
                            : `color-mix(in oklch, var(--color-brand-500) ${intensity * 100}%, white)`,
                        color: intensity > 0.6 ? "white" : "var(--color-ink-700)",
                      }}
                      onMouseEnter={() => setHovered(key)}
                      onMouseLeave={() => setHovered(null)}
                      title={`${day} ${String(hour).padStart(2, "0")}:00 — ${count} appointment${count === 1 ? "" : "s"}`}
                    >
                      {count > 0 ? count : ""}
                      {hovered === key && count > 0 ? (
                        <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-ink-200 bg-white px-2 py-1 text-[11px] font-medium text-ink-800 shadow-lg">
                          {day} {String(hour).padStart(2, "0")}:00 &middot; {count}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {busiest ? (
          <p className="text-xs text-ink-500">
            Busiest:{" "}
            <span className="font-medium text-ink-700">
              {DAYS[busiest.weekday]} at {String(busiest.hour_of_day).padStart(2, "0")}:00
            </span>{" "}
            &middot; {busiest.appointments} appointments
          </p>
        ) : null}

        <div className="flex items-center gap-1.5 text-xs text-ink-400">
          <span>Quieter</span>
          {[0.15, 0.4, 0.65, 0.9, 1].map((step) => (
            <span
              key={step}
              aria-hidden
              className="size-3 rounded-[2px]"
              style={{
                backgroundColor: `color-mix(in oklch, var(--color-brand-500) ${step * 100}%, white)`,
              }}
            />
          ))}
          <span>Busier</span>
        </div>
      </div>
    </figure>
  );
}
